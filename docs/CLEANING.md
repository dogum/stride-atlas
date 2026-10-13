# Cleaning rules

Every rule has an ID, a threshold in `config.yaml`, and logs each change to `cleaning_log(rule_id, table, row_key, field, before, after, note, run_at)`. The Data health chapter and `reports/02_data_health.html` are drawn from that log. Thresholds below are starting points; tune them against your data and record changes in `DECISIONS.md`.

Rules run in the order listed.

## Workouts

**W1. Duplicate workouts.** Two workouts of the same activity family whose time spans overlap by at least 80% of the shorter one are the same workout. Keep one, preferring: has a route, then has heart-rate samples, then source is Apple Watch, then the longer duration. Copy over any metadata the kept one lacks (weather, elevation). Log the dropped one.

**W2. Indoor workouts.** `HKIndoorWorkout = 1`, or a walking or running workout with no route and no `DistanceWalkingRunning` samples from GPS, is indoor. Keep it in totals and the calendar; exclude it from the map, pace charts, weather charts and best efforts.

**W3. Fragments.** Outdoor workouts shorter than 3 minutes or 0.1 mi are dropped from route views and records (they're accidental starts). Keep them in the log.

**W4. Activity relabel (suggest only).** A "walk" whose cleaned moving pace is under 11 min/mi for most of its length is probably a run, and a "walk" with more than 120 ft of climb per mile on trails is probably a hike. Never change the type automatically. List candidates in the data-health report for you to confirm.

## GPS tracks

**G1. Accuracy filter.** Drop points with `hAcc` above 40 m when neighbors within 10 s are better than 15 m.

**G2. Spikes.** Compute speed between consecutive points. Drop a point when its implied speed in and out are both above three times the 30-second rolling median and above an absolute ceiling (walk and hike 9 mph, run 18 mph, ride 45 mph). Repeat once.

**G3. Door jitter.** Trim leading and trailing points while the track stays inside a 25 m circle for more than 45 s. Recompute start and end time from the remaining points but keep the workout's recorded duration for elapsed time.

**G4. Forgot to stop.** On foot, a sustained run of at least 60 s above 12 mph (driving) at the end of a workout is cut, along with everything after it. If the cut removes more than 20% of distance, flag the workout and use the GPS-derived distance for the remainder. Show these in the data-health report with their before-and-after maps.

**G5. Gaps.** A time gap over 30 s with under 10 m moved is a pause; one with over 200 m moved is a signal loss. Pauses count toward elapsed time only. Signal losses keep a straight segment but mark it so the map can draw it dashed.

**G6. Distance reconciliation.** Compare GPS distance (haversine over cleaned points) with the watch's reported distance. When they differ by more than 5%, keep the watch value as the headline distance, scale the per-point cumulative distance to match for splits and best efforts, and log the ratio.

## Elevation

**E1. Smoothing.** Smooth `ele` with a Savitzky–Golay filter (window about 30 s, order 2) before any climb calculation.

**E2. Climb with hysteresis.** Count ascent only when the smoothed elevation rises more than 2 m above the last local low. This stops noise from inflating climb.

**E3. Source preference.** Headline climb: the watch's `HKElevationAscended` when present; otherwise DEM climb (see `ENRICHMENT.md`); otherwise GPS climb from E2. Keep all three columns so the Terrain chapter can show agreement between them.

## Daily quantities

**S1. Step and distance deduplication.** For each type, build a per-minute series per device class by spreading each sample's value evenly over its minutes. For each minute, take the watch value if any watch sample covers it, otherwise the phone value, otherwise other sources. Sum per local day. Do the same for `DistanceWalkingRunning` and `FlightsClimbed`. Validate 10 random days against the Health app (list them in the report).

**S2. Local days.** Assign samples to days in the local time zone where they happened, not the export's zone, so trips don't split days at the wrong hour.

**S3. Sensor availability.** Before computing any daily metric, check `sensor_availability`. Days before a metric existed are null, not 0.

## Heart rate

**H1. Implausible values.** Drop heart-rate samples under 35 or over 220 bpm, and isolated jumps of more than 40 bpm within 5 s that return within 10 s.

**H2. Workout streams.** Resample a workout's heart rate to 5 s, forward-fill gaps up to 30 s, and leave longer gaps empty.

**H3. Max heart rate.** Default HRmax is the 99.5th percentile of cleaned workout heart-rate samples from the last two years, unless `config.yaml` sets one.

## Swims

**P1. Laps.** Use lap events and the lap length. Drop laps under 5 s (wall touches). SWOLF per lap = strokes + seconds; per swim = the median of freestyle laps.

## The data-health report

`reports/02_data_health.html` mirrors the app's Data health chapter:
1. Rule counts, square-root scaled, with the rule text on hover.
2. A raw-versus-cleaned map for the workout with the largest G4 cut, plus one with G2 spikes.
3. The step deduplication example for a real day: watch, phone and merged intervals.
4. A table of W4 relabel suggestions.
5. A list of 10 dates with their deduplicated step totals to check against the Health app on your phone.
