# Changelog

What changed between releases, newest first. Every judgment call behind these is in [docs/DECISIONS.md](docs/DECISIONS.md).

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
