"""Strava import: file readers and row building, on small hand-written files."""
from datetime import datetime

import pandas as pd

from stride.strava import build, read_gpx, read_tcx

PELOTON_TCX = b"""
<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="Biking"><Id>2022-09-11T20:37:19Z</Id>
  <Lap StartTime="2022-09-11T20:37:19Z"><TotalTimeSeconds>None</TotalTimeSeconds><DistanceMeters>5000.7</DistanceMeters><Calories>87.3</Calories>
   <Track>
    <Trackpoint><Time>2022-09-11T20:37:21Z</Time><DistanceMeters>12.9</DistanceMeters><HeartRateBpm><Value>0.0</Value></HeartRateBpm>
     <Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Speed>6.46</Speed><Watts>80</Watts></TPX></Extensions></Trackpoint>
    <Trackpoint><Time>2022-09-11T20:37:22Z</Time><DistanceMeters>19.5</DistanceMeters><HeartRateBpm><Value>0.0</Value></HeartRateBpm>
     <Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Speed>6.76</Speed><Watts>100</Watts></TPX></Extensions></Trackpoint>
   </Track></Lap>
  <Creator><Name>Peloton Bike</Name></Creator></Activity></Activities>
</TrainingCenterDatabase>"""

GPX = b"""<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <trk><trkseg>
  <trkpt lat="40.5500" lon="-105.0900"><ele>10.0</ele><time>2018-05-01T12:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lat="40.5509" lon="-105.0900"><ele>11.0</ele><time>2018-05-01T12:00:30Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>124</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lat="40.5518" lon="-105.0900"><ele>12.0</ele><time>2018-05-01T12:01:00Z</time></trkpt>
 </trkseg></trk>
</gpx>"""


def test_tcx_peloton_zero_heart_rate_is_missing():
    f = read_tcx(PELOTON_TCX)
    assert f["pts"] == []                      # indoor: no positions
    assert f["hr"] == []                       # 0.0 bpm means no strap, not a heart rate of zero
    assert f["sess"]["total_timer_time"] is None  # 'None' in the file
    assert abs(f["sess"]["total_distance"] - 5000.7) < 1e-6
    assert f["sess"]["avg_watts"] == 90.0
    assert f["dev"]["creator"] == "Peloton Bike"
    assert f["start"] == datetime(2022, 9, 11, 20, 37, 19)


def test_gpx_positions_and_heart_rate():
    f = read_gpx(GPX)
    assert len(f["pts"]) == 3 and f["pts"][0][1:4] == (40.55, -105.09, 10.0)
    assert [b for _, b in f["hr"]] == [120.0, 124.0]


def test_build_rows():
    acts = pd.DataFrame([
        {"id": "1", "name": "Peloton ride", "type": "Ride", "file": "activities/1.tcx.gz", "start": pd.Timestamp("2022-09-11 20:37:19"),
         "elapsed_s": 701.0, "moving_s": 701.0, "distance_m": 4980.0, "kcal": 87.0, "avg_hr": None, "max_hr": None, "gain_m": None},
        {"id": "2", "name": "Ridge Challenge", "type": "Hike", "file": "activities/2.gpx", "start": pd.Timestamp("2018-05-01 12:00:00"),
         "elapsed_s": 60.0, "moving_s": 60.0, "distance_m": 210.0, "kcal": None, "avg_hr": 122.0, "max_hr": 124.0, "gain_m": 2.0},
    ])
    files = {"activities/1.tcx.gz": read_tcx(PELOTON_TCX), "activities/2.gpx": read_gpx(GPX)}
    t, rep = build(acts, files, "test")
    w = t["workouts"].set_index("workout_id")
    assert list(w.index) == ["strava-1", "strava-2"]
    assert w.loc["strava-1", "indoor_flag"] is True and w.loc["strava-1", "type"] == "ride" and w.loc["strava-1", "device_class"] == "other"
    assert w.loc["strava-2", "type"] == "hike" and w.loc["strava-2", "total_distance_m"] == 210.0  # Strava's distance, as the app shows it
    assert (w.source_name == "Strava").all()
    assert len(t["route_points"]) == 3 and t["route_points"].seq.tolist() == [0, 1, 2]
    assert len(t["workout_hr_file"]) == 2 and set(t["workout_hr_file"].workout_id) == {"strava-2"}
    m = t["workout_metadata"]
    assert m[(m.workout_id == "strava-2") & (m.key == "StravaName")].value.iloc[0] == "Ridge Challenge"
    assert m[(m.workout_id == "strava-1") & (m.key == "HKIndoorWorkout")].value.iloc[0] == "1"
    assert rep["with_gps"] == 1 and rep["with_hr"] == 1 and not rep["unreadable"]
