# Stride Atlas: one command from a Health export to the dashboard. `make all` is idempotent; parse and the Strava
# import are skipped when their input has not changed. `make help` lists the targets.
UV ?= uv run
DATA ?= data
export STRIDE_DATA = $(DATA)
# the newest zip in $(DATA) that holds an Apple Health export, and (optional) the newest Strava "Download your data" zip
ZIP := $(firstword $(wildcard $(DATA)/export.zip) $(shell for z in $$(ls -t $(DATA)/*.zip 2>/dev/null); do unzip -l "$$z" 'apple_health_export/export.xml' >/dev/null 2>&1 && echo "$$z" && break; done))
STRAVA_ZIP := $(shell for z in $$(ls -t $(DATA)/*.zip $(DATA)/raw/*.zip 2>/dev/null); do unzip -l "$$z" activities.csv >/dev/null 2>&1 && echo "$$z" && break; done)
DEMO_DATA ?= demo-data

.PHONY: help all setup unzip inventory parse strava clean enrich osm weather-compare derive export reports validate verify-clean sleep app test dev demo demo-offline demo-digest site ci hashes

help: ## list the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | expand -t 18

all: unzip inventory parse strava clean enrich derive sleep export reports validate ## the whole pipeline, then the validation report

setup: ## install Python (uv) and app (npm) dependencies
	uv sync
	cd app && npm install --no-audit --no-fund

unzip: ## unzip the newest export in $(DATA)/ (and a Strava archive, if there is one)
	@test -n "$(ZIP)" || (echo "No Apple Health export zip in $(DATA)/ (see README: Health app → profile → Export All Health Data)"; exit 1)
	@mkdir -p $(DATA)/raw $(DATA)/archive
	@if [ ! -f $(DATA)/raw/.unzipped ] || [ "$(ZIP)" -nt $(DATA)/raw/.unzipped ]; then \
	  echo "unzipping $(ZIP)"; rm -rf $(DATA)/raw/apple_health_export; \
	  unzip -q -o "$(ZIP)" -x 'apple_health_export/export_cda.xml' -d $(DATA)/raw/ && touch $(DATA)/raw/.unzipped; \
	  D=$$(grep -m1 -o 'ExportDate value="[0-9-]*' $(DATA)/raw/apple_health_export/export.xml | cut -d'"' -f2); \
	  [ -f $(DATA)/archive/export_$$D.zip ] || cp -c "$(ZIP)" $(DATA)/archive/export_$$D.zip 2>/dev/null || cp "$(ZIP)" $(DATA)/archive/export_$$D.zip; \
	else echo "export already unzipped"; fi
	@# Strava: only activities.csv and the activity files; the rest of that zip (messages, logins, media) is never extracted
	@if [ -n "$(STRAVA_ZIP)" ] && { [ ! -f $(DATA)/raw/strava/.unzipped ] || [ "$(STRAVA_ZIP)" -nt $(DATA)/raw/strava/.unzipped ]; }; then \
	  echo "unzipping Strava activities from $(STRAVA_ZIP)"; chmod -R u+w $(DATA)/raw/strava 2>/dev/null; rm -rf $(DATA)/raw/strava; mkdir -p $(DATA)/raw/strava; \
	  unzip -q -o "$(STRAVA_ZIP)" activities.csv 'activities/*' -d $(DATA)/raw/strava && touch $(DATA)/raw/strava/.unzipped && chmod -R a-w $(DATA)/raw/strava/activities $(DATA)/raw/strava/activities.csv; fi

inventory: ## Phase 0: count everything in the export, write reports/00_inventory.html
	$(UV) python -c "from stride import inventory; inventory.main()"

parse: ## Phase 1: export.xml and the GPX files into DuckDB
	$(UV) python -m stride.parse

strava: ## Phase 1b: workouts from a Strava archive, if one was unzipped
	$(UV) python -m stride.strava

clean: ## Phase 2: cleaning rules, reports/02_data_health.html
	$(UV) python -m stride.clean
	$(UV) python -m stride.health_report

enrich: ## Phase 3: weather, elevation, sun, places (cached), and street coverage
	$(UV) python -m stride.enrich
	-$(UV) python -m stride.osm

osm: ## street coverage near home only (OpenStreetMap)
	$(UV) python -m stride.osm

weather-compare: ## how the weather sources agree with Apple's own temperatures
	$(UV) python -m stride.weather_compare

derive: ## Phase 4: metrics, records, loops, fitness model
	$(UV) python -m stride.derive

sleep: ## Phase 4: one row per night from every sleep source (rules Z1-Z5), with overnight vitals
	$(UV) python -m stride.sleep

export: ## Phase 4: Parquet and route buffers for the app
	$(UV) python -m stride.export

reports: ## regenerate the HTML reports
	$(UV) python -m stride.health_report
	@R=$${STRIDE_REPORTS:-reports}; mkdir -p $$R/_assets/fonts; \
	cp app/node_modules/@fontsource-variable/overpass/files/overpass-latin-wght-normal.woff2 \
	   app/node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2 \
	   app/node_modules/@fontsource-variable/overpass-mono/files/overpass-mono-latin-wght-normal.woff2 $$R/_assets/fonts/ 2>/dev/null || true

validate: ## Phase 6: reports/06_validation.md
	$(UV) python -m stride.validate

verify-clean: ## rebuild from the raw export in a scratch folder and compare every output hash
	$(UV) python -m stride.verify

hashes:
	@cat $(DATA)/export_hashes.json

test: ## pytest
	$(UV) pytest -q

app: ## production build of the app
	cd app && npm install --no-audit --no-fund && npm run build

dev: ## the app at http://localhost:5173
	cd app && npm run dev

demo: ## build everything from synthetic data (no export needed) into demo-data/, then run make dev
	@# a regenerated demo is a different export, not a refresh of the old one: start the database fresh (the HTTP cache stays)
	@chmod -R u+w $(DEMO_DATA)/raw 2>/dev/null; rm -rf $(DEMO_DATA)/stride.duckdb $(DEMO_DATA)/raw
	$(UV) python -m stride.demo --out $(DEMO_DATA)
	STRIDE_CONFIG=demo/config.yaml STRIDE_REPORTS=$(DEMO_DATA)/reports $(MAKE) all DATA=$(DEMO_DATA)

SITE_BASE ?= /
SITE_URL ?=
site: ## the public demo site from the demo data (after make demo) into app/dist; SITE_BASE=/repo-name/ for GitHub Pages
	cd app && STRIDE_BASE=$(SITE_BASE) VITE_STRIDE_DEMO=1 SITE_URL=$(SITE_URL) npm run build
	cp docs/images/og.png app/dist/og.png

demo-digest: ## after an intended change to the generator: record the synthetic export's digest that CI checks
	$(UV) python -m stride.demo --out $(DEMO_DATA) --write-digest demo/digest.json

demo-offline: ## the demo with no network calls (weather and elevation stay missing)
	STRIDE_OFFLINE=1 $(MAKE) demo

ci: ## what continuous integration runs: tests, the offline demo pipeline, an app build
	$(MAKE) test
	@chmod -R u+w $(DEMO_DATA)/raw 2>/dev/null; rm -rf $(DEMO_DATA)/stride.duckdb $(DEMO_DATA)/raw
	$(UV) python -m stride.demo --out $(DEMO_DATA) --check demo/digest.json
	STRIDE_OFFLINE=1 STRIDE_CONFIG=demo/config.yaml STRIDE_REPORTS=$(DEMO_DATA)/reports $(MAKE) unzip inventory parse strava clean enrich derive sleep export DATA=$(DEMO_DATA)
	cd app && npm ci --no-audit --no-fund && npm run build
