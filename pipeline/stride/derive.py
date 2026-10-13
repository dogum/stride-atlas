"""Phase 4: everything in docs/METRICS.md.

Tables: daily, workouts_final, splits, best_efforts, loops, loop_laps, new_ground,
records, streaks, wx_model_temp, wx_model_year, places.
"""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd

from . import paths
from .geo import MI, haversine, local_xy
from .metrics import (best_effort, buffered_overlap, cells_along, dilate, eddington, fitness_model, gap_speed,
                      longest_streak, loop_label, signed_area, trimp_samples)
from .paths import Timer
from .track import climb_hysteresis

HR = "HKQuantityTypeIdentifierHeartRate"
ON_FOOT = ("walk", "run", "hike")
BE = {
    "walk": [("1 mi", MI), ("2 mi", 2 * MI), ("5K", 5000.0), ("5 mi", 5 * MI), ("10K", 10000.0), ("10 mi", 10 * MI), ("Half", 21097.5)],
    "run": [("1 mi", MI), ("5K", 5000.0), ("10K", 10000.0), ("10 mi", 10 * MI), ("Half", 21097.5), ("Marathon", 42195.0)],
    "ride": [("10 mi", 10 * MI), ("20 mi", 20 * MI), ("40 km", 40000.0)],
}


def _by_id(df: pd.DataFrame) -> pd.DataFrame:
    df = df.set_index("workout_id", drop=False)
    df.index.name = None
    return df


# ------------------------------------------------------------------ daily
def build_daily(con, export_date: str) -> pd.DataFrame:
    """One row per local day from the first sample to the export date (S2 local days, S3 nulls)."""
    con.execute("""CREATE OR REPLACE TEMP TABLE qloc AS
        SELECT q.type, q.device_class, q.value_si, q.value, q.start_utc, q.end_utc,
               CAST(timezone(s.tz, q.start_utc::TIMESTAMPTZ) AS DATE) AS d
        FROM quantity_samples_clean q ASOF JOIN tz_segments s ON q.start_utc >= s.from_utc
        WHERE q.type IN ('HKQuantityTypeIdentifierActiveEnergyBurned','HKQuantityTypeIdentifierAppleExerciseTime',
                         'HKQuantityTypeIdentifierRestingHeartRate','HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
                         'HKQuantityTypeIdentifierVO2Max','HKQuantityTypeIdentifierWalkingSpeed','HKQuantityTypeIdentifierWalkingStepLength',
                         'HKQuantityTypeIdentifierWalkingDoubleSupportPercentage','HKQuantityTypeIdentifierWalkingAsymmetryPercentage',
                         'HKQuantityTypeIdentifierTimeInDaylight','HKQuantityTypeIdentifierOxygenSaturation','HKQuantityTypeIdentifierRespiratoryRate',
                         'HKQuantityTypeIdentifierAppleSleepingWristTemperature','HKQuantityTypeIdentifierWalkingHeartRateAverage')""")
    q = lambda t: f"'HKQuantityTypeIdentifier{t}'"
    sql = f"""
    WITH pri AS (  -- additive energy/exercise: the watch wins for any day it wrote samples
        SELECT type, d, device_class, sum(value_si) AS v FROM qloc WHERE type IN ({q('ActiveEnergyBurned')}, {q('AppleExerciseTime')}) GROUP BY ALL),
    add_ AS (
        SELECT type, d, arg_min(v, CASE device_class WHEN 'watch' THEN 0 WHEN 'phone' THEN 1 ELSE 2 END) AS v FROM pri GROUP BY ALL),
    m AS (
        SELECT d,
          avg(value_si) FILTER (WHERE type = {q('RestingHeartRate')}) AS resting_hr,
          avg(value_si) FILTER (WHERE type = {q('HeartRateVariabilitySDNN')}) AS hrv_sdnn,
          arg_max(value_si, start_utc) FILTER (WHERE type = {q('VO2Max')}) AS vo2max,
          avg(value_si) FILTER (WHERE type = {q('WalkingSpeed')}) AS walk_speed_ms,
          avg(value_si) FILTER (WHERE type = {q('WalkingStepLength')}) AS step_length_m,
          avg(value_si) FILTER (WHERE type = {q('WalkingDoubleSupportPercentage')}) AS double_support,
          avg(value_si) FILTER (WHERE type = {q('WalkingAsymmetryPercentage')}) AS asymmetry,
          sum(value_si) FILTER (WHERE type = {q('TimeInDaylight')}) / 60 AS daylight_min,
          avg(value_si) FILTER (WHERE type = {q('OxygenSaturation')}) AS spo2,
          avg(value_si) FILTER (WHERE type = {q('RespiratoryRate')}) AS resp_rate,
          avg(value_si) FILTER (WHERE type = {q('AppleSleepingWristTemperature')}) AS wrist_temp_c,
          avg(value_si) FILTER (WHERE type = {q('WalkingHeartRateAverage')}) AS walking_hr
        FROM qloc GROUP BY d),
    dq AS (
        SELECT local_date AS d,
          max(v) FILTER (WHERE type = {q('StepCount')}) AS steps,
          max(v) FILTER (WHERE type = {q('DistanceWalkingRunning')}) AS distance_m,
          max(v) FILTER (WHERE type = {q('FlightsClimbed')}) AS flights,
          max(raw_sum) FILTER (WHERE type = {q('StepCount')}) AS steps_raw_sum
        FROM daily_quantities_clean GROUP BY 1),
    stand AS (
        SELECT CAST(timezone(s.tz, c.start_utc::TIMESTAMPTZ) AS DATE) AS d, count(*) FILTER (WHERE c.value LIKE '%Stood') AS stand_hours
        FROM category_samples c ASOF JOIN tz_segments s ON c.start_utc >= s.from_utc
        WHERE c.type = 'HKCategoryTypeIdentifierAppleStandHour' GROUP BY 1),
    spine AS (SELECT CAST(unnest(generate_series((SELECT min(d) FROM dq), DATE '{export_date[:10]}', INTERVAL 1 DAY)) AS DATE) AS d)
    SELECT spine.d AS date, dq.steps, dq.distance_m, dq.flights, dq.steps_raw_sum,
           (SELECT v FROM add_ WHERE add_.d = spine.d AND add_.type = {q('ActiveEnergyBurned')}) AS active_kcal,
           (SELECT v FROM add_ WHERE add_.d = spine.d AND add_.type = {q('AppleExerciseTime')}) / 60 AS exercise_min,
           stand.stand_hours, m.* EXCLUDE (d),
           a.active_kcal AS as_active_kcal, a.exercise_min AS as_exercise_min, a.stand_hours AS as_stand_hours
    FROM spine LEFT JOIN dq ON dq.d = spine.d LEFT JOIN m ON m.d = spine.d LEFT JOIN stand ON stand.d = spine.d
    LEFT JOIN activity_summaries a ON a.date = spine.d
    ORDER BY 1"""
    return con.execute(sql).df()


# ------------------------------------------------------------------ per-workout
def file_era_hr_max(con) -> dict | None:
    """HRmax for workouts whose heart rate came from an imported watch file (the Garmin years before the Apple
    Watch): the same 99.5th percentile rule, over that era's own hard efforts, so a younger heart is not scored
    against today's maximum."""
    r = con.execute("""SELECT quantile_cont(f.bpm, 0.995), count(*), min(w.local_date), max(w.local_date)
        FROM workout_hr_file f JOIN workouts_clean w USING (workout_id)
        WHERE w.device_class = 'watch' AND w.type IN ('run', 'ride', 'cross', 'hiit')""").fetchone()
    if not r or not r[1] or r[1] < 2000:
        return None
    return {"hr_max": round(float(r[0]), 1), "n": int(r[1]), "from": str(r[2]), "to": str(r[3])}


def workout_hr_metrics(con, w: pd.DataFrame, daily: pd.DataFrame, hr_max: float, era: dict | None = None) -> pd.DataFrame:
    """Average HR, zones and TRIMP per workout.

    Before 2025 the export holds only 3-8 heart-rate samples per walk (the watch's dense workout series
    is not in the export), so a 5-second sum would be about 5% of the real load. TRIMP therefore uses
    Banister's average-HR form for every workout (one method across all years); the 5-second sum is kept
    as trimp_stream. Zones split moving time by the share of samples in each zone.
    """
    hr5 = con.execute("SELECT workout_id, t_s, hr FROM workout_hr_5s ORDER BY workout_id, t_s").df()
    cov = hr5.groupby("workout_id").hr.apply(lambda s: float(s.notna().mean())).to_dict()
    # heart rate recorded inside an imported file (Strava) is that workout's only source; everything else uses the
    # Health samples inside the workout's window
    con.execute("CREATE TABLE IF NOT EXISTS workout_hr_file (workout_id VARCHAR, t_utc TIMESTAMP, bpm DOUBLE)")
    samples = con.execute(f"""SELECT w.workout_id, q.value FROM workouts_clean w JOIN quantity_samples_clean q
            ON q.type = '{HR}' AND q.start_utc BETWEEN w.start_utc AND w.end_utc
        WHERE w.workout_id NOT IN (SELECT DISTINCT workout_id FROM workout_hr_file)
        UNION ALL
        SELECT f.workout_id, f.bpm AS value FROM workout_hr_file f JOIN workouts_clean w USING (workout_id)
        ORDER BY 1""").df()
    from_file = set(con.execute("SELECT DISTINCT workout_id FROM workout_hr_file").df().workout_id)
    stats = dict(con.execute("SELECT workout_id, average FROM workout_stats WHERE type = 'HeartRate' AND average IS NOT NULL").fetchall())
    rhr = daily.set_index("date").resting_hr
    rhr30 = rhr.rolling(30, min_periods=1).median()
    zb = [0.6, 0.7, 0.8, 0.9]
    rows = []
    base_max = hr_max
    for wid, g in samples.groupby("workout_id", sort=True):
        x = g.value.to_numpy(dtype=float)
        if not len(x) or wid not in w.index:
            continue
        r_ = w.loc[wid]
        hr_max = era["hr_max"] if era and wid in from_file and r_["device_class"] == "watch" else base_max
        d = r_["local_date"]
        rest = rhr.get(d)
        if rest is None or not np.isfinite(rest):
            rest = rhr30.get(d, np.nan)
        if not np.isfinite(rest):
            rest = 60.0
        avg = float(stats.get(wid, x.mean()))
        mov = float(r_["moving_s"]) if pd.notna(r_["moving_s"]) else float(r_["duration_s"])
        pct = x / hr_max
        share = [np.mean(pct < zb[0]), np.mean((pct >= zb[0]) & (pct < zb[1])), np.mean((pct >= zb[1]) & (pct < zb[2])),
                 np.mean((pct >= zb[2]) & (pct < zb[3])), np.mean(pct >= zb[3])]
        rr = min(1.2, max(0.0, (avg - rest) / (hr_max - rest)))
        trimp = (mov / 60) * rr * 0.64 * math.exp(1.92 * rr)
        s5 = hr5.loc[hr5.workout_id == wid, "hr"].to_numpy(dtype=float) if cov.get(wid, 0) >= 0.8 else None
        # an on-foot workout averaging below resting heart rate is a sensor problem (loose band), not fitness
        suspect = r_["type"] in ON_FOOT and avg < rest + 15  # walking sits 24+ bpm above rest in every other workout
        if suspect:
            rows.append({"workout_id": wid, "avg_hr": None, "avg_hr_source": "withdrawn: below resting HR", "max_hr": None, "n_hr_samples": int(len(x)), "hr_max_used": hr_max,
                         "hr_rest_used": float(rest), "hr_suspect": True, "hr_coverage": float(cov.get(wid, 0.0))})
            continue
        rows.append({"workout_id": wid, "avg_hr": avg, "avg_hr_source": "file" if wid in from_file else "watch statistics" if wid in stats else "samples", "max_hr": float(x.max()), "hr_suspect": False, "hr_max_used": hr_max,
                     "n_hr_samples": int(len(x)), "hr_rest_used": float(rest), **{f"zone{i + 1}_s": float(share[i] * mov) for i in range(5)},
                     "trimp": trimp, "trimp_stream": trimp_samples(s5, 5 / 60, rest, hr_max) if s5 is not None else None,
                     "hr_coverage": float(cov.get(wid, 0.0))})
    return pd.DataFrame(rows)


def workout_steps(con) -> pd.DataFrame:
    return con.execute("""
        SELECT w.workout_id, sum(m.v * (least(epoch(w.end_utc), epoch(m.minute) + 60) - greatest(epoch(w.start_utc), epoch(m.minute))) / 60) AS steps
        FROM workouts_clean w JOIN minute_dedup m
          ON m.type = 'HKQuantityTypeIdentifierStepCount' AND m.minute >= date_trunc('minute', w.start_utc) AND m.minute < w.end_utc
        WHERE w.type IN ('walk','run','hike') GROUP BY 1""").df()


def track_metrics(con, w: pd.DataFrame, home, hr_streams: dict) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """max speed, max grade, GAP, splits, EF/decoupling, best efforts, max distance from home."""
    pts = con.execute("""SELECT workout_id, epoch(t_utc) AS t, lat, lon, cum_m, cum_moving_s, gap,
                                coalesce(ele_dem_m, ele_gps_smooth_m) AS ele, ele_dem_m, ele_gps_smooth_m AS ele_dev
                         FROM route_points_enriched ORDER BY workout_id, seq""").fetchnumpy()
    fl = lambda a: np.ma.filled(a.astype(float), np.nan) if np.ma.isMaskedArray(a) else a.astype(float)  # noqa: E731
    ele_all, dem_all, dev_all = fl(pts["ele"]), fl(pts["ele_dem_m"]), fl(pts["ele_dev"])
    wid = pts["workout_id"]
    u, f = np.unique(wid, return_index=True)
    bnd = dict(zip(u, zip(f, np.r_[f[1:], len(wid)])))
    rows, split_rows, be_rows = [], [], []
    for r in w[(w.setting == "outdoor")].itertuples():
        if r.workout_id not in bnd:
            continue
        a, b = bnd[r.workout_id]
        t, la, lo = pts["t"][a:b], pts["lat"][a:b], pts["lon"][a:b]
        cm, ct, gp, ele = pts["cum_m"][a:b], pts["cum_moving_s"][a:b], pts["gap"][a:b], ele_all[a:b]
        n = len(t)
        out = {"workout_id": r.workout_id}
        if n < 5 or cm[-1] <= 0:
            rows.append(out)
            continue
        bad = gp >= 2
        # 10-second speeds (moving clock); windows may not cross bad segments
        j = np.searchsorted(ct, ct + 10.0)
        ok = j < n
        ii = np.flatnonzero(ok)
        jj = j[ok]
        badc = np.cumsum(bad)
        clean_w = badc[jj] - badc[ii] == 0
        sp = (cm[jj] - cm[ii]) / np.maximum(ct[jj] - ct[ii], 1e-6)
        sp = sp[clean_w]
        out["max_speed_ms"] = float(np.percentile(sp, 95)) if len(sp) else None
        # 10 m resampling along distance
        cmm = np.maximum.accumulate(cm)
        keep = np.r_[True, np.diff(cmm) > 0]
        cmu, ctu = cmm[keep], ct[keep]
        grid = np.arange(0, cmu[-1], 10.0)
        if len(grid) > 2:
            td = np.interp(grid, cmu, ctu)
            okE = np.isfinite(ele[keep])
            if okE.mean() > 0.7:
                ed = np.interp(grid, cmu[okE], ele[keep][okE])
                # 50 m centred smoothing before grades
                k = 5
                eds = np.convolve(np.pad(ed, (k // 2, k // 2), mode="edge"), np.ones(k) / k, mode="valid")
                if len(eds) > 10:
                    g100 = (eds[10:] - eds[:-10]) / 100.0
                    # the steepest-stretch record must hold in both the terrain model and the watch's own (barometric)
                    # altitude: near cliffs a few metres of GPS error swings the DEM by tens of metres
                    dem_k, dev_k = dem_all[a:b][keep], dev_all[a:b][keep]
                    if np.isfinite(dem_k).mean() > 0.7 and np.isfinite(dev_k).mean() > 0.7:
                        both = []
                        for e_ in (dem_k, dev_k):
                            ok_ = np.isfinite(e_)
                            e2 = np.convolve(np.pad(np.interp(grid, cmu[ok_], e_[ok_]), (k // 2, k // 2), mode="edge"), np.ones(k) / k, mode="valid")
                            both.append((e2[10:] - e2[:-10]) / 100.0)
                        g100 = np.minimum(both[0], both[1])
                    # like the speeds, a 100 m window may not span a signal loss or jump: the elevations on either
                    # side of a gap are not 100 m apart
                    badk = np.cumsum(bad)[keep]
                    bg = badk[np.clip(np.searchsorted(cmu, grid, side="right") - 1, 0, len(cmu) - 1)]
                    okg = bg[10:] == bg[:-10]
                    if okg.any():
                        out["max_grade"] = float(np.max(g100[okg]))
                # grade-adjusted pace and split climbs read the watch's own (barometric) altitude when it has one,
                # smoothed over ~90 m; the DEM is the fallback. Steps that cross a signal loss or jump are skipped.
                kg = 9
                src_e = dev_all[a:b][keep] if np.isfinite(dev_all[a:b][keep]).mean() > 0.7 else ele[keep]
                okp = np.isfinite(src_e)
                prof = np.convolve(np.pad(np.interp(grid, cmu[okp], src_e[okp]), (kg // 2, kg // 2), mode="edge"), np.ones(kg) / kg, mode="valid")
                badk_ = np.cumsum(bad)[keep]
                bgs = badk_[np.clip(np.searchsorted(cmu, grid, side="right") - 1, 0, len(cmu) - 1)]
                dts = np.where(bgs[1:] == bgs[:-1], np.diff(td), np.nan)
                gs = gap_speed(10.0, dts, np.diff(prof) / 10.0, r.type == "run")
                if gs and r.type in ON_FOOT:
                    out["gap_pace_s_per_mi"] = MI / gs
            else:
                ed = prof = None
            # EF and decoupling: speed m/min over HR, first vs second half of moving time
            hs = hr_streams.get(r.workout_id)
            if hs is not None and r.moving_s and r.moving_s >= 1200:
                el = t - r.start_utc.timestamp()
                hr_pts = np.interp(el, hs[0], hs[1], left=np.nan, right=np.nan)
                half = ct[-1] / 2
                h1, h2 = ct <= half, ct > half
                d1 = cm[h1][-1] - cm[0] if h1.any() else 0
                d2 = cm[-1] - cm[h1][-1] if h1.any() else 0
                a1, a2 = np.nanmean(hr_pts[h1]) if h1.any() else np.nan, np.nanmean(hr_pts[h2]) if h2.any() else np.nan
                # steadiness: coefficient of variation of 1-minute speeds
                m1 = np.searchsorted(ct, np.arange(0, ct[-1], 60.0))
                spm = np.diff(cm[m1]) / 60.0
                cv = float(np.std(spm) / np.mean(spm)) if len(spm) > 3 and np.mean(spm) > 0 else None
                out["speed_cv"] = cv
                reliable = (r.avg_hr_source == "watch statistics") or (pd.notna(r.n_hr_samples) and r.n_hr_samples >= 5)
                if np.isfinite(a1) and np.isfinite(a2) and half > 0 and cv is not None and cv < 0.25 and reliable and pd.notna(r.avg_hr):
                    ef1, ef2 = (d1 / (half / 60)) / a1, (d2 / (half / 60)) / a2
                    out["ef"] = (r.distance_m / (r.moving_s / 60)) / r.avg_hr
                    out["decoupling"] = (ef1 - ef2) / ef1 if ef1 > 0 else None
            # splits per mile
            if r.type in ("walk", "run", "hike", "ride"):
                el = t - r.start_utc.timestamp()
                hr_pts = np.interp(el, hs[0], hs[1], left=np.nan, right=np.nan) if (hs := hr_streams.get(r.workout_id)) is not None else np.full(n, np.nan)
                total = cmu[-1]
                marks = np.r_[np.arange(0, total, MI), total]
                tm = np.interp(marks, cmu, ctu)
                for s in range(len(marks) - 1):
                    seg = (cm >= marks[s]) & (cm <= marks[s + 1])
                    length = marks[s + 1] - marks[s]
                    if length < 50:
                        continue
                    sec = tm[s + 1] - tm[s]
                    hr_seg = hr_pts[seg]
                    sg = up = down = None
                    if prof is not None:
                        gi = np.flatnonzero((grid >= marks[s]) & (grid <= marks[s + 1]))
                        if len(gi) > 2:
                            sg = gap_speed(10.0, dts[gi[:-1]], np.diff(prof[gi]) / 10.0, r.type == "run")
                            up, down = climb_hysteresis(prof[gi], 2.0)
                    elif np.isfinite(ele[seg]).sum() > 3:
                        up, down = climb_hysteresis(ele[seg], 2.0)
                    split_rows.append({"workout_id": r.workout_id, "split": s + 1, "length_m": float(length), "seconds": float(sec),
                                       "pace_s_per_mi": float(sec / (length / MI)) if length > 0 else None,
                                       "avg_hr": float(np.nanmean(hr_seg)) if np.isfinite(hr_seg).any() else None,
                                       "climb_m": up, "descent_m": down, "gap_pace_s_per_mi": (MI / sg) if sg else None, "partial": bool(length < MI - 1)})
                half_d = total / 2
                th = np.interp(half_d, cmu, ctu)
                out["split_delta_s"] = float((ctu[-1] - th) - th)
        # best efforts: distance counts only while moving (a paused workout with the GPS still running adds nothing)
        if r.type in BE and not r.is_fragment and not bool(r.partial_track) and not bool(r.g4_cut):
            dd, dtm = np.diff(cm), np.diff(ct)
            moving = dtm > 0
            dmov = np.r_[0.0, np.cumsum(np.where(moving, dd, 0.0))]
            bad_be = bad | np.r_[False, (~moving) & (dd > 5)]
            for label, D in BE[r.type]:
                res = best_effort(dmov, ct, D, bad_be)
                if res:
                    be_rows.append({"workout_id": r.workout_id, "type": r.type, "distance_label": label, "distance_m": D,
                                    "seconds": res[0], "start_offset_m": res[1], "date": r.local_date})
        # furthest from home for routes starting within 500 m of home
        if haversine(la[0], lo[0], home[0], home[1]) < 500:
            out["max_from_home_m"] = float(np.max(haversine(la, lo, home[0], home[1])))
        rows.append(out)
    return pd.DataFrame(rows), pd.DataFrame(split_rows), pd.DataFrame(be_rows)


# ------------------------------------------------------------------ loops
def find_loops(con, w: pd.DataFrame, cfg: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    lc = cfg["loops"]
    pts = con.execute("SELECT workout_id, lat, lon, cum_gps_m, gap FROM route_points_clean ORDER BY workout_id, seq").fetchnumpy()
    wid = pts["workout_id"]
    u, f = np.unique(wid, return_index=True)
    bnd = dict(zip(u, zip(f, np.r_[f[1:], len(wid)])))
    cand = w[(w.setting == "outdoor") & w.type.isin(ON_FOOT) & ~w.is_fragment & w.place_id.notna()].copy()
    centers = cand.groupby("place_id")[["start_lat", "start_lon"]].median()
    cand = cand[[haversine(r.start_lat, r.start_lon, *centers.loc[r.place_id]) < 500 for r in cand.itertuples()]]
    recs = []
    for r in cand.itertuples():
        if r.workout_id not in bnd:
            continue
        a, b = bnd[r.workout_id]
        c = centers.loc[r.place_id]
        x, y = local_xy(pts["lat"][a:b], pts["lon"][a:b], c.start_lat, c.start_lon)
        cum = pts["cum_gps_m"][a:b]
        if len(x) < 10 or cum[-1] < 200:
            continue
        cells = cells_along(x, y, cum, 10.0, float(lc["grid_m"]))
        recs.append({"workout_id": r.workout_id, "type": r.type, "place_id": r.place_id, "x0": x[0], "y0": y[0], "dist": r.distance_m, "gdist": cum[-1],
                     "cells": cells, "dil": dilate(cells), "area": signed_area(x, y), "date": r.local_date, "elapsed_s": r.elapsed_s})
    from scipy.spatial import cKDTree

    pairs = []
    n = len(recs)
    for pid in sorted({r["place_id"] for r in recs}):
        idx = [i for i in range(n) if recs[i]["place_id"] == pid]
        xy = np.array([[recs[i]["x0"], recs[i]["y0"]] for i in idx])
        tree = cKDTree(xy)
        for i_, j_ in tree.query_pairs(float(lc["start_within_m"])):
            A, B = recs[idx[i_]], recs[idx[j_]]
            if abs(A["gdist"] - B["gdist"]) / max(A["gdist"], B["gdist"]) > lc["length_tolerance"]:
                continue
            if buffered_overlap(A["cells"], B["cells"], A["dil"], B["dil"]) >= lc["jaccard_min"]:
                pairs.append((idx[i_], idx[j_]))
    # Seeded clustering instead of plain connected components: components chain 1.0 -> 1.05 -> ... -> 2.5 mi
    # routes into one "loop". Here the route with the most matches seeds a loop and only its direct matches join.
    adj: dict[int, set] = {i: set() for i in range(n)}
    for a_, b_ in pairs:
        adj[a_].add(b_)
        adj[b_].add(a_)
    unassigned = set(range(n))
    groups = {}
    while True:
        cand_seeds = [i for i in unassigned if adj[i] & unassigned]
        if not cand_seeds:
            break
        seed = max(cand_seeds, key=lambda i: (len(adj[i] & unassigned), -i))
        members = {seed} | (adj[seed] & unassigned)
        groups[seed] = sorted(members)
        unassigned -= members
    # leaderboards are walking loops: clustering uses every on-foot route, the stats use walks
    loops = [g for g in groups.values() if sum(recs[i]["type"] == "walk" for i in g) >= 3]
    loops.sort(key=lambda g: (-sum(recs[i]["type"] == "walk" for i in g), min(recs[i]["date"] for i in g)))
    names = lc.get("names") or {}
    loop_rows, lap_rows = [], []
    for rank, g in enumerate(loops):
        label = loop_label(rank)
        lid = f"L{rank + 1:03d}"
        allr = sorted((recs[i] for i in g), key=lambda r: r["date"])
        laps = [r for r in allr if r["type"] == "walk"]
        el = np.array([r["elapsed_s"] for r in laps])
        rec_i = int(np.argmin(el))
        loop_rows.append({"loop_id": lid, "label": label, "name": names.get(label), "place_id": laps[0]["place_id"], "laps": len(laps),
                          "median_distance_m": float(np.median([r["dist"] for r in laps])), "record_s": float(el[rec_i]),
                          "record_workout_id": laps[rec_i]["workout_id"], "record_date": laps[rec_i]["date"], "median_s": float(np.median(el)),
                          "latest_s": float(el[-1]), "latest_date": laps[-1]["date"],
                          "cw_laps": int(sum(1 for r in laps if r["area"] < 0)), "ccw_laps": int(sum(1 for r in laps if r["area"] > 0)),
                          "representative_workout_id": laps[int(np.argsort(el)[len(el) // 2])]["workout_id"],
                          "other_laps": len(allr) - len(laps)})
        best = math.inf
        for r in allr:
            pr = r["type"] == "walk" and r["elapsed_s"] < best
            if r["type"] == "walk":
                best = min(best, r["elapsed_s"])
            lap_rows.append({"loop_id": lid, "workout_id": r["workout_id"], "type": r["type"], "date": r["date"], "elapsed_s": r["elapsed_s"],
                             "direction": "cw" if r["area"] < 0 else "ccw", "is_record": pr})
    return pd.DataFrame(loop_rows), pd.DataFrame(lap_rows)


# ------------------------------------------------------------------ new ground
def new_ground(con, w: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    grid = float(cfg["exploration"]["grid_m"])
    pts = con.execute("SELECT workout_id, lat, lon, cum_gps_m FROM route_points_clean ORDER BY workout_id, seq").fetchnumpy()
    wid = pts["workout_id"]
    u, f = np.unique(wid, return_index=True)
    bnd = dict(zip(u, zip(f, np.r_[f[1:], len(wid)])))
    ws = w[(w.setting == "outdoor") & w.type.isin(ON_FOOT) & ~w.is_fragment].sort_values("start_utc")
    centers = ws.groupby("place_id")[["start_lat", "start_lon"]].median()
    seen: set = set()
    rows = []
    cum_new = 0.0
    for r in ws.itertuples():
        if r.workout_id not in bnd or pd.isna(r.place_id):
            continue
        a, b = bnd[r.workout_id]
        c = centers.loc[r.place_id]
        x, y = local_xy(pts["lat"][a:b], pts["lon"][a:b], c.start_lat, c.start_lon)
        cells = cells_along(x, y, pts["cum_gps_m"][a:b], grid / 2, grid)
        key = int(r.place_id) * 10**15
        cells = {k + key for k in cells}
        new = cells - seen
        seen |= cells
        # the share of this route's cells that are new, times its distance: counting cells x 30 m overstates
        # diagonal and winding tracks by up to 1.4x (a 41-mile hike came out at 44 miles of new ground)
        nm = len(new) / len(cells) * float(r.distance_m) if cells and pd.notna(r.distance_m) else 0.0
        cum_new += nm
        rows.append({"workout_id": r.workout_id, "date": r.local_date, "new_ground_m": nm, "cum_new_ground_m": cum_new, "cells": len(cells)})
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ weather model
def weather_model(w: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    import statsmodels.formula.api as smf

    d = w[(w.type == "walk") & (w.setting == "outdoor") & ~w.is_fragment & w.temp_c.notna() & (w.distance_m > 800)].copy()
    d["pace"] = d.moving_s / (d.distance_m / MI) / 60  # min/mi
    d = d[(d.pace > 11) & (d.pace < 30)]
    d["year"] = pd.to_datetime(d.local_date).dt.year
    d["hour"] = pd.to_datetime(d.start_local).dt.hour
    d["hbin"] = pd.cut(d.hour, [-1, 8, 11, 14, 17, 24], labels=["early", "morning", "midday", "afternoon", "evening"]).astype(str)
    d["climb_ftmi"] = (d.climb_m.fillna(0) * 3.28084) / (d.distance_m / MI)
    d["temp_f"] = d.temp_c * 9 / 5 + 32
    m = smf.ols("pace ~ C(year) + bs(temp_f, df=5) + C(hbin) + climb_ftmi", data=d).fit()
    ref = {"year": int(d.year.median()), "hbin": d.hbin.mode()[0], "climb_ftmi": float(d.climb_ftmi.median())}
    grid = pd.DataFrame({"temp_f": np.arange(max(10, np.floor(d.temp_f.quantile(0.01))), min(100, np.ceil(d.temp_f.quantile(0.99))) + 1, 1.0)})
    for k, v in ref.items():
        grid[k] = v
    pr = m.get_prediction(grid).summary_frame(alpha=0.05)
    base = float(m.predict(pd.DataFrame([{**ref, "temp_f": 60.0}]))[0])
    temp = pd.DataFrame({"temp_f": grid.temp_f, "effect_min": pr["mean"] - base, "lo": pr["mean_ci_lower"] - base, "hi": pr["mean_ci_upper"] - base})
    ygrid = pd.DataFrame({"year": sorted(d.year.unique())})
    ygrid["temp_f"] = 60.0
    ygrid["hbin"] = ref["hbin"]
    ygrid["climb_ftmi"] = ref["climb_ftmi"]
    py = m.get_prediction(ygrid).summary_frame(alpha=0.05)
    raw = d.groupby("year").pace.median()
    years = pd.DataFrame({"year": ygrid.year, "adjusted_min": py["mean"], "lo": py["mean_ci_lower"], "hi": py["mean_ci_upper"],
                          "raw_median_min": ygrid.year.map(raw), "n": ygrid.year.map(d.groupby("year").size())})
    info = {"n": int(len(d)), "r2": float(m.rsquared), "formula": "pace_min_per_mi ~ C(year) + bs(temp_F, df=5) + C(hour bin) + climb_ft_per_mi",
            "reference": {**ref, "temp_f": 60.0}}
    return temp, years, info


# ------------------------------------------------------------------ records
def compute_records(w: pd.DataFrame, daily: pd.DataFrame, be: pd.DataFrame, loops: pd.DataFrame, swims: pd.DataFrame, streaks: dict, edd: dict) -> pd.DataFrame:
    """records(record_id, label, group, scope, year, value, unit, workout_id, date, runner_up_value, runner_up_workout_id, runner_up_date)."""
    out = []
    w = w.copy()
    w["year"] = pd.to_datetime(w.local_date).dt.year
    good = w[~w.is_fragment & w.dup_of.isna()]
    out_foot = good[(good.setting == "outdoor") & good.type.isin(ON_FOOT)]

    def add(rid, label, group, df, col, unit, mode="max", date_col="local_date", id_col="workout_id"):
        df = df[df[col].notna()]
        if not len(df):
            return
        for scope, sub in [("all", df)] + [("year", g) for _, g in df.groupby("year")]:
            s = sub.sort_values([col, date_col], ascending=[mode == "min", True])
            top = s.iloc[0]
            ru = s.iloc[1] if len(s) > 1 else None
            out.append({"record_id": rid, "label": label, "group": group, "scope": scope, "year": int(top["year"]) if scope == "year" else None,
                        "value": float(top[col]), "unit": unit, "workout_id": top.get(id_col) if id_col else None, "date": top[date_col],
                        "runner_up_value": float(ru[col]) if ru is not None else None,
                        "runner_up_workout_id": ru.get(id_col) if (ru is not None and id_col) else None, "runner_up_date": ru[date_col] if ru is not None else None})

    for t, nm in [("walk", "walk"), ("hike", "hike"), ("run", "run"), ("ride", "ride")]:
        add(f"longest_{t}", f"Longest {nm}", "Distance", good[(good.type == t) & (good.setting == "outdoor")], "distance_m", "m")
    add("longest_walk_time", "Longest walk by time", "Distance", good[(good.type == "walk") & (good.setting == "outdoor")], "elapsed_s", "s")
    g = good[~good.g4_cut.fillna(False).astype(bool)].assign(pace=lambda x: x.moving_s / (x.distance_m / MI))
    add("fastest_walk_2mi", "Fastest walk over 2 miles", "Speed", g[(g.type == "walk") & (g.setting == "outdoor") & (g.distance_m >= 2 * MI)], "pace", "s/mi", "min")
    add("fastest_run_3mi", "Fastest run over 3 miles", "Speed", g[(g.type == "run") & (g.setting == "outdoor") & (g.distance_m >= 3 * MI)], "pace", "s/mi", "min")
    ns = out_foot[(out_foot.distance_m >= 3 * MI)].assign(neg=lambda x: -x.split_delta_s / (x.distance_m / MI))
    add("biggest_negative_split", "Biggest negative split", "Speed", ns, "neg", "s/mi")
    add("biggest_climb", "Biggest climb", "Climbing", out_foot, "climb_m", "m")
    add("steepest_stretch", "Steepest stretch", "Climbing", out_foot, "max_grade", "fraction")
    hw = out_foot[(out_foot.type == "walk") & (out_foot.distance_m >= 2 * MI)].assign(cpm=lambda x: x.climb_m / (x.distance_m / MI))
    add("hilliest_walk", "Hilliest walk", "Climbing", hw, "cpm", "m/mi")
    add("most_efficient_walk", "Most efficient walk", "Heart", out_foot[(out_foot.type == "walk") & (out_foot.distance_m >= 2 * MI)], "ef", "m/min/bpm")
    dd = daily.assign(year=pd.to_datetime(daily.date).dt.year, local_date=daily.date)
    dd["rhr30"] = dd.resting_hr.rolling(30, min_periods=20).mean()
    add("lowest_resting_hr", "Lowest resting heart rate (30-day mean)", "Heart", dd, "rhr30", "bpm", "min", id_col=None)
    mv = dd.assign(month=pd.to_datetime(dd.date).dt.to_period("M")).groupby("month").agg(vo2=("vo2max", "mean")).reset_index()
    mv["local_date"] = mv.month.dt.to_timestamp().dt.date
    mv["year"] = mv.month.dt.year
    add("highest_vo2max", "Highest VO₂ max (monthly mean)", "Heart", mv, "vo2", "mL/kg/min", id_col=None)
    for col, lab in [("temp_c", "Hottest"), ("feels_c", "Hottest feels-like")]:
        add(f"{lab.lower().replace(' ', '_').replace('-', '_')}", f"{lab} outing", "Weather and sun", out_foot, col, "degC")
    add("coldest", "Coldest outing", "Weather and sun", out_foot, "temp_c", "degC", "min")
    add("coldest_feels", "Coldest feels-like outing", "Weather and sun", out_foot, "feels_c", "degC", "min")
    add("windiest", "Windiest outing", "Weather and sun", out_foot, "wind_mean_ms", "m/s")
    add("wettest", "Wettest outing", "Weather and sun", out_foot, "precip_mm", "mm")
    st = out_foot.assign(sh=pd.to_datetime(out_foot.start_local).dt.hour + pd.to_datetime(out_foot.start_local).dt.minute / 60,
                         eh=lambda x: (pd.to_datetime(x.end_local) - pd.to_datetime(x.end_local).dt.normalize()).dt.total_seconds() / 3600)
    add("earliest_start", "Earliest start", "Weather and sun", st, "sh", "hour", "min")
    add("latest_finish", "Latest finish", "Weather and sun", st, "eh", "hour")
    add("most_dark", "Most minutes in darkness", "Weather and sun", out_foot, "dark_min", "min")
    add("most_steps_day", "Most steps in a day", "Volume", dd, "steps", "steps", id_col=None)
    add("most_foot_day", "Most on-foot miles in a day", "Volume", dd, "foot_m", "m", id_col=None)
    for per, lab in [("W", "week"), ("M", "month"), ("Y", "year")]:
        x = dd.assign(p=pd.to_datetime(dd.date).dt.to_period(per if per != "W" else "W-SUN")).groupby("p").agg(v=("foot_m", "sum")).reset_index()
        x["local_date"] = x.p.dt.start_time.dt.date
        x["year"] = x.p.dt.start_time.dt.year
        add(f"most_foot_{lab}", f"Most on-foot miles in a {lab}", "Volume", x, "v", "m", id_col=None)
    wk = good[good.type.isin(ON_FOOT)].assign(p=lambda x: pd.to_datetime(x.local_date).dt.to_period("W-SUN")).groupby("p").size().rename("n").reset_index()
    wk["local_date"] = wk.p.dt.start_time.dt.date
    wk["year"] = wk.p.dt.start_time.dt.year
    add("most_workouts_week", "Most on-foot workouts in a week", "Volume", wk, "n", "workouts", id_col=None)
    for k, (lab, v, end) in streaks.items():
        out.append({"record_id": k, "label": lab, "group": "Consistency", "scope": "all", "year": None, "value": float(v), "unit": "days" if "week" not in k else "weeks",
                    "workout_id": None, "date": end, "runner_up_value": None, "runner_up_workout_id": None, "runner_up_date": None})
    out.append({"record_id": "eddington", "label": "Eddington number (on foot, miles)", "group": "Consistency", "scope": "all", "year": None,
                "value": float(edd["E"]), "unit": "", "workout_id": None, "date": None, "runner_up_value": float(edd["need"]), "runner_up_workout_id": None, "runner_up_date": None})
    add("furthest_from_home", "Furthest from home", "Exploration", out_foot, "max_from_home_m", "m")
    add("most_new_ground", "Most new ground in one workout", "Exploration", out_foot, "new_ground_m", "m")
    if len(be):
        bb = be.merge(w[["workout_id", "year"]], on="workout_id")
        for (t, lab), g2 in bb.groupby(["type", "distance_label"]):
            add(f"best_{t}_{lab.replace(' ', '').lower()}", f"Best {lab} ({t})", "Speed", g2.rename(columns={"date": "local_date"}), "seconds", "s", "min")
    if len(swims):
        sw = swims.copy()
        sw["year"] = pd.to_datetime(sw.local_date).dt.year
        add("longest_swim", "Longest swim", "Pool", sw, "distance_m", "m")
        add("fastest_100yd", "Fastest 100 yd pace", "Pool", sw, "pace_100yd_s", "s/100yd", "min")
        add("best_swolf", "Best SWOLF", "Pool", sw, "swolf", "", "min")
    s_ = good[good.type == "strength"].assign(p=lambda x: pd.to_datetime(x.local_date).dt.to_period("W-SUN"))
    if len(s_):
        sk = s_.groupby("p").size().rename("n").reset_index()
        sk["local_date"] = sk.p.dt.start_time.dt.date
        sk["year"] = sk.p.dt.start_time.dt.year
        add("most_strength_week", "Most strength sessions in a week", "Strength", sk, "n", "sessions", id_col=None)
        add("longest_strength", "Longest strength session", "Strength", s_, "elapsed_s", "s")
    return pd.DataFrame(out)


# ------------------------------------------------------------------ main
def run() -> dict:
    cfg = paths.config()
    con = paths.connect()
    export_date = con.execute("SELECT v FROM _meta WHERE k='export_date'").fetchone()[0]
    hr_max = float(con.execute("SELECT v FROM params WHERE k='hr_max'").fetchone()[0])
    home = con.execute("SELECT lat, lon FROM home").fetchone()
    info = {"hr_max": hr_max}
    w = con.execute("SELECT * FROM workouts_enriched ORDER BY start_utc, workout_id").df()
    w["dup_of"] = None
    w = w.pipe(_by_id)

    with Timer("daily"):
        daily = build_daily(con, export_date)
    with Timer("heart rate per workout"):
        era = file_era_hr_max(con)
        info["hr_max_file_era"] = era
        hm = workout_hr_metrics(con, w, daily, hr_max, era)
        w = w.merge(hm, on="workout_id", how="left").pipe(_by_id)
        hs = con.execute("SELECT workout_id, t_s, hr FROM workout_hr_5s WHERE hr IS NOT NULL ORDER BY workout_id, t_s").df()
        hr_streams = {k: (g.t_s.to_numpy(float), g.hr.to_numpy(float)) for k, g in hs.groupby("workout_id")}
    with Timer("steps per workout"):
        st = workout_steps(con)
        w = w.merge(st, on="workout_id", how="left").pipe(_by_id)
        w["cadence_spm"] = w.steps / (w.moving_s / 60)
    with Timer("track metrics, splits, best efforts"):
        tm, splits, be = track_metrics(con, w, home, hr_streams)
        w = w.merge(tm, on="workout_id", how="left").pipe(_by_id)
        w["pace_s_per_mi"] = np.where(w.distance_m > 0, w.moving_s / (w.distance_m / MI), np.nan)
        w["beats_per_mile"] = np.where(w.distance_m > 0, w.avg_hr * (w.moving_s / 60) / (w.distance_m / MI), np.nan)
    with Timer("best-effort progression"):
        if len(be):
            be = be.sort_values(["type", "distance_label", "date", "seconds"]).reset_index(drop=True)
            be["is_pr"] = False
            for _, g in be.groupby(["type", "distance_label"]):
                best = math.inf
                for i, r in g.iterrows():
                    if r.seconds < best:
                        be.at[i, "is_pr"] = True
                        best = r.seconds
    with Timer("loops"):
        loops, laps = find_loops(con, w, cfg)
        w["loop_id"] = w.workout_id.map(dict(zip(laps.workout_id, laps.loop_id))) if len(laps) else None
        info["loops"] = int(len(loops))
    with Timer("new ground"):
        ng = new_ground(con, w, cfg)
        w["new_ground_m"] = w.workout_id.map(dict(zip(ng.workout_id, ng.new_ground_m)))
    with Timer("daily workout columns, fitness model"):
        g = w[w.dup_of.isna()]
        foot = g[g.type.isin(ON_FOOT)].groupby("local_date").agg(foot_m=("distance_m", "sum"), n_foot=("workout_id", "size"))
        nall = g.groupby("local_date").agg(n_workouts=("workout_id", "size"), trimp=("trimp", "sum"))
        daily = daily.merge(foot, left_on="date", right_index=True, how="left").merge(nall, left_on="date", right_index=True, how="left")
        daily["n_workouts"] = daily.n_workouts.fillna(0).astype(int)
        daily["n_foot"] = daily.n_foot.fillna(0).astype(int)
        daily["foot_m"] = daily.foot_m.fillna(0.0)
        daily["active"] = daily.n_foot > 0
        first_hr = g[g.trimp.fillna(0) > 0].local_date.min()
        tr = daily.trimp.fillna(0.0).to_numpy()
        live = (pd.to_datetime(daily.date) >= pd.Timestamp(first_hr)).to_numpy()
        ctl, atl, tsb = fitness_model(np.where(live, tr, 0.0))
        warm = (pd.to_datetime(daily.date) < pd.Timestamp(first_hr) + pd.Timedelta(days=60)).to_numpy()
        daily["trimp"] = np.where(live, tr, np.nan)
        daily["ctl"] = np.where(warm, np.nan, ctl)
        daily["atl"] = np.where(warm, np.nan, atl)
        daily["tsb"] = np.where(warm, np.nan, tsb)
        info["fitness_model_start"] = str(first_hr)
    with Timer("streaks, Eddington"):
        dts = daily.date.tolist()
        a_len, a_end = longest_streak(daily.active.tolist())
        s_len, s_end = longest_streak([(s or 0) >= 10000 for s in daily.steps.tolist()])
        wk = daily.assign(p=pd.to_datetime(daily.date).dt.to_period("W-SUN")).groupby("p").n_foot.sum()
        w_len, w_end = longest_streak((wk >= 3).tolist())
        streaks = {"streak_active": ("Longest active streak", a_len, dts[a_end] if a_end >= 0 else None),
                   "streak_10k": ("Longest 10,000-step streak", s_len, dts[s_end] if s_end >= 0 else None),
                   "streak_weekly": ("Longest weekly streak (3+ on-foot workouts)", w_len, wk.index[w_end].end_time.date() if w_end >= 0 else None)}
        E, need = eddington((daily.foot_m / MI).to_numpy())
        edd = {"E": E, "need": need}
        info["eddington"] = edd
    with Timer("swims"):
        sw = con.execute("""SELECT w.workout_id, w.local_date, w.distance_m, w.duration_s,
                                   median(l.swolf) FILTER (WHERE l.stroke_style='freestyle' AND NOT l.dropped) AS swolf,
                                   median(l.swolf_apple) FILTER (WHERE l.stroke_style='freestyle' AND NOT l.dropped) AS swolf_apple,
                                   count(*) FILTER (WHERE NOT l.dropped) AS laps,
                                   sum(l.duration_s) FILTER (WHERE NOT l.dropped) AS lap_seconds,
                                   arg_max(l.stroke_style, l.duration_s) AS main_stroke
                            FROM workouts_clean w LEFT JOIN swim_laps l USING (workout_id) WHERE w.type='swim' GROUP BY ALL ORDER BY w.local_date""").df()
        sw["pace_100yd_s"] = sw.lap_seconds / (sw.distance_m / 91.44)
    with Timer("weather model"):
        try:
            wt, wy, winfo = weather_model(w)
            info["weather_model"] = winfo
        except Exception as e:  # not enough data
            wt, wy = pd.DataFrame(), pd.DataFrame()
            info["weather_model_error"] = str(e)
    with Timer("records"):
        recs = compute_records(w, daily, be, loops, sw, streaks, edd)
    with Timer("write"):
        w = w.reset_index(drop=True)
        for name, df in [("workouts_final", w), ("daily", daily), ("splits", splits), ("best_efforts", be), ("loops", loops), ("loop_laps", laps),
                         ("new_ground", ng), ("records", recs), ("swims", sw), ("wx_model_temp", wt), ("wx_model_year", wy)]:
            con.register("x_df", df)
            con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM x_df")
            con.unregister("x_df")
        con.execute("CREATE OR REPLACE TABLE derive_info AS SELECT ? AS info", [json.dumps(info, default=str)])
    con.close()
    paths.write_json(paths.DATA / "derive_log.json", info)
    return info


def main() -> None:
    print(json.dumps(run(), indent=1, default=str))


if __name__ == "__main__":
    main()
