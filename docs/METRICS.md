# Metrics, records and charts

Exact definitions for everything the app shows. When a definition here and the code disagree, fix one of them: this file is the reference.

## Conventions

- **On foot** means walk, run and hike. **GPS types** means walk, run, hike and ride.
- **Local date** is the date where the activity happened (`CLEANING.md` rule S2). Weeks start Monday.
- **Elapsed time** is start to end. **Moving time** excludes pauses and auto-pauses (rule G5). Pace and speed use moving time; the loop leaderboard uses elapsed time.
- **Distance** is the headline distance from rule G6.
- **Indoor and fragment workouts** (rules W2 and W3) count toward daily totals and the calendar only.
- Display: miles to 0.1, feet and steps as integers, pace as m:ss per mile, temperatures in whole °F.

## Daily table `daily`

| Column | Definition |
|---|---|
| `steps`, `distance_mi`, `flights` | Deduplicated sums (rule S1) |
| `active_kcal`, `exercise_min`, `stand_hours` | From samples; cross-checked against ActivitySummary |
| `resting_hr`, `hrv_sdnn`, `vo2max` | Day's value; VO₂ max is the latest sample that day |
| `walk_speed`, `step_length`, `double_support` | Daily means of the iPhone mobility samples |
| `foot_mi`, `n_workouts`, `active` | From cleaned outdoor and indoor workouts; `active` = at least one on-foot workout |
| `trimp`, `ctl`, `atl`, `tsb` | Fitness model below |

## Workout table `workouts_enriched`

| Column | Definition |
|---|---|
| `elapsed_s`, `moving_s`, `distance_m` | As above |
| `pace_s_per_mi` | `moving_s / miles` |
| `max_speed` | 95th percentile of 10-second speeds, to resist spikes |
| `avg_hr`, `max_hr` | From the cleaned 5-second stream (rule H2) |
| `zone_s[1..5]` | Seconds in each zone. Zone 1 below 60% of HRmax, then 60–70, 70–80, 80–90, 90+ |
| `trimp` | Σ over 5 s samples of `Δt_min × r × 0.64 × e^(1.92 r)`, `r = (HR − HRrest)/(HRmax − HRrest)`, HRrest = that day's resting HR (else the 30-day median) |
| `beats_per_mile` | `avg_hr × moving minutes / miles` |
| `ef` | Efficiency factor: average speed in m/min ÷ average HR. Only for steady workouts of 20 min or more |
| `decoupling` | `(EF first half − EF second half) / EF first half`, by moving time |
| `steps`, `cadence` | Deduplicated steps inside the workout span; cadence = steps per moving minute |
| `climb_m`, `descent_m` | Headline climb (rule E3); descent with the same hysteresis |
| `max_grade` | Steepest average grade over any 100 m stretch |
| `gap_pace` | Grade-adjusted pace (below) |
| `temp_c`, `feels_c`, `humidity`, `wind`, `precip_mm`, `condition` | `ENRICHMENT.md` |
| `in_dark`, `dark_min` | Sun section of `ENRICHMENT.md` |
| `place`, `region`, `loop_id` | Place clusters (DBSCAN on start points, 2 km), region auto-names, loop clustering below |
| `max_from_home_m` | Furthest point from home for routes that start within 500 m of home |
| `new_ground_m` | Distinct ground this workout added (exploration below) |
| `device`, `flags` | Recording watch model; cleaning flags |

### Grade-adjusted pace

Use the Minetti et al. (2002) energy-cost polynomials, with grade `i` as a fraction (rise over run), valid roughly from −0.45 to +0.45. Verify the coefficients against the paper before relying on them.

- Walking (walks, hikes): `Cw(i) = 280.5 i⁵ − 58.7 i⁴ − 76.8 i³ + 51.9 i² + 19.6 i + 2.5`
- Running (runs): `Cr(i) = 155.4 i⁵ − 30.4 i⁴ − 43.3 i³ + 46.3 i² + 19.5 i + 3.6`

Grade-adjusted speed for each 10 m step = `speed × C(i) / C(0)`, with `i` from the smoothed DEM profile. `gap_pace` is the moving-time-weighted result.

*As built (see DECISIONS.md, 2026-10-13):* runs use Minetti's running polynomial as above. Walks and hikes use Tobler's hiking function instead, `factor(i) = exp(3.5 · (|i + 0.05| − 0.05))`, because Minetti's walking curve is a metabolic cost that makes a −8% mile look twice as slow on flat ground. The profile is the watch's own barometric altitude when at least 70% of points have it (the DEM otherwise), smoothed over ~90 m, and steps that cross a signal loss or jump are skipped. Each split also stores `descent_m`.

### Splits

Per mile (and a partial last split): time, pace, average HR, climb, GAP. A negative split means the second half by distance was faster; store `split_delta_s = second_half_s − first_half_s`.

## Best efforts

Distances. Walks: 1 mi, 2 mi, 5K, 5 mi, 10K, 10 mi, half marathon. Runs: 1 mi, 5K, 10K, 10 mi, half, marathon. Rides: 10 mi, 20 mi, 40 km.

Algorithm, per workout: on the cleaned track with pauses removed, build cumulative distance `d[k]` (scaled by rule G6) and moving time `t[k]`. Slide two pointers so that for every end point `j` the start `i` is the latest point with `d[j] − d[i] ≥ D`; interpolate the start to exactly `D` and take `t[j] − t_interp`. The minimum over `j` is the workout's best effort for `D`. It's O(n) per distance. Skip windows that contain a signal-loss segment or a G4 cut.

Store `best_efforts(workout_id, type, distance_label, seconds, start_offset_m, date)`. The **record progression** for a distance is the running minimum by date; each new minimum is a record event (the orange steps in the Bests chapter).

## Records

Each record is stored all-time and per calendar year (`records(record_id, scope, year, value, workout_id or date, runner_up)`), so the app can show "best this year". Ties go to the earlier date.

| Group | Record | Definition |
|---|---|---|
| Distance | Longest walk, hike, run, ride | Max `distance_m` per type |
| | Longest walk by time | Max `elapsed_s` for walks |
| Speed | Fastest walk over 2 miles | Min moving pace, walks of 2 mi or more |
| | Fastest run over 3 miles | Min moving pace, runs of 3 mi or more |
| | Best effort at each distance | From `best_efforts` |
| | Biggest negative split | Max `−split_delta_s` per mile, on-foot workouts of 3 mi or more |
| Climbing | Biggest climb | Max `climb_m` in one workout |
| | Steepest stretch | Max `max_grade` |
| | Hilliest walk | Max climb per mile, walks of 2 mi or more |
| Heart | Most efficient walk | Max `ef`, walks of 2 mi or more |
| | Lowest resting HR | Min 30-day rolling mean of `resting_hr` |
| | Highest VO₂ max | Max monthly mean of `vo2max` |
| Weather and sun | Hottest, coldest | Max and min `temp_c` at start, outdoor on-foot workouts |
| | Feels-like extremes | Same on `feels_c` |
| | Windiest, wettest | Max mean wind; max `precip_mm` during the workout |
| | Earliest start, latest finish | Local clock time |
| | Most minutes in darkness | Max `dark_min` |
| Volume | Most steps in a day | Max `daily.steps` |
| | Most on-foot miles in a day, week, month, year | Sums of `distance_m` for on-foot workouts |
| | Most workouts in a week | Count of on-foot workouts per ISO week |
| Consistency | Longest active streak | Consecutive days with `active` |
| | Longest 10K-step streak | Consecutive days with `steps ≥ 10,000` |
| | Longest weekly streak | Consecutive weeks with at least 3 on-foot workouts |
| | Eddington number | Below |
| Exploration | Furthest from home | Max `max_from_home_m` |
| | Most new ground in one workout | Max `new_ground_m` |
| Pool | Longest swim, fastest 100 yd, best SWOLF | Per swim |
| Strength | Most sessions in a week, longest session | Per ISO week; max `elapsed_s` |

## Loops

1. Take every outdoor on-foot route that starts within 500 m of a place-cluster center.
2. Rasterize its cleaned track to a 25 m grid, sampling segments every 10 m, giving a set of cells.
3. Candidate pairs: starts within 150 m and distances within 5%.
4. Same loop when the Jaccard similarity of the cell sets is 0.85 or more. Loops are the connected components.
5. Record direction (sign of the polygon area) so clockwise and counterclockwise laps can be compared or merged; default is merged.
6. Name loops by rank ("Loop A", "Loop B", ...) and let `config.yaml` override names.

The leaderboard per loop: lap count, record elapsed time with date, median, latest, the record step line, and each lap as a dot. Weather-adjusted lap times are a stretch goal.

## Fitness model

Daily `trimp` is the sum over all workouts that day. Then, with `kc = 1 − e^(−1/42)` and `ka = 1 − e^(−1/7)`:

- `ctl[t] = ctl[t−1] + (trimp[t] − ctl[t−1]) × kc` (fitness)
- `atl[t] = atl[t−1] + (trimp[t] − atl[t−1]) × ka` (fatigue)
- `tsb[t] = ctl[t−1] − atl[t−1]` (form)

Start both at 0 on the first day and hide the first 60 days as warm-up. Fitness and fatigue share one chart; form gets its own.

Also: heart rate against pace per year (least-squares `avg_hr ~ pace` for walks, reported at a 16:00 reference pace; 9:00 for runs), beats per mile by year, and monthly resting HR and VO₂ max with a 10th–90th percentile band.

## Exploration

- **New ground (grid):** process outdoor on-foot routes in date order; rasterize to 30 m cells by sampling every 15 m; a cell is new the first time any route touches it. `new_ground_m = new cells × 30`. Cumulative curve, per-year totals, and share of each year's miles on new ground.
- **Street coverage (OSM):** `ENRICHMENT.md`. Show coverage within 1, 2 and 3 miles of home, with a map layer of walked versus unwalked streets.
- **Eddington number (on foot, miles):** the largest `E` such that there are at least `E` days with `foot_mi ≥ E`. Also report how many more days of `E + 1` miles reach the next number.

## Weather adjustment

Raw "pace against temperature" is confounded by fitness: fitness changes over the same years the weather varies. Show the raw medians, and add an adjusted view: fit `pace ~ year trend + spline(temp) + hour of day + climb per mile` on walks (statsmodels or a small GAM), and plot the partial effect of temperature with its confidence band. Use the same model to report a weather-adjusted pace trend.

## Space and time (the 3D view)

The routes around one place (the atlas's place; home when the atlas shows everywhere), drawn in local metres scaled so
98% of points fit a floor about ±100 units across, clipped at ±125. Three heights, interpolated on the GPU when switched:

- **Date**: the workout's day plus its start hour as a fraction, from the first route at that place (floor) to the last
  (top, 150 units). A space-time cube: loops repeated for years rise as columns.
- **Time of day**: the local start hour plus the elapsed time at each point, midnight at the floor and at the top.
- **Elevation**: the ground under each point (3DEP where available) above the lowest route point or contour on the
  floor, exaggerated so the relief fills about 60% of the height (between 1× and 30×, shown on screen).

Share mode applies as on the atlas: hidden points split the routes, and the floor shadow carries the same gaps.

## Sleep

One row per night in `sleep_nights` (rules Z1–Z5 in `docs/CLEANING.md`). Clock times are hours on an 18-to-42 axis
(22.5 is 10:30 pm; 30 is 6 am the next morning).

- **Fell asleep / woke**: the first and last minute asleep in the night's sessions. **Asleep**: minutes in any asleep
  stage between them; **awake**: the rest of that span. **In bed**: the source's `InBed` records around it, when there
  are any; **latency** = fell asleep − in bed (within 4 hours).
- **Stages**: deep, core, REM and awake minutes (watchOS 9 and later). **Woke up**: awake runs of 2 minutes or more.
- **Overnight vitals**: inside the night's sleep, watch samples only: lowest and median heart rate, median HRV, breathing
  rate and blood oxygen (median and lowest). Wrist temperature and breathing disturbances are the watch's one value per
  night; the wrist temperature **change** is the night minus the median of the previous 30 nights.
- **Medians and records** use measured nights only (not estimates, not time in bed only). Trend lines are rolling
  medians over nights (vitals: rolling means) and break across gaps of more than 30 days.

## Life milestones

`data/milestones.yaml` (format in `milestones.example.yaml`): a date or a month, an optional end for a period, a label,
a kind. Drawn on every chart with a date axis on both pages (a faint line, or a band for a period, and a marker to
hover); in the map replay as the replay passes the date; as a coloured ring in the 3D date stack. Share mode hides the
label unless the milestone is `public: true`. They are context only: no metric uses them.

## Chart catalog

| Chapter | Panel (id) | Data |
|---|---|---|
| Atlas | `map`, `tiles` | `route_points` (cleaned, simplified to about 5 m for display), `workouts_enriched`, `daily` |
| In 3D (space and time) | `stack` | the atlas's display points plus `routes_ele.bin` (USGS 3DEP elevation, else smoothed GPS, in half metres) and `routes_time.bin` (seconds from the workout's start, in 2 s steps); place contours |
| Rhythm | `cal`, `sun`, `clock`, `punch`, `matrix`, `dow` | `daily`, workout start and end local times, sun times for home |
| Volume | `race`, `yearly`, `weekly`, `mix` | `workouts_enriched` aggregates; race projection = year-to-date ÷ mean share-of-year completed by this day across complete years |
| Pace and effort | `pace`, `ptemp`, `phour`, `hrpace`, `bpm`, `zones`, `fit`, `gait` | `workouts_enriched`, `daily` |
| Terrain and weather | `wx`, `cond`, `climb`, `hills`, `fill` | `workouts_enriched`, provenance columns |
| Records | `recs` | `records` |
| Bests | `prog`, `bestTable`, `loops`, `ff`, `edd`, `ground` | `best_efforts`, `loops`, `daily` fitness columns, exploration tables |
| Close-up | `cuMap`, `cuCharts`, `splits` | one workout's cleaned 1 s stream, resampled to 10 m for charts |
| Pool and weights | `swim`, `swolf`, `lift` | swim laps, strength sessions |
| Data health | `rules`, `track`, `dedupe` | `cleaning_log`, raw and cleaned tracks, per-minute step series for one day |
| Watches | `sensors` | `sensor_availability`, `devices` |
| Sleep · Nights | `barcode`, tiles | `sleep_nights`, `sleep_runs` (each night's timeline as runs of one stage) |
| Sleep · Duration and timing | `sdur`, `sclock`, `sweek`, `smonth` | `sleep_nights` |
| Sleep · Stages | `sstage`, `styp` | `sleep_nights`, `sleep_runs` (staged nights) |
| Sleep · One night | `night` | one night's runs and vitals |
| Sleep · Overnight vitals | `svit`, `stemp`, `sbreath` | `sleep_nights` vitals; apnea notification windows |
| Sleep · Records, Sources | `srecords`, `ssrc` | `sleep_nights`; `cleaning_log` rules Z1–Z5 |
