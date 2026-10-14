"""Export Parquet tables, route buffers, per-workout streams and basemap contours to app/public/data/.

Deterministic: every table is sorted, Parquet is written single-threaded, and no
wall-clock times are embedded, so `make all` twice gives identical hashes.
Privacy: home coordinates are never written here. Routes carry share-mode trim
indices (first and last 200 m of routes that start or end within 300 m of home);
the data-health example tracks are written as local metres, not coordinates.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil

import numpy as np
import pandas as pd

from . import paths
from .geo import MI, haversine, local_xy, rdp, seg_dist
from .paths import Timer

OUT = paths.APP_DATA
# the app's years start with the first on-foot GPS route (DECISIONS.md); earlier daily data stays in the tables
def year_min(con) -> int:
    y = con.execute("""SELECT min(year(local_date)) FROM workouts_clean
                       WHERE setting = 'outdoor' AND type IN ('walk', 'run', 'hike') AND NOT is_fragment""").fetchone()[0]
    return int(y) if y else 2018

HARDWARE = {
    "Watch4,1": "Apple Watch Series 4", "Watch4,2": "Apple Watch Series 4", "Watch4,3": "Apple Watch Series 4", "Watch4,4": "Apple Watch Series 4",
    "Watch5,1": "Apple Watch Series 5", "Watch5,2": "Apple Watch Series 5", "Watch5,3": "Apple Watch Series 5", "Watch5,4": "Apple Watch Series 5",
    "Watch6,1": "Apple Watch Series 6", "Watch6,2": "Apple Watch Series 6", "Watch6,6": "Apple Watch Series 7", "Watch6,7": "Apple Watch Series 7",
    "Watch6,14": "Apple Watch Series 8", "Watch6,15": "Apple Watch Series 8", "Watch6,18": "Apple Watch Ultra", "Watch7,1": "Apple Watch Series 9",
    "Watch7,2": "Apple Watch Series 9", "Watch7,5": "Apple Watch Ultra 2", "Watch7,8": "Apple Watch Series 10", "Watch7,9": "Apple Watch Series 10",
    "iPhone10,3": "iPhone X", "iPhone10,6": "iPhone X", "iPhone11,2": "iPhone XS", "iPhone12,1": "iPhone 11", "iPhone13,2": "iPhone 12",
    "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone15,2": "iPhone 14 Pro", "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone17,2": "iPhone 16 Pro Max", "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max",
    "fr920xt": "Garmin Forerunner 920XT", "Peloton Bike": "Peloton Bike", "Peloton App": "Peloton App",
}

METRIC_NAMES = {
    "HeartRate": "Heart rate", "GPSRoute": "GPS routes", "GPSElevation": "GPS altitude in routes",
    "ElevationAscended": "Barometric climb in workouts", "VO2Max": "Cardio fitness (VO₂ max)", "HeartRateVariabilitySDNN": "Heart rate variability",
    "RestingHeartRate": "Resting heart rate", "WeatherTemperature": "Weather in workout metadata", "StepCount": "Steps",
    "DistanceWalkingRunning": "Walking + running distance", "FlightsClimbed": "Flights climbed", "AppleExerciseTime": "Exercise minutes",
    "AppleStandHour": "Stand hours", "EnvironmentalAudioExposure": "Noise exposure", "WalkingSpeed": "Walking speed, step length, double support",
    "WalkingAsymmetryPercentage": "Walking asymmetry", "SixMinuteWalkTestDistance": "Six-minute walk estimate", "AppleWalkingSteadiness": "Walking steadiness",
    "RespiratoryRate": "Respiratory rate (sleep)", "SleepAnalysis": "Sleep", "HeartRateRecoveryOneMinute": "Heart-rate recovery",
    "SwimmingStrokeCount": "Swim laps and strokes", "FileHeartRate": "Heart rate in Strava files", "PhysicalEffort": "Physical effort", "TimeInDaylight": "Time in daylight",
    "OxygenSaturation": "Blood oxygen", "AppleSleepingWristTemperature": "Wrist temperature", "StairAscentSpeed": "Stair speed",
    "RunningPower": "Running power and form", "AppleSleepingBreathingDisturbances": "Breathing disturbances", "HandwashingEvent": "Handwashing",
    "BasalEnergyBurned": "Resting energy", "ActiveEnergyBurned": "Active energy", "WalkingHeartRateAverage": "Walking heart rate average",
}
TIMELINE = ["StepCount", "HeartRate", "FileHeartRate", "GPSRoute", "ElevationAscended", "WeatherTemperature", "VO2Max", "RestingHeartRate", "HeartRateVariabilitySDNN",
            "EnvironmentalAudioExposure", "WalkingSpeed", "SleepAnalysis", "RespiratoryRate", "HeartRateRecoveryOneMinute", "SwimmingStrokeCount",
            "PhysicalEffort", "TimeInDaylight", "OxygenSaturation", "AppleSleepingWristTemperature", "RunningPower", "AppleSleepingBreathingDisturbances"]


def copy_parquet(con, sql: str, name: str) -> None:
    """Floats are rounded to 6 decimals: DuckDB's parallel sums differ in the last bit from run to run, and
    byte-identical outputs (ground rule 6) matter more than precision no chart can show."""
    OUT.mkdir(parents=True, exist_ok=True)
    cols = con.execute(f"DESCRIBE ({sql})").fetchall()
    sel = ", ".join(f'round("{c}", 6) AS "{c}"' if t in ("DOUBLE", "FLOAT") else f'"{c}"' for c, t, *_ in cols)
    con.execute(f"COPY (SELECT {sel} FROM ({sql})) TO '{OUT / name}' (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 1000000)")


def dump(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(obj, separators=(",", ":"), sort_keys=True, default=str, allow_nan=False))


def r(x, nd=1):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return None
    return round(float(x), nd)


# ------------------------------------------------------------------ places
US_STATES = dict(zip(
    ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia",
     "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
     "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York",
     "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
     "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "Puerto Rico"],
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split()))


def name_places(con, w: pd.DataFrame) -> pd.DataFrame:
    import reverse_geocoder as rg

    g = w[w.place_id.notna()].groupby("place_id").agg(lat=("start_lat", "median"), lon=("start_lon", "median"), n=("workout_id", "size"),
                                                         mi=("distance_m", lambda s: s.sum() / MI), first=("local_date", "min"), last=("local_date", "max")).reset_index()
    res = rg.search(list(zip(g.lat, g.lon)), mode=1, verbose=False)
    abbr = US_STATES
    names = []
    for i, x in enumerate(res):
        a1 = abbr.get(x["admin1"], x["admin1"])
        if x["cc"] != "US":
            nm = f'{x["name"]}, {x["cc"]}'
        elif x["admin1"] in ("Washington, D.C.", "District of Columbia") or x["name"].startswith("Washington, D.C"):
            nm = "Washington, DC"
        else:
            nm = f'{x["name"]}, {a1}'
        if nm in names:  # two clusters near the same town
            nm = f"{nm} ({len([n for n in names if n.startswith(nm)]) + 1})"
        names.append(nm)
    g["area"] = names
    g["name"] = np.where(g.place_id == 0, "Home", g.area)
    return g


# ------------------------------------------------------------------ privacy
def zone_center(home) -> tuple[float, float]:
    """A privacy-zone centre offset 100-150 m from home in a direction fixed by a hash of the location, so the
    hole share mode leaves in the route network does not point at the door. Never written outside data/."""
    h = hashlib.sha256(f"{home[0]:.5f},{home[1]:.5f}".encode()).digest()
    ang = h[0] / 255 * 2 * math.pi
    dist = 100 + h[1] / 255 * 50
    return home[0] + dist * math.cos(ang) / 111_195, home[1] + dist * math.sin(ang) / (111_195 * math.cos(math.radians(home[0])))


def share_visible(lat, lon, cum, home, zc, radius=300.0, trim=200.0) -> np.ndarray:
    """Share mode (ground rule 7): hide the first and last 200 m of routes that start or end within 300 m of home,
    and every point inside the 300 m privacy zone."""
    vis = haversine(lat, lon, zc[0], zc[1]) >= radius
    if haversine(lat[0], lon[0], home[0], home[1]) < radius:
        vis &= cum >= trim
    if haversine(lat[-1], lon[-1], home[0], home[1]) < radius:
        vis &= cum <= cum[-1] - trim
    return vis


# ------------------------------------------------------------------ routes
def export_routes(con, w: pd.DataFrame, home) -> pd.DataFrame:
    # elevation for the 3D view: USGS 3DEP where the enrich step has it (every route on one surface, so repeated loops
    # stack cleanly), else the smoothed GPS altitude
    enriched = con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = 'route_points_enriched'").fetchone()[0]
    pts = con.execute(f"""SELECT workout_id, lat, lon, gap, cum_gps_m, epoch_ms(t_utc) AS t_ms, ele_gps_smooth_m AS ele_gps,
                                 {'ele_dem_m' if enriched else 'NULL::DOUBLE'} AS ele_dem
                          FROM {'route_points_enriched' if enriched else 'route_points_clean'} ORDER BY workout_id, seq""").fetchnumpy()
    num = lambda a: np.ma.filled(np.ma.asarray(a, dtype=float), np.nan)  # NULL → NaN
    ele_all = np.where(np.isfinite(num(pts["ele_dem"])), num(pts["ele_dem"]), num(pts["ele_gps"]))
    t_all = num(pts["t_ms"]) / 1000
    wid = pts["workout_id"]
    u, f = np.unique(wid, return_index=True)
    bnd = dict(zip(u, zip(f, np.r_[f[1:], len(wid)])))
    order = w[(w.setting == "outdoor") & ~w.is_fragment].sort_values(["start_utc", "workout_id"]).workout_id.tolist()
    xs, ys, gaps, shares, eles, ts, rows = [], [], [], [], [], [], []
    zc = zone_center(home)
    off = 0
    for i_, w_ in enumerate(order):
        if w_ not in bnd:
            continue
        a, b = bnd[w_]
        la, lo, gp, cm = pts["lat"][a:b], pts["lon"][a:b], pts["gap"][a:b], pts["cum_gps_m"][a:b]
        x, y = local_xy(la, lo, float(la[0]), float(lo[0]))
        keep = np.zeros(len(la), dtype=bool)
        keep[rdp(x, y, 4.0)] = True
        brk = np.flatnonzero(gp > 0)
        keep[brk] = True
        keep[np.clip(brk - 1, 0, None)] = True
        k = np.flatnonzero(keep)
        n = len(k)
        # share mode: hide the first and last 200 m of routes that start or end within 300 m of home
        ta, tb = 0, n
        ck = cm[k]
        if haversine(la[0], lo[0], home[0], home[1]) < 300:
            ta = int(np.searchsorted(ck, 200.0))
        if haversine(la[-1], lo[-1], home[0], home[1]) < 300:
            tb = int(np.searchsorted(ck, ck[-1] - 200.0))
        vis = share_visible(la, lo, cm, home, zc)
        # keep the points where visibility flips so the hidden stretch starts and ends where it should
        flips = np.flatnonzero(np.diff(vis.astype(np.int8)) != 0)
        keep[flips] = True
        keep[np.clip(flips + 1, 0, len(keep) - 1)] = True
        k = np.flatnonzero(keep)
        n = len(k)
        ck = cm[k]
        ta, tb = (0 if not (~vis[k]).any() else int(np.argmax(vis[k]))), n
        xs.append(lo[k]); ys.append(la[k]); gaps.append(gp[k]); shares.append(vis[k])
        e = ele_all[a:b][k]
        eles.append(np.where(np.isfinite(e), np.clip(np.round(e * 2), -32767, 32767), -32768))  # half metres; -32768 = none
        tt = t_all[a:b][k]
        ts.append(np.clip(np.round((tt - tt[0]) / 2), 0, 65535))                                # 2 s steps from the start
        rows.append({"workout_id": w_, "route_off": off, "route_n": n, "share_a": min(ta, n), "share_b": max(min(tb, n), min(ta, n))})
        off += n
    lonlat = np.empty(off * 2, dtype=np.float32)
    lonlat[0::2] = np.concatenate(xs)
    lonlat[1::2] = np.concatenate(ys)
    (OUT / "routes.bin").write_bytes(lonlat.tobytes())
    (OUT / "routes_gap.bin").write_bytes(np.concatenate(gaps).astype(np.uint8).tobytes())
    (OUT / "routes_share.bin").write_bytes(np.concatenate(shares).astype(np.uint8).tobytes())
    (OUT / "routes_ele.bin").write_bytes(np.concatenate(eles).astype("<i2").tobytes())
    (OUT / "routes_time.bin").write_bytes(np.concatenate(ts).astype("<u2").tobytes())
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ sleep
def export_sleep(con) -> dict | None:
    """sleep_nights.parquet (one row per night) and sleep_runs.bin (each night's timeline as runs of one stage:
    uint16 start minute after 18:00, uint16 minutes, uint16 stage code; seg_off/seg_n index it per night)."""
    if not con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = 'sleep_nights'").fetchone()[0]:
        for f in ("sleep_nights.parquet", "sleep_runs.bin"):
            (OUT / f).unlink(missing_ok=True)
        return None
    runs = con.execute("SELECT date, start_min, minutes, stage FROM sleep_runs ORDER BY date, start_min").df()
    nights = con.execute("SELECT date FROM sleep_nights ORDER BY date").df()
    first = runs.groupby("date").size()
    n = nights.date.map(first).fillna(0).astype(int)
    idx = pd.DataFrame({"date": nights.date, "seg_off": np.r_[0, np.cumsum(n.to_numpy())[:-1]].astype(int), "seg_n": n.to_numpy()})
    con.register("si_df", idx)
    # 64-bit integers arrive in the browser as BigInt: everything countable here fits in 32 bits
    cols = ", ".join(f'CAST(n."{c}" AS INTEGER) AS "{c}"' if t in ("BIGINT", "HUGEINT") else f'n."{c}"'
                     for c, t, *_ in con.execute("DESCRIBE sleep_nights").fetchall() if c != "tz")
    copy_parquet(con, f"""SELECT {cols}, CAST(i.seg_off AS INTEGER) AS seg_off, CAST(i.seg_n AS INTEGER) AS seg_n
                          FROM sleep_nights n JOIN si_df i USING (date) ORDER BY n.date""", "sleep_nights.parquet")
    con.unregister("si_df")
    (OUT / "sleep_runs.bin").write_bytes(runs[["start_min", "minutes", "stage"]].to_numpy().astype("<u2").tobytes())
    info = json.loads(con.execute("SELECT info FROM sleep_info").fetchone()[0])
    return {"nights": int(len(nights)), "apnea_windows": info.get("apnea_windows", [])}


# ------------------------------------------------------------------ streams
def export_streams(con, w: pd.DataFrame, home) -> int:
    zc = zone_center(home)
    sdir = OUT / "streams"
    if sdir.exists():
        shutil.rmtree(sdir)
    sdir.mkdir(parents=True)
    pts = con.execute("""SELECT workout_id, epoch(t_utc) AS t, lat, lon, cum_m, cum_moving_s, gap,
                                coalesce(ele_dem_m, ele_gps_smooth_m) AS ele FROM route_points_enriched ORDER BY workout_id, seq""").fetchnumpy()
    ele_all = np.ma.filled(pts["ele"].astype(float), np.nan) if np.ma.isMaskedArray(pts["ele"]) else pts["ele"].astype(float)
    wid = pts["workout_id"]
    u, f = np.unique(wid, return_index=True)
    bnd = dict(zip(u, zip(f, np.r_[f[1:], len(wid)])))
    hr = con.execute("SELECT workout_id, t_s, hr FROM workout_hr_5s ORDER BY workout_id, t_s").df()
    hrs = {k: g.hr.to_numpy(float) for k, g in hr.groupby("workout_id")}
    st = con.execute("""SELECT w.workout_id, epoch(m.minute) AS m, m.v FROM workouts_clean w JOIN minute_dedup m
                        ON m.type='HKQuantityTypeIdentifierStepCount' AND m.minute >= date_trunc('minute', w.start_utc) AND m.minute < w.end_utc
                        WHERE w.setting = 'outdoor' AND w.type IN ('walk','run','hike') ORDER BY 1, 2""").df()
    sts = {k: (g.m.to_numpy(float), g.v.to_numpy(float)) for k, g in st.groupby("workout_id")}
    n = 0
    for r_ in w[(w.setting == "outdoor")].itertuples():
        if r_.workout_id not in bnd:
            continue
        a, b = bnd[r_.workout_id]
        cm = np.maximum.accumulate(pts["cum_m"][a:b])
        keep = np.r_[True, np.diff(cm) > 0]
        if keep.sum() < 3:
            continue
        cmu = cm[keep]
        grid = np.r_[np.arange(0, cmu[-1], 10.0), cmu[-1]]
        ip = lambda arr: np.interp(grid, cmu, arr[a:b][keep])
        t_mov = ip(pts["cum_moving_s"])
        t_abs = ip(pts["t"])
        la, lo = ip(pts["lat"]), ip(pts["lon"])
        e = ele_all[a:b][keep]
        ok = np.isfinite(e)
        ele = np.interp(grid, cmu[ok], e[ok]) if ok.mean() > 0.7 else np.full(len(grid), np.nan)
        h = np.full(len(grid), np.nan)
        if r_.workout_id in hrs:  # look up the 5 s grid; no interpolation across gaps longer than H2's 30 s fill
            g5 = hrs[r_.workout_id]
            k5 = np.round((t_abs - r_.start_utc.timestamp()) / 5).astype(int)
            ok5 = (k5 >= 0) & (k5 < len(g5))
            h[ok5] = g5[k5[ok5]]
        cad = np.full(len(grid), np.nan)
        if r_.workout_id in sts:
            mm, vv = sts[r_.workout_id]
            idx = np.searchsorted(mm, np.floor(t_abs / 60) * 60)
            ok2 = (idx < len(mm)) & (mm[np.clip(idx, 0, len(mm) - 1)] == np.floor(t_abs / 60) * 60)
            cad[ok2] = vv[idx[ok2]]
        # gap flags at grid resolution (any break inside the 10 m step)
        gp = pts["gap"][a:b][keep]
        gi = np.searchsorted(grid, cmu[gp > 0]) if (gp > 0).any() else np.array([], dtype=int)
        hide_m = ~share_visible(la, lo, grid, home, zc)
        edges = np.flatnonzero(np.diff(np.r_[0, hide_m.astype(np.int8), 0]))
        out = {
            "id": r_.workout_id, "step": 10, "n": int(len(grid)), "last": r(grid[-1], 1), "share_hide": edges.reshape(-1, 2).tolist(),
            "t": [int(round(x)) for x in t_mov], "lat": [r(x, 6) for x in la], "lon": [r(x, 6) for x in lo],
            "ele": [r(x, 1) for x in ele], "hr": [None if not np.isfinite(x) else int(round(x)) for x in h],
            "cad": [None if not np.isfinite(x) else int(round(x)) for x in cad], "gaps": sorted({int(x) for x in gi}),
        }
        (sdir / f"{r_.workout_id}.json").write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
        n += 1
    return n


# ------------------------------------------------------------------ contours
def export_contours(con, places: pd.DataFrame, w: pd.DataFrame) -> list[dict]:
    import contourpy
    import rasterio

    cdir = OUT / "contours"
    if cdir.exists():
        shutil.rmtree(cdir)
    cdir.mkdir(parents=True)
    out = []
    pts = con.execute("""SELECT w.place_id, p.lat, p.lon FROM route_points_clean p JOIN workouts_enriched w USING (workout_id)
                         WHERE w.place_id IS NOT NULL AND p.seq % 20 = 0""").df()
    for pl in places.itertuples():
        pp = pts[pts.place_id == pl.place_id]
        if len(pp) < 20 or pl.n < 3:
            continue
        la0, la1 = np.quantile(pp.lat, [0.002, 0.998])
        lo0, lo1 = np.quantile(pp.lon, [0.002, 0.998])
        m = 0.02
        s, n_, wl, e = math.floor((la0 - m) / 0.1), math.floor((la1 + m) / 0.1), math.floor((lo0 - m) / 0.1), math.floor((lo1 + m) / 0.1)
        tiles = [(i, j) for i in range(s, n_ + 1) for j in range(wl, e + 1)]
        files = [paths.CACHE / "dem" / f"dem_{i}_{j}.tif" for i, j in tiles]
        if not all(f.exists() for f in files):
            continue
        # mosaic at 3x downsampling (about 30 m)
        ds_ = 3
        rows_ = []
        for i in range(n_, s - 1, -1):
            row = []
            for j in range(wl, e + 1):
                with rasterio.open(paths.CACHE / "dem" / f"dem_{i}_{j}.tif") as d:
                    a = d.read(1).astype(np.float32)
                a[(a < -500) | (a > 9000)] = np.nan
                row.append(a[::ds_, ::ds_])
            rows_.append(np.hstack(row))
        z = np.vstack(rows_)
        H, W = z.shape
        lats = (n_ + 1) * 0.1 - (np.arange(H) + 0.5) * ((n_ - s + 1) * 0.1 / H)
        lons = wl * 0.1 + (np.arange(W) + 0.5) * ((e - wl + 1) * 0.1 / W)
        # crop to the route area plus margin
        rmask = (lats >= la0 - m) & (lats <= la1 + m)
        cmask = (lons >= lo0 - m) & (lons <= lo1 + m)
        z, lats, lons = z[np.ix_(rmask, cmask)], lats[rmask], lons[cmask]
        if np.isnan(z).all():
            continue
        zf = np.where(np.isfinite(z), z, np.nanmin(z))
        relief = float(np.nanpercentile(z, 99) - np.nanpercentile(z, 1))
        step = 2 if relief < 40 else 5 if relief < 150 else 10 if relief < 400 else 20
        major = step * 5
        gen = contourpy.contour_generator(lons, lats, zf, name="serial", line_type="SeparateCode")
        coords, offs, levels = [], [0], []
        for lev in np.arange(math.ceil(np.nanmin(z) / step) * step, np.nanmax(z), step):
            lines, _codes = gen.lines(lev)
            for ln in lines:
                if len(ln) < 4:
                    continue
                coords.append(ln.astype(np.float32))
                offs.append(offs[-1] + len(ln))
                levels.append(float(lev))
        if not coords:
            continue
        arr = np.concatenate(coords).ravel().astype(np.float32)
        (cdir / f"place_{int(pl.place_id)}.bin").write_bytes(arr.tobytes())
        out.append({"place_id": int(pl.place_id), "file": f"contours/place_{int(pl.place_id)}.bin", "offsets": offs, "levels": levels,
                    "step_m": step, "major_m": major, "min_m": r(np.nanmin(z), 0), "max_m": r(np.nanmax(z), 0)})
    return out


# ------------------------------------------------------------------ data health
def export_health(con) -> dict:
    from .health_report import RULES

    log = con.execute("SELECT rule_id, table_name, row_key, field, after, note FROM cleaning_log").df()
    home = con.execute("SELECT lat, lon FROM home").fetchone()
    units = {
        "G1": int((log.rule_id == "G1").sum()), "G2": int((log.rule_id == "G2").sum()), "G3": int(log[log.rule_id == "G3"].row_key.nunique()),
        "G4": int(log[log.rule_id == "G4"].row_key.nunique()), "G5": int(log[log.rule_id == "G5"].row_key.nunique()),
        "G6": int(log[(log.rule_id == "G6")].row_key.nunique()), "E2": int(log[log.rule_id == "E2"].row_key.nunique()),
        "S1": int(log[log.rule_id == "S1"].row_key.str.startswith("steps:").sum()), "W1": int(((log.rule_id == "W1") & (log.field == "dropped")).sum()),
        "W2": int((log.rule_id == "W2").sum()), "W3": int((log.rule_id == "W3").sum()), "W4": int((log.rule_id == "W4").sum()), "W5": int((log.rule_id == "W5").sum()),
        "H1": int((log.rule_id == "H1").sum()), "P1": int((log.rule_id == "P1").sum()), "TZ": int(log[log.rule_id == "TZ"].row_key.nunique()),
        **{k: int((log.rule_id == k).sum()) for k in ("Z1", "Z2", "Z3", "Z4")},
        "Z5": int(pd.to_numeric(log[log.rule_id == "Z5"].after, errors="coerce").fillna(0).sum()),
    }
    rules = [{"id": k, "name": RULES[k][0], "unit": RULES[k][1], "why": RULES[k][2], "n": units.get(k, 0)} for k in RULES if units.get(k, 0)]

    def track(wid, note):
        raw = con.execute("SELECT seq, lat, lon FROM route_points WHERE workout_id=? ORDER BY seq", [wid]).df()
        cl = con.execute("SELECT orig_seq AS seq, lat, lon, gap FROM route_points_clean WHERE workout_id=? ORDER BY seq", [wid]).df()
        lat0, lon0 = float(raw.lat.mean()), float(raw.lon.mean())
        rx, ry = local_xy(raw.lat.values, raw.lon.values, lat0, lon0)
        cx, cy = local_xy(cl.lat.values, cl.lon.values, lat0, lon0)
        rcum = np.r_[0, np.cumsum(seg_dist(raw.lat.values, raw.lon.values))]
        ccum = np.r_[0, np.cumsum(seg_dist(cl.lat.values, cl.lon.values))]

        def trim(la, lo, cum):
            a, b = 0, len(la)
            if haversine(la[0], lo[0], home[0], home[1]) < 300:
                a = int(np.searchsorted(cum, 200.0))
            if haversine(la[-1], lo[-1], home[0], home[1]) < 300:
                b = int(np.searchsorted(cum, cum[-1] - 200.0))
            return a, max(a, b)

        zc = zone_center(home)
        rv = share_visible(raw.lat.values, raw.lon.values, rcum, home, zc)
        cvis = share_visible(cl.lat.values, cl.lon.values, ccum, home, zc)
        ra, rb = 0, len(raw)
        ca, cb = 0, len(cl)
        drop = sorted({int(k.split(":")[1]) for k in log[log.rule_id.isin(["G1", "G2"]) & log.row_key.str.startswith(wid + ":")].row_key})
        wi = con.execute("SELECT local_date, type, distance_m, gps_distance_m, total_distance_m, g4_max_mph FROM workouts_final WHERE workout_id=?", [wid]).fetchone()
        ri = [i for i in range(ra, rb) if rv[i]]
        sk = max(1, len(ri) // 2500)
        return {"workout_id": wid, "date": pd.Timestamp(wi[0]).strftime("%b %-d, %Y"), "type": wi[1], "note": note, "headline_m": r(wi[2]), "gps_m": r(wi[3]), "watch_m": r(wi[4]),
                "max_mph": r(wi[5]), "raw_m": r(rcum[-1]),
                "raw": [[r(rx[i], 1), r(ry[i], 1)] for i in ri[::sk]],
                "clean": [[r(cx[i], 1), r(cy[i], 1), int(cl.gap.values[i]) if cvis[i - 1 if i else 0] else 3] for i in range(ca, cb) if cvis[i]][::max(1, int(cvis.sum()) // 2500)],
                "dropped": [[r(rx[i], 1), r(ry[i], 1)] for i in range(len(raw)) if int(raw.seq.values[i]) in set(drop) and rv[i]]}

    # the largest cut that still leaves 1.5 km of walk visible after the 200 m home trim at each end
    g4 = con.execute("""SELECT w.workout_id, l.note FROM workouts_final w JOIN cleaning_log l ON l.rule_id='G4' AND l.row_key=w.workout_id
                        ORDER BY (w.gps_distance_m >= 1500) DESC, w.g4_removed_share DESC LIMIT 1""").fetchone()
    g2 = con.execute("""SELECT split_part(row_key, ':', 1), count(*) FROM cleaning_log WHERE rule_id='G2' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1""").fetchone()
    tracks = []
    if g4:
        tracks.append(track(g4[0], g4[1]))
    if g2:
        tracks.append(track(g2[0], f"{g2[1]} GPS spikes removed"))
    # dedupe example day (same choice as the report)
    ex = con.execute("""SELECT local_date, raw_sum, v FROM daily_quantities_clean
                        WHERE type='HKQuantityTypeIdentifierStepCount' AND raw_watch > 3000 AND raw_phone > 3000 AND local_date >= DATE '2024-01-01'
                        ORDER BY raw_sum / v DESC, local_date LIMIT 40""").df()
    dedupe = None
    if len(ex):
        day = ex.sort_values("local_date").iloc[len(ex) // 2]
        dd = pd.Timestamp(day.local_date).date()
        seg = con.execute("SELECT tz FROM tz_segments WHERE from_utc <= ? AND to_utc > ?", [str(dd), str(dd)]).fetchone()
        tz = seg[0] if seg else "America/New_York"
        q = f"""WITH src AS (SELECT device_class, start_utc, end_utc, value_si v, epoch(end_utc)-epoch(start_utc) dur FROM quantity_samples
                    WHERE type='HKQuantityTypeIdentifierStepCount' AND start_utc BETWEEN ?::TIMESTAMP - INTERVAL 1 DAY AND ?::TIMESTAMP + INTERVAL 2 DAY),
                ex AS (SELECT *, unnest(generate_series(date_trunc('minute', start_utc), CASE WHEN dur<=0 THEN date_trunc('minute', start_utc) ELSE date_trunc('minute', end_utc - INTERVAL 1 MICROSECOND) END, INTERVAL 1 MINUTE)) m FROM src)
                SELECT device_class, timezone('{tz}', m::TIMESTAMPTZ) ltime,
                       sum(CASE WHEN dur<=0 THEN v ELSE v*(least(epoch(end_utc), epoch(m)+60)-greatest(epoch(start_utc), epoch(m)))/dur END) v
                FROM ex GROUP BY ALL ORDER BY 1, 2"""
        rows = con.execute(q, [str(dd), str(dd)]).df()
        rows = rows[pd.to_datetime(rows["ltime"]).dt.date == dd]
        md = con.execute(f"""SELECT timezone('{tz}', minute::TIMESTAMPTZ) ltime, v FROM minute_dedup WHERE type='HKQuantityTypeIdentifierStepCount'
                             AND minute BETWEEN ?::TIMESTAMP - INTERVAL 1 DAY AND ?::TIMESTAMP + INTERVAL 2 DAY ORDER BY 1""", [str(dd), str(dd)]).df()
        md = md[pd.to_datetime(md["ltime"]).dt.date == dd]
        hh = lambda s: (pd.to_datetime(s).dt.hour + pd.to_datetime(s).dt.minute / 60).round(4).tolist()
        dedupe = {"date": str(dd), "raw_sum": r(day.raw_sum, 0), "merged": r(day.v, 0),
                  "watch": list(zip(hh(rows[rows.device_class == "watch"].ltime), rows[rows.device_class == "watch"].v.round(1).tolist())),
                  "phone": list(zip(hh(rows[rows.device_class == "phone"].ltime), rows[rows.device_class == "phone"].v.round(1).tolist())),
                  "chosen": list(zip(hh(md.ltime), md.v.round(1).tolist()))}
    both = con.execute("""SELECT count(*), avg(raw_sum / v) FROM daily_quantities_clean WHERE type='HKQuantityTypeIdentifierStepCount' AND raw_watch > 0 AND raw_phone > 0""").fetchone()
    sug = con.execute("""SELECT s.workout_id, s.suggest, s.reason, w.local_date, w.distance_m FROM relabel_suggestions s JOIN workouts_clean w USING (workout_id) ORDER BY w.local_date""").df()
    return {"rules": rules, "log_rows": int(len(log)), "tracks": tracks, "dedupe": dedupe, "days_both": int(both[0]), "overstate": r(both[1] - 1, 3),
            "relabel": [{"workout_id": x.workout_id, "suggest": x.suggest, "reason": x.reason, "date": pd.Timestamp(x.local_date).strftime("%b %-d, %Y"), "mi": r(x.distance_m / MI, 2)} for x in sug.itertuples()]}


def export_sensors(con) -> dict:
    dv = con.execute("""SELECT device_class, device_hardware, min(first_utc) a, max(last_utc) b, sum(n_rows) n FROM devices
                        WHERE device_hardware IS NOT NULL AND device_class IN ('watch','phone') GROUP BY ALL
                        HAVING sum(n_rows) > 500 OR (device_class = 'watch' AND sum(n_rows) > 100) ORDER BY a""").df()
    devices = [{"cls": x.device_class, "hardware": x.device_hardware, "name": HARDWARE.get(x.device_hardware, x.device_hardware),
                "from": str(x.a.date()), "to": str(x.b.date()), "n": int(x.n)} for x in dv.itertuples()]
    other = con.execute("""SELECT source_name, min(first_utc) a, max(last_utc) b, sum(n_rows) n FROM devices WHERE device_class='other' GROUP BY 1 HAVING sum(n_rows) > 200 ORDER BY a""").df()
    sources = [{"name": x.source_name, "from": str(x.a.date()), "to": str(x.b.date()), "n": int(x.n)} for x in other.itertuples()]
    sa = con.execute("SELECT metric, device_class, first_utc, last_utc, n FROM sensor_availability").df()
    # months with any sample, so a bar can break where a metric stopped for half a year or more (the 2016 Garmin
    # swims and the 2023 Apple swims are two spans, not one seven-year bar)
    con.execute("CREATE TABLE IF NOT EXISTS workout_hr_file (workout_id VARCHAR, t_utc TIMESTAMP, bpm DOUBLE)")
    mo = con.execute("""
        SELECT replace(replace(type, 'HKQuantityTypeIdentifier', ''), 'HKCategoryTypeIdentifier', '') AS metric, device_class, date_trunc('month', start_utc) AS m
        FROM quantity_samples GROUP BY ALL
        UNION SELECT replace(replace(type, 'HKQuantityTypeIdentifier', ''), 'HKCategoryTypeIdentifier', ''), device_class, date_trunc('month', start_utc)
        FROM category_samples GROUP BY ALL
        UNION SELECT 'FileHeartRate', w.device_class, date_trunc('month', f.t_utc) FROM workout_hr_file f JOIN workouts w USING (workout_id) GROUP BY ALL
        ORDER BY 1, 2, 3""").df()
    months = {k: sorted(g.m) for k, g in mo.groupby(["metric", "device_class"])}

    def spans(k, cls, a, b):
        ms = months.get((k, cls))
        if not ms:
            return [[str(a.date()), str(b.date())]]
        out, start, prev = [], ms[0], ms[0]
        for m in ms[1:]:
            if (m - prev).days > 183:
                out.append([start, prev])
                start = m
            prev = m
        out.append([start, prev])
        res = [[str(x.date()), str((y + pd.offsets.MonthEnd(0)).date())] for x, y in out]
        res[0][0], res[-1][1] = str(a.date()), str(b.date())
        return res
    metrics = []
    for k in TIMELINE:
        s_ = sa[sa.metric == k]
        if not len(s_):
            continue
        for cls in ["watch", "phone", "other"]:
            c = s_[s_.device_class == cls]
            if len(c) and int(c.n.sum()) >= 3:
                a, b = c.first_utc.min(), c.last_utc.max()
                metrics.append({"key": k, "name": METRIC_NAMES.get(k, k), "cls": cls, "from": str(a.date()), "to": str(b.date()), "n": int(c.n.sum()),
                                "spans": spans(k, cls, a, b)})
    return {"devices": devices, "sources": sources, "metrics": metrics}


def sources_used(con, export_date: str) -> list[dict]:
    """The sources this build actually drew on, for the About page."""
    out = [{"name": "Apple Health export", "detail": "export.xml and workout-routes/*.gpx, exported " + export_date[:10]}]
    sv = con.execute("""SELECT count(*), min(local_date), max(local_date) FROM workouts_clean WHERE source_name = 'Strava'""").fetchone()
    if sv[0]:
        out.append({"name": "Strava archive", "detail": f"{sv[0]:,} workouts kept from activities.csv and the original FIT, TCX and GPX files, {sv[1]} to {sv[2]}; copies of workouts already in Health dropped"})
    wx = dict(con.execute("SELECT split_part(weather_source, ':', 2), count(*) FROM workouts_enriched WHERE weather_source LIKE 'api:%' GROUP BY 1").fetchall())
    names = {"open-meteo": ("Open-Meteo historical archive", "hourly weather (ERA5 reanalysis, a model, not a station reading) at a 0.25° grid cell; CC BY 4.0"),
             "noaa": ("NOAA GHCNh", "hourly observations from the nearest weather station; public domain"),
             "nasa-power": ("NASA POWER", "hourly MERRA-2 reanalysis on a 0.5° grid; public domain")}
    for k, n in sorted(wx.items()):
        if k in names:
            out.append({"name": names[k][0], "detail": f"{names[k][1]} ({n:,} workouts)"})
    if (OUT / "streets.json").exists():
        st = json.loads((OUT / "streets.json").read_text())
        src = st.get("network_source", "")
        name = "Street network (local file)" if src.startswith("file:") else "OpenStreetMap"
        out.append({"name": name, "detail": f"walkable streets and paths near home ({src}); {st.get('attribution', '')}"})
    return out


# ------------------------------------------------------------------ main
def run() -> dict:
    con = paths.connect()
    con.execute("SET threads=1")
    if OUT.exists():
        for p in OUT.glob("*.parquet"):
            p.unlink()
    OUT.mkdir(parents=True, exist_ok=True)
    home = con.execute("SELECT lat, lon FROM home").fetchone()
    export_date = con.execute("SELECT v FROM _meta WHERE k='export_date'").fetchone()[0]
    params = dict(con.execute("SELECT k, v FROM params").fetchall())
    info = json.loads(con.execute("SELECT info FROM derive_info").fetchone()[0])
    w = con.execute("SELECT * FROM workouts_final ORDER BY start_utc, workout_id").df()
    out = {}
    with Timer("places"):
        places = name_places(con, w)
    with Timer("routes"):
        ri = export_routes(con, w, home)
        con.register("ri_df", ri)
        out["route_points"] = int(ri.route_n.sum())
    with Timer("workouts.parquet"):
        con.register("pl_df", places[["place_id", "name"]])
        copy_parquet(con, """
            SELECT w.workout_id AS id, w.type, w.activity_type, w.setting, w.source_name, coalesce(w.device_hardware, '') AS hardware, w.title,
                   strftime(w.local_date, '%Y-%m-%d') AS date,
                   CAST(hour(w.start_local) + minute(w.start_local) / 60.0 + second(w.start_local) / 3600.0 AS DOUBLE) AS start_h,
                   CAST(w.duration_s AS DOUBLE) AS duration_s, CAST(w.elapsed_s AS DOUBLE) AS elapsed_s, CAST(w.moving_s AS DOUBLE) AS moving_s,
                   w.distance_m, w.distance_source, w.pace_s_per_mi, w.gap_pace_s_per_mi, w.max_speed_ms, w.split_delta_s,
                   w.avg_hr, w.max_hr, w.hr_max_used, w.zone1_s, w.zone2_s, w.zone3_s, w.zone4_s, w.zone5_s, w.trimp, w.beats_per_mile, w.ef, w.decoupling,
                   w.steps, w.cadence_spm, w.climb_m, w.climb_source, w.climb_watch_m, w.climb_dem_m, w.climb_gps_m, w.descent_m, w.max_grade,
                   w.temp_c, w.feels_c, w.humidity, w.wind_ms, w.wind_mean_ms, w.gust_ms, w.precip_mm, w.condition, w.weather_source,
                   w.temp_health_c, w.temp_api_c, w.in_dark, w.dark_min,
                   CAST(hour(w.sunrise_local) + minute(w.sunrise_local) / 60.0 AS DOUBLE) AS sunrise_h,
                   CAST(hour(w.sunset_local) + minute(w.sunset_local) / 60.0 AS DOUBLE) AS sunset_h,
                   CAST(w.place_id AS INTEGER) AS place_id, pl.name AS place, w.loop_id, w.max_from_home_m, w.new_ground_m,
                   w.total_energy_kcal AS kcal, w.is_fragment, coalesce(w.g4_cut, false) AS g4_cut, coalesce(w.partial_track, false) AS partial_track,
                   coalesce(w.open_pause_end, false) AS open_pause_end, w.tz, w.tz_source, w.elevation_profile_source,
                   coalesce(CAST(ri.route_off AS INTEGER), -1) AS route_off, coalesce(CAST(ri.route_n AS INTEGER), 0) AS route_n,
                   coalesce(CAST(ri.share_a AS INTEGER), 0) AS share_a, coalesce(CAST(ri.share_b AS INTEGER), 0) AS share_b,
                   CAST(s.laps AS INTEGER) AS swim_laps, s.swolf, s.swolf_apple, s.main_stroke, s.pace_100yd_s, w.lap_length_m
            FROM workouts_final w LEFT JOIN ri_df ri USING (workout_id) LEFT JOIN pl_df pl ON pl.place_id = w.place_id
            LEFT JOIN swims s USING (workout_id)
            ORDER BY w.start_utc, w.workout_id""", "workouts.parquet")
    with Timer("other tables"):
        copy_parquet(con, """SELECT strftime(date, '%Y-%m-%d') AS date, steps, distance_m, flights, CAST(steps_raw_sum AS DOUBLE) AS steps_raw_sum, active_kcal,
                                    exercise_min, CAST(stand_hours AS INTEGER) AS stand_hours, resting_hr, hrv_sdnn, vo2max, walk_speed_ms, step_length_m,
                                    double_support, asymmetry, daylight_min, spo2, resp_rate, wrist_temp_c, walking_hr, foot_m,
                                    CAST(n_workouts AS INTEGER) AS n_workouts, CAST(n_foot AS INTEGER) AS n_foot, active, trimp, ctl, atl, tsb,
                                    as_active_kcal, as_exercise_min, as_stand_hours
                             FROM daily ORDER BY date""", "daily.parquet")
        copy_parquet(con, """SELECT workout_id AS id, type, distance_label, distance_m, seconds, start_offset_m, strftime(date, '%Y-%m-%d') AS date, is_pr
                             FROM best_efforts ORDER BY type, distance_m, date, id""", "best_efforts.parquet")
        copy_parquet(con, "SELECT workout_id AS id, CAST(split AS INTEGER) AS split, length_m, seconds, pace_s_per_mi, avg_hr, climb_m, descent_m, gap_pace_s_per_mi, partial FROM splits ORDER BY id, split", "splits.parquet")
        copy_parquet(con, """SELECT loop_id, label, name, CAST(place_id AS INTEGER) AS place_id, CAST(laps AS INTEGER) AS laps, median_distance_m, record_s,
                                    record_workout_id, strftime(record_date, '%Y-%m-%d') AS record_date, median_s, latest_s, strftime(latest_date, '%Y-%m-%d') AS latest_date,
                                    CAST(cw_laps AS INTEGER) AS cw_laps, CAST(ccw_laps AS INTEGER) AS ccw_laps, representative_workout_id, CAST(other_laps AS INTEGER) AS other_laps
                             FROM loops ORDER BY loop_id""", "loops.parquet")
        copy_parquet(con, "SELECT loop_id, workout_id AS id, type, strftime(date, '%Y-%m-%d') AS date, elapsed_s, direction, is_record FROM loop_laps ORDER BY loop_id, date, id", "loop_laps.parquet")
        copy_parquet(con, """SELECT record_id, label, "group", scope, CAST(year AS INTEGER) AS year, value, unit, workout_id AS id, CAST(date AS VARCHAR) AS date,
                                    runner_up_value, runner_up_workout_id AS runner_up_id, CAST(runner_up_date AS VARCHAR) AS runner_up_date
                             FROM records ORDER BY "group", record_id, scope, year""", "records.parquet")
        copy_parquet(con, "SELECT workout_id AS id, strftime(date, '%Y-%m-%d') AS date, new_ground_m, cum_new_ground_m FROM new_ground ORDER BY date, id", "new_ground.parquet")
        copy_parquet(con, "SELECT workout_id AS id, CAST(lap_seq AS INTEGER) AS lap, duration_s, length_m, stroke_style, strokes, swolf, swolf_apple, dropped FROM swim_laps ORDER BY id, lap", "swim_laps.parquet")
        if con.execute("SELECT count(*) FROM wx_model_temp").fetchone()[0]:
            copy_parquet(con, "SELECT * FROM wx_model_temp ORDER BY temp_f", "wx_model_temp.parquet")
            copy_parquet(con, "SELECT CAST(year AS INTEGER) AS year, adjusted_min, lo, hi, raw_median_min, CAST(n AS INTEGER) AS n FROM wx_model_year ORDER BY year", "wx_model_year.parquet")
        copy_parquet(con, "SELECT strftime(date, '%Y-%m-%d') AS date, sunrise_h, sunset_h, dawn_h, dusk_h FROM sun_home ORDER BY date", "sun_home.parquet")
        # the yearly, monthly and weekly aggregates behind the Volume charts (the app recomputes them per filter)
        agg = """SELECT {key}, type, setting, CAST(count(*) AS INTEGER) AS workouts, sum(distance_m) AS distance_m, sum(elapsed_s) / 3600 AS hours,
                        sum(climb_m) AS climb_m FROM workouts_final WHERE NOT is_fragment GROUP BY ALL ORDER BY ALL"""
        copy_parquet(con, agg.format(key="CAST(year(local_date) AS INTEGER) AS year"), "agg_yearly.parquet")
        copy_parquet(con, agg.format(key="strftime(local_date, '%Y-%m') AS month"), "agg_monthly.parquet")
        copy_parquet(con, agg.format(key="strftime(date_trunc('week', local_date), '%Y-%m-%d') AS week_monday"), "agg_weekly.parquet")
    with Timer("streams"):
        out["streams"] = export_streams(con, w, home)
    with Timer("contours"):
        contours = export_contours(con, places, w)
    with Timer("sleep"):
        sleep_meta = export_sleep(con)
        out["sleep_nights"] = sleep_meta["nights"] if sleep_meta else 0
    with Timer("milestones"):
        from . import milestones

        ms = milestones.load()
        milestones.write_json(ms)
        out["milestones"] = len(ms)
    with Timer("health, sensors, meta"):
        dump("health.json", export_health(con))
        dump("sensors.json", export_sensors(con))
        pl = []
        bb = con.execute("""SELECT CAST(w.place_id AS INTEGER) AS place_id, quantile_cont(p.lat, 0.02) s, quantile_cont(p.lat, 0.98) n,
                                   quantile_cont(p.lon, 0.02) w, quantile_cont(p.lon, 0.98) e
                            FROM route_points_clean p JOIN workouts_enriched w USING (workout_id) WHERE w.place_id IS NOT NULL AND p.seq % 10 = 0
                            GROUP BY 1""").df().set_index("place_id")
        for x in places.itertuples():
            b = bb.loc[int(x.place_id)] if int(x.place_id) in bb.index else None
            pl.append({"id": int(x.place_id), "name": x.name, "area": x.area if x.place_id != 0 else None, "n": int(x.n), "mi": r(x.mi, 1),
                       "first": str(x.first), "last": str(x.last),
                       "bbox": [r(b.w, 3), r(b.s, 3), r(b.e, 3), r(b.n, 3)] if b is not None else None})
        hs = con.execute("SELECT home_tz FROM tz_segments LIMIT 1").fetchone()[0]
        el = json.loads((paths.DATA / "enrich_log.json").read_text())
        meta = {
            "export_date": export_date, "home_tz": hs, "hr_max": float(params["hr_max"]), "hr_max_source": params["hr_max_source"], "hr_max_file_era": info.get("hr_max_file_era"),
            "zones_pct": paths.config()["heart_rate"]["zones_pct_of_max"], "year_min": year_min(con), "places": pl, "contours": contours,
            "sleep": sleep_meta, "eddington": info.get("eddington"),
            # which data folder these files came from (relative), so the dev server edits that folder's milestones
            "data_dir": paths.DATA.relative_to(paths.ROOT).as_posix() if paths.DATA.is_relative_to(paths.ROOT) else None, "weather_model": info.get("weather_model"), "fitness_model_start": info.get("fitness_model_start"),
            "counts": {"workouts": int(len(w)), "routes": int(len(ri)), "route_points": out["route_points"], "streams": out["streams"]},
            "enrich": {k: el.get(k) for k in ("weather_calls", "places")},
            "sources": sources_used(con, export_date) + [
                {"name": "USGS 3DEP", "detail": "1/3 arc-second (about 10 m) elevation tiles, public domain"},
                {"name": "Open-Meteo elevation", "detail": "about 90 m elevation for routes outside the United States"},
                {"name": "GeoNames (offline, via reverse_geocoder)", "detail": "place names for route clusters; CC BY 4.0"},
                {"name": "astral, timezonefinder", "detail": "sun times and time zones computed locally"},
            ],
        }
        dump("meta.json", meta)
    # hashes for the reproducibility check
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.glob("*.parquet"))}
    hashes.update({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.glob("*.bin"))})
    paths.write_json(paths.DATA / "export_hashes.json", hashes)
    con.close()
    out["files"] = len(hashes)
    return out


def main() -> None:
    print(json.dumps(run(), indent=1, default=str))


if __name__ == "__main__":
    main()
