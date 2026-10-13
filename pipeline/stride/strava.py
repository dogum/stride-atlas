"""Phase 1b (optional): workouts from a Strava bulk export.

Strava's "Download your data" zip holds activities.csv plus one original file per activity under activities/
(.fit.gz from Garmin watches, .tcx.gz from Peloton and older uploads, .gpx). `make unzip` extracts only those
two into data/raw/strava/ (read-only); everything else in the zip (messages, followers, logins, media) is
never read.

Each activity becomes rows in the same tables parse.py fills, keyed `strava-<activity id>` and with
source_name 'Strava', so cleaning, enrichment and derivation treat it like any other workout:
    workouts, workout_metadata, workout_events (timer pauses, swim lengths), workout_stats (heart rate),
    routes + route_points (GPS), quantity_samples (swim stroke counts only)
Heart rate recorded inside a file goes to workout_hr_file, tied to its workout, rather than to
quantity_samples: a Strava copy of a workout the watch also recorded would otherwise double the samples.
Overlaps with Apple Health workouts are settled by rule W1 in clean.py (keep the copy with a route, then
heart rate, then the native source).
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from lxml import etree

from . import paths
from .paths import Timer

DIR = paths.RAW / "strava"
SEMI = 180.0 / 2 ** 31  # FIT semicircles to degrees
STRAVA_TYPE = {"Run": "Running", "Ride": "Cycling", "Swim": "Swimming", "Hike": "Hiking", "Walk": "Walking", "Workout": "Other",
               "VirtualRide": "Cycling", "VirtualRun": "Running", "WeightTraining": "TraditionalStrengthTraining", "Yoga": "Yoga"}
TYPE_OF = {"Running": "run", "Cycling": "ride", "Swimming": "swim", "Hiking": "hike", "Walking": "walk",
           "TraditionalStrengthTraining": "strength", "CrossTraining": "cross"}
# the device's own sport wins for gym sessions that Strava filed as runs
FIT_SPORT = {("training", "strength_training"): "TraditionalStrengthTraining", ("training", "cardio_training"): "CrossTraining"}
INDOOR_SUB = {"treadmill", "indoor_cycling", "indoor_rowing", "virtual_activity", "indoor_running", "indoor_walking"}
PRODUCTS = {"fr920xt": "Forerunner 920XT", "fr935": "Forerunner 935", "fr945": "Forerunner 945", "fenix5": "fenix 5", "edge520": "Edge 520"}
STROKE = {"mixed": 1, "im": 1, "freestyle": 2, "backstroke": 3, "breaststroke": 4, "butterfly": 5, "drill": 6}
HR = "HKQuantityTypeIdentifierHeartRate"


def _naive(t):
    return t.astimezone(timezone.utc).replace(tzinfo=None) if t.tzinfo else t


# ------------------------------------------------------------------ file readers: one shape for all three formats
def read_fit(raw: bytes) -> dict:
    import fitdecode

    pts, hr, lengths, events, sess, dev, local = [], [], [], [], {}, {}, None
    with fitdecode.FitReader(io.BytesIO(raw)) as fr:
        for m in fr:
            if not isinstance(m, fitdecode.FitDataMessage):
                continue
            v = lambda k: m.get_value(k, fallback=None)  # noqa: E731
            if m.name == "record":
                t = v("timestamp")
                if t is None:
                    continue
                t = _naive(t)
                la, lo = v("position_lat"), v("position_long")
                if la is not None and lo is not None:
                    pts.append((t, la * SEMI, lo * SEMI, v("enhanced_altitude") if v("enhanced_altitude") is not None else v("altitude"),
                                v("enhanced_speed") if v("enhanced_speed") is not None else v("speed")))
                if v("heart_rate"):
                    hr.append((t, float(v("heart_rate"))))
            elif m.name == "length" and v("length_type") == "active" and v("start_time") is not None:
                lengths.append((_naive(v("start_time")), float(v("total_elapsed_time") or 0), v("total_strokes"), v("swim_stroke")))
            elif m.name == "event" and v("event") == "timer" and v("timestamp") is not None:
                events.append((_naive(v("timestamp")), v("event_type")))
            elif m.name == "session" and not sess:
                sess = {k: v(k) for k in ("sport", "sub_sport", "start_time", "total_elapsed_time", "total_timer_time", "total_distance",
                                          "total_calories", "total_ascent", "total_descent", "avg_heart_rate", "max_heart_rate", "pool_length")}
            elif m.name == "file_id":
                dev = {"maker": v("manufacturer"), "product": v("garmin_product") or v("product")}
            elif m.name == "device_info" and v("device_index") == "creator" and v("software_version") is not None:
                dev["software"] = str(v("software_version"))
            elif m.name == "activity" and v("local_timestamp") is not None and v("timestamp") is not None:
                local = round((_naive(v("local_timestamp")) - _naive(v("timestamp"))).total_seconds() / 60)
    start = _naive(sess["start_time"]) if sess.get("start_time") else (pts[0][0] if pts else None)
    return {"format": "fit", "pts": pts, "hr": hr, "lengths": lengths, "events": events, "sess": sess, "dev": dev, "offset_min": local, "start": start}


TCX_NS = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2", "x": "http://www.garmin.com/xmlschemas/ActivityExtension/v2"}


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def read_tcx(raw: bytes) -> dict:
    root = etree.fromstring(raw.lstrip())  # Strava's TCX files sometimes start with whitespace before the declaration
    act = root.find(".//t:Activity", TCX_NS)
    pts, hr, watts = [], [], []
    laps = act.findall("t:Lap", TCX_NS) if act is not None else []
    for tp in root.iterfind(".//t:Trackpoint", TCX_NS):
        ts = tp.findtext("t:Time", namespaces=TCX_NS)
        if not ts:
            continue
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
        la, lo = tp.findtext("t:Position/t:LatitudeDegrees", namespaces=TCX_NS), tp.findtext("t:Position/t:LongitudeDegrees", namespaces=TCX_NS)
        if la is not None and lo is not None:
            pts.append((t, float(la), float(lo), _num(tp.findtext("t:AltitudeMeters", namespaces=TCX_NS)), _num(tp.findtext(".//x:Speed", namespaces=TCX_NS))))
        b = _num(tp.findtext("t:HeartRateBpm/t:Value", namespaces=TCX_NS))
        if b:  # Peloton writes 0.0 when no strap was paired: missing, not zero
            hr.append((t, b))
        w = _num(tp.findtext(".//x:Watts", namespaces=TCX_NS))
        if w is not None:
            watts.append(w)
    creator = root.findtext(".//t:Creator/t:Name", namespaces=TCX_NS) or ""
    tot = lambda tag: sum(x for x in (_num(l.findtext(f"t:{tag}", namespaces=TCX_NS)) for l in laps) if x is not None)  # noqa: E731, E741
    start = laps[0].get("StartTime") if laps else None
    start = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None) if start else (pts[0][0] if pts else None)
    timer = tot("TotalTimeSeconds")
    sess = {"sport": (act.get("Sport") if act is not None else None), "total_distance": tot("DistanceMeters") or None,
            "total_calories": tot("Calories") or None, "total_timer_time": timer or None,
            "avg_watts": float(np.mean(watts)) if watts else None, "work_kj": float(np.sum(watts)) / 1000 if watts else None}
    return {"format": "tcx", "pts": pts, "hr": hr, "lengths": [], "events": [], "sess": sess, "dev": {"creator": creator}, "offset_min": None, "start": start}


def read_gpx(raw: bytes) -> dict:
    root = etree.fromstring(raw.lstrip())
    ns = {"g": root.nsmap.get(None, "http://www.topografix.com/GPX/1/1")}
    pts, hr = [], []
    for p in root.iterfind(".//g:trkpt", ns):
        ts = p.findtext("g:time", namespaces=ns)
        if not ts:
            continue
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
        pts.append((t, float(p.get("lat")), float(p.get("lon")), _num(p.findtext("g:ele", namespaces=ns)), None))
        b = next((_num(e.text) for e in p.iter() if isinstance(e.tag, str) and e.tag.endswith("}hr")), None)
        if b:
            hr.append((t, b))
    return {"format": "gpx", "pts": pts, "hr": hr, "lengths": [], "events": [], "sess": {}, "dev": {"creator": root.get("creator") or ""},
            "offset_min": None, "start": pts[0][0] if pts else None}


def read_file(rel: str) -> dict:
    p = DIR / rel
    raw = p.read_bytes()
    if rel.endswith(".gz"):
        raw = gzip.decompress(raw)
    base = rel[:-3] if rel.endswith(".gz") else rel
    try:
        return read_fit(raw) if base.endswith(".fit") else read_tcx(raw) if base.endswith(".tcx") else read_gpx(raw)
    except Exception as e:  # one unreadable file must not stop the import; it is reported
        return {"error": f"{type(e).__name__}: {str(e)[:160]}"}


# ------------------------------------------------------------------ activities.csv
def read_csv() -> pd.DataFrame:
    df = pd.read_csv(DIR / "activities.csv", dtype=str, keep_default_na=False)
    # the export repeats some headers ('Distance' in km for display, then in metres); pandas suffixes the second '.1'
    num = lambda c: pd.to_numeric(df.get(c, pd.Series([""] * len(df))).replace("", None), errors="coerce")  # noqa: E731
    out = pd.DataFrame({
        "id": df["Activity ID"], "name": df["Activity Name"], "type": df["Activity Type"], "file": df["Filename"].replace("", None),
        "start": pd.to_datetime(df["Activity Date"], format="%b %d, %Y, %I:%M:%S %p"),  # UTC
        "elapsed_s": num("Elapsed Time.1").fillna(num("Elapsed Time")), "moving_s": num("Moving Time"),
        "distance_m": num("Distance.1"), "kcal": num("Calories"), "avg_hr": num("Average Heart Rate"), "max_hr": num("Max Heart Rate.1"),
        "gain_m": num("Elevation Gain"),
    })
    return out.sort_values(["start", "id"]).reset_index(drop=True)


def fingerprint() -> str:
    h = hashlib.sha256((DIR / "activities.csv").read_bytes())
    for p in sorted((DIR / "activities").glob("*")):
        h.update(f"{p.name}:{p.stat().st_size}".encode())
    return h.hexdigest()[:16]


# ------------------------------------------------------------------ rows
def build(acts: pd.DataFrame, files: dict[str, dict], version: str) -> tuple[dict[str, pd.DataFrame], dict]:
    W, M, E, ST, R, P, Q, H = [], [], [], [], [], [], [], []
    rep = {"activities": len(acts), "with_gps": 0, "with_hr": 0, "unreadable": [], "types": {}}
    for a in acts.itertuples():
        f = files.get(a.file) if a.file else None
        if f and "error" in f:
            rep["unreadable"].append(f"{a.file}: {f['error']}")
            f = None
        f = f or {"pts": [], "hr": [], "lengths": [], "events": [], "sess": {}, "dev": {}, "offset_min": None, "start": None}
        s = f["sess"]
        wid = f"strava-{a.id}"
        at = STRAVA_TYPE.get(a.type, "Other")
        at = FIT_SPORT.get((s.get("sport"), s.get("sub_sport")), at)
        start = f["start"] or a.start.to_pydatetime()
        elapsed = s.get("total_elapsed_time") or a.elapsed_s or 0.0
        if f["pts"]:
            elapsed = max(elapsed, (f["pts"][-1][0] - start).total_seconds())
        end = start + timedelta(seconds=float(elapsed))
        timer = s.get("total_timer_time") or (a.moving_s if pd.notna(a.moving_s) else None) or elapsed
        d = f["dev"]
        creator = d.get("creator", "")
        if d.get("product") or "Forerunner" in creator or "Garmin" in creator:
            prod = d.get("product") or creator  # a FIT product code (fr920xt), or the TCX creator's full name
            dev = ("watch", PRODUCTS.get(prod, re.sub(r"^Garmin\s+", "", prod)), "Garmin", prod, d.get("software"))
        elif creator.startswith("Peloton"):
            dev = ("other", creator, "Peloton", creator, None)
        else:
            dev = ("other", creator or None, None, None, None)
        indoor = (s.get("sub_sport") in INDOOR_SUB) or creator.startswith("Peloton")
        W.append({"workout_id": wid, "activity_type": at, "type": TYPE_OF.get(at, "other"), "source_name": "Strava", "source_version": version,
                  "device_class": dev[0], "device_name": dev[1], "device_model": dev[2], "device_hardware": dev[3], "device_software": dev[4],
                  "start_utc": start, "end_utc": end, "creation_utc": start, "tz_offset_min": f["offset_min"], "duration_s": float(timer),
                  # Strava's own distance, so each workout matches the app it would be checked against (as Apple's
                  # match the Fitness app); the device's odometer is kept as metadata
                  "total_distance_m": (a.distance_m if pd.notna(a.distance_m) and a.distance_m > 0 else None) or s.get("total_distance"),
                  "total_energy_kcal": s.get("total_calories") or (a.kcal if pd.notna(a.kcal) and a.kcal > 0 else None),
                  "indoor_flag": True if indoor else None, "hk_timezone": None, "meta_conflicts": None})
        rep["types"][at] = rep["types"].get(at, 0) + 1

        def meta(k, v, num=None, unit=None, si=None, unit_si=None):
            M.append({"workout_id": wid, "key": k, "value": None if v is None else str(v), "value_num": num, "unit": unit, "value_si": si, "unit_si": unit_si})
        meta("StravaActivityId", a.id)
        meta("StravaName", a.name or None)
        meta("SourceFile", a.file)
        if indoor:
            meta("HKIndoorWorkout", "1", 1.0)
        if s.get("total_distance"):
            meta("DeviceDistance", f"{s['total_distance']:.1f} m", float(s["total_distance"]), "m", float(s["total_distance"]), "m")
        if s.get("total_ascent") is not None and f["pts"]:
            meta("HKElevationAscended", f"{s['total_ascent']} m", float(s["total_ascent"]), "m", float(s["total_ascent"]), "m")
        if at == "Swimming":
            loc = "2" if s.get("sub_sport") == "open_water" or f["pts"] else "1"
            meta("HKSwimmingLocationType", loc, float(loc))
            if s.get("pool_length"):
                meta("HKLapLength", f"{s['pool_length']} m", float(s["pool_length"]), "m", float(s["pool_length"]), "m")
        if s.get("avg_watts") is not None:
            meta("AverageWatts", f"{s['avg_watts']:.1f}", round(s["avg_watts"], 1), "W", round(s["avg_watts"], 1), "W")
            meta("TotalWork", f"{s['work_kj']:.1f} kJ", round(s["work_kj"], 1), "kJ", round(s["work_kj"] * 1000, 1), "J")

        # timer stops and starts inside the activity become pauses, as the Workout app writes them
        ev = []
        for t, kind in sorted(f["events"]):
            if kind in ("stop", "stop_all", "stop_disable", "stop_disable_all") and start < t < end - timedelta(seconds=2):
                ev.append((t, "Pause"))
            elif kind == "start" and ev and ev[-1][1] == "Pause":
                ev.append((t, "Resume"))
        for t, kind in ev:
            E.append({"workout_id": wid, "type": kind, "date_utc": t, "duration_s": 0.0, "meta": None})
        for t, secs, strokes, style in f["lengths"]:
            E.append({"workout_id": wid, "type": "Lap", "date_utc": t, "duration_s": secs, "meta": json.dumps({"HKSwimmingStrokeStyle": STROKE.get(style, 0)})})
            if strokes is not None:
                Q.append({"type": "HKQuantityTypeIdentifierSwimmingStrokeCount", "source_name": "Strava", "source_version": version, "device_class": dev[0],
                          "device_name": dev[1], "device_model": dev[2], "device_hardware": dev[3], "device_software": dev[4], "unit": "count",
                          "value": float(strokes), "value_si": float(strokes), "unit_si": "count", "start_utc": t, "end_utc": t + timedelta(seconds=secs),
                          "creation_utc": t, "tz_offset_min": f["offset_min"], "meta": None})

        bpm = [b for _, b in f["hr"] if 30 <= b <= 230]
        if bpm:
            rep["with_hr"] += 1
            ST.append({"workout_id": wid, "type": "HeartRate", "start_utc": start, "end_utc": end, "unit": "count/min", "average": float(np.mean(bpm)),
                       "minimum": float(np.min(bpm)), "maximum": float(np.max(bpm)), "sum": None, "average_si": float(np.mean(bpm)),
                       "minimum_si": float(np.min(bpm)), "maximum_si": float(np.max(bpm)), "sum_si": None, "unit_si": "count/min"})
            seen = set()
            for t, b in f["hr"]:
                if 30 <= b <= 230 and t not in seen:
                    seen.add(t)
                    H.append({"workout_id": wid, "t_utc": t, "bpm": b})
        if f["pts"]:
            rep["with_gps"] += 1
            ele = [p[3] for p in f["pts"]]
            R.append({"workout_id": wid, "file": f"strava/{a.file}", "source_name": "Strava", "source_version": version, "start_utc": f["pts"][0][0],
                      "end_utc": f["pts"][-1][0], "creation_utc": start, "meta": None, "n_points": len(f["pts"]),
                      "ele_valid": int(sum(1 for e in ele if e is not None and -500 < e < 9000))})
            last = None
            for t, la, lo, el, sp in f["pts"]:
                if t == last:  # repeated timestamps carry no new position
                    continue
                last = t
                P.append((wid, t, la, lo, el, sp))
    route_points = pd.DataFrame(P, columns=["workout_id", "t_utc", "lat", "lon", "ele_m", "speed_ms"])
    route_points["seq"] = route_points.groupby("workout_id").cumcount().astype("int32")
    for c in ("course", "hacc_m", "vacc_m"):
        route_points[c] = np.nan
    route_points["segment"] = np.int8(0)
    route_points = route_points[["workout_id", "seq", "t_utc", "lat", "lon", "ele_m", "speed_ms", "course", "hacc_m", "vacc_m", "segment"]]
    ev = pd.DataFrame(E, columns=["workout_id", "type", "date_utc", "duration_s", "meta"])
    ev["seq"] = ev.sort_values(["workout_id", "date_utc"]).groupby("workout_id").cumcount()
    tables = {"workouts": pd.DataFrame(W), "workout_metadata": pd.DataFrame(M), "workout_events": ev, "workout_stats": pd.DataFrame(ST),
              "routes": pd.DataFrame(R), "route_points": route_points, "quantity_samples": pd.DataFrame(Q),
              "workout_hr_file": pd.DataFrame(H, columns=["workout_id", "t_utc", "bpm"])}
    return tables, rep


ORDER = {"workouts": "start_utc, workout_id", "workout_metadata": "workout_id, key", "workout_events": "workout_id, seq",
         "workout_stats": "workout_id, type", "routes": "workout_id, file", "route_points": "workout_id, seq",
         "quantity_samples": "type, source_name, device_class, start_utc, end_utc, value", "workout_hr_file": "workout_id, t_utc"}


def run(force: bool = False) -> dict:
    con = paths.connect()
    con.execute("CREATE TABLE IF NOT EXISTS workout_hr_file (workout_id VARCHAR, t_utc TIMESTAMP, bpm DOUBLE)")
    if not (DIR / "activities.csv").exists():
        con.close()
        print("strava: no export in data/raw/strava (optional; see docs/HEALTH_EXPORT.md)")
        return {"skipped": "no Strava export"}
    fp = fingerprint()
    prev = con.execute("SELECT v FROM _meta WHERE k = 'strava_fingerprint'").fetchone()
    has_rows = con.execute("SELECT count(*) FROM workouts WHERE source_name = 'Strava'").fetchone()[0] > 0
    if prev and prev[0] == fp and has_rows and not force:
        con.close()
        print("strava: export unchanged since last run; nothing to do")
        return {"skipped": "unchanged"}
    with Timer("strava files"):
        acts = read_csv()
        rels = sorted(set(acts.file.dropna()))
        with ProcessPoolExecutor() as ex:
            files = dict(zip(rels, ex.map(read_file, rels, chunksize=8)))
        version = "strava-export"
        tables, rep = build(acts, files, version)
    with Timer("strava merge"):
        # replace every Strava row, so a newer export (or a fixed reader) never leaves stale copies behind
        for name, df in tables.items():
            cond = "source_name = 'Strava'" if name in ("workouts", "quantity_samples") else "workout_id LIKE 'strava-%'"
            con.execute(f"DELETE FROM {name} WHERE {cond}")
            if len(df):
                con.register("s_df", df)
                cols = [c[0] for c in con.execute(f"DESCRIBE {name}").fetchall()]
                con.execute(f"INSERT INTO {name} SELECT {', '.join(c if c in df.columns else 'NULL' for c in cols)} FROM s_df")
                con.unregister("s_df")
            con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM {name} ORDER BY {ORDER[name]}")
        from .parse import build_devices, build_sensor_availability

        build_devices(con)
        build_sensor_availability(con)
        con.execute("INSERT OR REPLACE INTO _meta VALUES ('strava_fingerprint', ?)", [fp])
    rep["route_points"] = int(len(tables["route_points"]))
    rep["first"], rep["last"] = str(acts.start.min()), str(acts.start.max())
    con.close()
    paths.write_json(paths.DATA / "strava_log.json", rep)
    return rep


def main() -> None:
    import sys

    print(json.dumps(run(force="--force" in sys.argv), indent=1, default=str))


if __name__ == "__main__":
    main()
