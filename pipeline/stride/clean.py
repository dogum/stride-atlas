"""Phase 2: apply every rule in docs/CLEANING.md.

Writes *_clean tables next to the raw ones and one cleaning_log row per change:
cleaning_log(rule_id, table_name, row_key, field, before, after, note, run_at).
run_at is the export's ExportDate so re-running on the same export is byte-identical.
"""
from __future__ import annotations

import json
import os
from concurrent.futures import ProcessPoolExecutor
from datetime import timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pyarrow as pa

from . import paths
from .geo import MI, detect_home, tz_at, tz_segments
from .paths import Timer
from .track import TrackParams, clean_track

HR = "HKQuantityTypeIdentifierHeartRate"
FAMILY = {"walk": "foot", "run": "foot", "hike": "foot", "ride": "ride", "swim": "swim", "strength": "strength"}


class Log:
    def __init__(self, run_at: str):
        self.rows: list[tuple] = []
        self.run_at = run_at

    def add(self, rule, table, key, field=None, before=None, after=None, note=None):
        self.rows.append((rule, table, str(key), field, None if before is None else str(before), None if after is None else str(after), note, self.run_at))

    def df(self) -> pd.DataFrame:
        return pd.DataFrame(self.rows, columns=["rule_id", "table_name", "row_key", "field", "before", "after", "note", "run_at"])


# ------------------------------------------------------------------ workouts
def load_workouts(con) -> pd.DataFrame:
    w = con.execute("SELECT * FROM workouts ORDER BY start_utc, workout_id").df()
    m = con.execute("SELECT workout_id, key, value, value_num, unit, value_si FROM workout_metadata").df()
    piv = {}
    for r in m.itertuples(index=False):
        d = piv.setdefault(r.workout_id, {})
        k = r.key
        if k == "HKWeatherTemperature":
            d["temp_health_c"] = r.value_si
        elif k == "HKWeatherHumidity":
            v = r.value_num
            d["humidity_health"] = v / 100 if v is not None and v > 100 else v  # '7400 %' means 74 %
        elif k == "HKElevationAscended":
            d["climb_watch_m"] = r.value_si
        elif k == "HKAverageMETs":
            d["avg_mets"] = r.value_num
        elif k == "HKLapLength":
            d["lap_length_m"] = r.value_si
        elif k == "HKSwimmingLocationType":
            d["swim_location"] = {"1": "pool", "2": "open_water"}.get(str(r.value), "unknown")
        elif k == "HKWasUserEntered":
            d["user_entered"] = str(r.value) == "1"
        elif k == "StravaName":
            d["title"] = r.value
    md = pd.DataFrame.from_dict(piv, orient="index")
    md.index.name = "workout_id"
    for c in ["temp_health_c", "humidity_health", "climb_watch_m", "avg_mets", "lap_length_m", "swim_location", "user_entered", "title"]:
        if c not in md:
            md[c] = None
    w = w.merge(md.reset_index(), on="workout_id", how="left")
    rt = con.execute("""SELECT workout_id, any_value(file) AS route_file, count(*) AS n_routes FROM routes WHERE file IS NOT NULL GROUP BY 1""").df()
    w = w.merge(rt, on="workout_id", how="left")
    w["has_route"] = w.route_file.notna() & w.workout_id.isin(con.execute("SELECT DISTINCT workout_id FROM route_points").df().workout_id)
    hrn = con.execute(f"""SELECT w.workout_id, count(q.value) AS n_hr FROM workouts w LEFT JOIN quantity_samples q
        ON q.type = '{HR}' AND q.start_utc >= w.start_utc AND q.start_utc <= w.end_utc GROUP BY 1""").df()
    w = w.merge(hrn, on="workout_id", how="left")
    # heart rate stored inside an imported file (Strava) belongs to that workout only
    con.execute("CREATE TABLE IF NOT EXISTS workout_hr_file (workout_id VARCHAR, t_utc TIMESTAMP, bpm DOUBLE)")
    hrf = con.execute("SELECT workout_id, count(*) AS n_hr_file FROM workout_hr_file GROUP BY 1").df()
    w = w.merge(hrf, on="workout_id", how="left")
    w["n_hr_file"] = w.n_hr_file.fillna(0).astype(int)
    w["n_hr"] = w.n_hr.fillna(0) + w.n_hr_file
    first = con.execute("""SELECT workout_id, lat AS start_lat, lon AS start_lon FROM route_points WHERE seq = 0""").df()
    w = w.merge(first, on="workout_id", how="left")
    w["family"] = w.type.map(FAMILY).fillna("other")
    return w


def rule_w1(w: pd.DataFrame, log: Log, thresh: float) -> pd.DataFrame:
    """Duplicate workouts: same family, spans overlap >= 80% of the shorter one."""
    w = w.copy()
    w["dup_of"] = None
    parent = {i: i for i in w.index}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for fam, g in w.groupby("family"):
        g = g.sort_values("start_utc")
        rows = list(g.itertuples())
        for a_i, a in enumerate(rows):
            for b in rows[a_i + 1:]:
                if b.start_utc >= a.end_utc:
                    break
                ov = (min(a.end_utc, b.end_utc) - max(a.start_utc, b.start_utc)).total_seconds()
                shorter = min((a.end_utc - a.start_utc).total_seconds(), (b.end_utc - b.start_utc).total_seconds())
                if shorter > 0 and ov >= thresh * shorter:
                    parent[find(a.Index)] = find(b.Index)
    # copies whose clock is off by whole hours (a time-zone slip when one app synced to another while travelling):
    # same family, different source, starts a whole number of hours apart, distance and duration equal within 1%
    shifted = {}
    for fam, g in w.groupby("family"):
        rows = list(g.sort_values("start_utc").itertuples())
        for a_i, a in enumerate(rows):
            for b in rows[a_i + 1:]:
                dt = (b.start_utc - a.start_utc).total_seconds()
                if dt > 14 * 3600:
                    break
                if a.source_name == b.source_name or dt < 1800 or abs(dt - round(dt / 3600) * 3600) > 60:
                    continue
                close = lambda u, v, floor: pd.notna(u) and pd.notna(v) and abs(u - v) <= max(floor, 0.01 * max(u, v))  # noqa: E731
                if close(a.duration_s, b.duration_s, 5) and close(a.total_distance_m, b.total_distance_m, 5) and (a.total_distance_m or 0) > 0:
                    parent[find(a.Index)] = find(b.Index)
                    shifted[a.Index] = shifted[b.Index] = round(dt / 3600)
    groups = {}
    for i in w.index:
        groups.setdefault(find(i), []).append(i)
    copy_cols = ["temp_health_c", "humidity_health", "climb_watch_m", "avg_mets", "hk_timezone", "title"]
    for members in groups.values():
        if len(members) < 2:
            continue
        g = w.loc[members]
        order = g.assign(
            _r=g.has_route.astype(int), _h=(g.n_hr.fillna(0) > 0).astype(int), _w=(g.device_class == "watch").astype(int),
            _n=(g.source_name != "Strava").astype(int), _d=(g.end_utc - g.start_utc).dt.total_seconds(),
        ).sort_values(["_r", "_h", "_w", "_n", "_d", "workout_id"], ascending=[False, False, False, False, False, True])
        keep = order.index[0]
        for drop in order.index[1:]:
            for c in copy_cols:
                if pd.isna(w.at[keep, c]) and not pd.isna(w.at[drop, c]):
                    w.at[keep, c] = w.at[drop, c]
                    log.add("W1", "workouts", w.at[keep, "workout_id"], c, None, w.at[drop, c], f"copied from duplicate {w.at[drop, 'workout_id']}")
            w.at[drop, "dup_of"] = w.at[keep, "workout_id"]
            log.add("W1", "workouts", w.at[drop, "workout_id"], "dropped", None, w.at[keep, "workout_id"],
                    f"duplicate of {w.at[keep, 'source_name']} {w.at[keep, 'activity_type']} at {w.at[keep, 'start_utc']}"
                    + (f" (same distance and duration, clock {shifted[drop]} h off)" if drop in shifted else "") + "; kept the one with "
                    + ("a route" if w.at[keep, "has_route"] else "heart rate" if (w.at[keep, "n_hr"] or 0) > 0 else "the watch source" if w.at[keep, "device_class"] == "watch" else "the longer duration"))
    return w


def rule_w2(w: pd.DataFrame, log: Log) -> pd.DataFrame:
    w = w.copy()

    def flag(v):
        return None if v is None or (isinstance(v, float) and np.isnan(v)) or v is pd.NA else bool(v)

    def setting(r):
        ind = flag(r.indoor_flag)
        if r.type == "swim":
            return "pool" if r.swim_location == "pool" else "open_water" if r.swim_location == "open_water" else "pool"
        if ind is True:
            return "indoor"
        if r.has_route:
            return "outdoor"
        if r.type in ("walk", "run", "hike", "ride"):
            return "no_route"
        return "indoor"

    w["setting"] = [setting(r) for r in w.itertuples()]
    for r in w.itertuples():
        if r.type in ("walk", "run", "hike", "ride") and r.setting in ("indoor", "no_route") and r.dup_of is None:
            log.add("W2", "workouts", r.workout_id, "setting", None, r.setting,
                    "HKIndoorWorkout = 1" if r.setting == "indoor" else "no route file and no GPS distance: kept in totals, excluded from map, pace, weather and best efforts")
    return w


# ------------------------------------------------------------------ time zones
def assign_time_zones(con, w: pd.DataFrame, home: dict, log: Log) -> tuple[pd.DataFrame, pd.DataFrame]:
    home_tz = tz_at(round(home["lat"], 3), round(home["lon"], 3)) or "America/New_York"
    tzs, srcs = [], []
    for r in w.itertuples():
        tf = tz_at(round(r.start_lat, 4), round(r.start_lon, 4)) if pd.notna(r.start_lat) else None
        meta = r.hk_timezone if isinstance(r.hk_timezone, str) and r.hk_timezone else None
        if meta:
            try:
                zi = ZoneInfo(meta)
            except Exception:
                meta = None
        if meta and meta.startswith("Etc/"):
            # fixed-offset zones (Peloton writes Etc/GMT+4 for EDT): use the named zone with the same offset at that instant
            t = r.start_utc.tz_localize("UTC")
            cand = tf or home_tz
            if t.tz_convert(ZoneInfo(cand)).utcoffset() == t.tz_convert(zi).utcoffset():
                log.add("TZ", "workouts", r.workout_id, "tz", meta, cand, "fixed-offset zone mapped to the named zone with the same offset")
                meta = cand
        if meta and tf and meta != tf:
            log.add("TZ", "workouts", r.workout_id, "tz", meta, tf, "HKTimeZone disagrees with timezonefinder on the route start; metadata kept")
        if meta:
            tzs.append(meta); srcs.append("metadata")
        elif tf:
            tzs.append(tf); srcs.append("timezonefinder")
        else:
            tzs.append(None); srcs.append(None)
    w = w.assign(tz=tzs, tz_source=srcs)
    obs = w.loc[w.tz.notna() & w.dup_of.isna(), ["start_utc", "tz"]].rename(columns={"start_utc": "t_utc"})
    segs = tz_segments(obs, home_tz)
    # workouts without any zone take the timeline's zone
    miss = w.tz.isna()
    if miss.any():
        z = []
        for t in w.loc[miss, "start_utc"]:
            z.append(segs.loc[(segs.from_utc <= t) & (segs.to_utc > t), "tz"].iloc[0])
        w.loc[miss, "tz"] = z
        w.loc[miss, "tz_source"] = "timeline"
    loc_s, loc_e = [], []
    for r in w.itertuples():
        zi = ZoneInfo(r.tz)
        loc_s.append(r.start_utc.tz_localize("UTC").tz_convert(zi).tz_localize(None))
        loc_e.append(r.end_utc.tz_localize("UTC").tz_convert(zi).tz_localize(None))
    w["start_local"] = loc_s
    w["end_local"] = loc_e
    w["local_date"] = pd.to_datetime(w.start_local).dt.date
    return w, segs.assign(home_tz=home_tz)


# ------------------------------------------------------------------ tracks
def _pauses(ev: pd.DataFrame, start, end) -> list[tuple[float, float]]:
    out, open_t = [], None
    for r in ev.sort_values("date_utc").itertuples():
        t = r.date_utc.timestamp() if hasattr(r.date_utc, "timestamp") else None
        if t is None:
            continue
        if r.type in ("Pause", "MotionPaused"):
            open_t = t if open_t is None else open_t
        elif r.type in ("Resume", "MotionResumed") and open_t is not None:
            out.append((open_t, t))
            open_t = None
    if open_t is not None:
        out.append((open_t, end.timestamp()))
    return out


def _clean_one(args):
    wid, t, lat, lon, ele, hacc, params, watch_m, pauses, dur = args
    res = clean_track(t, lat, lon, ele, hacc, params, watch_m, pauses, dur)
    return wid, res


def clean_routes(con, w: pd.DataFrame, log: Log, cfg: dict) -> tuple[pd.DataFrame, pa.Table]:
    pts = con.execute("""SELECT p.workout_id, p.seq, epoch_ms(p.t_utc) / 1000.0 AS t, p.lat, p.lon, p.ele_m, p.hacc_m
                         FROM route_points p ORDER BY p.workout_id, p.seq""").fetchnumpy()
    filled = lambda a: np.ma.filled(a.astype(float), np.nan) if np.ma.isMaskedArray(a) else a.astype(float)
    ele, hacc = filled(pts["ele_m"]), filled(pts["hacc_m"])
    wids = pts["workout_id"]
    uniq, first = np.unique(wids, return_index=True)
    bounds = dict(zip(uniq, zip(first, np.r_[first[1:], len(wids)])))
    ev = con.execute("SELECT workout_id, type, date_utc FROM workout_events WHERE type IN ('Pause','Resume','MotionPaused','MotionResumed')").df()
    evg = dict(tuple(ev.groupby("workout_id")))
    cc = cfg["cleaning"]
    jobs = []
    keep = w[w.has_route & w.dup_of.isna()]
    for r in keep.itertuples():
        if r.workout_id not in bounds:
            continue
        a, b = bounds[r.workout_id]
        ty = r.type if r.type in cc["max_speed_mph"] else "walk"
        p = TrackParams(ceiling_mph=cc["max_speed_mph"][ty], on_foot=r.type in cfg["on_foot_types"], hacc_drop_m=cc["hacc_drop_m"],
                        jitter_radius_m=cc["door_jitter_radius_m"], jitter_seconds=cc["door_jitter_seconds"],
                        drive_mph=cc["forgot_to_stop_mph"], climb_hysteresis_m=cc["climb_hysteresis_m"])
        pz = _pauses(evg[r.workout_id], r.start_utc.tz_localize("UTC"), r.end_utc.tz_localize("UTC")) if r.workout_id in evg else []
        jobs.append((r.workout_id, pts["t"][a:b], pts["lat"][a:b], pts["lon"][a:b], ele[a:b], hacc[a:b],
                     p, float(r.total_distance_m) if pd.notna(r.total_distance_m) else None, pz, float(r.duration_s)))
    stats, parts = [], []
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 4) - 1)) as ex:
        for wid, res in ex.map(_clean_one, jobs, chunksize=8):
            a, b = bounds[wid]
            k = res.keep_idx
            s = dict(res.stats, workout_id=wid)
            stats.append(s)
            for rule, field, before, after, note, oseq in res.log:
                if oseq is None:
                    log.add(rule, "workouts" if rule in ("G3", "G4", "G6", "E2", "G5") else "route_points", wid, field, before, after, note)
                else:
                    log.add(rule, "route_points", f"{wid}:{oseq}", field, before, after, note)
            n = len(k)
            parts.append(pa.table({
                "workout_id": pa.array([wid] * n, pa.string()), "seq": pa.array(np.arange(n, dtype=np.int32)),
                "orig_seq": pa.array(pts["seq"][a:b][k].astype(np.int32)),
                "t_utc": pa.array((pts["t"][a:b][k] * 1000).astype("int64").astype("datetime64[ms]")),
                "lat": pa.array(pts["lat"][a:b][k]), "lon": pa.array(pts["lon"][a:b][k]),
                "ele_gps_m": pa.array(ele[a:b][k], from_pandas=True),
                "ele_gps_smooth_m": pa.array(res.ele_smooth, from_pandas=True),
                "hacc_m": pa.array(hacc[a:b][k], from_pandas=True),
                "cum_gps_m": pa.array(res.cum_gps_m), "cum_m": pa.array(res.cum_m), "cum_moving_s": pa.array(res.cum_moving_s),
                "gap": pa.array(res.gap),
            }))
    return pd.DataFrame(stats), pa.concat_tables(parts)


# ------------------------------------------------------------------ S1 daily dedupe
S1_TYPES = {"HKQuantityTypeIdentifierStepCount": "steps", "HKQuantityTypeIdentifierDistanceWalkingRunning": "distance_m",
            "HKQuantityTypeIdentifierFlightsClimbed": "flights"}


def rule_s1(con, segs: pd.DataFrame, priority: list[str], log: Log) -> None:
    con.register("tzseg", segs[["from_utc", "to_utc", "tz"]])
    types = ", ".join(f"'{t}'" for t in S1_TYPES)
    pr = " ".join(f"WHEN '{c}' THEN {i}" for i, c in enumerate(priority))
    con.execute(f"""CREATE OR REPLACE TEMP TABLE s1_min AS
        WITH src AS (
          SELECT type, device_class, source_name, start_utc, end_utc, value_si AS v, epoch(end_utc) - epoch(start_utc) AS dur
          FROM quantity_samples WHERE type IN ({types}) AND value_si > 0),
        ex AS (
          SELECT *, unnest(generate_series(date_trunc('minute', start_utc),
                 CASE WHEN dur <= 0 THEN date_trunc('minute', start_utc) ELSE date_trunc('minute', end_utc - INTERVAL 1 MICROSECOND) END,
                 INTERVAL 1 MINUTE)) AS minute FROM src)
        SELECT type, device_class, source_name, minute,
               CASE WHEN dur <= 0 THEN v ELSE v * (least(epoch(end_utc), epoch(minute) + 60) - greatest(epoch(start_utc), epoch(minute))) / dur END AS v
        FROM ex""")
    con.execute(f"""CREATE OR REPLACE TABLE minute_dedup AS
        WITH per_src AS (SELECT type, minute, device_class, source_name, sum(v) AS v FROM s1_min GROUP BY ALL),
             per_cls AS (SELECT type, minute, device_class, max(v) AS v FROM per_src GROUP BY ALL),
             ranked AS (SELECT *, row_number() OVER (PARTITION BY type, minute ORDER BY CASE device_class {pr} ELSE 9 END) AS rk FROM per_cls)
        SELECT type, minute, device_class AS chosen_class, v FROM ranked WHERE rk = 1""")
    con.execute("""CREATE OR REPLACE TEMP TABLE s1_local AS
        SELECT m.type, m.minute, m.chosen_class, m.v, s.tz,
               CAST(timezone(s.tz, m.minute::TIMESTAMPTZ) AS DATE) AS local_date
        FROM minute_dedup m ASOF JOIN tzseg s ON m.minute >= s.from_utc""")
    con.execute("""CREATE OR REPLACE TEMP TABLE s1_cls AS
        SELECT p.type, CAST(timezone(s.tz, p.minute::TIMESTAMPTZ) AS DATE) AS local_date, p.device_class, sum(p.v) AS v
        FROM (SELECT type, minute, device_class, sum(v) AS v FROM s1_min GROUP BY ALL) p ASOF JOIN tzseg s ON p.minute >= s.from_utc
        GROUP BY ALL""")
    con.execute("""CREATE OR REPLACE TABLE daily_quantities_clean AS
        WITH merged AS (SELECT type, local_date, sum(v) AS v, sum(v) FILTER (WHERE chosen_class='watch') AS from_watch,
                               sum(v) FILTER (WHERE chosen_class='phone') AS from_phone, sum(v) FILTER (WHERE chosen_class='other') AS from_other
                        FROM s1_local GROUP BY ALL),
             raw AS (SELECT type, local_date, sum(v) AS raw_sum, sum(v) FILTER (WHERE device_class='watch') AS raw_watch,
                            sum(v) FILTER (WHERE device_class='phone') AS raw_phone, sum(v) FILTER (WHERE device_class='other') AS raw_other
                     FROM s1_cls GROUP BY ALL)
        SELECT m.*, r.raw_sum, r.raw_watch, r.raw_phone, r.raw_other FROM merged m JOIN raw r USING (type, local_date)
        ORDER BY type, local_date""")
    rows = con.execute("""SELECT type, local_date, raw_sum, v FROM daily_quantities_clean WHERE raw_sum > v * 1.005""").fetchall()
    for t, d, before, after in rows:
        log.add("S1", "daily_quantities_clean", f"{S1_TYPES[t]}:{d}", S1_TYPES[t], round(before, 2), round(after, 2), "overlapping watch and phone samples merged per minute, watch first")


# ------------------------------------------------------------------ heart rate
def rule_h(con, log: Log, w: pd.DataFrame, cfg: dict, export_date) -> dict:
    con.execute(f"""CREATE OR REPLACE TEMP TABLE hr_flag AS
        WITH hr AS (SELECT type, source_name, device_class, start_utc, end_utc, value,
                           lag(value) OVER win AS pv, lag(start_utc) OVER win AS pt, lead(value) OVER win AS nv, lead(start_utc) OVER win AS nt
                    FROM quantity_samples WHERE type = '{HR}' WINDOW win AS (PARTITION BY source_name, device_class ORDER BY start_utc))
        SELECT *, CASE WHEN value < 35 OR value > 220 THEN 'implausible'
                       WHEN pv IS NOT NULL AND nv IS NOT NULL AND abs(value - pv) > 40 AND epoch(start_utc) - epoch(pt) <= 5
                            AND epoch(nt) - epoch(start_utc) <= 10 AND abs(nv - pv) <= 20 THEN 'isolated jump' END AS h1
        FROM hr""")
    for r in con.execute("SELECT source_name, device_class, start_utc, value, pv, h1 FROM hr_flag WHERE h1 IS NOT NULL ORDER BY start_utc").fetchall():
        log.add("H1", "quantity_samples", f"{HR}|{r[0]}|{r[1]}|{r[2]}", "value", r[3], None, f"{r[5]} (previous {r[4]})")
    keys = "type, source_name, device_class, start_utc, end_utc, value"
    con.execute(f"""CREATE OR REPLACE TABLE quantity_samples_clean AS
        SELECT q.* FROM quantity_samples q ANTI JOIN (SELECT {keys} FROM hr_flag WHERE h1 IS NOT NULL) d USING ({keys})
        ORDER BY {keys}""")
    # H2: 5-second workout streams, forward fill up to 30 s
    ww = w.loc[w.dup_of.isna(), ["workout_id", "start_utc", "end_utc"]]
    con.register("hw", ww)
    con.execute(f"""CREATE OR REPLACE TABLE workout_hr_5s AS
        WITH g AS (SELECT workout_id, start_utc AS w0, unnest(generate_series(start_utc, end_utc, INTERVAL 5 SECOND)) AS ts FROM hw),
             hr AS (SELECT start_utc, value, CASE device_class WHEN 'watch' THEN 0 ELSE 1 END AS pri
                    FROM quantity_samples_clean WHERE type = '{HR}'),
             hr1 AS (SELECT DISTINCT ON (start_utc) start_utc, value FROM hr ORDER BY start_utc, pri)
        SELECT g.workout_id, CAST(epoch(g.ts) - epoch(g.w0) AS INTEGER) AS t_s,
               CASE WHEN epoch(g.ts) - epoch(h.start_utc) <= 30 THEN h.value END AS hr
        FROM g ASOF LEFT JOIN hr1 h ON g.ts >= h.start_utc
        ORDER BY g.workout_id, t_s""")
    # workouts imported with their own heart rate (Strava files) use only that stream
    con.execute("DELETE FROM workout_hr_5s WHERE workout_id IN (SELECT DISTINCT workout_id FROM workout_hr_file)")
    con.execute("""INSERT INTO workout_hr_5s
        WITH g AS (SELECT workout_id, start_utc AS w0, unnest(generate_series(start_utc, end_utc, INTERVAL 5 SECOND)) AS ts
                   FROM hw WHERE workout_id IN (SELECT DISTINCT workout_id FROM workout_hr_file)),
             hr AS (SELECT workout_id, t_utc, bpm FROM workout_hr_file)
        SELECT g.workout_id, CAST(epoch(g.ts) - epoch(g.w0) AS INTEGER) AS t_s,
               CASE WHEN epoch(g.ts) - epoch(h.t_utc) <= 30 THEN h.bpm END AS hr
        FROM g ASOF LEFT JOIN hr h ON g.workout_id = h.workout_id AND g.ts >= h.t_utc""")
    con.execute("CREATE OR REPLACE TABLE workout_hr_5s AS SELECT * FROM workout_hr_5s ORDER BY workout_id, t_s")
    con.execute("DELETE FROM workout_hr_5s WHERE workout_id IN (SELECT workout_id FROM workout_hr_5s GROUP BY 1 HAVING count(hr) = 0)")
    # H3: HRmax
    cfg_max = cfg["heart_rate"].get("max_bpm")
    end = pd.Timestamp(export_date)
    hard = w[w.dup_of.isna() & w.type.isin(["run", "ride", "hiit", "cross", "stairs"]) & (w.n_hr.fillna(0) > 0)]
    last_hard = hard.start_utc.max() if len(hard) else end
    windows = {"last_two_years": end, "two_years_to_last_hard_effort": min(end, last_hard + pd.Timedelta(days=1))}
    res = {}
    for name, e in windows.items():
        s0 = e - pd.DateOffset(years=2)
        con.register("hw2", w.loc[w.dup_of.isna() & (w.start_utc >= s0) & (w.start_utc <= e), ["workout_id", "start_utc", "end_utc"]])
        res[name] = con.execute(f"""SELECT quantile_cont(q.value, 0.995), count(*) FROM quantity_samples_clean q JOIN hw2 w
            ON q.type = '{HR}' AND q.start_utc BETWEEN w.start_utc AND w.end_utc""").fetchone() + (s0, e)
    a, b = res["last_two_years"], res["two_years_to_last_hard_effort"]
    if cfg_max:
        hrmax, src = float(cfg_max), "config.yaml heart_rate.max_bpm"
    elif b[0] is not None and a[0] is not None and b[0] > a[0] * 1.05:
        hrmax, src = round(float(b[0]), 1), f"p99.5 of {b[1]:,} workout samples {b[2].date()} to {b[3].date()} (the two years ending at the last run, ride or interval session; the last two years hold only walks and peak at {a[0]:.0f})"
    else:
        hrmax, src = round(float(a[0]), 1), f"p99.5 of {a[1]:,} workout samples since {a[2].date()}"
    return {"hr_max": hrmax, "hr_max_source": src, "hr_p995_last2y": float(a[0]) if a[0] is not None else None}


# ------------------------------------------------------------------ swims
STROKES = {"1": "mixed", "2": "freestyle", "3": "backstroke", "4": "breaststroke", "5": "butterfly", "6": "kickboard"}


def rule_p1(con, w: pd.DataFrame, log: Log) -> None:
    sw = w[(w.type == "swim") & w.dup_of.isna()]
    con.register("sw", sw[["workout_id", "lap_length_m"]])
    laps = con.execute("""SELECT e.workout_id, e.seq, e.date_utc, e.duration_s, e.meta, sw.lap_length_m
        FROM workout_events e JOIN sw USING (workout_id) WHERE e.type = 'Lap' ORDER BY e.workout_id, e.date_utc""").df()
    strokes = con.execute("""SELECT start_utc, end_utc, value FROM quantity_samples WHERE type = 'HKQuantityTypeIdentifierSwimmingStrokeCount'""").df()
    out = []
    for r in laps.itertuples():
        m = json.loads(r.meta) if r.meta else {}
        st = strokes[(strokes.start_utc >= r.date_utc - timedelta(seconds=1)) & (strokes.start_utc <= r.date_utc + timedelta(seconds=r.duration_s + 1))]
        n_str = float(st.value.sum()) if len(st) else None
        secs = float(r.duration_s)
        dropped = secs < 5
        if dropped:
            log.add("P1", "swim_laps", f"{r.workout_id}:{r.seq}", "duration_s", round(secs, 1), None, "lap under 5 s (wall touch) dropped")
        out.append({"workout_id": r.workout_id, "lap_seq": int(r.seq), "start_utc": r.date_utc, "duration_s": secs, "length_m": r.lap_length_m,
                    "stroke_style": STROKES.get(str(m.get("HKSwimmingStrokeStyle")), "unknown"), "strokes": n_str,
                    "swolf": (n_str + secs) if n_str is not None else None, "swolf_apple": float(m["HKSWOLFScore"]) if "HKSWOLFScore" in m else None,
                    "dropped": dropped})
    df = pd.DataFrame(out, columns=["workout_id", "lap_seq", "start_utc", "duration_s", "length_m", "stroke_style", "strokes", "swolf", "swolf_apple", "dropped"])
    con.register("laps_df", df)
    con.execute("CREATE OR REPLACE TABLE swim_laps AS SELECT * FROM laps_df ORDER BY workout_id, lap_seq")


# ------------------------------------------------------------------ W3 / W4
def rule_w3_w4(con, w: pd.DataFrame, log: Log) -> pd.DataFrame:
    w = w.copy()
    frag = (w.setting == "outdoor") & ((w.duration_s < 180) | (w.distance_m.fillna(0) < 0.1 * MI))
    w["is_fragment"] = frag & w.dup_of.isna()
    for r in w[w.is_fragment].itertuples():
        log.add("W3", "workouts", r.workout_id, "is_fragment", False, True, f"{r.duration_s:.0f} s, {(r.distance_m or 0):.0f} m: accidental start, kept out of routes and records")
    sug = []
    pts = con.execute("""SELECT workout_id, seq, cum_m, cum_moving_s FROM route_points_clean ORDER BY workout_id, seq""").fetchnumpy()
    wid = pts["workout_id"]
    u, f = np.unique(wid, return_index=True)
    bounds = dict(zip(u, zip(f, np.r_[f[1:], len(wid)])))
    walks = w[(w.type == "walk") & (w.setting == "outdoor") & w.dup_of.isna() & ~w.is_fragment]
    for r in walks.itertuples():
        if r.workout_id not in bounds:
            continue
        a, b = bounds[r.workout_id]
        cm, ct = pts["cum_m"][a:b], pts["cum_moving_s"][a:b]
        if len(cm) < 60:
            continue
        # moving pace over ~30 s windows; share of distance faster than 11:00 /mi
        step = 30
        dd, tt = cm[step:] - cm[:-step], ct[step:] - ct[:-step]
        fast = (tt > 0) & (dd / np.maximum(tt, 1e-6) > MI / 660)
        share = float(dd[fast].sum() / max(dd.sum(), 1.0))
        climb_ftmi = None
        c = r.climb_watch_m if pd.notna(r.climb_watch_m) else r.climb_gps_m
        if pd.notna(c) and r.distance_m and r.distance_m > 0:
            climb_ftmi = c * 3.28084 / (r.distance_m / MI)
        if share > 0.5:
            sug.append({"workout_id": r.workout_id, "suggest": "run", "reason": f"{share:.0%} of the distance faster than 11:00 /mi", "metric": share})
            log.add("W4", "workouts", r.workout_id, "type", "walk", "run?", f"suggestion only: {share:.0%} of distance under 11:00 /mi")
        if climb_ftmi is not None and climb_ftmi > 120 and r.distance_m >= MI:
            sug.append({"workout_id": r.workout_id, "suggest": "hike", "reason": f"{climb_ftmi:.0f} ft of climb per mile", "metric": climb_ftmi})
            log.add("W4", "workouts", r.workout_id, "type", "walk", "hike?", f"suggestion only: {climb_ftmi:.0f} ft/mi of climb")
    con.register("sug_df", pd.DataFrame(sug, columns=["workout_id", "suggest", "reason", "metric"]))
    con.execute("CREATE OR REPLACE TABLE relabel_suggestions AS SELECT * FROM sug_df ORDER BY workout_id, suggest")
    return w


# ------------------------------------------------------------------ main
def run() -> dict:
    cfg = paths.config()
    con = paths.connect()
    export_date = con.execute("SELECT v FROM _meta WHERE k='export_date'").fetchone()[0]
    run_at = export_date
    log = Log(run_at)
    out = {"run_at": run_at}
    with Timer("workouts, home, time zones"):
        w = load_workouts(con)
        starts = w.loc[w.has_route & w.start_lat.notna(), ["start_lat", "start_lon"]].rename(columns={"start_lat": "lat", "start_lon": "lon"})
        home = detect_home(starts, cfg["privacy"]["home_radius_m"])
        con.execute("CREATE OR REPLACE TABLE home AS SELECT ? AS lat, ? AS lon, ? AS radius_m, ? AS n_starts, ? AS share",
                    [home["lat"], home["lon"], cfg["privacy"]["home_radius_m"], home["n_starts"], home["share"]])
        out["home_share_of_starts"] = home["share"]
        w = rule_w1(w, log, cfg["dedupe"]["workout_overlap"])
        w = rule_w2(w, log)
        w, segs = assign_time_zones(con, w, home, log)
        con.register("segs_df", segs)
        con.execute("CREATE OR REPLACE TABLE tz_segments AS SELECT * FROM segs_df ORDER BY from_utc")
        out["tz_segments"] = len(segs)
    with Timer("routes G1-G6, E1-E2"):
        st, pts = clean_routes(con, w, log, cfg)
        con.register("pts_tbl", pts)
        con.execute("CREATE OR REPLACE TABLE route_points_clean AS SELECT * FROM pts_tbl ORDER BY workout_id, seq")
        con.unregister("pts_tbl")
        w = w.merge(st, on="workout_id", how="left")
        # headline distance for workouts without a cleaned route: watch statistics
        w["distance_m"] = w["distance_m"].where(w["distance_m"].notna(), w["total_distance_m"])
        w["distance_source"] = w["distance_source"].where(w["distance_source"].notna(), np.where(w["total_distance_m"].notna(), "watch", None))
        w.loc[(w.source_name == "Strava") & (w.distance_source == "watch"), "distance_source"] = "app:strava"
        w["moving_s"] = w["moving_s"].where(w["moving_s"].notna(), w["duration_s"])
        w["elapsed_s"] = (w.end_utc - w.start_utc).dt.total_seconds()
        # W5: a final pause that is never resumed ends the workout (the watch was left running)
        ev = con.execute("""SELECT workout_id, type, date_utc FROM workout_events WHERE type IN ('Pause','Resume','MotionPaused','MotionResumed')
                            ORDER BY workout_id, date_utc""").df()
        open_end = {}
        for wid, g in ev.groupby("workout_id"):
            last = g.iloc[-1]
            if last.type in ("Pause", "MotionPaused"):
                open_end[wid] = last.date_utc
        for i, r in w[w.workout_id.isin(open_end.keys())].iterrows():
            pe = open_end[r.workout_id]
            new_el = (pe - r.start_utc).total_seconds()
            if r.end_utc - pe > pd.Timedelta(minutes=10) and new_el > 0:
                log.add("W5", "workouts", r.workout_id, "elapsed_s", round(r.elapsed_s), round(new_el), f"paused {(r.end_utc - pe).total_seconds() / 3600:.1f} h before the end and never resumed: elapsed time ends at the pause")
                w.at[i, "elapsed_s"] = new_el
                w.at[i, "open_pause_end"] = True
        if "open_pause_end" not in w:
            w["open_pause_end"] = False
        w["open_pause_end"] = w["open_pause_end"].fillna(False).astype(bool)
    with Timer("W3, W4"):
        w = rule_w3_w4(con, w, log)
    with Timer("S1 steps, distance, flights"):
        rule_s1(con, segs, cfg["dedupe"]["source_priority"], log)
    with Timer("H1-H3 heart rate"):
        out.update(rule_h(con, log, w, cfg, pd.Timestamp(export_date[:19])))
    with Timer("P1 swims"):
        rule_p1(con, w, log)
    keep_cols = ["workout_id", "activity_type", "type", "family", "setting", "source_name", "source_version", "device_class", "device_name",
                 "device_model", "device_hardware", "device_software", "start_utc", "end_utc", "start_local", "end_local", "local_date",
                 "tz", "tz_source", "duration_s", "elapsed_s", "moving_s", "distance_m", "distance_source", "total_distance_m",
                 "gps_distance_m", "distance_ratio", "total_energy_kcal", "indoor_flag", "has_route", "route_file", "n_hr", "dup_of",
                 "is_fragment", "temp_health_c", "humidity_health", "climb_watch_m", "climb_gps_m", "descent_gps_m", "avg_mets",
                 "lap_length_m", "swim_location", "user_entered", "n_raw", "n_clean", "n_pauses", "n_signal_loss", "gps_pause_s",
                 "g4_cut", "g4_removed_share", "g4_max_mph", "g3_start_s", "g3_end_s", "ele_valid_share", "start_lat", "start_lon",
                 "open_pause_end", "n_jumps", "n_vehicle_breaks", "gps_coverage", "partial_track", "title"]
    wc = w[keep_cols].copy()
    con.register("wc_df", wc)
    con.execute("CREATE OR REPLACE TABLE workouts_all_clean AS SELECT * FROM wc_df ORDER BY start_utc, workout_id")
    con.execute("CREATE OR REPLACE TABLE workouts_clean AS SELECT * FROM workouts_all_clean WHERE dup_of IS NULL ORDER BY start_utc, workout_id")
    con.execute("CREATE OR REPLACE TABLE params AS SELECT * FROM (VALUES ('hr_max', ?), ('hr_max_source', ?), ('export_date', ?)) t(k, v)",
                [str(out["hr_max"]), out["hr_max_source"], export_date])
    lg = log.df()
    con.register("log_df", lg)
    con.execute("CREATE OR REPLACE TABLE cleaning_log AS SELECT * FROM log_df ORDER BY rule_id, table_name, row_key, field")
    out["log_counts"] = lg.groupby("rule_id").size().to_dict()
    out["workouts_clean"] = int(wc.dup_of.isna().sum())
    con.close()
    paths.write_json(paths.DATA / "clean_log.json", out)
    return out


def main() -> None:
    print(json.dumps(run(), indent=1, default=str))


if __name__ == "__main__":
    main()
