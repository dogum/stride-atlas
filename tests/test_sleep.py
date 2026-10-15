"""Sleep nights (rules Z1-Z5) and life milestones, on small hand-made cases."""
import numpy as np
import pandas as pd

from stride import milestones, sleep as Z


def recs(rows, tz="America/Denver"):
    """Records as load() returns them: local times given, UTC derived for the zone."""
    df = pd.DataFrame(rows, columns=["s_loc", "e_loc", "value", "source_name", "device_class"])
    df["s_loc"], df["e_loc"] = pd.to_datetime(df.s_loc), pd.to_datetime(df.e_loc)
    df["start_utc"] = df.s_loc.dt.tz_localize(tz).dt.tz_convert("UTC").dt.tz_localize(None)
    df["end_utc"] = df.e_loc.dt.tz_localize(tz).dt.tz_convert("UTC").dt.tz_localize(None)
    df["code"] = df.value.map(Z.STAGE)
    df["tz"] = tz
    df["shifted"] = False
    df["night"] = (df.s_loc - pd.Timedelta(hours=Z.NIGHT_START_H)).dt.normalize()
    df["is_watch"] = df.device_class.eq("watch")
    return df


def test_a_staged_night_is_measured_from_first_to_last_minute_asleep():
    g = recs([
        ("2024-03-01 22:10", "2024-03-02 06:05", "InBed", "Watch", "watch"),
        ("2024-03-01 22:30", "2024-03-02 00:30", "AsleepCore", "Watch", "watch"),
        ("2024-03-02 00:30", "2024-03-02 01:30", "AsleepDeep", "Watch", "watch"),
        ("2024-03-02 01:30", "2024-03-02 01:50", "Awake", "Watch", "watch"),
        ("2024-03-02 01:50", "2024-03-02 05:00", "AsleepCore", "Watch", "watch"),
        ("2024-03-02 05:00", "2024-03-02 05:45", "AsleepREM", "Watch", "watch"),
    ])
    row, runs = Z.night_row(pd.Timestamp("2024-03-01"), g, 1)
    assert row["cls"] == "stages"
    assert row["onset_h"] == 22.5 and row["wake_h"] == 29.75          # 10:30 pm to 5:45 am
    assert row["asleep_min"] == 7 * 60 + 15 - 20 and row["awake_min"] == 20
    assert (row["deep_min"], row["rem_min"]) == (60, 45)
    assert row["latency_min"] == 20 and row["wakes"] == 1
    assert runs[0] == (4 * 60 + 10, 20, Z.INBED)                       # in bed from 22:10, then asleep


def test_a_daytime_session_is_a_nap_and_a_long_one_is_not():
    g = recs([
        ("2024-03-01 23:00", "2024-03-02 06:00", "AsleepCore", "Watch", "watch"),
        ("2024-03-02 14:00", "2024-03-02 14:40", "AsleepCore", "Watch", "watch"),
    ])
    row, _ = Z.night_row(pd.Timestamp("2024-03-01"), g, 1)
    assert row["asleep_min"] == 7 * 60 and (row["naps"], row["nap_min"]) == (1, 40)
    g = recs([("2024-03-01 23:00", "2024-03-02 06:00", "AsleepCore", "W", "watch"), ("2024-03-02 09:00", "2024-03-02 15:00", "AsleepCore", "W", "watch")])
    assert Z.night_row(pd.Timestamp("2024-03-01"), g, 1)[0]["naps"] == 0   # six hours by day is a misplaced record


def test_time_in_bed_only_is_not_counted_as_sleep():
    g = recs([("2019-05-01 22:40", "2019-05-02 06:20", "InBed", "iPhone", "phone")])
    row, _ = Z.night_row(pd.Timestamp("2019-05-01"), g, 1)
    assert row["cls"] == "inbed" and "asleep_min" not in row and row["inbed_min"] == 460


def test_one_source_per_night_prefers_stages_then_the_watch(monkeypatch):
    df = recs([
        ("2024-03-01 22:00", "2024-03-02 07:00", "InBed", "iPhone", "phone"),
        ("2024-03-01 22:30", "2024-03-02 06:30", "AsleepUnspecified", "SleepApp", "other"),
        ("2024-03-01 23:00", "2024-03-02 06:00", "AsleepCore", "Watch", "watch"),
    ])
    monkeypatch.setattr(Z, "load", lambda con: df)
    nights, _, log = Z.build(None)
    assert len(nights) == 1 and nights.source.iloc[0] == "Watch" and nights.asleep_min.iloc[0] == 7 * 60
    assert [r[0] for r in log] == ["Z2"]


def test_asleep_written_in_local_time_as_utc_is_moved_back():
    # Garmin Connect, 2017: in bed 22:30 local is right, asleep was written as 22:30 UTC (17:30 local in winter)
    df = recs([("2017-11-05 22:30", "2017-11-06 05:15", "InBed", "Connect", "other"), ("2017-11-05 17:30", "2017-11-06 00:07", "AsleepUnspecified", "Connect", "other")], tz="America/New_York")
    out = Z.fix_local_as_utc(df.copy())
    moved = out[out.code == Z.ASLEEP].iloc[0]
    assert moved.shifted and moved.s_loc == pd.Timestamp("2017-11-05 22:30") and moved.e_loc == pd.Timestamp("2017-11-06 05:07")


def test_a_source_that_never_records_awake_time_gives_estimates(monkeypatch):
    rows = []
    for d in range(1, 8):
        a, b = f"2018-03-0{d} 22:00", f"2018-03-0{d + 1} 07:00" if d < 9 else ""
        rows += [(a, b, "InBed", "Connect", "other"), (a, b, "AsleepUnspecified", "Connect", "other")]
    monkeypatch.setattr(Z, "load", lambda con: recs(rows))
    nights, _, log = Z.build(None)
    assert nights.est.all() and any(r[0] == "Z5" for r in log)


def test_milestones_accept_days_months_and_periods():
    out = milestones.normalise([
        {"date": "2021-08-14", "label": "Daughter born", "kind": "family"},
        {"date": "2023-02", "end": "2023-03-20", "label": "Ankle", "kind": "health", "public": True},
        {"date": "someday", "label": "No date"},
        {"date": "2020-03-16", "label": " "},
        {"date": "2020-03-16", "label": "Unknown kind", "kind": "party"},
    ])
    assert [m["label"] for m in out] == ["Unknown kind", "Daughter born", "Ankle"]
    assert out[2]["date"] == "2023-02-01" and out[2]["precision"] == "month" and out[2]["end"] == "2023-03-20" and out[2]["public"]
    assert out[0]["kind"] == "other" and [m["id"] for m in out] == [0, 1, 2]
    assert np.all([m.get("public") is False for m in out[:2]])


def test_breathing_windows_fit_a_rule_that_tells_notified_from_quiet():
    rng = np.random.default_rng(1)
    days = pd.date_range("2025-01-01", periods=310, freq="D")
    anchor, hot = pd.Timestamp("2025-03-02"), (2, 3, 6)          # three windows notified
    k = (days - anchor).days // 30
    bd = np.where(np.isin(k, hot), rng.normal(13, 1.5, len(days)), rng.normal(7, 1.5, len(days)))
    bd[::9] = np.nan                                              # nights without a value are left out, not zero
    nights = pd.DataFrame({"date": days.strftime("%Y-%m-%d"), "bdist": bd})
    events = [{"from": str((anchor + pd.Timedelta(days=30 * i)).date()), "to": str((anchor + pd.Timedelta(days=30 * i + 30)).date())} for i in hot]
    out = Z.breathing(nights, events)
    r, W = out["rule"], out["windows"]
    assert r["agree"] == r["of"] and r["quiet_max"] < r["cut"] < r["notified_min"] and 7 < r["level"] < 13
    assert W[0]["from"] == "2025-01-01" and sum(w["notified"] for w in W) == 3
    assert W[-1]["open"] and not any(w["open"] for w in W[:-1])  # the last window runs past the export
    assert all(w["share"] >= r["cut"] for w in W if w["notified"])


def test_without_notifications_the_windows_have_no_rule():
    days = pd.date_range("2025-01-01", periods=90, freq="D")
    out = Z.breathing(pd.DataFrame({"date": days.strftime("%Y-%m-%d"), "bdist": 6.0}), [])
    assert out["rule"] is None and out["windows"][0]["from"] == "2025-01-01" and out["windows"][0]["share"] is None
    assert Z.breathing(pd.DataFrame({"date": ["2025-01-01"], "bdist": [np.nan]}), []) is None
