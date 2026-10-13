"""Phase 1: load export.xml and the GPX routes into DuckDB.

Tables: quantity_samples, category_samples, workouts, workout_metadata,
workout_events, workout_stats, routes, route_points, activity_summaries,
devices, sensor_availability, parse_log.

Every table is merged by its natural key, so a new export adds new rows and
replaces changed ones without duplicating, and rows that a later export no
longer contains are kept. Running parse twice on the same export is a no-op.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
from lxml import etree

from . import paths
from .inventory import parse_device
from .paths import Timer, norm
from .units import parse_num_unit, sql_case, to_si
from .xmlstream import iter_top

CHUNK = 400_000
VACC_INVALID = 0.0  # vAcc below this means the GPX elevation is a placeholder

REC_COLS = ["type", "source_name", "source_version", "dev_id", "unit", "creation", "start", "end_", "value", "meta"]

ACTIVITY_MAP = {
    "Walking": "walk", "Running": "run", "Hiking": "hike", "Cycling": "ride", "Swimming": "swim",
    "TraditionalStrengthTraining": "strength", "FunctionalStrengthTraining": "strength",
    "HighIntensityIntervalTraining": "hiit", "CrossTraining": "cross", "MixedMetabolicCardioTraining": "cross",
    "Stairs": "stairs", "StairClimbing": "stairs", "PreparationAndRecovery": "recovery",
}

KEYS = {
    "quantity_samples": ["type", "source_name", "device_class", "start_utc", "end_utc", "value"],
    "category_samples": ["type", "source_name", "device_class", "start_utc", "end_utc", "value"],
    "workouts": ["workout_id"],
    "activity_summaries": ["date"],
}


def parse_ts(s: str | None):
    if not s:
        return None, None
    dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
    off = int(dt.utcoffset().total_seconds() // 60)
    return dt.astimezone(timezone.utc).replace(tzinfo=None), off


def workout_key(activity_type: str, source_name: str, start_utc: datetime, end_utc: datetime) -> str:
    raw = f"{activity_type}|{source_name}|{start_utc.isoformat()}|{end_utc.isoformat()}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def fingerprint(xml: Path) -> str:
    st = xml.stat()
    h = hashlib.sha1(f"{st.st_size}".encode())
    with open(xml, "rb") as f:
        h.update(f.read(4 << 20))
        f.seek(max(0, st.st_size - (4 << 20)))
        h.update(f.read())
    return h.hexdigest()


# ------------------------------------------------------------------ records
class DeviceIndex:
    def __init__(self):
        self.ids: dict[str, int] = {}
        self.rows: list[dict] = []

    def get(self, dev: str | None) -> int:
        if not dev:
            return -1
        key = dev.split(">", 1)[1] if ">" in dev else dev
        i = self.ids.get(key)
        if i is None:
            i = len(self.rows)
            self.ids[key] = i
            d = parse_device(dev)
            self.rows.append({"dev_id": i, "name": d.get("name"), "manufacturer": d.get("manufacturer"), "model": d.get("model"),
                              "hardware": d.get("hardware"), "software": d.get("software")})
        return i


def _flush(con, buf: dict[str, list], first: bool) -> None:
    tbl = pa.table({k: pa.array(buf[k], type=pa.int32() if k == "dev_id" else pa.string()) for k in REC_COLS})
    con.register("chunk", tbl)
    if first:
        con.execute("CREATE OR REPLACE TEMP TABLE stage_records AS SELECT * FROM chunk")
    else:
        con.execute("INSERT INTO stage_records SELECT * FROM chunk")
    con.unregister("chunk")
    for k in REC_COLS:
        buf[k].clear()


def _workout_from_elem(el, devs: DeviceIndex) -> dict:
    g = el.get
    at_raw = g("workoutActivityType") or ""
    at = at_raw.replace("HKWorkoutActivityType", "")
    src = norm(g("sourceName"))
    start, off = parse_ts(g("startDate"))
    end, _ = parse_ts(g("endDate"))
    creation, _ = parse_ts(g("creationDate"))
    wid = workout_key(at_raw, src, start, end)
    dev_id = devs.get(g("device"))
    dur, dunit = float(g("duration") or "nan"), g("durationUnit")
    dur_s, _ = to_si(dur, dunit)
    w = {
        "workout_id": wid, "activity_type": at, "type": ACTIVITY_MAP.get(at, "other"), "source_name": src,
        "source_version": g("sourceVersion"), "dev_id": dev_id, "start_utc": start, "end_utc": end,
        "creation_utc": creation, "tz_offset_min": off, "duration_s": dur_s,
        "total_distance_m": None, "total_energy_kcal": None,
    }
    if g("totalDistance") is not None:
        w["total_distance_m"] = to_si(float(g("totalDistance")), g("totalDistanceUnit"))[0]
    if g("totalEnergyBurned") is not None:
        w["total_energy_kcal"] = to_si(float(g("totalEnergyBurned")), g("totalEnergyBurnedUnit"))[0]
    meta, events, stats, routes, conflicts = {}, [], [], [], []
    for ch in el:
        t = ch.tag
        if t == "MetadataEntry":
            k, v = norm(ch.get("key")), ch.get("value")
            if k in meta:
                if meta[k] != v:
                    conflicts.append((k, meta[k], v))
            else:
                meta[k] = v
        elif t == "WorkoutEvent":
            d, _ = parse_ts(ch.get("date"))
            du = ch.get("duration")
            ds = to_si(float(du), ch.get("durationUnit"))[0] if du is not None else None
            em = {}
            for m in ch:
                if m.tag == "MetadataEntry":
                    em.setdefault(norm(m.get("key")), m.get("value"))
            events.append({"workout_id": wid, "type": (ch.get("type") or "").replace("HKWorkoutEventType", ""), "date_utc": d,
                           "duration_s": ds, "meta": json.dumps(em, sort_keys=True) if em else None})
        elif t == "WorkoutStatistics":
            s0, _ = parse_ts(ch.get("startDate"))
            s1, _ = parse_ts(ch.get("endDate"))
            u = ch.get("unit")
            row = {"workout_id": wid, "type": (ch.get("type") or "").replace("HKQuantityTypeIdentifier", ""), "start_utc": s0, "end_utc": s1, "unit": u}
            for a in ("average", "minimum", "maximum", "sum"):
                v = ch.get(a)
                row[a] = float(v) if v is not None else None
                row[a + "_si"] = to_si(row[a], u)[0] if v is not None else None
            row["unit_si"] = to_si(1.0, u)[1]
            stats.append(row)
        elif t == "WorkoutRoute":
            rm = {}
            refs = []
            for m in ch:
                if m.tag == "MetadataEntry":
                    rm.setdefault(norm(m.get("key")), m.get("value"))
                elif m.tag == "FileReference":
                    refs.append(m.get("path"))
            r0, _ = parse_ts(ch.get("startDate"))
            r1, _ = parse_ts(ch.get("endDate"))
            rc, _ = parse_ts(ch.get("creationDate"))
            for p in refs or [None]:
                routes.append({"workout_id": wid, "file": Path(p).name if p else None, "source_name": norm(ch.get("sourceName")),
                               "source_version": ch.get("sourceVersion"), "start_utc": r0, "end_utc": r1, "creation_utc": rc,
                               "meta": json.dumps(rm, sort_keys=True) if rm else None})
    md = []
    for k, v in meta.items():
        num, unit = parse_num_unit(v)
        si, siu = to_si(num, unit) if num is not None else (None, None)
        md.append({"workout_id": wid, "key": k, "value": v, "value_num": num, "unit": unit, "value_si": si, "unit_si": siu})
    ind = meta.get("HKIndoorWorkout")
    w["indoor_flag"] = None if ind is None else ind == "1"
    w["hk_timezone"] = meta.get("HKTimeZone")
    w["meta_conflicts"] = json.dumps(conflicts) if conflicts else None
    for s in stats:  # newer exports: totals from statistics
        if s["type"] in ("DistanceWalkingRunning", "DistanceCycling", "DistanceSwimming") and s["sum_si"] is not None and w["total_distance_m"] is None:
            w["total_distance_m"] = s["sum_si"]
        if s["type"] == "ActiveEnergyBurned" and s["sum_si"] is not None and w["total_energy_kcal"] is None:
            w["total_energy_kcal"] = s["sum_si"]
    return {"w": w, "meta": md, "events": events, "stats": stats, "routes": routes}


def stream_export(con, xml: Path) -> dict:
    devs = DeviceIndex()
    buf = {k: [] for k in REC_COLS}
    first = True
    n_rec = 0
    W, M, E, S, R, A = [], [], [], [], [], []
    t0 = time.time()
    export_date = None
    for el in iter_top(xml):
        tag = el.tag
        if tag == "Record":
            g = el.get
            buf["type"].append(g("type"))
            buf["source_name"].append(norm(g("sourceName")))
            buf["source_version"].append(g("sourceVersion"))
            buf["dev_id"].append(devs.get(g("device")))
            buf["unit"].append(g("unit"))
            buf["creation"].append(g("creationDate"))
            buf["start"].append(g("startDate"))
            buf["end_"].append(g("endDate"))
            buf["value"].append(g("value"))
            meta = None
            if len(el):
                md = {}
                for ch in el:
                    if ch.tag == "MetadataEntry":
                        md.setdefault(norm(ch.get("key")), ch.get("value"))
                    elif ch.tag == "HeartRateVariabilityMetadataList":
                        md["_beats"] = str(len(ch))
                if md:
                    meta = json.dumps(md, sort_keys=True)
            buf["meta"].append(meta)
            n_rec += 1
            if len(buf["type"]) >= CHUNK:
                _flush(con, buf, first)
                first = False
                print(f"  {n_rec:,} records, {time.time() - t0:.0f}s", flush=True)
        elif tag == "Workout":
            o = _workout_from_elem(el, devs)
            W.append(o["w"]); M += o["meta"]; E += o["events"]; S += o["stats"]; R += o["routes"]
        elif tag == "ActivitySummary":
            g = el.get
            row = {"date": g("dateComponents"), "unit": g("activeEnergyBurnedUnit")}
            for a, b in [("active_kcal", "activeEnergyBurned"), ("active_goal_kcal", "activeEnergyBurnedGoal"), ("move_min", "appleMoveTime"),
                         ("move_goal_min", "appleMoveTimeGoal"), ("exercise_min", "appleExerciseTime"), ("exercise_goal_min", "appleExerciseTimeGoal"),
                         ("stand_hours", "appleStandHours"), ("stand_goal_hours", "appleStandHoursGoal")]:
                v = g(b)
                row[a] = float(v) if v is not None else None
            A.append(row)
        elif tag == "ExportDate":
            export_date = el.get("value")
    if buf["type"]:
        _flush(con, buf, first)
    print(f"  {n_rec:,} records, {len(W):,} workouts streamed in {time.time() - t0:.0f}s", flush=True)
    return {"devs": devs.rows, "workouts": W, "meta": M, "events": E, "stats": S, "routes": R, "summaries": A,
            "n_records": n_rec, "export_date": export_date}


# ------------------------------------------------------------------ GPX
GPX_NS = "{http://www.topografix.com/GPX/1/1}"


def parse_gpx(path: str) -> dict:
    tree = etree.parse(path, etree.XMLParser(huge_tree=True, resolve_entities=False, no_network=True))
    lat, lon, ele, tm, spd, crs, hacc, vacc = [], [], [], [], [], [], [], []
    nan = float("nan")

    def fnum(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return nan

    for pt in tree.iter(GPX_NS + "trkpt", "trkpt"):
        lat.append(float(pt.get("lat")))
        lon.append(float(pt.get("lon")))
        e = t = s = c = h = v = None
        for ch in pt:
            tag = ch.tag.rsplit("}", 1)[-1]
            if tag == "ele":
                e = ch.text
            elif tag == "time":
                t = ch.text
            elif tag == "extensions":
                for x in ch:
                    xt = x.tag.rsplit("}", 1)[-1]
                    if xt == "speed":
                        s = x.text
                    elif xt == "course":
                        c = x.text
                    elif xt == "hAcc":
                        h = x.text
                    elif xt == "vAcc":
                        v = x.text
        ele.append(fnum(e)); spd.append(fnum(s)); crs.append(fnum(c)); hacc.append(fnum(h)); vacc.append(fnum(v))
        tm.append((t or "").rstrip("Z"))
    ts = np.array(tm, dtype="datetime64[ms]") if tm else np.array([], dtype="datetime64[ms]")
    ele_a = np.array(ele, dtype=np.float64)
    vacc_a = np.array(vacc, dtype=np.float64)
    ele_a[(vacc_a < VACC_INVALID)] = np.nan
    return {"file": Path(path).name, "lat": np.array(lat), "lon": np.array(lon), "ele": ele_a, "t": ts,
            "speed": np.array(spd), "course": np.array(crs), "hacc": np.array(hacc), "vacc": vacc_a}


def load_gpx(con, rdir: Path, routes: pd.DataFrame) -> pd.DataFrame:
    files = sorted(str(p) for p in rdir.glob("*.gpx"))
    by_file = {}
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 4) - 1)) as ex:
        for r in ex.map(parse_gpx, files, chunksize=16):
            by_file[r["file"]] = r
    ref = dict(zip(routes["file"], routes["workout_id"])) if len(routes) else {}
    # fallback: unreferenced GPX matched by time overlap with a workout (route span inside workout span +/- 2 min)
    unref = sorted(set(by_file) - set(ref))
    matched = []
    if unref:
        ws = con.execute("SELECT workout_id, start_utc, end_utc FROM stage_workouts").df()
        for f in unref:
            r = by_file[f]
            if not len(r["t"]):
                continue
            a, b = pd.Timestamp(r["t"][0]), pd.Timestamp(r["t"][-1])
            hit = ws[(ws.start_utc - pd.Timedelta(minutes=2) <= a) & (ws.end_utc + pd.Timedelta(minutes=2) >= b)]
            if len(hit) == 1:
                ref[f] = hit.workout_id.iloc[0]
                matched.append({"workout_id": ref[f], "file": f, "source_name": None, "source_version": None,
                                "start_utc": a.to_pydatetime(), "end_utc": b.to_pydatetime(), "creation_utc": None, "meta": json.dumps({"_matched": "time_overlap"})})
    parts = []
    stats = []
    # a workout can reference several consecutive GPX files: number points continuously, in time order
    per_w: dict[str, list] = {}
    for f, r in by_file.items():
        wid = ref.get(f)
        if wid is None:
            continue
        stats.append({"file": f, "n_points": len(r["lat"]), "ele_valid": int(np.isfinite(r["ele"]).sum())})
        if len(r["lat"]):
            per_w.setdefault(wid, []).append(r)
    for wid in sorted(per_w):
        off = 0
        for segi, r in enumerate(sorted(per_w[wid], key=lambda r: (r["t"][0], r["file"]))):
            n = len(r["lat"])
            parts.append(pa.table({
            "workout_id": pa.array([wid] * n, pa.string()), "seq": pa.array(np.arange(off, off + n, dtype=np.int32)),
            "segment": pa.array(np.full(n, segi, dtype=np.int8)),
            "t_utc": pa.array(r["t"]), "lat": pa.array(r["lat"]), "lon": pa.array(r["lon"]),
            "ele_m": pa.array(r["ele"], from_pandas=True), "speed_ms": pa.array(r["speed"], from_pandas=True),
            "course": pa.array(r["course"], from_pandas=True), "hacc_m": pa.array(r["hacc"], from_pandas=True),
            "vacc_m": pa.array(r["vacc"], from_pandas=True),
            }))
            off += n
    big = pa.concat_tables(parts) if parts else None
    if big is not None:
        con.register("rp", big)
        con.execute("CREATE OR REPLACE TEMP TABLE stage_route_points AS SELECT * FROM rp")
        con.unregister("rp")
    st = pd.DataFrame(stats)
    return st, pd.DataFrame(matched)


# ------------------------------------------------------------------ merge
def table_exists(con, name: str) -> bool:
    return bool(con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ? AND table_schema='main'", [name]).fetchone()[0])


def merge(con, target: str, stage: str, keys: list[str], order: list[str] | None = None) -> dict:
    """Upsert stage into target by natural key: stage rows replace matching target rows, other target rows survive."""
    order = order or keys
    ob = ", ".join(order)
    n_stage = con.execute(f"SELECT count(*) FROM {stage}").fetchone()[0]
    if not table_exists(con, target):
        con.execute(f"CREATE TABLE {target} AS SELECT * FROM {stage} ORDER BY {ob}")
        return {"table": target, "stage": n_stage, "kept_old": 0, "total": n_stage}
    using = ", ".join(keys)
    kept = con.execute(f"SELECT count(*) FROM {target} t ANTI JOIN {stage} s USING ({using})").fetchone()[0]
    con.execute(f"""CREATE OR REPLACE TABLE {target}__new AS
        SELECT * FROM (SELECT t.* FROM {target} t ANTI JOIN {stage} s USING ({using})
                       UNION ALL BY NAME SELECT * FROM {stage}) ORDER BY {ob}""")
    con.execute(f"DROP TABLE {target}")
    con.execute(f"ALTER TABLE {target}__new RENAME TO {target}")
    return {"table": target, "stage": n_stage, "kept_old": kept, "total": n_stage + kept}


def replace_children(con, target: str, stage: str, order: str) -> dict:
    """Child tables are replaced per workout_id present in the stage."""
    n_stage = con.execute(f"SELECT count(*) FROM {stage}").fetchone()[0]
    if not table_exists(con, target):
        con.execute(f"CREATE TABLE {target} AS SELECT * FROM {stage} ORDER BY {order}")
        return {"table": target, "stage": n_stage, "kept_old": 0, "total": n_stage}
    kept = con.execute(f"SELECT count(*) FROM {target} WHERE workout_id NOT IN (SELECT DISTINCT workout_id FROM {stage})").fetchone()[0]
    con.execute(f"""CREATE OR REPLACE TABLE {target}__new AS SELECT * FROM (
        SELECT * FROM {target} WHERE workout_id NOT IN (SELECT DISTINCT workout_id FROM {stage})
        UNION ALL BY NAME SELECT * FROM {stage}) ORDER BY {order}""")
    con.execute(f"DROP TABLE {target}")
    con.execute(f"ALTER TABLE {target}__new RENAME TO {target}")
    return {"table": target, "stage": n_stage, "kept_old": kept, "total": n_stage + kept}


DEVICE_CLASS_SQL = """CASE
    WHEN lower(coalesce(d.model,'')) LIKE '%watch%' THEN 'watch'
    WHEN lower(coalesce(d.model,'')) LIKE '%iphone%' OR lower(coalesce(d.model,'')) LIKE '%ipod%' THEN 'phone'
    WHEN d.dev_id IS NOT NULL THEN 'other'
    WHEN lower({src}) LIKE '%watch%' THEN 'watch'
    WHEN lower({src}) LIKE '%iphone%' OR lower({src}) LIKE '%phone%' THEN 'phone'
    ELSE 'other' END"""


def build_samples(con) -> dict:
    v_si, u_si = sql_case("value_d", "unit")
    ts = lambda c: f"(strptime({c}, '%Y-%m-%d %H:%M:%S %z'))::TIMESTAMP"
    off = "(CASE WHEN substr(start, 21, 1) = '-' THEN -1 ELSE 1 END) * (CAST(substr(start, 22, 2) AS INT) * 60 + CAST(substr(start, 24, 2) AS INT))"
    con.execute(f"""CREATE OR REPLACE TEMP TABLE stage_all AS
        SELECT r.type, r.source_name, r.source_version,
               {DEVICE_CLASS_SQL.format(src='r.source_name')} AS device_class,
               d.name AS device_name, d.model AS device_model, d.hardware AS device_hardware, d.software AS device_software,
               r.unit, r.value AS value_raw, TRY_CAST(r.value AS DOUBLE) AS value_d,
               {ts('r.start')} AS start_utc, {ts('r.end_')} AS end_utc, {ts('r.creation')} AS creation_utc,
               CAST({off.replace('start', 'r.start')} AS SMALLINT) AS tz_offset_min, r.meta
        FROM stage_records r LEFT JOIN stage_devices d ON r.dev_id = d.dev_id""")
    n_all = con.execute("SELECT count(*) FROM stage_all").fetchone()[0]
    # quantity: numeric values on non-category types
    con.execute(f"""CREATE OR REPLACE TEMP TABLE stage_q AS
        SELECT DISTINCT ON (type, source_name, device_class, start_utc, end_utc, value_d)
               type, source_name, source_version, device_class, device_name, device_model, device_hardware, device_software,
               unit, value_d AS value, {v_si} AS value_si, {u_si} AS unit_si, start_utc, end_utc, creation_utc, tz_offset_min, meta
        FROM stage_all
        WHERE NOT starts_with(type, 'HKCategoryTypeIdentifier') AND value_d IS NOT NULL
        ORDER BY type, source_name, device_class, start_utc, end_utc, value_d, creation_utc DESC""")
    con.execute("""CREATE OR REPLACE TEMP TABLE stage_c AS
        SELECT DISTINCT ON (type, source_name, device_class, start_utc, end_utc, value_raw)
               type, source_name, source_version, device_class, device_name, device_model, device_hardware, device_software,
               unit, value_raw AS value, start_utc, end_utc, creation_utc, tz_offset_min, meta
        FROM stage_all
        WHERE starts_with(type, 'HKCategoryTypeIdentifier') OR value_d IS NULL
        ORDER BY type, source_name, device_class, start_utc, end_utc, value_raw, creation_utc DESC""")
    nq = con.execute("SELECT count(*) FROM stage_q").fetchone()[0]
    nc = con.execute("SELECT count(*) FROM stage_c").fetchone()[0]
    return {"stage_records": n_all, "quantity_unique": nq, "category_unique": nc, "natural_key_duplicates": n_all - nq - nc}


def run(force: bool = False, xml: Path | None = None) -> dict:
    xml = xml or paths.export_xml()
    con = paths.connect()
    con.execute("CREATE TABLE IF NOT EXISTS _meta (k VARCHAR PRIMARY KEY, v VARCHAR)")
    fp = fingerprint(xml)
    prev = con.execute("SELECT v FROM _meta WHERE k='export_fingerprint'").fetchone()
    if prev and prev[0] == fp and not force and table_exists(con, "route_points"):
        print("parse: export unchanged since last run; nothing to do")
        con.close()
        return {"skipped": True}
    log = {"export": str(xml), "fingerprint": fp, "started": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    with Timer("stream export.xml"):
        S = stream_export(con, xml)
    log["records_streamed"] = S["n_records"]
    log["export_date"] = S["export_date"]
    con.register("devs_df", pd.DataFrame(S["devs"], columns=["dev_id", "name", "manufacturer", "model", "hardware", "software"]))
    con.execute("CREATE OR REPLACE TEMP TABLE stage_devices AS SELECT * FROM devs_df")
    with Timer("samples"):
        log.update(build_samples(con))
        log["merge_quantity"] = merge(con, "quantity_samples", "stage_q", KEYS["quantity_samples"])
        log["merge_category"] = merge(con, "category_samples", "stage_c", KEYS["category_samples"])
    with Timer("workouts"):
        wdf = pd.DataFrame(S["workouts"])
        con.register("w_df", wdf)
        con.execute(f"""CREATE OR REPLACE TEMP TABLE stage_workouts AS
            SELECT w.workout_id, w.activity_type, w.type, w.source_name, w.source_version,
                   {DEVICE_CLASS_SQL.format(src='w.source_name')} AS device_class,
                   d.name AS device_name, d.model AS device_model, d.hardware AS device_hardware, d.software AS device_software,
                   w.start_utc, w.end_utc, w.creation_utc, CAST(w.tz_offset_min AS SMALLINT) AS tz_offset_min, w.duration_s,
                   w.total_distance_m, w.total_energy_kcal, w.indoor_flag, w.hk_timezone, w.meta_conflicts
            FROM w_df w LEFT JOIN stage_devices d ON w.dev_id = d.dev_id""")
        dups = con.execute("SELECT count(*) - count(DISTINCT workout_id) FROM stage_workouts").fetchone()[0]
        con.execute("CREATE OR REPLACE TEMP TABLE stage_workouts2 AS SELECT DISTINCT ON (workout_id) * FROM stage_workouts ORDER BY workout_id, creation_utc DESC")
        log["workout_natural_key_duplicates"] = dups
        log["merge_workouts"] = merge(con, "workouts", "stage_workouts2", ["workout_id"], ["start_utc", "workout_id"])
        for name, rows, cols, order in [
            ("workout_metadata", S["meta"], ["workout_id", "key", "value", "value_num", "unit", "value_si", "unit_si"], "workout_id, key"),
            ("workout_events", S["events"], ["workout_id", "type", "date_utc", "duration_s", "meta"], "workout_id, date_utc, type"),
            ("workout_stats", S["stats"], ["workout_id", "type", "start_utc", "end_utc", "unit", "average", "minimum", "maximum", "sum",
                                           "average_si", "minimum_si", "maximum_si", "sum_si", "unit_si"], "workout_id, type"),
            ("routes", S["routes"], ["workout_id", "file", "source_name", "source_version", "start_utc", "end_utc", "creation_utc", "meta"], "workout_id, file"),
        ]:
            df = pd.DataFrame(rows, columns=cols)
            # duplicate workouts (same natural key) repeat their children; keep one copy
            if name == "workout_metadata":
                df = df.drop_duplicates(["workout_id", "key"])
            elif name == "workout_stats":
                df = df.drop_duplicates(["workout_id", "type", "start_utc", "end_utc"])
            elif name == "routes":
                df = df.drop_duplicates(["workout_id", "file"])
            if name == "workout_events":
                df = df.drop_duplicates(["workout_id", "type", "date_utc", "duration_s"])
                df["seq"] = df.sort_values(["workout_id", "date_utc"]).groupby("workout_id").cumcount()
            con.register("x_df", df)
            con.execute(f"CREATE OR REPLACE TEMP TABLE stage_{name} AS SELECT * FROM x_df")
            con.unregister("x_df")
    with Timer("gpx"):
        rdf = con.execute("SELECT * FROM stage_routes").df()
        gstats, matched = load_gpx(con, xml.parent / "workout-routes", rdf)
        if len(matched):
            con.register("m_df", matched)
            # a matched file replaces the reference-less WorkoutRoute row of the same workout
            con.execute("DELETE FROM stage_routes WHERE file IS NULL AND workout_id IN (SELECT workout_id FROM m_df)")
            con.execute("INSERT INTO stage_routes SELECT * FROM m_df")
        con.register("g_df", gstats)
        con.execute("""CREATE OR REPLACE TEMP TABLE stage_routes2 AS
            SELECT r.*, g.n_points, g.ele_valid FROM stage_routes r LEFT JOIN g_df g USING (file)""")
        log["gpx_matched_by_time"] = len(matched)
        for name, stage, order in [("workout_metadata", "stage_workout_metadata", "workout_id, key"),
                                   ("workout_events", "stage_workout_events", "workout_id, seq"),
                                   ("workout_stats", "stage_workout_stats", "workout_id, type"),
                                   ("routes", "stage_routes2", "workout_id, file"),
                                   ("route_points", "stage_route_points", "workout_id, seq")]:
            log["merge_" + name] = replace_children(con, name, stage, order)
    with Timer("summaries, devices, sensors"):
        con.register("a_df", pd.DataFrame(S["summaries"]))
        con.execute("CREATE OR REPLACE TEMP TABLE stage_as AS SELECT DISTINCT ON (date) CAST(date AS DATE) AS date, * EXCLUDE (date) FROM a_df ORDER BY date")
        log["merge_activity_summaries"] = merge(con, "activity_summaries", "stage_as", ["date"])
        build_devices(con)
        build_sensor_availability(con)
    log["finished"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    con.execute("CREATE TABLE IF NOT EXISTS parse_log (run_at VARCHAR, log VARCHAR)")
    con.execute("DELETE FROM parse_log WHERE run_at = ?", [log["started"]])
    con.execute("INSERT INTO parse_log VALUES (?, ?)", [log["started"], json.dumps(log, default=str)])
    con.execute("INSERT OR REPLACE INTO _meta VALUES ('export_fingerprint', ?)", [fp])
    con.execute("INSERT OR REPLACE INTO _meta VALUES ('export_date', ?)", [S["export_date"]])
    con.close()
    paths.write_json(paths.DATA / "parse_log.json", log)
    return log


def build_devices(con) -> None:
    con.execute("""CREATE OR REPLACE TABLE devices AS
        WITH s AS (
          SELECT device_class, source_name, device_name, device_model, device_hardware, device_software, source_version, start_utc FROM quantity_samples
          UNION ALL SELECT device_class, source_name, device_name, device_model, device_hardware, device_software, source_version, start_utc FROM category_samples
          UNION ALL SELECT device_class, source_name, device_name, device_model, device_hardware, device_software, source_version, start_utc FROM workouts)
        SELECT device_class, source_name, device_name, device_model, device_hardware,
               min(start_utc) AS first_utc, max(start_utc) AS last_utc, count(*) AS n_rows,
               list(DISTINCT device_software ORDER BY device_software) FILTER (WHERE device_software IS NOT NULL) AS software_versions,
               list(DISTINCT source_version ORDER BY source_version) FILTER (WHERE source_version IS NOT NULL) AS source_versions
        FROM s GROUP BY ALL ORDER BY first_utc, source_name, device_hardware NULLS LAST""")


def build_sensor_availability(con) -> None:
    """First and last date each metric appears per device class, plus workout-level capabilities."""
    con.execute("CREATE TABLE IF NOT EXISTS workout_hr_file (workout_id VARCHAR, t_utc TIMESTAMP, bpm DOUBLE)")
    con.execute("""CREATE OR REPLACE TABLE sensor_availability AS
        SELECT replace(replace(type, 'HKQuantityTypeIdentifier', ''), 'HKCategoryTypeIdentifier', '') AS metric, device_class,
               min(start_utc) AS first_utc, max(start_utc) AS last_utc, count(*) AS n, 'record' AS kind
        FROM (SELECT type, device_class, start_utc FROM quantity_samples UNION ALL SELECT type, device_class, start_utc FROM category_samples)
        GROUP BY ALL
        UNION ALL
        SELECT 'GPSRoute', 'watch', min(w.start_utc), max(w.start_utc), count(*), 'workout'
        FROM workouts w JOIN routes r USING (workout_id) WHERE w.device_class = 'watch'
        UNION ALL
        SELECT 'GPSElevation', 'watch', min(w.start_utc), max(w.start_utc), count(*), 'workout'
        FROM workouts w JOIN routes r USING (workout_id) WHERE r.ele_valid > 0
        UNION ALL
        SELECT 'FileHeartRate', w.device_class, min(f.t_utc), max(f.t_utc), count(*), 'workout_file'
        FROM workout_hr_file f JOIN workouts w USING (workout_id) GROUP BY ALL
        UNION ALL
        SELECT replace(m.key, 'HK', ''), w.device_class, min(w.start_utc), max(w.start_utc), count(*), 'workout_metadata'
        FROM workout_metadata m JOIN workouts w USING (workout_id)
        WHERE m.key IN ('HKElevationAscended', 'HKWeatherTemperature', 'HKWeatherHumidity', 'HKAverageMETs', 'HKTimeZone')
        GROUP BY ALL
        ORDER BY first_utc""")


def main() -> None:
    import sys

    log = run(force="--force" in sys.argv)
    print(json.dumps({k: v for k, v in log.items() if k.startswith("merge") or "dup" in k or k.startswith("records")}, indent=1, default=str))


if __name__ == "__main__":
    main()
