"""Phase 1: the hand-written fixture export round-trips exactly into DuckDB."""
import shutil
from datetime import datetime
from pathlib import Path

import pytest

FIX = Path(__file__).parent / "fixtures" / "tiny_export"


@pytest.fixture()
def parsed(tmp_path, monkeypatch):
    monkeypatch.setenv("STRIDE_DB", str(tmp_path / "t.duckdb"))
    from stride import parse, paths

    log = parse.run(force=True, xml=FIX / "export.xml")
    con = paths.connect(read_only=True)
    yield con, log
    con.close()


def q(con, sql, *a):
    return con.execute(sql, list(a)).fetchall()


def test_record_counts_and_dedupe(parsed):
    con, log = parsed
    assert log["records_streamed"] == 11
    assert log["natural_key_duplicates"] == 1  # the watch step sample written twice (different HKDevice pointer)
    assert q(con, "SELECT count(*) FROM quantity_samples") == [(9,)]
    assert q(con, "SELECT count(*) FROM category_samples") == [(1,)]


def test_dates_are_utc_with_offset(parsed):
    con, _ = parsed
    rows = q(con, "SELECT start_utc, end_utc, tz_offset_min FROM quantity_samples WHERE type LIKE '%StepCount' AND device_class='watch'")
    assert rows == [(datetime(2024, 6, 1, 12, 0), datetime(2024, 6, 1, 12, 10), -240)]


def test_device_class_and_units(parsed):
    con, _ = parsed
    got = dict(q(con, "SELECT source_name || '|' || type, device_class FROM quantity_samples"))
    assert got["Alex’s iPhone|HKQuantityTypeIdentifierStepCount"] == "phone"
    assert got["Health|HKQuantityTypeIdentifierBodyMass"] == "other"
    assert got["Alex’s Apple Watch|HKQuantityTypeIdentifierHeartRate"] == "watch"
    (d,) = q(con, "SELECT value_si FROM quantity_samples WHERE type LIKE '%DistanceWalkingRunning'")[0]
    assert d == pytest.approx(804.672)
    (t,) = q(con, "SELECT value_si FROM quantity_samples WHERE type LIKE '%WristTemperature'")[0]
    assert t == pytest.approx(36.0)
    (kg,) = q(con, "SELECT value_si FROM quantity_samples WHERE type LIKE '%BodyMass'")[0]
    assert kg == pytest.approx(72.5747792)
    meta = q(con, "SELECT meta FROM quantity_samples WHERE type LIKE '%SDNN'")[0][0]
    assert '"_beats": "2"' in meta


def test_workouts(parsed):
    con, log = parsed
    w = {r[0]: r[1:] for r in q(con, "SELECT activity_type || '|' || source_name, type, device_class, total_distance_m, total_energy_kcal, indoor_flag, hk_timezone, duration_s FROM workouts")}
    assert len(w) == 5
    walk = w["Walking|Alex’s Apple Watch"]
    assert walk[0] == "walk" and walk[1] == "watch" and walk[2] == pytest.approx(2414.016) and walk[3] == pytest.approx(150)
    assert walk[4] is False and walk[5] == "America/New_York" and walk[6] == pytest.approx(1800)
    assert w["Walking|Strava"][2] == pytest.approx(2410) and w["Walking|Strava"][1] == "other"
    run = w["Running|Alex’s Apple Watch"]
    assert run[2] == pytest.approx(3218.688) and run[3] == pytest.approx(230)  # legacy totalDistance attributes
    assert w["TraditionalStrengthTraining|Health"][0] == "strength"
    assert w["Swimming|Alex’s Apple Watch"][0] == "swim"


def test_metadata_deduplicated_and_parsed(parsed):
    con, _ = parsed
    rows = q(con, """SELECT m.key, m.value_num, m.unit, m.value_si, m.unit_si FROM workout_metadata m JOIN workouts w USING (workout_id)
                     WHERE w.activity_type='Walking' AND w.source_name LIKE 'Alex%' ORDER BY key""")
    assert [r[0] for r in rows] == ["HKElevationAscended", "HKIndoorWorkout", "HKTimeZone", "HKWeatherHumidity", "HKWeatherTemperature"]
    m = {r[0]: r[1:] for r in rows}
    assert m["HKElevationAscended"][2] == pytest.approx(15.2) and m["HKElevationAscended"][3] == "m"
    assert m["HKWeatherTemperature"][2] == pytest.approx(20.0) and m["HKWeatherTemperature"][3] == "degC"
    assert m["HKWeatherHumidity"][0] == 5500 and m["HKWeatherHumidity"][1] == "%"


def test_events_stats_routes(parsed):
    con, log = parsed
    ev = q(con, """SELECT e.type, e.seq, e.duration_s FROM workout_events e JOIN workouts w USING (workout_id)
                   WHERE w.activity_type='Walking' AND w.source_name LIKE 'Alex%' ORDER BY seq""")
    assert [(t, s) for t, s, _ in ev] == [("Segment", 0), ("Pause", 1), ("Resume", 2)]
    assert ev[0][2] == pytest.approx(1080)
    laps = q(con, """SELECT e.meta FROM workout_events e JOIN workouts w USING (workout_id) WHERE w.type='swim' AND e.type='Lap' ORDER BY seq""")
    assert len(laps) == 2 and '"HKSWOLFScore": "48"' in laps[0][0]
    st = dict(q(con, "SELECT s.type, s.sum_si FROM workout_stats s JOIN workouts w USING (workout_id) WHERE w.type='swim'"))
    assert st["DistanceSwimming"] == pytest.approx(45.72) and st["SwimmingStrokeCount"] == 36
    # referenced walk route: 12 points, the last two have vAcc=-1 so elevation is null, not 0
    pts = q(con, """SELECT seq, lat, lon, ele_m, t_utc FROM route_points p JOIN workouts w USING (workout_id)
                    WHERE w.activity_type='Walking' AND w.source_name LIKE 'Alex%' ORDER BY seq""")
    assert len(pts) == 12
    assert pts[0][1:4] == (40.0, -75.0, 50.0) and pts[0][4] == datetime(2024, 6, 1, 12, 0, 0)
    assert pts[10][3] is None and pts[11][3] is None and pts[9][3] == pytest.approx(54.5)
    # the run's WorkoutRoute has no FileReference: its GPX is matched by time overlap
    assert log["gpx_matched_by_time"] == 1
    assert q(con, "SELECT count(*) FROM route_points p JOIN workouts w USING (workout_id) WHERE w.type='run'") == [(10,)]
    assert q(con, "SELECT file FROM routes r JOIN workouts w USING (workout_id) WHERE w.type='run'") == [("route_2024-06-01_6.20pm.gpx",)]
    # the stray file matches nothing and is not loaded
    assert q(con, "SELECT count(*) FROM routes WHERE file LIKE 'route_2024-05-20%'") == [(0,)]


def test_activity_summaries_devices_sensors(parsed):
    con, _ = parsed
    assert q(con, "SELECT count(*), sum(stand_hours) FROM activity_summaries") == [(2, 24.0)]
    hw = {r[0] for r in q(con, "SELECT device_hardware FROM devices WHERE device_hardware IS NOT NULL")}
    assert hw == {"Watch7,5", "iPhone14,3"}
    first = dict(q(con, "SELECT metric || '|' || device_class, first_utc FROM sensor_availability WHERE kind='record'"))
    assert first["StepCount|phone"] == datetime(2024, 6, 1, 12, 5)


def test_rerun_is_idempotent_and_merges(tmp_path, monkeypatch):
    monkeypatch.setenv("STRIDE_DB", str(tmp_path / "m.duckdb"))
    from stride import parse, paths

    parse.run(force=True, xml=FIX / "export.xml")
    again = parse.run(force=False, xml=FIX / "export.xml")
    assert again == {"skipped": True}
    parse.run(force=True, xml=FIX / "export.xml")
    con = paths.connect(read_only=True)
    assert q(con, "SELECT count(*) FROM quantity_samples") == [(9,)]
    assert q(con, "SELECT count(*) FROM workouts") == [(5,)]
    assert q(con, "SELECT count(*) FROM route_points") == [(22,)]
    con.close()
    # a later export: one new step sample, one old sample gone. The new row is added, the old one kept.
    d2 = tmp_path / "e2"
    shutil.copytree(FIX, d2)
    x = (d2 / "export.xml").read_text()
    x = x.replace('value="600"/>', 'value="650"/>')  # changed value => new natural key
    (d2 / "export.xml").write_text(x)
    parse.run(force=False, xml=d2 / "export.xml")
    con = paths.connect(read_only=True)
    vals = sorted(v for (v,) in q(con, "SELECT value FROM quantity_samples WHERE source_name='Alex’s iPhone'"))
    assert vals == [600.0, 650.0, 900.0]
    assert q(con, "SELECT count(*) FROM workouts") == [(5,)]
    con.close()
