"""Phase 0: stream export.xml once and describe what is in it.

Nothing is loaded into tables here. The result is data/inventory.json and
reports/00_inventory.html.
"""
from __future__ import annotations

import re
import time
from collections import Counter, defaultdict
from pathlib import Path

from . import paths
from .paths import norm
from .xmlstream import iter_top

DEV_RE = re.compile(r"(\w+):([^,>]*)")


def parse_device(dev: str | None) -> dict:
    """'<<HKDevice: 0x..>, name:Apple Watch, model:Watch, hardware:Watch7,5, software:10.1>'"""
    if not dev:
        return {}
    body = dev.split(">", 1)[1] if ">" in dev else dev
    out = {}
    # hardware values contain commas ("Watch7,5"), so split on ", key:" boundaries
    for part in re.split(r",\s(?=\w+:)", body):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip(" <>")] = v.strip(" <>")
    return out


def device_class(dev: dict, source: str | None) -> str:
    model = (dev.get("model") or "").lower()
    if "watch" in model:
        return "watch"
    if "iphone" in model or "ipod" in model:
        return "phone"
    if dev:
        return "other"
    s = (source or "").lower()
    if "watch" in s:
        return "watch"
    if "iphone" in s or "phone" in s:
        return "phone"
    return "other"


class DevCache:
    def __init__(self):
        self.cache: dict[str, dict] = {}

    def get(self, dev: str | None) -> dict:
        if not dev:
            return {}
        key = dev.split(">", 1)[1] if ">" in dev else dev
        d = self.cache.get(key)
        if d is None:
            d = parse_device(dev)
            self.cache[key] = d
        return d


def run(xml: Path | None = None) -> dict:
    xml = xml or paths.export_xml()
    t0 = time.time()
    elems = Counter()
    rec_types: dict[str, dict] = {}
    type_year_class = Counter()
    sources_by_year = Counter()
    devices_by_year = Counter()
    offsets = Counter()
    rec_meta_keys = Counter()
    corr_types = Counter()
    nested_records = 0
    w_types = Counter()
    w_indoor = Counter()
    w_meta = Counter()
    w_sources = Counter()
    w_events = Counter()
    w_stats = Counter()
    w_years = Counter()
    w_with_route = Counter()
    w_route_no_ref = 0
    w_total_attr = Counter()
    w_dur_units = Counter()
    route_refs: list[str] = []
    as_count = 0
    as_min = as_max = None
    export_date = None
    me_keys: list[str] = []
    dc = DevCache()
    n = 0

    for el in iter_top(xml):
        tag = el.tag
        elems[tag] += 1
        n += 1
        if n % 2_000_000 == 0:
            print(f"  {n:,} elements, {time.time() - t0:.0f}s", flush=True)
        if tag == "Record":
            t = el.get("type")
            start = el.get("startDate") or ""
            src = norm(el.get("sourceName"))
            dev = dc.get(el.get("device"))
            cls = device_class(dev, src)
            info = rec_types.get(t)
            if info is None:
                info = rec_types[t] = {"count": 0, "units": Counter(), "first": start, "last": start, "classes": Counter(), "sources": Counter()}
            info["count"] += 1
            info["units"][el.get("unit") or ""] += 1
            s19 = start[:19]
            if s19 < info["first"][:19]:
                info["first"] = start
            if s19 > info["last"][:19]:
                info["last"] = start
            info["classes"][cls] += 1
            info["sources"][src] += 1
            y = start[:4]
            type_year_class[(t, y, cls)] += 1
            sources_by_year[(y, src, el.get("sourceVersion") or "")] += 1
            if dev:
                devices_by_year[(y, dev.get("name", ""), dev.get("model", ""), dev.get("hardware", ""))] += 1
            offsets[start[20:]] += 1
            for ch in el:
                if ch.tag == "MetadataEntry":
                    rec_meta_keys[(t, ch.get("key"))] += 1
        elif tag == "Workout":
            at = el.get("workoutActivityType")
            start = el.get("startDate") or ""
            y = start[:4]
            w_types[at] += 1
            w_years[(y, at)] += 1
            src = norm(el.get("sourceName"))
            w_sources[(src, at)] += 1
            w_dur_units[el.get("durationUnit")] += 1
            if el.get("totalDistance") is not None:
                w_total_attr["totalDistance"] += 1
            if el.get("totalEnergyBurned") is not None:
                w_total_attr["totalEnergyBurned"] += 1
            dev = dc.get(el.get("device"))
            if dev:
                devices_by_year[(y, dev.get("name", ""), dev.get("model", ""), dev.get("hardware", ""))] += 1
            sources_by_year[(y, src, el.get("sourceVersion") or "")] += 1
            offsets[start[20:]] += 1
            indoor = None
            has_route = False
            for ch in el:
                ct = ch.tag
                if ct == "MetadataEntry":
                    k = ch.get("key")
                    w_meta[k] += 1
                    if k == "HKIndoorWorkout":
                        indoor = ch.get("value")
                elif ct == "WorkoutEvent":
                    w_events[ch.get("type")] += 1
                elif ct == "WorkoutStatistics":
                    w_stats[ch.get("type")] += 1
                elif ct == "WorkoutRoute":
                    has_route = True
                    refs = [fr.get("path") for fr in ch if fr.tag == "FileReference"]
                    if refs:
                        route_refs.extend(refs)
                    else:
                        w_route_no_ref += 1
            w_indoor[(at, indoor)] += 1
            w_with_route[(at, has_route)] += 1
        elif tag == "ActivitySummary":
            as_count += 1
            dcmp = el.get("dateComponents")
            if dcmp:
                as_min = dcmp if as_min is None or dcmp < as_min else as_min
                as_max = dcmp if as_max is None or dcmp > as_max else as_max
        elif tag == "Correlation":
            corr_types[el.get("type")] += 1
            nested_records += sum(1 for ch in el if ch.tag == "Record")
        elif tag == "ExportDate":
            export_date = el.get("value")
        elif tag == "Me":
            me_keys = sorted(el.attrib.keys())

    # GPX census
    rdir = xml.parent / "workout-routes"
    found = sorted(p.name for p in rdir.glob("*.gpx")) if rdir.exists() else []
    ref_names = [Path(r).name for r in route_refs]
    ref_set, found_set = set(ref_names), set(found)
    dup_refs = [k for k, v in Counter(ref_names).items() if v > 1]

    inv = {
        "export_xml": str(xml.relative_to(paths.ROOT)) if xml.is_relative_to(paths.ROOT) else str(xml),
        "export_bytes": xml.stat().st_size,
        "export_date": export_date,
        "seconds": round(time.time() - t0, 1),
        "elements": dict(elems),
        "element_total": n,
        "nested_correlation_records": nested_records,
        "correlation_types": dict(corr_types),
        "me_attributes": me_keys,
        "offsets": dict(offsets),
        "record_types": {
            t: {
                "count": v["count"], "units": dict(v["units"]), "first": v["first"], "last": v["last"],
                "classes": dict(v["classes"]), "sources": dict(v["sources"].most_common(8)),
            }
            for t, v in sorted(rec_types.items())
        },
        "type_year_class": [[t, y, c, k] for (t, y, c), k in sorted(type_year_class.items())],
        "sources_by_year": [[y, s, v, k] for (y, s, v), k in sorted(sources_by_year.items())],
        "devices_by_year": [[y, nm, m, hw, k] for (y, nm, m, hw), k in sorted(devices_by_year.items())],
        "record_metadata_keys": [[t, k, c] for (t, k), c in sorted(rec_meta_keys.items())],
        "workouts": {
            "types": dict(w_types.most_common()),
            "by_year": [[y, t, c] for (y, t), c in sorted(w_years.items())],
            "indoor": [[t, f, c] for (t, f), c in sorted(w_indoor.items(), key=lambda x: (x[0][0], str(x[0][1])))],
            "metadata_keys": dict(w_meta.most_common()),
            "sources": [[s, t, c] for (s, t), c in sorted(w_sources.items())],
            "events": dict(w_events.most_common()),
            "statistics": dict(w_stats.most_common()),
            "with_route": [[t, r, c] for (t, r), c in sorted(w_with_route.items())],
            "route_without_file_reference": w_route_no_ref,
            "total_attributes": dict(w_total_attr),
            "duration_units": dict(w_dur_units),
        },
        "routes": {
            "referenced": len(route_refs),
            "referenced_unique": len(ref_set),
            "found": len(found),
            "referenced_not_found": sorted(ref_set - found_set),
            "found_not_referenced": sorted(found_set - ref_set),
            "duplicate_references": dup_refs,
        },
        "activity_summaries": {"count": as_count, "first": as_min, "last": as_max},
    }
    # checks
    inv["checks"] = {
        "elements_sum_equals_total": sum(elems.values()) == n,
        "record_types_sum_equals_records": sum(v["count"] for v in rec_types.values()) == elems.get("Record", 0),
        "workout_types_sum_equals_workouts": sum(w_types.values()) == elems.get("Workout", 0),
        "routes_referenced_minus_found": len(ref_set - found_set),
        "routes_found_minus_referenced": len(found_set - ref_set),
    }
    paths.write_json(paths.DATA / "inventory.json", inv)
    print(f"inventory: {n:,} elements in {inv['seconds']}s", flush=True)
    return inv


if __name__ == "__main__":
    run()


# ---------------------------------------------------------------- report
SHORT = lambda t: (t or "").replace("HKQuantityTypeIdentifier", "").replace("HKCategoryTypeIdentifier", "").replace("HKWorkoutActivityType", "").replace("HKWorkoutEventType", "")

EXPECTED_TYPES = [
    "StepCount", "DistanceWalkingRunning", "FlightsClimbed", "AppleExerciseTime", "ActiveEnergyBurned", "HeartRate",
    "RestingHeartRate", "HeartRateVariabilitySDNN", "VO2Max", "WalkingSpeed", "WalkingStepLength",
    "WalkingDoubleSupportPercentage", "WalkingAsymmetryPercentage", "OxygenSaturation", "RunningPower",
    "RunningStrideLength", "RunningVerticalOscillation", "RunningGroundContactTime", "TimeInDaylight",
    "AppleSleepingWristTemperature", "DistanceSwimming", "SwimmingStrokeCount", "SleepAnalysis",
]


def differences(inv: dict) -> list[str]:
    """Differences between this export and docs/HEALTH_EXPORT.md, phrased for DECISIONS.md."""
    out = []
    offs = inv["offsets"]
    if len(offs) == 1:
        out.append(f"Every timestamp carries the same UTC offset ({next(iter(offs))}), the phone's offset at export time, even for winter dates and trips. Local time must come from real time-zone rules (HKTimeZone metadata, else timezonefinder on the route, else the home zone), never from the offset.")
    present = {SHORT(t) for t in inv["record_types"]}
    missing = [t for t in EXPECTED_TYPES if t not in present]
    if missing:
        out.append("Expected record types not present: " + ", ".join(missing) + ".")
    extra = sorted(present - set(EXPECTED_TYPES))
    if extra:
        out.append("Additional record types present: " + ", ".join(extra) + ".")
    w = inv["workouts"]
    if w["metadata_keys"].get("HKIndoorWorkout", 0) > inv["elements"].get("Workout", 0):
        out.append("Workout MetadataEntry children are written twice per workout (once before and once after the statistics and route children). Metadata is deduplicated by key.")
    if not w["total_attributes"]:
        out.append("No workout carries totalDistance/totalEnergyBurned attributes; totals come only from WorkoutStatistics children.")
    if w["events"].get("HKWorkoutEventTypeLap"):
        out.append("Swim lap events carry an HKSWOLFScore metadata value; the pipeline still computes SWOLF from strokes and seconds and compares.")
    out.append("Known export behavior (handled): GPX route file names can carry the route's local end time rather than its start, so routes are joined through FileReference only.")
    out.append("Known export behavior (handled): GPX points with <vAcc>-1</vAcc> have no GPS altitude, even when <ele> says 0; they are treated as missing elevation, never 0 m.")
    srcs = sorted({s for _, s, _, _ in inv["sources_by_year"]})
    nbsp = [s for s in srcs if "\u00a0" in s]
    if nbsp:
        out.append(f"{len(nbsp)} source name(s) contain a non-breaking space (e.g. '{nbsp[0].replace(chr(160), ' ')}'). Device class comes from the device string, so this does not split a device.")
    return out


def render(inv: dict) -> None:
    from .report import esc, page, table, tiles, write

    E = inv["elements"]
    w = inv["workouts"]
    checks = inv["checks"]
    ck = lambda b: '<span class="ok">pass</span>' if b else '<span class="bad">fail</span>'
    body = []
    body.append(f"<p>Export written {esc(inv['export_date'])}. One streaming pass over <code>{esc(inv['export_xml'])}</code> ({inv['export_bytes']/1e9:.2f} GB) in {inv['seconds']} s, with nothing loaded into tables.</p>")
    body.append(tiles([
        ("Elements", f"{inv['element_total']:,}"), ("Records", f"{E.get('Record',0):,}"), ("Workouts", f"{E.get('Workout',0):,}"),
        ("Route files", f"{inv['routes']['found']:,}"), ("Activity days", f"{inv['activity_summaries']['count']:,}"), ("Record types", f"{len(inv['record_types'])}"),
    ]))
    body.append("<h2>Checks</h2><div class='panel'>" + table([("k", "Check"), ("v", "Result")], [
        {"k": "Element counts add up to the element total", "v": ck(checks["elements_sum_equals_total"]) + f" &nbsp;<span class='mono'>{sum(E.values()):,} = {inv['element_total']:,}</span>"},
        {"k": "Per-type record counts add up to the Record total", "v": ck(checks["record_types_sum_equals_records"])},
        {"k": "Per-type workout counts add up to the Workout total", "v": ck(checks["workout_types_sum_equals_workouts"])},
        {"k": "Routes referenced = routes found", "v": ck(checks["routes_referenced_minus_found"] == 0 and checks["routes_found_minus_referenced"] == 0) + f" &nbsp;<span class='mono'>{inv['routes']['referenced']:,} referenced, {inv['routes']['found']:,} found, exceptions: {len(inv['routes']['referenced_not_found']) + len(inv['routes']['found_not_referenced'])}</span>"},
    ]) + "</div>")
    body.append("<h2>Differences from the expected export shape</h2><div class='panel'><ul>" + "".join(f"<li>{esc(d)}</li>" for d in differences(inv)) + "</ul><p class='muted'>Each is recorded in docs/DECISIONS.md with how the pipeline handles it. None changes the data model.</p></div>")
    body.append("<h2>Elements</h2><div class='panel'>" + table([("e", "Element"), ("n", "Count", True)], [{"e": k, "n": f"{v:,}"} for k, v in sorted(E.items(), key=lambda x: -x[1])]) + "</div>")
    rows = []
    for t, v in sorted(inv["record_types"].items(), key=lambda x: -x[1]["count"]):
        rows.append({"t": SHORT(t), "n": f"{v['count']:,}", "u": ", ".join(f"{k or '—'}" for k in v["units"]), "a": v["first"][:10], "b": v["last"][:10],
                     "c": " ".join(f"<span class='pill'>{esc(k)} {n:,}</span>" for k, n in sorted(v["classes"].items(), key=lambda x: -x[1])) or "<span></span>",
                     "s": "; ".join(f"{k} ({n:,})" for k, n in list(v["sources"].items())[:3])})
    body.append("<h2>Record types</h2><div class='panel scroll'>" + table([("t", "Type"), ("n", "Count", True), ("u", "Unit"), ("a", "First"), ("b", "Last"), ("c", "Device class"), ("s", "Top sources")], rows) + "</div>")
    # workouts
    ind = defaultdict(dict)
    for t, f, c in w["indoor"]:
        ind[t][{"1": "indoor", "0": "outdoor", None: "not set"}[f]] = c
    rt = defaultdict(dict)
    for t, r, c in w["with_route"]:
        rt[t]["route" if r else "no route"] = c
    wrows = [{"t": SHORT(t), "n": f"{c:,}", "i": ", ".join(f"{k} {v}" for k, v in ind[t].items()), "r": ", ".join(f"{k} {v}" for k, v in rt[t].items())} for t, c in w["types"].items()]
    body.append("<h2>Workouts</h2><div class='panel'>" + table([("t", "Activity"), ("n", "Count", True), ("i", "HKIndoorWorkout"), ("r", "Route")], sorted(wrows, key=lambda r: -int(r["n"].replace(",", "")))) + "</div>")
    by = defaultdict(dict)
    acts = sorted({SHORT(t) for _, t, _ in w["by_year"]})
    for y, t, c in w["by_year"]:
        by[y][SHORT(t)] = c
    body.append("<h3>By year</h3><div class='panel'>" + table([("y", "Year")] + [(a, a, True) for a in acts], [dict(y=y, **{a: by[y].get(a, "") for a in acts}) for y in sorted(by)]) + "</div>")
    src = [{"s": s, "t": SHORT(t), "n": c} for s, t, c in w["sources"]]
    body.append("<h3>Workout sources</h3><div class='panel'>" + table([("s", "Source"), ("t", "Activity"), ("n", "Count", True)], src) + "</div>")
    body.append("<h3>Workout metadata keys, events and statistics</h3><div class='panel'>" +
                table([("k", "MetadataEntry key"), ("n", "Entries", True)], [{"k": k, "n": f"{v:,}"} for k, v in w["metadata_keys"].items()]) +
                table([("k", "WorkoutEvent type"), ("n", "Count", True)], [{"k": SHORT(k), "n": f"{v:,}"} for k, v in w["events"].items()]) +
                table([("k", "WorkoutStatistics type"), ("n", "Count", True)], [{"k": SHORT(k), "n": f"{v:,}"} for k, v in w["statistics"].items()]) + "</div>")
    # devices and sources by year
    dev = [{"y": y, "n": nm, "m": m, "h": hw, "c": f"{k:,}"} for y, nm, m, hw, k in inv["devices_by_year"] if k >= 50]
    body.append("<h2>Devices by year</h2><div class='panel scroll'>" + table([("y", "Year"), ("n", "Name"), ("m", "Model"), ("h", "Hardware"), ("c", "Samples", True)], dev) + "</div>")
    sy = defaultdict(lambda: [0, set()])
    for y, s, v, k in inv["sources_by_year"]:
        sy[(y, s)][0] += k
        sy[(y, s)][1].add(v)
    srows = [{"y": y, "s": s, "v": ", ".join(sorted(vs)[:6]) + (" …" if len(vs) > 6 else ""), "n": f"{n:,}"} for (y, s), (n, vs) in sorted(sy.items())]
    body.append("<h2>Sources and versions by year</h2><div class='panel scroll'>" + table([("y", "Year"), ("s", "sourceName"), ("v", "sourceVersion"), ("n", "Rows", True)], srows) + "</div>")
    a = inv["activity_summaries"]
    body.append(f"<h2>Activity summaries</h2><div class='panel'><p>{a['count']:,} daily summaries from {a['first']} to {a['last']}.</p></div>")
    body.append(f"<h2>Route files</h2><div class='panel'><p>{inv['routes']['referenced']:,} FileReference paths, {inv['routes']['referenced_unique']:,} unique, {inv['routes']['found']:,} GPX files in <code>workout-routes/</code>. Referenced but missing: {len(inv['routes']['referenced_not_found'])}. Present but unreferenced: {len(inv['routes']['found_not_referenced'])}. Workouts with a WorkoutRoute but no FileReference: {w['route_without_file_reference']}.</p></div>")
    write(paths.REPORTS / "00_inventory.html", page("Stride Atlas · Inventory", "Phase 0 · Inventory", f"{inv['element_total']:,} elements, <em>{E.get('Workout',0):,} workouts</em>", "".join(body)))


def main() -> None:
    inv = run()
    render(inv)
