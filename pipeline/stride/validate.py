"""Phase 6: reports/06_validation.md, plus the closing checks (pytest, app build, Parquet hashes).

Numbers to compare against the Health and Fitness apps, every record with its date, cleaning
counts by rule, and the list of things the pipeline could not do.
"""
from __future__ import annotations

import json
import random
import subprocess
from datetime import datetime, timedelta, timezone

import pandas as pd

from . import paths

MI = 1609.344
FT = 3.28084


def fmt_dur(s):
    if s is None or pd.isna(s):
        return "—"
    s = int(round(s))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def md_table(cols: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    out += ["| " + " | ".join("" if v is None else str(v) for v in r) + " |" for r in rows]
    return "\n".join(out)


def run_checks() -> dict:
    res = {}
    t = subprocess.run(["uv", "run", "pytest", "-q"], cwd=paths.ROOT, capture_output=True, text=True)
    res["pytest"] = {"ok": t.returncode == 0, "tail": (t.stdout.strip().splitlines() or [""])[-1]}
    app = paths.ROOT / "app"
    if (app / "node_modules").exists():
        b = subprocess.run(["npm", "run", "build"], cwd=app, capture_output=True, text=True)
        tail = [ln for ln in (b.stdout + b.stderr).strip().splitlines() if ln.strip()][-1:] or [""]
        res["app_build"] = {"ok": b.returncode == 0, "tail": tail[0][:200]}
    else:
        res["app_build"] = {"ok": None, "tail": "app/node_modules missing; run make app"}
    from .verify import digest

    ref = paths.DATA / "export_hashes.reference.json"
    if paths.APP_DATA.exists():
        cur = {k: v for k, v in digest(paths.APP_DATA).items() if not k.startswith("streams/")}
        if ref.exists():
            prev = json.loads(ref.read_text())
            diff = sorted(k for k in set(cur) | set(prev) if cur.get(k) != prev.get(k))
            res["hashes"] = {"ok": not diff, "tail": f"all {len(cur)} Parquet, binary and JSON outputs identical to the clean-room build (make verify-clean)" if not diff else "differs: " + ", ".join(diff)}
        else:
            res["hashes"] = {"ok": None, "tail": "no reference yet (run make verify-clean)"}
    return res


def run(checks: bool = True) -> None:
    con = paths.connect(read_only=True)
    export_date = con.execute("SELECT v FROM _meta WHERE k='export_date'").fetchone()[0]
    params = dict(con.execute("SELECT k, v FROM params").fetchall())
    rnd = random.Random("validation|" + export_date)
    w = con.execute("""SELECT workout_id, local_date, start_local, type, activity_type, setting, source_name, distance_m, duration_s, elapsed_s, moving_s,
                              avg_hr, avg_hr_source, climb_m, climb_source, total_energy_kcal, steps
                       FROM workouts_final ORDER BY start_utc, workout_id""").df()
    last = pd.Timestamp(w.local_date.max())
    pool = w[(pd.to_datetime(w.local_date) > last - pd.Timedelta(days=365)) & w.type.isin(["walk", "hike", "run", "strength", "swim", "ride"])]
    pick = pool.iloc[sorted(rnd.sample(range(len(pool)), min(10, len(pool))))]
    L = []
    L.append("# Stride Atlas · Validation\n")
    L.append(f"Export of **{export_date}**, validated {datetime.now(timezone.utc).date().isoformat()} on this computer. Fill the blank columns from the Health and Fitness apps on your phone; anything more than a couple of percent off is worth a look.\n")

    if checks:
        c = run_checks()
        L.append("## Checks\n")
        mark = lambda ok: "pass" if ok else ("n/a" if ok is None else "**fail**")
        inv = json.loads((paths.DATA / "inventory.json").read_text())
        pl = json.loads(con.execute("SELECT log FROM parse_log ORDER BY run_at DESC LIMIT 1").fetchone()[0])
        el = json.loads((paths.DATA / "enrich_log.json").read_text())
        n_rec = pl["merge_quantity"]["total"] + pl["merge_category"]["total"] + pl["natural_key_duplicates"]
        fast = con.execute("""WITH s AS (SELECT p.gap, (p.cum_gps_m - lag(p.cum_gps_m) OVER w) / NULLIF(epoch(p.t_utc) - epoch(lag(p.t_utc) OVER w), 0) AS v
                                FROM route_points_clean p JOIN workouts_clean c USING (workout_id) WHERE c.type = 'walk'
                                WINDOW w AS (PARTITION BY p.workout_id ORDER BY p.seq))
                              SELECT max(v) / 0.44704 FROM s WHERE gap = 0""").fetchone()[0]
        no_t = con.execute("SELECT count(*) FROM workouts_enriched WHERE setting = 'outdoor' AND temp_c IS NULL").fetchone()[0]
        L.append(md_table(["Check", "Result", "Detail"], [
            ["Phase 0: element counts add up; routes referenced = found", mark(inv["checks"]["elements_sum_equals_total"] and inv["checks"]["routes_referenced_minus_found"] == 0),
             f"{inv['element_total']:,} elements; {inv['routes']['referenced']:,} routes referenced, {inv['routes']['found']:,} found"],
            ["Phase 1: parsed rows reconcile with the inventory", mark(n_rec == inv["elements"]["Record"]),
             f"{n_rec:,} = {inv['elements']['Record']:,} records ({pl['natural_key_duplicates']:,} exact duplicates collapsed)"],
            ["Phase 2: no walk segment faster than 12 mph after cleaning", mark(fast is not None and fast < 12), f"fastest moving walk segment {fast:.2f} mph"],
            ["Phase 2: 10 daily step totals within 2% of the Health app", "n/a", "needs your phone: section 2 below"],
            ["Phase 3: zero outdoor workouts without temperature", mark(no_t == 0), f"{no_t} missing"],
            ["Phase 3: a re-run makes zero network calls", mark(el.get("network_calls") == 0) if el.get("network_calls") == 0 or el.get("cache_hits") else "n/a",
             f"{el.get('network_calls')} calls, {el.get('cache_hits')} cache hits on the last run" + ("" if el.get("network_calls") == 0 or el.get("cache_hits") else " (a first run fetches; run `make enrich` again to check)")],
            ["`pytest` (parse fixture, track rules, metrics)", mark(c["pytest"]["ok"]), c["pytest"]["tail"]],
            ["App builds (`npm run build`)", mark(c["app_build"]["ok"]), c["app_build"]["tail"]],
            ["Parquet and route buffers reproduce byte for byte", mark(c.get("hashes", {}).get("ok")), c.get("hashes", {}).get("tail", "")],
        ]) + "\n")

    L.append("## 1 · Ten random workouts from the last year\n")
    L.append("Workout time is the active duration the watch reports (Fitness shows it as Workout Time); elapsed includes pauses. Climb is Elevation Gain.\n")
    rows = []
    for r in pick.itertuples():
        rows.append([pd.Timestamp(r.start_local).strftime("%a %b %-d, %Y %-I:%M %p"), r.activity_type + (" (indoor)" if r.setting == "indoor" else " (no route)" if r.setting == "no_route" else ""), r.source_name,
                     f"{r.distance_m / MI:.2f} mi" if r.distance_m and r.distance_m > 0 else "—", fmt_dur(r.duration_s), fmt_dur(r.elapsed_s),
                     f"{r.avg_hr:.0f}" if pd.notna(r.avg_hr) else "—", f"{r.climb_m * FT:.0f} ft" if pd.notna(r.climb_m) else "—", "", "", "", ""])
    L.append(md_table(["Start", "Type", "Source", "Distance", "Workout time", "Elapsed", "Avg HR", "Climb", "Fitness: distance", "Fitness: time", "Fitness: avg HR", "Fitness: elev. gain"], rows) + "\n")

    L.append("## 2 · Monthly steps and walking distance, last 12 months\n")
    L.append("Deduplicated per minute (watch first, then phone). Compare with Health → Steps / Walking + Running Distance → M view.\n")
    m = con.execute("""SELECT strftime(local_date, '%Y-%m') AS month,
                              sum(v) FILTER (WHERE type='HKQuantityTypeIdentifierStepCount') AS steps,
                              sum(v) FILTER (WHERE type='HKQuantityTypeIdentifierDistanceWalkingRunning') AS dist,
                              count(DISTINCT local_date) AS days
                       FROM daily_quantities_clean WHERE local_date > ?::DATE - INTERVAL 13 MONTH GROUP BY 1 ORDER BY 1""", [str(last.date())]).df().tail(13)
    L.append(md_table(["Month", "Steps", "Daily average", "Walking + running", "Days with data", "Health app shows"],
                      [[r.month, f"{r.steps:,.0f}", f"{r.steps / max(1, r.days):,.0f}", f"{r.dist / MI:,.1f} mi", int(r.days), ""] for r in m.itertuples()]) + "\n")
    dq = con.execute("""SELECT local_date, round(v) FROM daily_quantities_clean WHERE type='HKQuantityTypeIdentifierStepCount' ORDER BY local_date""").df()
    dq.columns = ["d", "steps"]
    pool_d = dq[pd.to_datetime(dq.d) > last - pd.Timedelta(days=365)]
    rdays = random.Random(export_date)
    pd_ = pool_d.iloc[sorted(rdays.sample(range(len(pool_d)), min(10, len(pool_d))))]
    L.append("### Ten days to check (same list as reports/02_data_health.html)\n")
    L.append(md_table(["Date", "Pipeline steps", "Health app shows", "Within 2%?"], [[pd.Timestamp(r.d).strftime("%a %b %-d, %Y"), f"{r.steps:,.0f}", "", ""] for r in pd_.itertuples()]) + "\n")

    L.append("## 3 · Every record, with its date\n")
    recs = con.execute("""SELECT "group", label, value, unit, date, workout_id, runner_up_value, runner_up_date FROM records WHERE scope='all' ORDER BY "group", label""").df()
    def fv(v, u):
        if v is None or pd.isna(v):
            return "—"
        return {"m": f"{v / MI:.2f} mi", "s": fmt_dur(v), "s/mi": f"{fmt_dur(v)} /mi", "degC": f"{v * 9 / 5 + 32:.0f}°F", "m/s": f"{v / 0.44704:.0f} mph",
                "mm": f"{v / 25.4:.2f} in", "hour": (datetime(2000, 1, 1) + timedelta(hours=float(v))).strftime("%-I:%M %p"), "min": f"{v:.0f} min",
                "fraction": f"{v:.0%}", "m/mi": f"{v * FT:.0f} ft/mi", "bpm": f"{v:.1f} bpm", "mL/kg/min": f"{v:.1f}", "steps": f"{v:,.0f}",
                "days": f"{v:.0f} days", "weeks": f"{v:.0f} weeks", "workouts": f"{v:.0f}", "sessions": f"{v:.0f}", "s/100yd": f"{fmt_dur(v)} /100 yd",
                "m/min/bpm": f"{v:.2f}"}.get(u, f"{v:,.2f}")
    rr = []
    for r in recs.itertuples():
        val = fv(r.value, r.unit)
        if r.label.startswith("Biggest climb"):
            val = f"{r.value * FT:,.0f} ft"
        if r.label.startswith("Eddington"):
            val = f"{r.value:.0f} ({r.runner_up_value:.0f} more days for the next)"
        dt = "" if r.date is None or (isinstance(r.date, float) and pd.isna(r.date)) or pd.isna(r.date) else pd.Timestamp(r.date).strftime("%b %-d, %Y")
        ru = "" if r.runner_up_value is None or pd.isna(r.runner_up_value) or r.label.startswith("Eddington") else f"{fv(r.runner_up_value, r.unit) if not r.label.startswith('Biggest climb') else f'{r.runner_up_value * FT:,.0f} ft'}" + (f", {pd.Timestamp(r.runner_up_date).strftime('%b %-d, %Y')}" if r.runner_up_date is not None and not pd.isna(r.runner_up_date) else "")
        rr.append([r.group, r.label, val, dt, ru])
    L.append(md_table(["Group", "Record", "Value", "Date", "Runner-up"], rr) + "\n")

    L.append("## 4 · Cleaning log by rule\n")
    cl = con.execute("""SELECT rule_id, table_name, count(*) AS rows, count(DISTINCT split_part(row_key, ':', 1)) AS items FROM cleaning_log GROUP BY ALL ORDER BY rule_id, table_name""").df()
    from .health_report import RULES
    L.append(md_table(["Rule", "What", "Table", "Log rows", "Distinct items"], [[r.rule_id, RULES.get(r.rule_id, ("",))[0], r.table_name, f"{r.rows:,}", f"{r.items:,}"] for r in cl.itertuples()]) + "\n")
    L.append(f"Heart-rate maximum used for zones and TRIMP: **{float(params['hr_max']):.0f} bpm** ({params['hr_max_source']}).\n")

    era = con.execute("SELECT info FROM derive_info").fetchone()
    era = json.loads(era[0]).get("hr_max_file_era") if era else None
    if era:
        L.append(f"Workouts whose heart rate came from the Garmin files ({era['from'][:4]}–{era['to'][:4]}) use **{era['hr_max']:.0f} bpm**, the same rule over that era's {era['n']:,} samples.\n")

    # ---- other sources
    sv = con.execute("""SELECT count(*) FILTER (WHERE dup_of IS NULL), count(*) FILTER (WHERE dup_of IS NOT NULL),
                               count(*) FILTER (WHERE dup_of IS NULL AND has_route) FROM workouts_all_clean WHERE source_name = 'Strava'""").fetchone()
    if sv[0] or sv[1]:
        L.append("## 5 · Other sources\n")
        L.append(f"**Strava archive.** {sv[0] + sv[1]:,} activities read; {sv[0]:,} kept ({sv[2]:,} with GPS), {sv[1]:,} dropped as copies of workouts already in Health (rule W1). "
                 "Distances are Strava's own, so check these against the Strava app:\n")
        top = con.execute("""SELECT title, type, local_date, distance_m, moving_s, elapsed_s, climb_m FROM workouts_final
                             WHERE source_name = 'Strava' AND setting = 'outdoor' ORDER BY distance_m DESC NULLS LAST LIMIT 5""").df()
        L.append(md_table(["Date", "Name", "Type", "Distance", "Moving time", "Elapsed", "Climb", "Strava: distance", "Strava: moving time", "Strava: elevation gain"],
                          [[str(r.local_date)[:10], r.title or "", r.type, f"{r.distance_m / MI:.2f} mi", fmt_dur(r.moving_s), fmt_dur(r.elapsed_s),
                            f"{r.climb_m * 3.28084:,.0f} ft" if pd.notna(r.climb_m) else "—", "", "", ""] for r in top.itertuples()]) + "\n")
    sj = paths.APP_DATA / "streets.json"
    if sj.exists():
        st = json.loads(sj.read_text())
        rows = [[f"{r['miles']} mi", f"{r['streets']['share']:.1%}", f"{r['streets']['walked_m'] / MI:.1f} of {r['streets']['total_m'] / MI:.1f} mi",
                 f"{r['paths']['share']:.1%}", f"{r['paths']['walked_m'] / MI:.1f} of {r['paths']['total_m'] / MI:.1f} mi"] for r in st["rings"]]
        L.append(f"**Street coverage near home** (OpenStreetMap, {st['network_source']}; {st['matched_share']:.1%} of on-foot GPS points matched a street or path):\n")
        L.append(md_table(["Within", "Streets walked", "Streets", "Paths & trails walked", "Paths & trails"], rows) + "\n")
    wc = paths.REPORTS / "weather_sources.md"
    if wc.exists():
        L.append("**Weather sources** compared against Apple's own workout temperatures: see `reports/weather_sources.md`.\n")

    L.append("## 6 · What the pipeline could not do, and why\n")
    hr_cov = con.execute("""SELECT year(local_date) y, median(n_hr_samples) FROM workouts_final WHERE type='walk' AND setting='outdoor' AND year(local_date) >= 2018 GROUP BY 1 ORDER BY 1""").fetchall()
    sparse = ", ".join(f"{y}: {n:.0f}" for y, n in hr_cov)
    nw, nd = con.execute("SELECT (SELECT count(*) FROM workouts_final), (SELECT count(*) FROM daily)").fetchone()
    rides = con.execute("""SELECT count(*) FILTER (WHERE setting = 'outdoor'), count(*) FILTER (WHERE setting <> 'outdoor') FROM workouts_final WHERE type = 'ride'""").fetchone()
    conn = con.execute("SELECT count(*) FROM workouts_all_clean WHERE source_name = 'Connect' AND dup_of IS NULL AND type IN ('run','walk','hike')").fetchone()[0]
    L.append("\n".join([x for x in [
        f"- **Second-by-second heart rate on the Apple Watch before 2025.** The export holds only a handful of heart-rate samples per walk (median per walk by year: {sparse}). TRIMP and zones use the watch's average and the samples that exist; the close-up shows the sparse samples as dots rather than inventing a curve. (The Garmin files from Strava carry full 1-second heart rate.)",
        "- **Comparisons with the Fitness, Health and Strava apps.** The blank columns above need your phone. The pipeline cannot read the apps' own totals.",
        "- **A labelled street basemap.** Not built: labels need font glyphs and vector tiles from the network. The Streets option draws OpenStreetMap ways near home as unlabelled lines; elsewhere the atlas shows USGS 3DEP contours (the mockup's night view) or a plain ground.",
        f"- **DuckDB-WASM in the browser.** Not used. The whole workout table is {nw:,} rows and the daily table {nd:,} days, so filtering in JS takes milliseconds; the Parquet files are read with hyparquet (a few KB) instead of a multi-MB WASM engine.",
        "- **Air quality.** Optional; skipped.",
        "- **Running power, stride and vertical oscillation charts.** The export has only 3 to 12 samples of each (November 2023), too few to chart. They appear on the Watches timeline.",
        "- **Swim water temperature.** No water-temperature samples in the export.",
        f"- **Rides.** {rides[0]:,} outdoor rides have GPS and appear on the map; {rides[1]:,} indoor rides (Peloton, trainer) appear in the hours-by-activity chart and the indoor-rides panel.",
        f"- **{conn} Garmin Connect workouts** in Health have no route file and no Strava copy, so they count in totals but cannot be mapped." if conn else None,
    ] if x]) + "\n")
    L.append("\nSee `docs/DECISIONS.md` (defaults) and `data/DECISIONS.md` (this build) for every judgment call and how to undo it, and `reports/02_data_health.html` for the cleaning evidence.\n")
    con.close()
    out = paths.REPORTS / "06_validation.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L))
    print(f"wrote {out}")


def main() -> None:
    import sys

    run(checks="--no-checks" not in sys.argv)


if __name__ == "__main__":
    main()
