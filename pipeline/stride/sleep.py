"""Sleep: one row per night and its stage timeline, from the SleepAnalysis records of every source, with the vitals
the watch records while you sleep. Rules Z1–Z3 in docs/CLEANING.md; metrics in docs/METRICS.md.

An export holds sleep from several eras and sources at once: another watch synced through its app (Garmin Connect,
Fitbit), sleep apps (AutoSleep, Pillow), the iPhone's bedtime schedule (time in bed only), the Apple Watch (asleep from
watchOS 7, stages from watchOS 9), and sometimes two watches on the same night. They overlap, so each night keeps one
source, chosen by what it measured; nights are never added together.

Tables: sleep_nights (one row per night), sleep_runs (the chosen source's timeline as runs of one stage).
"""
from __future__ import annotations

import json
import re

import numpy as np
import pandas as pd

from . import paths
from .paths import Timer

# stage codes, also used by the app; higher wins where one source's records overlap (Apple writes InBed under the stages)
INBED, ASLEEP, CORE, DEEP, REM, AWAKE = 1, 2, 3, 4, 5, 6
STAGE = {"InBed": INBED, "Asleep": ASLEEP, "AsleepUnspecified": ASLEEP, "AsleepCore": CORE, "AsleepDeep": DEEP, "AsleepREM": REM, "Awake": AWAKE}
SLEEPING = (ASLEEP, CORE, DEEP, REM)
NIGHT_START_H = 18      # Z1: a night runs from 18:00 to 18:00 the next day and is named by the evening's date
SESSION_GAP_MIN = 90    # Z1: asleep stretches further apart than this are separate sessions
NAP_MIN = 10            # a daytime session shorter than this is noise, not a nap
NAP_MAX = 4 * 60        # and one longer than this is a misplaced record, not a nap
MAX_SPAN_MIN = 20 * 60  # Z3: a source's records spanning more than this in one night are a stuck record, cut to the asleep part
MIN_NIGHT_MIN = 60      # Z1: less than an hour asleep is not a night's sleep (it can still be a nap)


def source_label(name: str) -> str:
    """A source name without the owner's name: "Alex’s Apple Watch" -> "Apple Watch"."""
    n = unicodedata_clean(name)
    n = re.sub(r"^.*?[’']s\s+", "", n)
    return {"Clock": "iPhone bedtime (Clock)", "Connect": "Garmin Connect"}.get(n, n)


def unicodedata_clean(s: str) -> str:
    return " ".join(str(s).replace(" ", " ").split())


def load(con) -> pd.DataFrame:
    df = con.execute("""
        SELECT c.start_utc, c.end_utc, c.value, c.source_name, c.device_class, s.tz
        FROM category_samples c ASOF JOIN tz_segments s ON c.start_utc >= s.from_utc
        WHERE c.type = 'HKCategoryTypeIdentifierSleepAnalysis' AND c.end_utc > c.start_utc
        ORDER BY c.start_utc, c.end_utc, c.source_name, c.value""").df()
    if df.empty:
        return df
    df["code"] = df.value.str.replace("HKCategoryValueSleepAnalysis", "", regex=False).map(STAGE).fillna(0).astype(int)
    df = df[df.code > 0].copy()
    # local wall-clock time where the sleep happened (the time-zone timeline, as for workouts)
    loc_s, loc_e = pd.Series(pd.NaT, index=df.index), pd.Series(pd.NaT, index=df.index)
    for tz, g in df.groupby("tz"):
        loc_s[g.index] = g.start_utc.dt.tz_localize("UTC").dt.tz_convert(tz).dt.tz_localize(None)
        loc_e[g.index] = g.end_utc.dt.tz_localize("UTC").dt.tz_convert(tz).dt.tz_localize(None)
    df["s_loc"], df["e_loc"] = pd.to_datetime(loc_s), pd.to_datetime(loc_e)
    df["shifted"] = False
    df = fix_local_as_utc(df)
    df["night"] = (df.s_loc - pd.Timedelta(hours=NIGHT_START_H)).dt.normalize()
    df["is_watch"] = (df.device_class == "watch") | df.source_name.str.contains("Watch")
    return df


def fix_local_as_utc(df: pd.DataFrame) -> pd.DataFrame:
    """Z4: some apps (Garmin Connect in 2017-18) wrote asleep records in local time labelled as UTC, so they sit exactly
    the time-zone offset away from the same app's own in-bed record. An asleep record that lies inside none of its
    source's in-bed records, but inside one once moved by the offset, is moved."""
    off = (df.s_loc - df.start_utc)                    # local minus UTC, e.g. -5 h in an Eastern winter
    tol = pd.Timedelta(minutes=3)
    for src, g in df.groupby("source_name"):
        ib = g[g.code == INBED].sort_values("start_utc")
        sl = g[g.code.isin(SLEEPING)]
        if ib.empty or sl.empty or (g.device_class == "watch").any():
            continue
        a, b = ib.start_utc.to_numpy(), ib.end_utc.to_numpy()
        t = np.timedelta64(tol)

        def inside(s0, e0) -> bool:
            j = np.searchsorted(a, s0 + t, side="right") - 1
            return any(a[k] - t <= s0 and e0 <= b[k] + t for k in range(max(0, j - 1), min(len(a), j + 1)))

        for i, r in sl.iterrows():
            if inside(np.datetime64(r.start_utc), np.datetime64(r.end_utc)):
                continue                                   # where it belongs already
            d = -off[i]
            if inside(np.datetime64(r.start_utc + d), np.datetime64(r.end_utc + d)):
                df.loc[i, ["start_utc", "end_utc"]] = [r.start_utc + d, r.end_utc + d]
                df.loc[i, ["s_loc", "e_loc"]] = [r.s_loc + d, r.e_loc + d]
                df.loc[i, "shifted"] = True
    return df


def timeline(g: pd.DataFrame, base: pd.Timestamp) -> np.ndarray:
    """One source's records for one night as a minute grid from 18:00 (Z3: overlaps merged, the more specific stage wins)."""
    grid = np.zeros(24 * 60 + 12 * 60, dtype=np.int8)   # room for a night that runs past 18:00 the next day
    a = ((g.s_loc - base).dt.total_seconds() // 60).clip(0, len(grid)).astype(int).to_numpy()
    b = np.ceil((g.e_loc - base).dt.total_seconds() / 60).clip(0, len(grid)).astype(int).to_numpy()
    for lo, hi, c in sorted(zip(a, b, g.code.to_numpy()), key=lambda t: t[2]):   # ascending precedence: later wins
        if hi > lo:
            grid[lo:hi] = np.maximum(grid[lo:hi], c)
    return grid


def sessions(grid: np.ndarray) -> list[tuple[int, int, int]]:
    """Z1: asleep stretches merged across gaps of up to 90 minutes, as (onset, wake, asleep minutes)."""
    asleep = np.isin(grid, SLEEPING)
    idx = np.flatnonzero(asleep)
    if not len(idx):
        return []
    out, s, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev > SESSION_GAP_MIN:
            out.append((s, prev + 1, int(asleep[s:prev + 1].sum())))
            s = i
        prev = i
    out.append((s, prev + 1, int(asleep[s:prev + 1].sum())))
    return out


def night_row(night: pd.Timestamp, g: pd.DataFrame, n_src: int) -> tuple[dict, list[tuple[int, int, int]]] | None:
    base = night + pd.Timedelta(hours=NIGHT_START_H)
    grid = timeline(g, base)
    ses = sessions(grid)
    # the night is every session that starts between 20:00 and 08:00; other daytime sessions are naps
    in_night = [x for x in ses if 2 * 60 <= x[0] < 14 * 60]
    main = in_night if sum(x[2] for x in in_night) >= MIN_NIGHT_MIN else []
    naps = [x for x in ses if x not in main and NAP_MIN <= x[2] <= NAP_MAX]
    staged = bool(np.isin(grid, (CORE, DEEP, REM)).any())
    ses = [x for x in ses if x[2] >= NAP_MIN]
    row = {"date": night.date(), "source": source_label(g.source_name.iloc[0]), "cls": "stages" if staged else "asleep" if main else "inbed",
           "n_src": n_src, "naps": len(naps), "nap_min": int(sum(x[2] for x in naps)) if naps else 0}
    inbed = np.flatnonzero(grid == INBED) if (grid == INBED).any() else np.flatnonzero(grid > 0)
    if main:
        on, off = main[0][0], main[-1][1]
        if off - on > MAX_SPAN_MIN:
            return None
        span = grid[on:off]
        asleep = int(np.isin(span, SLEEPING).sum())
        runs = np.flatnonzero(np.diff(np.r_[0, (span == AWAKE).astype(np.int8), 0]))
        wakes = sum(1 for a, b in zip(runs[0::2], runs[1::2]) if b - a >= 2)
        ib = np.flatnonzero(grid[:on] == INBED)
        ib_on = int(ib[0]) if len(ib) and (on - ib[0]) < 4 * 60 else None
        row.update(onset_h=NIGHT_START_H + on / 60, wake_h=NIGHT_START_H + off / 60, asleep_min=asleep, awake_min=int(off - on - asleep),
                   deep_min=int((span == DEEP).sum()), rem_min=int((span == REM).sum()), core_min=int((span == CORE).sum()),
                   unspec_min=int((span == ASLEEP).sum()), eff=round(asleep / max(1, off - on), 4), wakes=wakes,
                   bed_h=NIGHT_START_H + (ib_on if ib_on is not None else on) / 60, latency_min=(on - ib_on) if ib_on is not None else None)
        row["_on"], row["_off"] = on, off
        # an estimate, not a measurement: asleep exactly as long as in bed, with no time awake (old sleep-window
        # tracking such as Garmin's in 2018). Shown, but kept out of averages and records.
        row["est"] = bool(not staged and row["awake_min"] == 0 and g.code.eq(INBED).any() and int((grid == INBED).sum()) <= 5)
    elif len(inbed):
        on, off = int(inbed[0]), int(inbed[-1] + 1)
        if off - on > MAX_SPAN_MIN:
            return None
        row.update(bed_h=NIGHT_START_H + on / 60, up_h=NIGHT_START_H + off / 60, inbed_min=int(off - on))
        row["_on"], row["_off"] = on, off
    else:
        return None
    if main and len(inbed):
        row["up_h"] = NIGHT_START_H + max(int(inbed[-1] + 1), main[-1][1]) / 60
        row["inbed_min"] = int(round((row["up_h"] - row["bed_h"]) * 60))
    # the timeline as runs of one stage, for the barcode and the one-night view
    nz = np.flatnonzero(grid)
    runs: list[tuple[int, int, int]] = []
    if len(nz):
        seg = grid[nz[0]:nz[-1] + 1]
        cut = np.flatnonzero(np.diff(seg)) + 1
        for a, b in zip(np.r_[0, cut], np.r_[cut, len(seg)]):
            if seg[a]:
                runs.append((int(nz[0] + a), int(b - a), int(seg[a])))
    return row, runs


def build(con) -> tuple[pd.DataFrame, pd.DataFrame, list[tuple]]:
    df = load(con)
    if df.empty:
        return pd.DataFrame(), pd.DataFrame(), []
    log: list[tuple] = []
    rows, runs = [], []
    for night, g in df.groupby("night", sort=True):
        # Z2: one source per night: stages, then any asleep time, then time in bed only; the watch before other
        # sources; then the most asleep minutes. Never a sum of sources.
        cand = []
        for src, h in g.groupby("source_name", sort=True):
            asleep = ((h.e_loc - h.s_loc).dt.total_seconds()[h.code.isin(SLEEPING)]).sum() / 60
            cand.append(((2 if h.code.isin((CORE, DEEP, REM)).any() else 1 if h.code.isin(SLEEPING).any() else 0, bool(h.is_watch.any()), round(asleep)), src))
        cand.sort(key=lambda t: (t[0], t[1]), reverse=True)
        src = cand[0][1]
        if len(cand) > 1:
            log.append(("Z2", "category_samples", str(night.date()), "source", "; ".join(c[1] for c in cand), src, f"{len(cand)} sources that night"))
        g1 = g[g.source_name == src]
        r = night_row(night, g1, len(cand))
        if r is None:
            log.append(("Z3", "category_samples", str(night.date()), "night", src, None, "records span more than 20 h: dropped"))
            continue
        row, rr = r
        row["tz"] = g1.tz.iloc[0]
        if g1.shifted.any():
            log.append(("Z4", "category_samples", str(night.date()), "start_utc", None, None,
                        f"{int(g1.shifted.sum())} asleep records written in local time as UTC: moved by the time-zone offset"))
        rows.append(row)
        for a, n, c in rr:
            runs.append((str(night.date()), a, n, c))
        if row.get("naps"):
            log.append(("Z1", "category_samples", str(night.date()), "naps", None, row["naps"], f"{row['nap_min']} min asleep outside the night"))
    nights = pd.DataFrame(rows)
    # Z5: a source that almost never records time awake (its typical night has under 10 minutes) is tracking a sleep
    # window, not sleep: its nights are estimates, shown and labelled but kept out of averages and records
    if not nights.empty and "awake_min" in nights:
        # judged on nights without stages (a stage-recording source measures wake), and only with a week of them
        un = nights[nights.asleep_min.notna() & nights.cls.eq("asleep")]
        stat = un.groupby("source").awake_min.agg(["median", "size"])
        med = stat[stat["size"] >= 7]["median"]
        for src in med[med < 10].index:
            m = nights.source.eq(src) & nights.asleep_min.notna() & nights.cls.eq("asleep")
            nights.loc[m, "est"] = True
            log.append(("Z5", "category_samples", src, "est", None, int(m.sum()), f"median {med[src]:.0f} min awake a night: a sleep window, not sleep"))
    nights["est"] = nights.get("est", pd.Series(False, index=nights.index)).fillna(False).astype(bool)
    rdf = pd.DataFrame(runs, columns=["date", "start_min", "minutes", "stage"])
    return nights, rdf, log


def vitals(con, nights: pd.DataFrame) -> pd.DataFrame:
    """Overnight vitals inside each main sleep: lowest and median heart rate, HRV, breathing rate, blood oxygen; the
    wrist temperature and breathing disturbances the watch writes per night; and sleep-apnea notification windows."""
    have = nights[nights.onset_h.notna()][["date", "tz", "onset_h", "wake_h"]].copy()
    if have.empty:
        return pd.DataFrame(columns=["date"])
    day = pd.to_datetime(have.date)
    on_loc = day + pd.to_timedelta(have.onset_h, unit="h")
    off_loc = day + pd.to_timedelta(have.wake_h, unit="h")
    on_utc, off_utc = pd.Series(pd.NaT, index=have.index), pd.Series(pd.NaT, index=have.index)
    for tz, g in have.groupby("tz"):
        on_utc[g.index] = on_loc[g.index].dt.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward").dt.tz_convert("UTC").dt.tz_localize(None)
        off_utc[g.index] = off_loc[g.index].dt.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward").dt.tz_convert("UTC").dt.tz_localize(None)
    w = pd.DataFrame({"date": have.date.astype(str), "a": pd.to_datetime(on_utc), "b": pd.to_datetime(off_utc)}).dropna()
    con.register("nw", w)
    q = lambda t: f"'HKQuantityTypeIdentifier{t}'"
    v = con.execute(f"""
        WITH s AS (
            SELECT nw.date, q.type, q.value_si AS v FROM nw JOIN quantity_samples_clean q
              ON q.start_utc >= nw.a AND q.start_utc < nw.b
            WHERE q.type IN ({q('HeartRate')}, {q('HeartRateVariabilitySDNN')}, {q('RespiratoryRate')}, {q('OxygenSaturation')}) AND q.device_class = 'watch'),
        per AS (
            -- the nightly values sit near the sleep: anything starting within the 18:00-to-18:00 night that holds it
            SELECT nw.date, q.type, q.value_si AS v, abs(epoch(q.start_utc) - epoch(nw.a)) AS dist FROM nw JOIN quantity_samples_clean q
              ON q.start_utc >= nw.a - INTERVAL 6 HOUR AND q.start_utc < nw.b + INTERVAL 6 HOUR
            WHERE q.type IN ({q('AppleSleepingWristTemperature')}, {q('AppleSleepingBreathingDisturbances')}))
        SELECT d.date,
          min(v) FILTER (WHERE type = {q('HeartRate')}) AS hr_min, median(v) FILTER (WHERE type = {q('HeartRate')}) AS hr_med,
          median(v) FILTER (WHERE type = {q('HeartRateVariabilitySDNN')}) AS hrv,
          median(v) FILTER (WHERE type = {q('RespiratoryRate')}) AS resp,
          median(v) FILTER (WHERE type = {q('OxygenSaturation')}) AS spo2, min(v) FILTER (WHERE type = {q('OxygenSaturation')}) AS spo2_min,
          (SELECT arg_min(v, dist) FROM per WHERE per.date = d.date AND per.type = {q('AppleSleepingWristTemperature')}) AS temp_c,
          (SELECT arg_min(v, dist) FROM per WHERE per.date = d.date AND per.type = {q('AppleSleepingBreathingDisturbances')}) AS bdist
        FROM (SELECT DISTINCT date FROM nw) d LEFT JOIN s ON s.date = d.date GROUP BY d.date ORDER BY d.date""").df()
    con.unregister("nw")
    # wrist temperature as the watch shows it: the change from your own recent baseline (median of the previous 30 nights)
    v = v.sort_values("date").reset_index(drop=True)
    t = v.temp_c
    base = t.shift(1).rolling(30, min_periods=5).median()
    v["temp_dev_c"] = (t - base).round(3)
    return v


def apnea_windows(con) -> list[dict]:
    r = con.execute("""SELECT CAST(start_utc AS DATE) AS a, CAST(end_utc AS DATE) AS b FROM category_samples
                       WHERE type = 'HKCategoryTypeIdentifierSleepApneaEvent' ORDER BY 1""").fetchall()
    return [{"from": str(a), "to": str(b)} for a, b in r]


def run() -> dict:
    con = paths.connect()
    out: dict = {}
    with Timer("sleep nights (Z1-Z3)"):
        nights, runs, log = build(con)
    if nights.empty:
        for t in ("sleep_nights", "sleep_runs"):
            con.execute(f"DROP TABLE IF EXISTS {t}")
        print(json.dumps({"nights": 0}))
        return {"nights": 0}
    with Timer("overnight vitals"):
        v = vitals(con, nights)
    nights["date"] = nights.date.astype(str)
    nights = nights.merge(v, on="date", how="left").drop(columns=[c for c in ("_on", "_off") if c in nights.columns])
    home_tz = con.execute("SELECT home_tz FROM tz_segments LIMIT 1").fetchone()[0]
    nights["away"] = nights.tz != home_tz
    con.register("n_df", nights)
    con.execute("CREATE OR REPLACE TABLE sleep_nights AS SELECT * FROM n_df ORDER BY date")
    con.unregister("n_df")
    con.register("r_df", runs)
    con.execute("CREATE OR REPLACE TABLE sleep_runs AS SELECT * FROM r_df ORDER BY date, start_min")
    con.unregister("r_df")
    con.execute("CREATE OR REPLACE TABLE sleep_info AS SELECT ? AS info", [json.dumps({"apnea_windows": apnea_windows(con)})])
    # the sleep rules' rows in cleaning_log, replaced on every run
    run_at = con.execute("SELECT max(run_at) FROM cleaning_log").fetchone()[0] if con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'cleaning_log'").fetchone()[0] else None
    if run_at is not None:
        con.execute("DELETE FROM cleaning_log WHERE rule_id LIKE 'Z%'")
        if log:
            ld = pd.DataFrame([(*r, run_at) for r in log], columns=["rule_id", "table_name", "row_key", "field", "before", "after", "note", "run_at"])
            con.register("l_df", ld)
            con.execute("INSERT INTO cleaning_log SELECT * FROM l_df")
            con.unregister("l_df")
    cls = nights.cls.value_counts().to_dict()
    out = {"nights": len(nights), "estimated": int(nights.est.sum()), "stages": int(cls.get("stages", 0)), "asleep": int(cls.get("asleep", 0)), "inbed_only": int(cls.get("inbed", 0)),
           "multi_source_nights": int((nights.n_src > 1).sum()), "naps": int(nights.naps.sum()), "first": nights.date.min(), "last": nights.date.max(),
           "runs": len(runs)}
    print(json.dumps(out, indent=1))
    return out


def main() -> None:
    run()


if __name__ == "__main__":
    main()
