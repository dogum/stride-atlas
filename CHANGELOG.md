# Changelog

What changed between releases, newest first. Every judgment call behind these is in [docs/DECISIONS.md](docs/DECISIONS.md).

## Unreleased

- README images for Sound, Heart and movement, and Breathing (from the demo).
- Heart-rate recovery: the few values beyond the chart's range stay inside its frame instead of drawing over the labels.

## 0.4.0 (2026-10-15): Sound

After pulling, run `make all` (or `make export` if nothing else changed) and reload the app.

### Added

- **Sound**, a chapter after Pool and weights, from the watch's noise readings, headphone levels and loud-sound alerts.
  - Every hour of every month as one grid, coloured by the typical level around you, with your milestones.
  - Day against night, month by month.
  - Headphone listening (hours a week, and its level as an energy average), and loud-sound alerts a month.
- The demo person, Alex, now has a sound history shaped by the milestones: a newborn's nights, quieter days working
  from home, a train commute with headphones.

## 0.3.1 (2026-10-15): A page that rests

### Fixed

- **The page could slow some browsers to a crawl.** The 3D view kept turning, and so redrawing thousands of routes, on
  every screen refresh from the moment the page loaded, while it was still off screen below the map; on a 144 Hz
  laptop screen running Chrome on integrated graphics that could swamp the GPU the browser needs to scroll.
  - At rest the page now makes no WebGL draw calls at all (it made about 480 a second at the top of the demo).
  - The 3D view turns only while a third of it is on screen, at most 30 frames a second, for a minute at a time, and
    not at all on a computer whose frames cannot keep up (which also drops it to one pixel per screen pixel).
  - The wide, invisible copy of every route that makes hover and click work is drawn only when picking, not on screen,
    on the map and in 3D.
  - Building the 3D view hands the browser back its turn as it goes: its longest frame went from about 1.1 s to 33 ms.
  - The controls over the map and the 3D view lose their background blur, which was recomputed on every frame.

### Added

- `node scripts/perf.mjs`: frame times and WebGL draw calls while the page rests and scrolls, optionally with
  software-only graphics and a slower CPU.

## 0.3.0 (2026-10-14): Breathing, heart and movement

After pulling, run `make all` and reload the app.

### Added

- **Breathing**, a chapter on the Sleep page.
  - Nightly breathing disturbances, with the watch's sleep apnea notifications shaded.
  - The 30-day windows the notifications judge.
  - The simplest rule that tells your notified windows from your quiet ones: a nightly level and a share of nights above it, fitted to your own data and reported with how many windows it matches. Apple does not publish its threshold, so this is labelled a reconstruction, never a diagnosis.
  - Which nights run higher, by season, weekday, bedtime, hours asleep and deep sleep. Sleep data only.
  - Share mode leaves the chapter out.
- **Heart and movement**, a chapter after Pace and effort.
  - How far heart rate drops in the minute after each workout (cardio recovery), by activity; click a dot to open the workout.
  - Weekly walking steadiness, and stair speed up and down.
  - The six-minute walk estimate is only counted: real exports sit at 500 m every time, which cannot show change.
- **A 15-second cut of the video tour**, for posting an update (`node scripts/record.mjs --short`, or `?present=short`).
- The demo person, Alex, now has cardio recovery, steadiness, stair speed and sleep apnea notifications.

### Fixed

- Stair speed is stored in m/s like every other speed. Exports write it in ft/s, which the unit table did not know.

## 0.2.0 (2026-10-14): Sleep and life milestones

After pulling, run `make all` (it adds a `sleep` step) and reload the app.

### Added

- **A Sleep page** (the *Sleep* tab, `#sleep`).
  - Every night since your first sleep record is one picture, coloured by stage.
  - Hours asleep, bedtime and wake time, by year and by night of the week.
  - Deep, core and REM, with a typical night lined up at the moment you fell asleep.
  - One night stage by stage.
  - Overnight vitals: heart rate, HRV, breathing, blood oxygen, wrist temperature against your own baseline, and breathing disturbances.
  - Sleep records, and where each night came from.
  - Five new cleaning rules (Z1–Z5, in [docs/CLEANING.md](docs/CLEANING.md)):
    - nights run 6 pm to 6 pm local time, with naps kept apart from the night;
    - one source per night, never summed;
    - within a source, overlapping records merge minute by minute and the more specific stage wins;
    - an old tracker that wrote local time as UTC is moved back;
    - trackers that only knew a sleep window are marked as estimates and kept out of averages and records.
- **Life milestones.** Add the dates that explain your data (a child born, working from home, a move, an injury, a trip).
  - They appear faintly on every chart with a date axis, on both pages, in the map replay and as rings in the 3D stack.
  - Edit them in the app's *Milestones* panel (which saves to `data/milestones.yaml` while `make dev` runs) or in the file itself, which never leaves your computer. `milestones.example.yaml` shows the format.
  - Show or hide each kind (family, work, home, health, travel, other).
  - Share mode hides the labels unless a milestone says `public: true`.
- The demo person, Alex, now has eight years of sleep from several sources and five life milestones.

### Changed

- **The demo export is identical on every platform** (macOS and Linux, ARM and x86).
  - Each workout, day, night and town draws from its own random stream, and computed values are rounded before they are written.
  - `make ci` compares the result with `demo/digest.json`. After an intended change to the generator, run `make demo-digest`.
  - The demo data changed once, to 2,052 routes and 8,036 miles.
- **Time zones on trips.** A trip's time zone now covers its own workouts plus two travel days where it meets home, instead of half the gap to the next workout.
  - Before, a single trip after months without workouts could put weeks at home on the trip's clock.
  - Those days' steps, sleep and hour-of-day charts were off by the time difference.

### Fixed

- Charts of workouts span the workouts as well as the daily records. The New ground chart ran past its edge when workouts started before the first daily record.
- The static demo no longer asks the dev-server milestones endpoint, which caused a 404 on GitHub Pages.

## 0.1.0 (2026-10-13): First public release

- **Pipeline:** a cleaned, enriched and traceable pipeline over an Apple Health export, plus an optional Strava archive.
  - Weather from NOAA stations and Open-Meteo, terrain from USGS 3DEP, street coverage from OpenStreetMap.
  - Every response is cached, so a rebuild makes no network calls.
- **Chapters:** Atlas, In 3D, Rhythm, Volume, Pace and effort, Terrain and weather, Records, Bests, Close-up, Pool and weights, Data health and Watches.
- **Privacy:** a privacy zone and a share mode.
- **Video:** a scripted video tour (`?present=1`, `scripts/record.mjs`) with an original soundtrack.
- **Demo:** `make demo`, an export for a person who does not exist.
- **A live demo** at https://dogum.github.io/stride-atlas/, built from that export by GitHub Actions, including the 70-second tour (`?present=1`).
