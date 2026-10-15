# Stride Atlas playbook: what made the first build work

Lessons from the first full build (October 2026, one person's ~3 GB Apple Health export, 2014–2026). Written so the next Claude Code session, on someone else's export, can reproduce the dashboard without rediscovering any of this. Nothing here is personal data; counts are quoted only to show scale.

Read this after `CLAUDE.md` and the four specs. When this file and a spec disagree, the spec states the intent and this file states what the real data needed; follow this file and log the deviation in `DECISIONS.md`.

---

## 1. The process that worked

1. **Read everything, then look at the data before writing rules.** The specs describe the expected export. Real exports differ (section 3). Phase 0's inventory paid for itself within the hour.
2. **One phase at a time, each with a check that can fail.** Every phase ended with a query or test that could say no. Several did, and every failure was a real bug: walk segments over 12 mph, 6-second "mile records", a 12-hour "walk".
3. **Sanity-read the extremes after every derive.** Sort every record table and look at the top row. Absurd records (1 mile in 6 s, 16,000 ft of climb per mile, a 1,056-lap loop whose record is half its length) surfaced four pipeline bugs that no unit test caught.
4. **Decide, log, move on.** Every judgment call went into `DECISIONS.md` with its reason and how to undo it. About 45 entries; none needed the user.
5. **Build the app against real data, then review every panel in the browser.** Scroll through every chapter, read every subtitle and hover a few points. Copy that reads well on one person's data can be wrong on another's (section 9).
6. **Measure the budgets, don't assume them.** The first filter change took 1.6 s. Profiling found two causes (section 7); fixed, it is 40–200 ms.
7. **Finish with a clean-room rebuild.** `make verify-clean` rebuilds from raw into a scratch folder and compares hashes. It caught last-bit float noise from parallel sums.

Rough time for the first build: about 8 hours of agent work, mostly in cleaning edge cases and app review. The pipeline runs end to end in about 6 minutes on an M-series laptop (parse ~100 s, clean ~80 s, enrich ~40 s cached or ~5 min cold, derive ~45 s, export ~20 s).

---

## 2. Architecture that held up

- **Parse:** `lxml.iterparse` over top-level elements only. Clear an element only when its parent is `<HealthData>`, so `MetadataEntry` and `WorkoutStatistics` children survive until their workout is handled. Push raw strings into Arrow batches of 400k rows and let **DuckDB parse dates** (`strptime(... '%z')::TIMESTAMP`), which is vectorized and about 50× faster than Python `strptime`. 6.7M records stream in about 60 s.
- **Device class from the `device` string**, cached by the string minus its `0x…` pointer (the pointer changes on every record).
- **Natural-key merge** for incremental refresh: `target ANTI JOIN stage USING (keys) UNION ALL stage`. A parse fingerprint (size + first/last 4 MB) skips unchanged exports.
- **Per-track cleaning as pure numpy** (`track.py`), run in a process pool, unit-tested on synthetic tracks. Keep DB access out of it.
- **One DuckDB file, Parquet for the app**, JSON for small structured things (meta, health examples, sensors), binary for route geometry, one JSON per workout for close-up streams (~15 KB each).
- **App:** React shell; charts stay imperative D3 functions (ported from the original HTML design mockup), each returning `{sub, legend, table}` to a generic `Panel` component.

---

## 3. Export quirks to check in Phase 0

Run these on every new export. Each one broke something in the first build.

| Quirk | How to detect | What to do |
|---|---|---|
| **Every timestamp has the same UTC offset** (the phone's offset at export time, even for winter dates and trips) | `offsets` in the inventory has one key | Never use the offset for local time. Build a time-zone timeline from `HKTimeZone` and route locations; convert with real zone rules. |
| **Workout `MetadataEntry` written twice** (before and after the children) | metadata key count > 2× workout count | Deduplicate by key; log conflicts. |
| **Fixed-offset zones** like `Etc/GMT+4` (Peloton and other apps) | distinct `HKTimeZone` values | Map to the named zone with the same offset at that instant, or the timeline fragments into hundreds of pieces. |
| **One workout, several GPX files** | `routes` grouped by workout with count > 1 | Number points continuously across files in time order. Restarting `seq` at 0 fans out every join. |
| **GPX `<ele>0</ele>` with `<vAcc>-1</vAcc>`** | count of `vAcc < 0` | Elevation is missing, not 0. |
| **Sparse heart rate in older workouts.** The watch's dense workout HR series is not exported; the first build had 2–8 samples per walk before 2025, dense 5 s samples after. | median HR samples per workout, by year | Don't sum TRIMP over a 5 s grid; use average-HR TRIMP for all years (section 5). Never interpolate HR across gaps. |
| **Humidity as `7400 %`** for 74% | metadata values > 100 | Divide once. (It got multiplied back by 100 later in the first build; keep humidity in percent everywhere.) |
| **Exact duplicate records and workouts** (re-synced apps) | natural-key duplicate counts | Collapse at parse; deduplicate the children of duplicate workouts too. |
| **Source names with odd characters** (curly apostrophes, non-breaking spaces, renamed watches) | list distinct `sourceName` | Never key on source name. |
| **Route file names use the end time**, not the start | compare file names with workout starts | Join only through `FileReference`. |
| **Imported workouts without routes** (Garmin Connect, Peloton, Strava) | workouts with no `WorkoutRoute`, by source | Classify as `no_route`; count them in daily totals and time charts; keep them off maps, pace, weather and best efforts. |
| **Indoor flags** (`HKIndoorWorkout = 1`) on treadmill walks and bike-trainer rides | indoor counts by type | Distances from indoor workouts stay out of mileage charts. Test the flag with `bool(v)` or a null check, not `is True`: numpy booleans fail `is True`, and that mislabeled 400 indoor workouts. |
| **Data gaps** (years with no steps at all) | distinct days with samples by year | Days with no samples are null, not zero. |

---

## 4. Cleaning lessons (rules G1–G6, E1–E2, W1–W5, S1, H1–H3)

- **G4 "forgot to stop" must be general.** Drives also happen at the *start* (workout started in the car) and in the *middle*. Cut sustained ≥ 60 s stretches above 12 mph at either end (when ≥ 40% of the remaining head or tail is fast) and excise middle ones as breaks. Also treat isolated fast jumps under 30 s as their own gap type: drawn dashed, with no distance or moving time.
- **The watch usually did not count the drive.** In every G4 workout the watch's own distance worked out to walking pace over the whole workout. Keep the watch distance unless it implies more than 5 mph. The spec's "use GPS for the remainder" assumes otherwise.
- **G6 scaling needs a coverage check.** A 10-second GPS track scaled up to the watch's 2.6 km made a "mile in 6 seconds". Skip scaling when GPS covers under half the workout, or the watch distance is more than 1.5× GPS; keep those tracks out of best efforts.
- **Elevation needs a Hampel filter before Savitzky–Golay.** Smoothing alone let altitude glitches of hundreds of meters through.
- **Climb hysteresis: count to the peak.** The naive "add each rise over 2 m" algorithm drops the last partial rise before every summit. Use a state machine: once climbing is confirmed, count every meter up to the peak.
- **W5 (new rule): a final pause never resumed ends the workout.** One walk was paused at 23 min and left running for 12 h; it became the longest walk and "most minutes in darkness".
- **Best efforts count distance only while moving.** Paused segments with GPS still running add distance with zero moving time.
- **HRmax default can break.** The 99.5th percentile of the last two years measured walking peaks (145 bpm) because the last two years held no hard efforts. Use the two years ending at the last run, ride or interval session.
- **Withdraw implausible HR, don't zero it.** One walk averaged 1 bpm above resting (a loose band); every other walk was 24+ bpm above. Below rest + 15 bpm, withdraw that workout's HR metrics.
- **S1 per minute:** within the winning device class, take the larger source per minute rather than summing (two phones can overlap). Summing watch and phone naively overstated steps by 69% on days both were carried.

---

## 5. Derivation lessons

- **TRIMP:** with sparse HR, use Banister's average-HR form for every workout, one method across all years. Keep the 5 s sum as a separate column where coverage ≥ 80%. Where both exist they agreed within ~10%.
- **Loops: plain Jaccard on a 25 m grid fails.** The same loop shifted 2 m across a grid line scores 0.33 (there's a unit test). Use one-cell-buffered overlap at 0.85.
- **Loops: connected components chain.** 1.0 → 1.05 → … → 2.5 mile neighbourhood routes merged into one "loop". Use seeded clustering instead: the route with the most matches seeds a loop, and only its direct matches join. Cluster all on-foot routes, but compute leaderboards on walks only, or runs take every record.
- **Place clusters** (2 km connected components of route starts) get names from an offline gazetteer (`reverse_geocoder`, GeoNames bundled). No geocoding API is needed.
- **Weather model:** OLS `pace ~ C(year) + bs(temp, 5) + C(hour bin) + climb/mi` (statsmodels) gives both the partial temperature effect and a weather-adjusted pace by year. R² is low (~0.1); show the confidence band.
- **Grade-adjusted pace for walking: Tobler, not Minetti.** Minetti's walking polynomial is a metabolic cost; it makes a −8% mile "twice as slow" on flat ground. Tobler's hiking function describes walking speed on slopes. Use the watch's barometric altitude for grades where it exists (DEM otherwise), smoothed over ~90 m, and never across a GPS gap.
- **The DEM lies beside cliffs.** A few metres of GPS error next to a cliff swings DEM elevation by tens of metres: one hike scored a 413% grade. Records that depend on grade must hold in both the DEM and the barometer (take the lower per window).
- **New ground is a share, not a cell count.** Cells × 30 m overstates winding tracks by up to √2 (a 41-mile hike scored 44 miles of new ground). Use the route's distance × the share of its cells never visited before.
- **Reference values from the spec can sit outside the user's data** (a 16:00/mi reference pace for someone who walks 19–20 min/mi). Fall back to the user's median when the reference is outside their middle 80%.

---

## 6. Enrichment lessons

- **Open-Meteo weights calls.** One year of 11 hourly variables counts as ~30 calls against 600 per minute. Space archive requests ~4 s apart and back off 65 s on HTTP 429. About 70 requests cover eight years.
- **USGS 3DEP:** call the ImageServer `exportImage` endpoint directly for fixed 0.1° tiles at 1/3″ (1080 × 1080 float32), cache through requests-cache, and save GeoTIFFs. This skips py3dep's dependency stack. About 40 tiles (~200 MB) covered every US route.
- **Outside the US**, Open-Meteo elevation at ~100 m spacing, interpolated by distance.
- **Contours for the map** come from the same DEM tiles (contourpy at ~30 m, interval by relief). They make the trail-map look real and need no basemap service.
- **Zero-network re-run** is the check: requests-cache with `NEVER_EXPIRE`, and count `from_cache`. Cache 404s too, so "this station has no file for that year" is not asked again.
- **Weather providers are interchangeable** behind one hourly shape (`weather.py`). Measured against Apple's own workout temperatures (`make weather-compare`): Open-Meteo 1.95 °F mean difference, NOAA station data 1.8 °F where a station existed, NASA POWER (0.5° grid) 2.8 °F. The default `auto` takes the nearest station within 30 km and fills from Open-Meteo: 1.83 °F, 100% filled.
- **Reanalysis over-reports drizzle; ceilometers under-report cloud.** Open-Meteo called rain at the start of 12% of outings where the station saw 3%. Airport ceilometers see nothing above 12,000 ft, so stations report high cloud as clear. Take wet/dry from the station and cloud cover from the reanalysis, with the reanalysis's own class thresholds (clear < 50%, partly < 80%).
- **NOAA ISD is retired.** The `global-hourly` service and `isd-history.csv` stop at the end of August 2025. Use GHCNh's per-station-year Parquet files (~1 MB each) instead. Missing hours stay null, and `np.nansum` over all-missing hours is 0 °C, so weighted means need an explicit "any value?" check.
- **OpenStreetMap: use a Geofabrik extract, not Overpass,** when the network is shared with other OSM work (Overpass throttles per IP). pyosmium needs `NODE | WAY` with `.with_locations()`; keep sidewalks, crossings and service roads out of the denominator or coverage means little.

---

## 7. App lessons

- **Read Parquet with hyparquet**, a few KB with built-in snappy. Cast INT64 to INTEGER/DOUBLE and dates to strings in the export so the browser never sees BigInt.
- **Type D3 loosely.** `import * as d3_ from 'd3'; const d3: any = d3_;` in the ported chart modules keeps the rest of the code type-checked without fighting D3 generics.
- **deck.gl v9 additive glow:** luma v9 parameter names are `blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one'`, plus the alpha equivalents, `depthCompare: 'always'` and `depthWriteEnabled: false`. Draw an opaque background polygon as the first layer so additive colour composites correctly.
- **Additive blending breaks picking.** The blend applies to deck's colour-coded picking pass. Use an invisible, wider picking layer with normal blending, drawn *under* the glow; on top, 1,800 overlapping alpha-1/255 paths darken the glow to grey.
- **Filter on the GPU.** Building route objects per filter re-tessellates every path (~1.3 s). Build geometry once per place; filter years with `DataFilterExtension` on a day value and activity types with its category filter; make density alpha a layer `opacity` uniform.
- **Redraw only visible panels.** Redrawing ~40 SVG panels and creating thousands of Web Animations took 1.6 s per filter change. Panels redraw when within 400 px of the viewport; the rest are marked dirty. Groups of more than 300 animated marks arrive as one sweep.
- **Close-up streams:** heart rate comes straight from the 5 s grid with gaps left empty; isolated samples are drawn as dots.
- **`deck.canvas` can point at a stale element.** Inspect the canvas in the DOM before debugging "sizing".
- **The browser pane throttles `requestAnimationFrame`** when hidden, so frame-rate tests there read 1 fps. Time forced synchronous redraws with `gl.finish()` instead.
- **Fonts come from @fontsource packages**, never Google Fonts at runtime (ground rule 1).
- **A busy port 5173** (another project's server) is common. Let Vite fall back to the next free port.

---

- **A page at rest draws nothing.** An auto-rotating WebGL view redraws on every screen refresh, off screen too if
  its visibility margin is generous, and at 144 Hz on a laptop's integrated GPU that can stall the whole browser.
  Turn only while on screen, cap the frame rate, give up when frames arrive late, and check with `scripts/perf.mjs`
  (WebGL draw calls per second while idle should be 0).
- **Invisible pick layers still cost a full pass.** A wide transparent copy of every path for hover and click belongs
  in the picking pass only (`layerFilter: ({ layer, isPicking }) => isPicking || layer.id !== 'pick'`).

## 8. Privacy

- Home = densest cluster of route starts; it is stored only in the DuckDB file.
- **The 200 m end trims alone don't hide home.** In the first build, 1,432 routes still passed within 100 m of the house mid-loop. Share mode also hides a 300 m zone whose centre is offset 100–150 m from home in a hash-fixed direction, so the hole doesn't point at the door. The app gets per-point visibility flags, never coordinates of home.
- Weather requests use 0.25° cells; DEM requests use fixed 0.1° tiles. No request is centred on home.
- Reports draw maps as projected SVG with no coordinates and apply the same zone.

---

## 9. Copy follows the data

Never write a subtitle that assumes a direction ("faster, and easier on the heart"). Real data may say the opposite. In the first build resting HR rose and cardio fitness fell over the years, so titles were rewritten to be neutral ("How fast, and how hard"), and every subtitle states what the numbers show. Where a trend spans a watch change, say so: optical sensors differ between models.

---

## 10. Determinism

- Run stamps use the export's `ExportDate`, never the wall clock.
- Parquet: `ORDER BY` everything, `SET threads=1` during export, round doubles to 6 decimals (DuckDB's parallel sums differ in the last bit between runs).
- "Last refresh" in the app comes from the HTTP `Last-Modified` header of `meta.json`, so no clock time is baked into outputs.
- `make verify-clean` must say "identical" before calling the build done.
- **The same seed is not the same data on another machine** unless the generator is built for it. NumPy evaluates `exp`,
  `sin` and `arctan2` differently on Apple Silicon and on x86 Linux (where it uses vector libraries), so values can differ
  in the last bit. With one shared random stream, a workout that drew one extra number shifted every workout and day after
  it: GitHub's runners built a demo with 2,035 routes where a Mac built 2,039. The demo generator now gives each workout,
  day, the town and the schedule a stream of its own (keyed by what it is), and rounds values computed with those
  functions before writing them. `make ci` checks the export's content digest against `demo/digest.json`; after an
  intended change to the generator, run `make demo-digest` and commit it. Compare contents, not zip bytes: each
  machine's zlib compresses differently.

---

## 11. Acceptance checklist for a new user's build

- [ ] Phase 0: element counts add up; routes referenced = found; every quirk in section 3 checked and logged.
- [ ] Phase 1: fixture round-trip test passes; records + duplicates = Record count.
- [ ] Phase 2: fastest moving walk segment < 12 mph; 10 step days listed; the record table's extremes read sensibly.
- [ ] Phase 3: zero outdoor workouts without temperature; the re-run makes 0 network calls.
- [ ] Phase 4: unit tests for best efforts, loops, TRIMP/CTL/ATL, Eddington, streaks; top-3 of every record checked by eye.
- [ ] Phase 5: every panel drawn, no console errors, budgets measured (first paint < 2 s, filter < 300 ms, map redraw < 16 ms), share mode checked numerically against home.
- [ ] Phase 6: validation report written; `make verify-clean` identical; the user's blank columns ready.

---

## 12. Other sources

- **Ask about old watches early.** The Apple export started in 2018 for routes; a Strava archive brought back 2015–2018 (Garmin runs, hikes, pool swims, and the user's longest-ever hike, which they thought was lost). Garmin Connect summaries had synced into Health without routes, so the second source mostly *upgrades* existing rows rather than adding duplicates.
- **Load other sources into the same tables** under their own natural key and source name, and let the existing duplicate rule choose (route, then heart rate, then watch, then native source). Heart rate inside a file belongs to that workout only (`workout_hr_file`); putting it in the shared sample table doubles it wherever the watch also recorded.
- **Match each workout to the app it would be checked against.** Apple workouts use the Fitness app's distance; Strava ones use Strava's (the device odometer can differ by 3–4% on long trail days). Keep the other as metadata.
- **Device sport beats the platform's label** for gym sessions: the Forerunner said strength training where Strava said run.
- **Copies can carry a shifted clock.** A workout synced from one app to another while travelling can land 1–3 h off (local time written in the home zone). Same distance and duration to the metre and second, different start: W1 matches whole-hour offsets when both agree within 1%.
- **One maximum heart rate does not fit a decade.** Workouts with heart rate from an older watch's files get their own HRmax by the same percentile rule over that era's samples (183 vs 178 bpm in the first build).
- **Pool length changes SWOLF.** Garmin swims in a 25 m pool and Apple swims in a 25 yd pool are not comparable; break the trend line at a pool change, and at any gap of months.

## 12b. Sleep

- **Sleep comes in eras.** The first build had a Garmin through Connect (2017–18), AutoSleep, two years of the phone's
  bedtime schedule (time in bed only), the watch's "asleep" (2021–22), then stages, with up to three sources on one
  night (1,113 of 2,773 nights). One source per night, never a sum, or a night reads twice as long.
- **Check sleep against itself.** Garmin Connect wrote asleep records in local time labelled as UTC (a 5-hour shift in
  winter, 3-minute "nights" around midnight) and, later, whole sleep windows with no time awake (8+ hours a night).
  Compare a source's asleep records with its own in-bed records before trusting either.
- **Life milestones find errors both ways.** Matching the user's remembered dates with the data corrected two (a move a
  year later than remembered; the return to the office a month earlier) and revealed others (a weekly office day, a
  gym's start and end, an injury in a step-count dip, trip dates from route clusters and time zones). Offer what the
  data shows, flag where it differs from memory, and let the user decide.
- **Time zones between sparse observations.** Workouts can be weeks apart; a switch halfway between a June walk at home
  and a September trip put six weeks at home on another zone (sleep two hours off). A trip's zone now covers its
  workouts plus two travel days.
- **Read the extremes**: a 22-hour "nap" was a misplaced record (naps are capped at 4 hours), and the longest night was
  a Garmin window until estimates were excluded from records.
- **Medical signals need care in copy.** Sleep apnea notifications are 30-day screening windows; say what they are and
  that a doctor confirms, never more.
- **Browser details**: hyparquet returns 64-bit integers as BigInt (cast counts to INTEGER when exporting), and a
  `position: fixed` dialog inside a sticky header with `backdrop-filter` is trapped in the header (use a portal).

### Breathing and other screening signals

- **Do not invent a threshold the vendor does not publish.** Sleep apnea notifications judge 30-day windows; fit the
  simplest rule to the user's own notified and quiet windows, say how many it matches, and call it a reconstruction.
- **Medical views stay out of share mode** entirely, nav entry included, so no screenshot or video can carry them.
- **A metric that never changes is not a flat line.** One export's six-minute walk estimates were all exactly 500 m for
  years; count them and say so rather than drawing a measurement.
- **The parse fingerprint must cover the conversion table.** An unchanged export skips parsing, so a unit added to the
  table (ft/s, which stair speed arrives in) never reached stored values until the fingerprint included the table.

## 13. Presentation and recording

- **A compact home area and share mode can empty the 3D view.** In the first build the median home walk stayed within
  630 m of its start and the privacy zone hid 47% of the home points; the 3D view still works but reads as a few walls.
  Base the elevation view on the ground actually on the floor (the lowest contour of the whole place put the routes
  off-screen).

- **Presentation mode** (`?present=1`) is a data-driven tour; `scripts/record.mjs` streams it from headless Chrome over the DevTools screencast (about 30 fps at 1920×1080) and ffmpeg gives each frame its real duration.
- **Lazy panels move the page under a scripted scroll.** Draw every panel up front in presentation mode, and measure a target again after each scroll.
- **Frame maps around the captions.** Give the fit a bottom padding as tall as the caption, or the overlay hides the very clusters the caption describes.
- **Fly between places** with deck.gl's `FlyToInterpolator`; scale line width and alpha with zoom so a region still reads as light.
- **Hook in the first second.** The first cut opened on a static title card and a 13-second replay; viewers drop before
  anything happens. Start the replay on frame one with the title over it, then move every two bars.
- **Keep time like music.** Schedule everything against one clock (`at(bar)`), not chains of sleeps: a slow panel then
  delays only itself, and the cuts stay on the beat for the soundtrack.
- **Show the interaction, not just the result.** A visible pointer (a fingertip on the vertical cut) that presses the real
  toggles reads as a person using the app.
- **The screencast sends frames only when the page changes.** A still end card produces no frames; give the last frame
  the time until recording stopped, or the video ends early and the music runs past it.
- **Synthesised music needs checking by numbers, not ears**: deterministic seed, every note faded out (no clicks), peak
  under -1 dBFS, mids loud enough for phone speakers; loudness is normalised when muxing.
- **Short cuts need hard cuts.** In a 15-second video a scroll between far-apart chapters passes half-drawn panels;
  jump on the beat instead, and when switching pages, scroll to the top first and wait for the first chart to exist.
- **A requestAnimationFrame timestamp can be earlier than `performance.now()` taken just before.** Clamp tween
  progress at 0, or an ease-out overshoots below its start for one frame (a count-up from 0 showed "−531 nights").

## 14. Ideas not built yet

Air quality since 2022; manual entries for activities no device kept (a small YAML file with provenance `manual`); a labelled basemap; more importers (Garmin Connect, Fitbit, Google Health Connect, Polar, COROS, a plain folder of GPX files). See `CONTRIBUTING.md`.
