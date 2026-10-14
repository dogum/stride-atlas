# The Apple Health export

What's in `export.zip`, how to read it, and the quirks that bite. Apple changes details between iOS versions, so treat this as the expected shape and let the Phase 0 inventory confirm or correct it. Record any differences in `DECISIONS.md`.

## Files

```
apple_health_export/
  export.xml              everything except routes and ECGs; often 1–5 GB
  export_cda.xml          clinical document format; ignore
  workout-routes/         one GPX file per outdoor workout route
    route_2024-05-11_7.42am.gpx
  electrocardiograms/     ECG CSVs; ignore
  clinical-records/       FHIR JSON if any; ignore
```

## export.xml

The file opens with an internal DTD (`<!DOCTYPE HealthData [ ... ]>`), then one `<HealthData>` root. If `lxml` complains about the DTD or about the document size, parse with `resolve_entities=False`, `huge_tree=True`, `recover=True`. As a last resort, strip the DOCTYPE block with a streaming pre-pass. Use `iterparse(events=("end",))` on the elements below and call `elem.clear()` plus delete previous siblings as you go, or memory will grow to the size of the file.

### Dates

Every timestamp looks like `2024-05-11 07:42:10 -0400`, parsed with `%Y-%m-%d %H:%M:%S %z`. Store UTC plus the original offset. The offset may reflect the phone's time zone at export, not where the sample happened. For routes, the GPX times are UTC, so derive local time from the route's coordinates with `timezonefinder`, and prefer the workout's `HKTimeZone` metadata where present.

### `<Record>` — one sample

```xml
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Alex’s Apple Watch" sourceVersion="10.1"
  device="&lt;&lt;HKDevice: 0x...&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch7,5, software:10.1&gt;"
  unit="count" creationDate="..." startDate="..." endDate="..." value="52"/>
```

- `sourceName` uses a curly apostrophe (`’`). Don't match on it; classify device from the `device` string (`model:Watch`, `model:iPhone`) and fall back to the source name only when `device` is missing.
- Category types (`HKCategoryTypeIdentifier...`) put a string in `value`, such as `HKCategoryValueSleepAnalysisAsleepCore`.
- Some records carry `<MetadataEntry key value/>` children. Heart rate variability records nest a `<HeartRateVariabilityMetadataList>` of beat-to-beat readings.
- **Natural key:** `(type, source_name, device_class, start_utc, end_utc, value)`.

Types this project uses (verify the exact identifiers in Phase 0):

| Identifier | Unit (typical, US locale) | Used for |
|---|---|---|
| `HKQuantityTypeIdentifierStepCount` | count | daily steps, calendar, matrix, weekday profile |
| `HKQuantityTypeIdentifierDistanceWalkingRunning` | mi | daily distance |
| `HKQuantityTypeIdentifierFlightsClimbed` | count | calendar metric |
| `HKQuantityTypeIdentifierAppleExerciseTime` | min | calendar metric |
| `HKQuantityTypeIdentifierActiveEnergyBurned` | kcal | daily and workout energy |
| `HKQuantityTypeIdentifierHeartRate` | count/min | workout streams, zones, TRIMP, max HR |
| `HKQuantityTypeIdentifierRestingHeartRate` | count/min | fitness chapter, TRIMP |
| `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | ms | optional chart |
| `HKQuantityTypeIdentifierVO2Max` | mL/min·kg | fitness chapter |
| `HKQuantityTypeIdentifierWalkingSpeed` | mi/hr | gait chart (iPhone) |
| `HKQuantityTypeIdentifierWalkingStepLength` | in | gait chart (iPhone) |
| `HKQuantityTypeIdentifierWalkingDoubleSupportPercentage` | % | gait chart (iPhone) |
| `HKQuantityTypeIdentifierWalkingAsymmetryPercentage` | % | optional |
| `HKQuantityTypeIdentifierOxygenSaturation` | % | sensor timeline |
| `HKQuantityTypeIdentifierRunningPower`, `RunningStrideLength`, `RunningVerticalOscillation`, `RunningGroundContactTime` | W, m, cm, ms | run close-ups |
| `HKQuantityTypeIdentifierTimeInDaylight` | min | optional |
| `HKQuantityTypeIdentifierAppleSleepingWristTemperature` | degF | sensor timeline |
| `HKQuantityTypeIdentifierDistanceSwimming`, `SwimmingStrokeCount` | yd, count | swims, SWOLF |
| `HKCategoryTypeIdentifierSleepAnalysis` | — | the Sleep page (see Sleep below) |
| `HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances` | count | the Sleep page, overnight vitals |
| `HKCategoryTypeIdentifierSleepApneaEvent` | — | the Sleep page: 30-day notification windows |

### `<Workout>`

```xml
<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="42.7" durationUnit="min"
  sourceName="..." sourceVersion="..." device="..." creationDate="..." startDate="..." endDate="...">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <MetadataEntry key="HKTimeZone" value="America/New_York"/>
  <MetadataEntry key="HKWeatherTemperature" value="64.4 degF"/>
  <MetadataEntry key="HKWeatherHumidity" value="7400 %"/>
  <MetadataEntry key="HKElevationAscended" value="2840 cm"/>
  <MetadataEntry key="HKAverageMETs" value="3.9 kcal/hr·kg"/>
  <WorkoutEvent type="HKWorkoutEventTypePause" date="..." duration="..." durationUnit="min"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="..." endDate="..." sum="2.61" unit="mi"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" ... average="108" minimum="80" maximum="131" unit="count/min"/>
  <WorkoutRoute sourceName="..." ...>
    <FileReference path="/workout-routes/route_2024-05-11_7.42am.gpx"/>
  </WorkoutRoute>
</Workout>
```

- **Activity types:** `Walking`, `Running`, `Hiking`, `Cycling`, `Swimming`, `TraditionalStrengthTraining`, `FunctionalStrengthTraining`, plus whatever else Phase 0 finds. Map anything unknown to `other` and keep it out of route views.
- **Older exports** put totals on the `<Workout>` element itself (`totalDistance`, `totalDistanceUnit`, `totalEnergyBurned`, `totalEnergyBurnedUnit`). Newer ones use `<WorkoutStatistics>` children. Support both.
- **Metadata values carry units in the string.** Parse the number and the unit separately. Known oddities: humidity is percent × 100 (`7400 %` means 74%); elevation ascended is in centimeters; temperature is in `degF` or `degC`.
- **Indoor:** `HKIndoorWorkout = 1` means treadmill or indoor walk. Keep these for totals, exclude them from route views, weather and pace-versus-temperature.
- **Pauses:** `WorkoutEvent` pause and resume pairs define moving time. Auto-pause events exist for some runs.
- **Swims:** `HKSwimmingLocationType` (1 pool, 2 open water), `HKLapLength` (for example `25 yd`), and `WorkoutEvent` lap and segment events with `HKSwimmingStrokeStyle` (1 mixed, 2 freestyle, 3 backstroke, 4 breaststroke, 5 butterfly, 6 kickboard). SWOLF is not stored; compute it (see `METRICS.md`). Newer watches add water temperature samples.
- **Routes:** `<WorkoutRoute>` holds a `<FileReference>` to the GPX. Some older exports have routes without a reference; match those GPX files to workouts by time overlap (route time span inside workout span ± 2 min).
- **Natural key:** `(activity_type, source_name, start_utc, end_utc)`.

### `<ActivitySummary>`

One per day: `dateComponents`, active energy and goal, exercise minutes and goal, stand hours and goal. Useful as a cross-check for daily active energy and exercise minutes, and for an optional rings view.

## GPX route files

```xml
<trkpt lon="-105.093" lat="40.553">
  <ele>131.2</ele>
  <time>2024-05-11T11:42:10Z</time>
  <extensions><speed>1.41</speed><course>212.3</course><hAcc>3.2</hAcc><vAcc>2.1</vAcc></extensions>
</trkpt>
```

- Roughly one point per second. Times are UTC. `ele` is meters; `speed` is m/s; `hAcc` and `vAcc` are accuracy estimates in meters (lower is better).
- File names use the local start time (`route_2024-05-11_7.42am.gpx`) and can collide when two workouts start in the same minute; the export appends a suffix. Always join through the `FileReference` path.
- Store as `route_points(workout_id, seq, t_utc, lat, lon, ele_m, speed_ms, course, hacc_m, vacc_m)`.

## Sleep

`HKCategoryTypeIdentifierSleepAnalysis` records carry a stage in `value` (`HKCategoryValueSleepAnalysis…`): `InBed`,
`AsleepUnspecified` (older exports: `Asleep`), `AsleepCore`, `AsleepDeep`, `AsleepREM`, `Awake`. One export usually holds
several eras and sources at once, and they overlap:

| Era | Source (sourceName) | What it writes |
|---|---|---|
| any | another watch through its app (`Connect` for Garmin, Fitbit, Oura…) | its own sleep; Garmin's 2017–18 records are a window: `InBed` and `Asleep…` identical to the minute, almost no `Awake` |
| any | sleep apps (`AutoSleep`, `Pillow`…) | `Asleep…` stretches, often `InBed` |
| iOS 13–17 | the iPhone (`Clock` bedtime, then the Sleep schedule as `iPhone`) | `InBed` only, from the phone's bedtime and alarm and its use |
| watchOS 7–8 (2020–22) | the Apple Watch | `AsleepUnspecified` stretches; time awake is the gap between them |
| watchOS 9+ (autumn 2022) | the Apple Watch | `AsleepCore`, `AsleepDeep`, `AsleepREM`, `Awake` and `InBed` |

Two watches can record the same night after an upgrade, and a renamed watch is a new `sourceName` (the non-breaking
space trap again). While asleep the watch also writes heart rate, HRV, `RespiratoryRate`, `OxygenSaturation`,
`AppleSleepingWristTemperature` (one value per night, Series 8 / Ultra and later) and, from watchOS 11,
`AppleSleepingBreathingDisturbances` per night. `HKCategoryTypeIdentifierSleepApneaEvent` records are Apple's sleep
apnea notifications: each covers a 30-day evaluation window, not a night.

**Trap.** Garmin Connect wrote some `Asleep…` records in local time labelled as UTC: they sit exactly the time-zone
offset away from the same app's `InBed` record (rule Z4).

## Sensor timeline

Metrics appear as hardware and iOS versions change. Detect the first date each type appears per device class and store it in `sensor_availability`. The Watches chapter is drawn from that table, and charts use it to show "not recorded yet" instead of zeros.

## Known traps

1. **Double-counted steps and distance.** Watch and phone both write overlapping samples. Summing them inflates totals by 30–80% on days you carry both. See `CLEANING.md`, rule S1.
2. **Duplicate workouts.** The same walk saved by the watch and by a second app (Strava, Nike Run Club, a gym app). See rule W1.
3. **Forgot to stop.** A walk that ends with a drive. See rule G4.
4. **Unit drift.** Locale and iOS updates change units (mi or km, kcal or Cal, degF or degC). Normalize by the `unit` attribute on every row, never by assumption.
5. **Memory.** Never load `export.xml` with `ElementTree.parse` or `BeautifulSoup`. Stream it.
6. **Curly quotes and odd characters** in source names. Normalize to NFC and strip control characters before using as keys.

## Second source: a Strava bulk export (optional)

Strava's *Settings → My Account → Download or delete your account → Request your archive* produces `export_<number>.zip`. Put it in `data/` (or `data/raw/`); `make unzip` extracts only `activities.csv` and `activities/` into `data/raw/strava/` and never touches the rest (messages, followers, logins, media). `make strava` (`pipeline/stride/strava.py`) then loads it.

- **`activities.csv`**: one row per activity, 100+ columns. `Activity Date` is UTC in the form `Nov 25, 2015, 4:55:24 PM`. Some headers repeat: the first `Distance` is in the athlete's display unit (km here), the second (`Distance.1` in pandas) is metres; `Elapsed Time.1` and `Max Heart Rate.1` likewise. `Filename` points into `activities/`.
- **`activities/<id>.fit.gz`**: the original Garmin file. `record` messages (1 Hz or smart recording; position in semicircles × 180 / 2³¹, `enhanced_altitude` barometric, `heart_rate`), `session` (sport, sub sport, totals, `total_ascent`, `pool_length`), `length` (one per pool length: duration, strokes, stroke style), `event` (timer start and stop = pauses), `activity.local_timestamp` (gives the UTC offset), `file_id.garmin_product` (e.g. `fr920xt`). Read with `fitdecode`.
- **`activities/<id>.tcx.gz`**: Garmin TCX. Peloton writes these with no positions, `HeartRateBpm` of `0.0` when no strap was paired (missing, not zero), `TotalTimeSeconds` of `None`, and watts in `Extensions/TPX`. Some files start with whitespace before the XML declaration.
- **`activities/<id>.gpx`**: plain GPX with heart rate in `gpxtpx` extensions.
- **Natural key**: `strava-<Activity ID>`. Every Strava row is replaced on each run, so a newer archive never leaves stale copies.
- **Overlaps** with Apple Health (Peloton classes saved by both, Garmin Connect summaries synced to Health) are resolved by rule W1 in `CLEANING.md`.
