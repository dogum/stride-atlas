"""reports/02_data_health.html: the Data health chapter as a standalone report.

Maps are drawn as projected SVG without coordinates or a basemap, and routes that
start or end near home have their first and last 200 m hidden (share-mode trim).
"""
from __future__ import annotations

import json
import math
import random

import numpy as np
import pandas as pd

from . import paths
from .geo import haversine, local_xy, seg_dist
from .report import esc, page, table, tiles, write

RULES = {
    "W1": ("Duplicate workouts merged", "workouts", "Same activity family, spans overlapping at least 80% of the shorter one. Keep the one with a route, then heart rate, then the watch, then the longer."),
    "W2": ("Indoor and route-less workouts set aside", "workouts", "HKIndoorWorkout = 1, or no route file: kept in totals and the calendar, excluded from map, pace, weather and best efforts."),
    "W3": ("Accidental starts set aside", "workouts", "Outdoor workouts under 3 minutes or 0.1 mi."),
    "W4": ("Activity relabels suggested", "suggestions", "Walks mostly faster than 11:00 /mi (run?) or above 120 ft of climb per mile (hike?). Never applied automatically."),
    "G1": ("Inaccurate GPS points dropped", "points", "hAcc above 40 m when neighbours within 10 s are better than 15 m."),
    "G2": ("GPS spikes removed", "points", "Speed in and out both above 3x the 30 s rolling median and above the activity ceiling. Two passes."),
    "G3": ("Door jitter trimmed", "routes", "Leading and trailing points that stay inside a 25 m circle for more than 45 s."),
    "G4": ("Driving removed", "routes", "Sustained 60 s or more above 12 mph on foot: cut at the end (forgot to stop), at the start, or excised in the middle."),
    "G5": ("Pauses, signal losses and jumps marked", "routes", "Gaps over 30 s with under 10 m moved are pauses; over 200 m moved, or one-sided jumps above the ceiling, are signal loss drawn dashed."),
    "G6": ("Watch and GPS distance reconciled", "routes", "Over 5% apart: the watch distance is the headline and cumulative distance is scaled to it."),
    "E2": ("Elevation smoothed before counting climb", "routes", "Savitzky–Golay (about 30 s, order 2), then ascent counted only beyond 2 m above the last low."),
    "W5": ("Left running after a final pause", "workouts", "A pause that is never resumed ends the workout for elapsed time; the watch stayed on for hours."),
    "S1": ("Phone and watch step overlap merged", "days", "Per minute: the watch if any watch sample covers it, else the phone, else other sources."),
    "H1": ("Implausible heart-rate samples dropped", "samples", "Under 35 or over 220 bpm, or isolated 40 bpm jumps within 5 s that return within 10 s."),
    "P1": ("Swim wall touches dropped", "laps", "Laps under 5 s."),
    "Z2": ("One sleep source per night", "nights", "Several sources recorded the same night: keep stages, then any asleep time, then time in bed only; the watch first; never a sum."),
    "Z4": ("Sleep written in local time as UTC, moved", "nights", "Asleep records exactly the time-zone offset away from the same app's in-bed record (Garmin Connect, 2017-18)."),
    "Z5": ("Sleep windows marked as estimates", "nights", "A source whose typical night has under 10 minutes awake is timing a sleep window, not measuring sleep: kept out of averages and records."),
    "Z1": ("Naps separated from the night", "nights", "Asleep stretches more than 90 minutes apart are separate sessions; daytime ones are naps."),
    "Z3": ("Implausible nights dropped", "nights", "One source's records spanning more than 20 hours in a night."),
    "TZ": ("Time zones resolved", "workouts", "HKTimeZone kept; fixed-offset Peloton zones mapped to the named zone; disagreements with the route location logged."),
}


def rule_chart(counts: dict[str, int]) -> str:
    items = [(k, RULES[k][0], RULES[k][1], RULES[k][2], counts.get(k, 0)) for k in RULES if counts.get(k, 0) > 0]
    items.sort(key=lambda x: -x[4])
    W, row = 760, 40
    H = len(items) * row + 10
    mx = max(c for *_, c in items)
    sx = lambda v: math.sqrt(v / mx) * (W - 200)
    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Cleaning rule counts">']
    for i, (k, name, unit, why, c) in enumerate(items):
        y = i * row
        out.append(f'<g><title>{esc(k)}: {esc(why)}</title><text x="0" y="{y + 12}" style="fill:var(--ink-2);font-family:var(--font-ui);font-size:12px">{esc(k)} · {esc(name)}</text>'
                   f'<rect x="0" y="{y + 18}" width="{max(3, sx(c)):.1f}" height="9" rx="2" style="fill:var(--s1)"/>'
                   f'<text x="{max(3, sx(c)) + 8:.1f}" y="{y + 27}">{c:,} {esc(unit)}</text></g>')
    out.append("</svg>")
    return "".join(out)


def _trim_home(lat, lon, home, radius=300.0, trim=200.0):
    """Indices to draw after hiding the first/last 200 m of tracks that start/end near home."""
    n = len(lat)
    if n < 3:
        return np.arange(n)
    cum = np.r_[0, np.cumsum(seg_dist(lat, lon))]
    lo, hi = 0, n
    if haversine(lat[0], lon[0], home[0], home[1]) < radius:
        lo = int(np.searchsorted(cum, trim))
    if haversine(lat[-1], lon[-1], home[0], home[1]) < radius:
        hi = int(np.searchsorted(cum, cum[-1] - trim))
    return np.arange(lo, max(lo, hi))


def track_svg(raw: pd.DataFrame, clean: pd.DataFrame, home, dropped_seq: set, W=560, H=360) -> str:
    lat0, lon0 = float(raw.lat.mean()), float(raw.lon.mean())
    rx, ry = local_xy(raw.lat.values, raw.lon.values, lat0, lon0)
    cx, cy = local_xy(clean.lat.values, clean.lon.values, lat0, lon0)
    x0, x1, y0, y1 = min(rx.min(), cx.min()), max(rx.max(), cx.max()), min(ry.min(), cy.min()), max(ry.max(), cy.max())
    k = min((W - 40) / max(1, x1 - x0), (H - 40) / max(1, y1 - y0))
    P = lambda x, y: (W / 2 + (x - (x0 + x1) / 2) * k, H / 2 - (y - (y0 + y1) / 2) * k)
    from .export import share_visible, zone_center
    zc = zone_center(home)
    rv = share_visible(raw.lat.values, raw.lon.values, np.r_[0, np.cumsum(seg_dist(raw.lat.values, raw.lon.values))], home, zc)
    cv = share_visible(clean.lat.values, clean.lon.values, np.r_[0, np.cumsum(seg_dist(clean.lat.values, clean.lon.values))], home, zc)
    ri = np.flatnonzero(rv)
    ci = np.flatnonzero(cv)

    def path(xs, ys, idx, gaps=None):
        d = []
        prev = None
        for j in idx:
            X, Y = P(xs[j], ys[j])
            brk = (gaps is not None and gaps[j] == 3) or prev is None or j != prev + 1
            d.append(("M" if brk else "L") + f"{X:.1f},{Y:.1f}")
            prev = j
        return "".join(d)

    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" style="background:var(--map-bg);border-radius:6px">']
    out.append(f'<path d="{path(rx, ry, ri)}" fill="none" stroke="rgba(230,103,103,.85)" stroke-width="1.4"/>')
    out.append(f'<path d="{path(cx, cy, ci, clean.gap.values)}" fill="none" stroke="#ff8f4a" stroke-width="2.6" stroke-linejoin="round"/>')
    seqs = raw.seq.values
    for j in ri:
        if seqs[j] in dropped_seq:
            X, Y = P(rx[j], ry[j])
            out.append(f'<circle cx="{X:.1f}" cy="{Y:.1f}" r="5" fill="none" stroke="#e66767" stroke-width="2"/>')
    out.append("</svg>")
    return "".join(out)


def dedupe_svg(day_rows: pd.DataFrame, merged: pd.DataFrame, title: str) -> str:
    """Intervals per device class over one local day, plus the merged choice."""
    W, H, L, R = 900, 170, 90, 120
    x = lambda h: L + (h - 5) / 19 * (W - L - R)
    rows = [("Apple Watch", "watch", "var(--s1)"), ("iPhone", "phone", "var(--s3)"), ("Merged", "merged", "var(--signal)")]
    out = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="{esc(title)}">']
    for h in range(6, 25, 2):
        out.append(f'<line x1="{x(h):.1f}" x2="{x(h):.1f}" y1="0" y2="{H - 22}" style="stroke:var(--edge-soft)"/><text x="{x(h):.1f}" y="{H - 6}" text-anchor="middle">{(h - 1) % 12 + 1}{"a" if h < 12 or h == 24 else "p"}</text>')
    for i, (lab, key, col) in enumerate(rows):
        y = 10 + i * 46
        out.append(f'<text x="0" y="{y + 18}" style="fill:var(--ink-2);font-family:var(--font-ui);font-size:12px">{lab}</text>')
        src = merged if key == "merged" else day_rows[day_rows.device_class == key]
        tot = src.v.sum()
        for r in src.itertuples():
            h = r.h
            out.append(f'<rect x="{x(h):.2f}" y="{y}" width="{max(0.8, x(h + 1 / 60) - x(h)):.2f}" height="28" style="fill:{col}" opacity="{0.45 + 0.55 * min(1, r.v / 120):.2f}"><title>{int(h):02d}:{int(round((h % 1) * 60)) % 60:02d} · {r.v:.0f} steps</title></rect>')
        out.append(f'<text x="{W - R + 12}" y="{y + 18}" style="font-size:12px;fill:var(--ink-1)">{tot:,.0f} steps</text>')
    out.append("</svg>")
    return "".join(out)


def run() -> None:
    con = paths.connect(read_only=True)
    home = con.execute("SELECT lat, lon FROM home").fetchone()
    export_date = con.execute("SELECT v FROM _meta WHERE k='export_date'").fetchone()[0]
    log = con.execute("SELECT * FROM cleaning_log").df()
    # count units per rule
    units = {
        "G1": int((log.rule_id == "G1").sum()), "G2": int((log.rule_id == "G2").sum()),
        "G3": int(log[log.rule_id == "G3"].row_key.nunique()), "G4": int(log[log.rule_id == "G4"].row_key.nunique()),
        "G5": int(log[log.rule_id == "G5"].row_key.nunique()), "G6": int(log[(log.rule_id == "G6")].row_key.nunique()),
        "E2": int(log[log.rule_id == "E2"].row_key.nunique()), "S1": int(log[log.rule_id == "S1"].row_key.str.startswith("steps:").sum()),
        "W1": int(((log.rule_id == "W1") & (log.field == "dropped")).sum()), "W2": int((log.rule_id == "W2").sum()), "W3": int((log.rule_id == "W3").sum()),
        "W4": int((log.rule_id == "W4").sum()), "W5": int((log.rule_id == "W5").sum()), "H1": int((log.rule_id == "H1").sum()), "P1": int((log.rule_id == "P1").sum()), "TZ": int(log[log.rule_id == "TZ"].row_key.nunique()),
        **{k: int((log.rule_id == k).sum()) for k in ("Z1", "Z2", "Z3", "Z4")},
        "Z5": int(pd.to_numeric(log[log.rule_id == "Z5"].after, errors="coerce").fillna(0).sum()),
    }
    body = []
    wc = con.execute("SELECT count(*) FILTER (WHERE setting='outdoor') o, count(*) n FROM workouts_clean").fetchone()
    params = dict(con.execute("SELECT k, v FROM params").fetchall())
    body.append(f"<p>Everything below is regenerated on every run from <code>cleaning_log</code> ({len(log):,} rows). Run stamp: the export date, {esc(export_date)}.</p>")
    body.append(tiles([("Workouts kept", f"{wc[1]:,}"), ("Outdoor with route", f"{wc[0]:,}"), ("Log rows", f"{len(log):,}"),
                       ("GPS points dropped", f"{units['G1'] + units['G2']:,}"), ("Routes with driving cut", f"{units['G4']}"), ("HRmax used", f"{float(params['hr_max']):.0f} bpm")]))
    body.append("<h2>1 · Cleaning rules and how often they fired</h2><div class='panel'><p class='muted'>Square-root scale so rare fixes stay visible. Hover a bar for the rule.</p>" + rule_chart(units) + "</div>")
    # Phase 1 reconciliation
    pl = json.loads(con.execute("SELECT log FROM parse_log ORDER BY run_at DESC LIMIT 1").fetchone()[0])
    inv = json.loads((paths.DATA / "inventory.json").read_text())
    rec = [
        {"k": "Record elements (Phase 0)", "v": f"{inv['elements']['Record']:,}"},
        {"k": "quantity_samples + category_samples", "v": f"{pl['merge_quantity']['total'] + pl['merge_category']['total']:,}"},
        {"k": "Exact natural-key duplicates collapsed", "v": f"{pl['natural_key_duplicates']:,}"},
        {"k": "Workout elements (Phase 0) / unique workouts", "v": f"{inv['elements']['Workout']:,} / {pl['merge_workouts']['total']:,} ({pl['workout_natural_key_duplicates']} exact duplicates)"},
        {"k": "Route files referenced / loaded", "v": f"{inv['routes']['referenced']:,} / {pl['merge_routes']['total']:,}"},
        {"k": "Route points", "v": f"{pl['merge_route_points']['total']:,}"},
    ]
    body.append("<h3>Parse reconciliation (Phase 1 check)</h3><div class='panel'>" + table([("k", "Count"), ("v", "Value", True)], rec) + "</div>")
    # HR max
    body.append(f"<h3>Maximum heart rate</h3><div class='panel'><p><b>{float(params['hr_max']):.0f} bpm</b>, {esc(params['hr_max_source'])}. Override with <code>heart_rate.max_bpm</code> in config.yaml.</p></div>")

    # 2 · raw vs cleaned
    body.append("<h2>2 · Routes, raw and cleaned</h2>")
    g4 = con.execute("""SELECT w.workout_id, w.local_date, w.type, w.g4_removed_share, w.g4_max_mph, w.distance_m, w.gps_distance_m, l.note
                        FROM workouts_clean w JOIN cleaning_log l ON l.rule_id='G4' AND l.row_key = w.workout_id
                        ORDER BY w.g4_removed_share DESC LIMIT 1""").df()
    g2 = con.execute("""SELECT split_part(row_key, ':', 1) AS workout_id, count(*) n FROM cleaning_log WHERE rule_id='G2' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1""").df()
    for title, wid, note in [("Largest G4 cut", g4.workout_id[0] if len(g4) else None, g4.note[0] if len(g4) else ""),
                             ("Most GPS spikes (G2)", g2.workout_id[0] if len(g2) else None, f"{int(g2.n[0])} spikes removed" if len(g2) else "")]:
        if not wid:
            continue
        raw = con.execute("SELECT seq, lat, lon FROM route_points WHERE workout_id=? ORDER BY seq", [wid]).df()
        cl = con.execute("SELECT orig_seq AS seq, lat, lon, gap FROM route_points_clean WHERE workout_id=? ORDER BY seq", [wid]).df()
        drop = {int(k.split(":")[1]) for k in log[(log.rule_id.isin(["G1", "G2"])) & log.row_key.str.startswith(wid + ":")].row_key}
        w = con.execute("SELECT local_date, type, distance_m, gps_distance_m, total_distance_m FROM workouts_clean WHERE workout_id=?", [wid]).fetchone()
        rawd = float(seg_dist(raw.lat.values, raw.lon.values).sum())
        body.append(f"<div class='panel'><h3>{esc(title)} · {esc(w[1])} on {esc(w[0])}</h3><p>{esc(note)}. Raw track <b>{rawd / 1609.344:.2f} mi</b>, cleaned <b>{w[3] / 1609.344:.2f} mi</b>; the watch reported {((w[4] or 0) / 1609.344):.2f} mi; headline {w[2] / 1609.344:.2f} mi.</p>"
                    + track_svg(raw, cl, home, drop) + "<p class='muted'>Red: raw GPX. Orange: cleaned. Circles: dropped points. The area around home is hidden (share-mode privacy zone).</p></div>")

    # 3 · dedupe example
    body.append("<h2>3 · Why step totals need deduplicating</h2>")
    ex = con.execute("""SELECT local_date, raw_sum, v, raw_watch, raw_phone FROM daily_quantities_clean
                        WHERE type='HKQuantityTypeIdentifierStepCount' AND raw_watch > 3000 AND raw_phone > 3000 AND local_date >= DATE '2024-01-01'
                        ORDER BY raw_sum / v DESC, local_date LIMIT 40""").df()
    if len(ex):
        day = ex.sort_values("local_date").iloc[len(ex) // 2]
        segs = con.execute("SELECT * FROM tz_segments").df()
        seg = segs[(segs.from_utc <= pd.Timestamp(day.local_date)) & (segs.to_utc > pd.Timestamp(day.local_date))]
        tz = seg.tz.iloc[0] if len(seg) else "America/New_York"
        q = f"""WITH src AS (SELECT device_class, start_utc, end_utc, value_si v, epoch(end_utc)-epoch(start_utc) dur FROM quantity_samples
                    WHERE type='HKQuantityTypeIdentifierStepCount' AND start_utc BETWEEN ?::TIMESTAMP - INTERVAL 1 DAY AND ?::TIMESTAMP + INTERVAL 2 DAY),
                ex AS (SELECT *, unnest(generate_series(date_trunc('minute', start_utc), CASE WHEN dur<=0 THEN date_trunc('minute', start_utc) ELSE date_trunc('minute', end_utc - INTERVAL 1 MICROSECOND) END, INTERVAL 1 MINUTE)) m FROM src)
                SELECT device_class, timezone('{tz}', m::TIMESTAMPTZ) ltime,
                       sum(CASE WHEN dur<=0 THEN v ELSE v*(least(epoch(end_utc), epoch(m)+60)-greatest(epoch(start_utc), epoch(m)))/dur END) v
                FROM ex GROUP BY ALL"""
        rows = con.execute(q, [str(day.local_date), str(day.local_date)]).df()
        dday = pd.Timestamp(day.local_date).date()
        rows = rows[pd.to_datetime(rows["ltime"]).dt.date == dday].copy()
        rows["h"] = pd.to_datetime(rows["ltime"]).dt.hour + pd.to_datetime(rows["ltime"]).dt.minute / 60
        md = con.execute(f"""SELECT timezone('{tz}', minute::TIMESTAMPTZ) ltime, v FROM minute_dedup WHERE type='HKQuantityTypeIdentifierStepCount'
                             AND minute BETWEEN ?::TIMESTAMP - INTERVAL 1 DAY AND ?::TIMESTAMP + INTERVAL 2 DAY""", [str(day.local_date), str(day.local_date)]).df()
        md = md[pd.to_datetime(md["ltime"]).dt.date == dday].copy()
        md["h"] = pd.to_datetime(md["ltime"]).dt.hour + pd.to_datetime(md["ltime"]).dt.minute / 60
        body.append(f"<div class='panel'><p>{esc(pd.Timestamp(day.local_date).strftime('%A %B %-d, %Y'))}. Adding both devices gives <b>{day.raw_sum:,.0f} steps</b>; the deduplicated total is <b>{day.v:,.0f}</b>, "
                    f"so the naive sum runs {(day.raw_sum / day.v - 1):.0%} high. Each sliver is one minute; shade is steps per minute.</p>" + dedupe_svg(rows, md, "Step samples by device") + "</div>")
        stats = con.execute("""SELECT count(*) n, avg(raw_sum / v) r FROM daily_quantities_clean WHERE type='HKQuantityTypeIdentifierStepCount' AND raw_watch > 0 AND raw_phone > 0""").fetchone()
        body.append(f"<p>Across {stats[0]:,} days with both devices, summing them naively would overstate steps by {stats[1] - 1:.0%} on average.</p>")

    # 4 · W4
    sug = con.execute("""SELECT s.suggest, s.reason, w.local_date, w.distance_m, w.workout_id FROM relabel_suggestions s JOIN workouts_clean w USING (workout_id) ORDER BY s.suggest, w.local_date""").df()
    body.append(f"<h2>4 · Relabel suggestions (W4)</h2><div class='panel scroll'><p>{len(sug)} walks that may be something else. Nothing is changed automatically; confirm on your phone and edit the type there if you agree.</p>"
                + table([("d", "Date"), ("s", "Maybe a"), ("r", "Why"), ("mi", "Miles", True)],
                        [{"d": pd.Timestamp(r.local_date).strftime("%b %-d, %Y"), "s": r.suggest, "r": r.reason, "mi": f"{r.distance_m / 1609.344:.2f}"} for r in sug.itertuples()]) + "</div>")
    # 5 · ten days to check
    days = con.execute("""SELECT local_date, round(v) AS steps, round(raw_watch) w, round(raw_phone) p FROM daily_quantities_clean
                          WHERE type='HKQuantityTypeIdentifierStepCount' ORDER BY local_date""").df()
    last = days.local_date.max()
    pool = days[days.local_date > last - pd.Timedelta(days=365)]
    rnd = random.Random(export_date)
    pick = pool.iloc[sorted(rnd.sample(range(len(pool)), min(10, len(pool))))]
    body.append("<h2>5 · Ten days to check on your phone</h2><div class='panel'><p>Open Health → Steps → Show All Data is not needed: the daily total on the Steps chart (D view) should be within 2% of these.</p>"
                + table([("d", "Date"), ("s", "Pipeline steps", True), ("w", "Watch alone", True), ("p", "Phone alone", True), ("h", "Health app shows"), ("ok", "Within 2%?")],
                        [{"d": pd.Timestamp(r.local_date).strftime("%a %b %-d, %Y"), "s": f"{r.steps:,.0f}", "w": f"{(r.w or 0):,.0f}", "p": f"{(r.p or 0):,.0f}", "h": "", "ok": ""} for r in pick.itertuples()]) + "</div>")
    # weather check, filled in after enrichment
    try:
        wx = con.execute("""SELECT count(*) n, avg(temp_health_c - temp_api_c) d, avg(abs(temp_health_c - temp_api_c)) ad,
                                   avg(humidity_health - humidity_api) dh FROM workouts_enriched WHERE temp_health_c IS NOT NULL AND temp_api_c IS NOT NULL""").fetchone()
        body.append(f"<h2>6 · Health weather versus Open-Meteo</h2><div class='panel'><p>{wx[0]:,} outdoor workouts have both. Mean difference (Health − API) <b>{wx[1] * 9 / 5:+.1f} °F</b> "
                    f"(mean absolute {wx[2] * 9 / 5:.1f} °F); humidity {wx[3]:+.0f} points. The archive is model reanalysis at the hour of the start, not a station reading.</p></div>")
    except Exception:
        pass
    con.close()
    write(paths.REPORTS / "02_data_health.html", page("Stride Atlas · Data health", "Phase 2 · Data health", f"Clean before clever: <em>{len(log):,} logged fixes</em>", "".join(body)))


if __name__ == "__main__":
    run()
