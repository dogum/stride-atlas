"""Sound (export.export_sound) on a hand-made day: nights named by their evening, headphone level as an energy average."""
import math

import duckdb
import pandas as pd

from stride import export


def test_sound_days_name_nights_by_their_evening_and_average_headphone_energy(tmp_path, monkeypatch):
    monkeypatch.setattr(export, "OUT", tmp_path)
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")   # as paths.connect() does: naive timestamps are UTC
    con.execute("CREATE TABLE tz_segments (from_utc TIMESTAMP, to_utc TIMESTAMP, tz VARCHAR, home_tz VARCHAR)")
    con.execute("INSERT INTO tz_segments VALUES ('2000-01-01', '2100-01-01', 'America/New_York', 'America/New_York')")
    env, hp = "HKQuantityTypeIdentifierEnvironmentalAudioExposure", "HKQuantityTypeIdentifierHeadphoneAudioExposure"
    # local (Eastern, UTC-5 in March before the change) -> UTC
    u = lambda s: pd.Timestamp(s) + pd.Timedelta(hours=5)
    q = pd.DataFrame([
        (env, 50.0, u("2025-03-01 23:00"), u("2025-03-01 23:30")),   # night of Mar 1
        (env, 54.0, u("2025-03-02 02:00"), u("2025-03-02 02:30")),   # still the night of Mar 1
        (env, 70.0, u("2025-03-02 12:00"), u("2025-03-02 12:30")),   # day of Mar 2
        (hp, 60.0, u("2025-03-02 08:00"), u("2025-03-02 08:01")),
        (hp, 80.0, u("2025-03-02 09:00"), u("2025-03-02 09:01")),
    ], columns=["type", "value_si", "start_utc", "end_utc"])
    con.register("q_df", q)
    con.execute("CREATE TABLE quantity_samples_clean AS SELECT * FROM q_df")
    con.execute("""CREATE TABLE category_samples AS SELECT 'HKCategoryTypeIdentifierAudioExposureEvent' AS type, TIMESTAMP '2025-03-02 20:00' AS start_utc,
                   '{"HKMetadataKeyAudioExposureLevel": "95.2 dBASPL"}' AS meta""")
    out = export.export_sound(con)
    assert out == {"env": 3, "headphone": 2, "alerts": 1}
    d = duckdb.sql(f"SELECT * FROM '{tmp_path / 'sound_days.parquet'}' ORDER BY date").df().set_index("date")
    assert d.loc["2025-03-01", "night_db"] == 52.0 and d.loc["2025-03-01", "night_n"] == 2 and pd.isna(d.loc["2025-03-01", "day_db"])
    assert d.loc["2025-03-02", "day_db"] == 70.0 and pd.isna(d.loc["2025-03-02", "night_db"])
    # one minute at 60 dB and one at 80 dB average to 77 dB of energy, not 70
    assert math.isclose(d.loc["2025-03-02", "hp_db"], 10 * math.log10((1e6 + 1e8) / 2), abs_tol=1e-4) and d.loc["2025-03-02", "hp_s"] == 120
    assert d.loc["2025-03-02", "alerts"] == 1 and d.loc["2025-03-02", "alert_db"] == 95.2
    h = duckdb.sql(f"SELECT * FROM '{tmp_path / 'sound_hours.parquet'}' ORDER BY month, hour").df()
    assert list(h.hour) == [2, 12, 23] and set(h.month) == {"2025-03"}
