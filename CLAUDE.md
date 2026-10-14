# Stride Atlas: instructions for Claude Code

Stride Atlas turns one person's Apple Health export (and, optionally, a Strava archive) into a local dashboard of every
walk, run, hike and ride, plus a separate Sleep page for every night: a glowing route atlas, the same routes stacked in 3D by date, time of day or elevation, rhythm and volume charts, pace and effort, terrain and weather,
records, loops, fitness, swims and strength, a data-health chapter and a device timeline. The pipeline and the app are
built. Your job is usually to run them on someone's data, adapt to what their export does differently, and explain
what you found.

Read this file, then `docs/PLAYBOOK.md` (lessons from the first build), then skim `docs/HEALTH_EXPORT.md`,
`docs/CLEANING.md`, `docs/ENRICHMENT.md` and `docs/METRICS.md` (the specs), `docs/DECISIONS.md` (the defaults) and
`data/DECISIONS.md` (this build's own log, if a previous session started one).

## Ground rules

1. **Local only.** No accounts, no cloud services, no analytics. The only network calls are the enrichment lookups in
   `docs/ENRICHMENT.md` (weather, elevation, one OpenStreetMap download), and every response is cached on disk.
2. **The user's data never leaves `data/`.** Never commit `data/`, `app/public/data/`, `reports/` or anything derived
   from a real export; never paste a user's personal data into an issue, a commit message, a public page or a
   screenshot that will be shared. `.gitignore` already covers the folders; keep it that way.
3. **Raw data is read-only.** Everything downstream is rebuilt from `data/raw/`.
4. **Every number is traceable.** Derived and enriched values carry a provenance column (`watch`, `phone`,
   `app:<name>`, `api:<service>`, `dem`, `derived`).
5. **Missing is not zero.** A metric a device could not record yet is null; charts break the line or say "not
   recorded yet". Never plot it as 0, never interpolate across a gap.
6. **SI inside, the user's units outside** (`units:` in `config.yaml`).
7. **Idempotent and deterministic.** `make all` twice gives identical outputs; `make verify-clean` checks it.
8. **Privacy zone.** Home is detected from route starts and stays in the database. Share mode hides the area around
   it. Never write home coordinates outside `data/`; round coordinates sent to weather APIs to 0.25°.
9. **Decide, then write it down.** When the data forces a judgment call, pick the option most faithful to the data,
   add a row to `data/DECISIONS.md` (date, decision, reason, how to undo; create it with the same table header as
   `docs/DECISIONS.md`), and keep going. It lives in `data/` because it describes the user's data and must never be
   committed. Only a change of *default* for everyone belongs in `docs/DECISIONS.md`.
   Ask the user only when a choice changes what they will see in a way they would want to choose themselves.
10. **Keep the look.** Dusk-navy ground, blaze-orange accent, Overpass / Public Sans / Overpass Mono, contour-line
    chapter headers, the route-line chapter nav, light and dark themes. Do not swap in another design system.

## Runbook: "build this for my data"

1. **Check the tools.** `uv` (Python 3.12), Node 20+ and npm. Optional: Google Chrome or Chromium (screenshots,
   video) and `ffmpeg` (video). Run `make setup`.
2. **Get the exports into `data/`.** Tell the user how, if they have not done it yet:
   - *Apple Health:* on the iPhone, Health app → profile picture (top right) → **Export All Health Data**. It can take
     several minutes and makes a zip (often 1–5 GB). AirDrop or copy it into `data/`. Any file name works.
   - *Strava (optional, worth it for older watches):* strava.com → Settings → My Account → **Download or Delete Your
     Account** → *Download Request* → *Request your archive*. Strava emails a link; put the zip in `data/` too. Only its
     activities are read.
3. **Settings.** `cp config.example.yaml config.yaml`. Ask the user only about `units` (imperial or metric). Leave the
   rest at its defaults unless the data says otherwise. Offer **life milestones** (optional): the dates that explain
   their data, such as a child born, working from home, a move, a new commute or an injury. Write what they give you
   to `data/milestones.yaml` (format in `milestones.example.yaml`; a month is fine when they are unsure of the day), or
   point them to the Milestones button in the app. Never put them anywhere but `data/`.
4. **Phase 0, inventory.** `make unzip inventory`, then read `reports/00_inventory.html`, especially the
   *Differences* list. Compare with `docs/HEALTH_EXPORT.md` and the quirk table in `docs/PLAYBOOK.md` §3. Record every
   difference in `data/DECISIONS.md`. Stop and ask only if a difference breaks the data model (for example, no
   `workout-routes/` folder at all).
5. **Phases 1–2, parse and clean.** `make parse strava clean` (sleep is assembled later by `make sleep`, rules Z1–Z5). Read `reports/02_data_health.html`. The checks: counts
   reconcile with the inventory; no moving walk segment faster than 12 mph; the step totals look like the Health app's.
6. **Phase 3, enrich.** `make enrich`. This calls Open-Meteo, NOAA, USGS 3DEP and downloads one Geofabrik regional
   extract (50–500 MB). Tell the user about the download before it starts. A re-run must make zero network calls.
7. **Phase 4, derive and export.** `make derive export`. Then sanity-read the extremes: open the Records chapter or
   `reports/06_validation.md` and look at the top of every record. An absurd record (a 6-second mile, a 400% grade, a
   12-hour walk) is a pipeline bug or an export quirk, never a fact to report. Fix the cause, log the decision.
8. **Phase 5, the app.** `make dev` (http://localhost:5173). Scroll every chapter, read every subtitle, hover a few
   points. `node scripts/shoot.mjs <panel ids>` takes screenshots headlessly when you cannot see a browser. Copy must
   describe what this person's numbers show.
9. **Phase 6, validate.** `make validate` writes `reports/06_validation.md` with blank columns for the user to fill from
   the Fitness and Strava apps; `make verify-clean` rebuilds from raw and must report identical outputs.
10. **Hand over.** Give the user the local URL, the path to the validation report, the decisions you logged, and a
    short list of anything you could not do and why.

Optional extras: `make weather-compare` (how the weather sources agree with Apple's own temperatures for this user),
`node scripts/record.mjs` (a 70-second, beat-synced video of the dashboard in share mode, landscape or `--vertical`, with a
silent copy and one with an original generated soundtrack).

## Where things are

```
pipeline/stride/   inventory, parse, strava, clean (+ track), enrich (+ weather, osm), derive (+ metrics), sleep,
                   export, milestones, validate, verify, demo (synthetic data), health_report, soundtrack (video music)
app/src/           React shell; charts/ are imperative D3 (charts/sleep.ts and components/sleep.tsx are the Sleep page);
                   map/atlas.ts and map/stack.ts (3D) are deck.gl; milestones.ts draws life milestones on every date
                   axis; present.tsx is the video tour; credits.ts is the credit line
scripts/           shoot.mjs (screenshots), record.mjs (video), lib/cdp.mjs (headless Chrome)
docs/              the specs, the playbook, the decisions log
demo/config.yaml   settings for `make demo`
tests/             pytest: a hand-written fixture export, GPS cleaning rules, metrics, the Strava readers
```

Data: `data/raw/` (unzipped export), `data/cache/` (HTTP and DEM cache), `data/stride.duckdb`, and the app's inputs in
`app/public/data/`. All of them are git-ignored.

## Working on the code

- `make test` runs pytest; `make demo` builds everything from synthetic data (`demo-data/`, a person who does not
  exist), which is the quickest way to see a change end to end; `make ci` is what GitHub Actions runs (offline demo,
  tests, app build).
- Keep pipeline steps pure where you can (`track.py` and `metrics.py` are numpy only and unit-tested). New rules get an
  ID, a threshold in `config.yaml`, a `cleaning_log` row per change and an entry in `docs/CLEANING.md`.
- When you change an output, re-run `make verify-clean`: it must still say identical.
- When something looks wrong, read `docs/PLAYBOOK.md` first. Most surprises in an export have been met before.
