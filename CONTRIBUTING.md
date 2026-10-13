# Contributing

Stride Atlas started as one person's dashboard and became a template so anyone can build theirs. Improvements of every
size are welcome: a quirk your export has that the pipeline missed, a new data source, a chart, a fix to the docs.

## The one rule: no personal data

Never commit, attach or paste anything from a real export: not the zip, not `data/`, not `app/public/data/`, not a
screenshot of your own map without share mode, not a GPX file, not "just a few rows" of `export.xml`. That includes
issues and pull requests. When you need an example:

- **Reproduce it on the demo.** `make demo` builds the whole dashboard for a person who does not exist. If your bug needs
  a quirk the demo lacks, add the quirk to `pipeline/stride/demo.py` (that is a welcome contribution in itself).
- **Describe the shape, not the content**: element names, attribute names, counts, units, a made-up value with the
  same format.
- **Hand-write a fixture** in `tests/fixtures/` with invented coordinates (the demo town near Fort Collins is a good
  place to put them).

## Getting set up

```bash
make setup     # uv sync + npm install
make demo      # the synthetic export through the whole pipeline
make dev       # http://localhost:5173
make ci        # what GitHub Actions runs: tests, the offline demo build, the app build
```

Read [`CLAUDE.md`](CLAUDE.md) and [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md) first; most surprises in an export have been
met before. Working with Claude Code is encouraged: the repository is written to be read by it.

## What a good change looks like

- **It keeps the ground rules** in `CLAUDE.md`: local only, raw data read-only, every number traceable to a provenance
  column, missing is never zero, SI inside and the user's units outside, deterministic outputs.
- **New cleaning rules** get an ID, a threshold in `config.example.yaml`, a `cleaning_log` row per change and an entry
  in `docs/CLEANING.md`. New metrics get a line in `docs/METRICS.md`. A change of default gets a row in
  `docs/DECISIONS.md` with the reason and how to undo it.
- **It is tested**: `track.py` and `metrics.py` are numpy only and easy to unit-test against small hand-computed cases.
- **Outputs stay deterministic**: `make verify-clean` on the demo must still report identical files.
- **It keeps the look**: dusk-navy ground, blaze-orange accent, Overpass / Public Sans / Overpass Mono, light and dark
  themes. No component-library themes.
- **Copy states what the data shows.** No assumed success stories: someone's numbers may go the other way.

## Ideas that would help

- **More sources.** Garmin Connect exports (FIT files), Fitbit or Google Takeout, Health Connect on Android, Polar,
  COROS, Suunto, Samsung Health, or simply a folder of GPX files. The Strava importer (`pipeline/stride/strava.py`) is the
  pattern: load into the same tables under the source's own natural key and name, and let rule W1 merge copies.
- **Exports from other regions.** Weather and terrain fall back to Open-Meteo outside the US; better local elevation
  sources, metric-first copy and non-English exports all need people who have them.
- **Manual entries** for activities no device kept, with provenance `manual`.
- **Air quality**, a labelled basemap, new chapters.

## Pull requests

Keep them focused, describe what changed and how you checked it, and fill in the checklist in the template. If you are
unsure whether something fits, open an issue first.

## Credit

Stride Atlas was made by [Greg Dogum](https://github.com/dogum) with [Claude Code](https://claude.com/claude-code), and it is MIT licensed: fork it,
change it, ship it. The small credit line lives in `app/src/credits.ts`; if you build on the project, a link back is
appreciated.
