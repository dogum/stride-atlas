# Enrichment

Free sources that fill what the export lacks. Every call goes through `requests-cache` (SQLite at `data/cache/http.sqlite`, no expiry) so a rebuild makes no network calls. Every filled value gets a provenance column. Check each service's current terms and limits before the first run; the endpoints below are the ones known at the time of writing.

## Weather — Open-Meteo historical archive

- Endpoint: `https://archive-api.open-meteo.com/v1/archive`
- Free for non-commercial use, no key. Fair-use limits are generous (on the order of 10,000 calls a day); this project needs a few dozen.
- Parameters: `latitude`, `longitude`, `start_date`, `end_date` (YYYY-MM-DD), `hourly=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m`, `timezone=GMT`. Request SI units and convert at display time.
- **Batching:** round each workout's start point to a 0.25° grid cell, group workouts by (cell, year), and fetch one full year of hourly data per group. Home is one or two cells, so eight years of walks cost under twenty calls. Rounding also keeps exact locations out of the requests.
- **Per workout:** take the hour containing the start for "conditions at start", and the duration-weighted mean over the workout for temperature, humidity, wind and total precipitation.
- **Condition classes** from WMO `weather_code`: 0–1 Clear; 2 Partly cloudy; 3 Overcast (and 45/48 fog); 51–67 and 80–82 Rain (drizzle included); 71–77 and 85–86 Snow; 95–99 Storm. The app shows all six classes.
- **Precedence:** headline temperature and humidity come from the workout's Health metadata when present (`weather_source = health`), otherwise from the API (`api:open-meteo`). Store both when both exist and put their mean difference in the data-health report. Condition class, wind and precipitation always come from the API, since Health doesn't record them.
- The archive is model reanalysis, not a station reading. Say so in the app's About page.
- **Other providers** (`weather.source` in `config.yaml`; see `pipeline/stride/weather.py`). Each returns the same hourly columns, with nulls for anything it cannot supply:
  - `noaa`: NOAA NCEI **GHCNh** station observations, one Parquet file per station-year from `https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-year/<year>/parquet/GHCNh_<id>_<year>.parquet` (station list: `.../hourly/doc/ghcnh-station-list.csv`). The nearest station within 60 km that has a file for the year, airports preferred; hourly METARs (FM-15) for precipitation; sky state from the most-covered summation layer and present-weather codes. The older ISD service (`/access/services/data/v1?dataset=global-hourly`) stopped updating in August 2025.
  - `nasa-power`: `https://power.larc.nasa.gov/api/temporal/hourly/point` (`T2M,RH2M,T2MDEW,WS10M,PRECTOTCORR`, `community=RE`, `time-standard=UTC`), one year per call. Coarse (0.5°) and no sky state.
  - `auto` (the default): per hour, the NOAA station within 30 km for temperature, humidity, wind, precipitation and rain/snow/storm; Open-Meteo for hours the station missed and, always, for cloud cover (ceilometers stop at 12,000 ft). Station sky cover uses Open-Meteo's thresholds (clear below 50%, partly cloudy below 80%).
  - `make weather-compare` runs every provider over the workouts that carry Apple's own temperature and writes `reports/weather_sources.md`.
- Optional: air quality from `https://air-quality-api.open-meteo.com/v1/air-quality` (`us_aqi`, `pm2_5`). Historical coverage is shorter; check it before building a chart on it.

## Elevation — USGS 3DEP

Two ways in. Use the first for whole tracks and the second for spot gaps.

1. **DEM tiles, sampled locally.** Download 1/3 arc-second (about 10 m) 3DEP elevation for a bounding box around each place cluster, once, with `py3dep` (for example `py3dep.get_dem(bbox, resolution=10)`; check the current API), save as GeoTIFF in `data/cache/dem/`, and sample every cleaned track point with bilinear interpolation. This gives one consistent elevation source across all eight years and every watch generation.
2. **Point query (EPQS).** `https://epqs.nationalmap.gov/v1/json?x=<lon>&y=<lat>&wkid=4326&units=Meters&includeDate=false`, one point per call. Fine for a few hundred start points; too slow for full tracks.

Fallback outside the US: Open-Meteo's elevation endpoint (`https://api.open-meteo.com/v1/elevation`, up to 100 points per call, about 90 m resolution).

Compute DEM climb with the same smoothing and hysteresis as `CLEANING.md` rules E1 and E2, and keep it next to the watch and GPS values (`climb_watch_m`, `climb_dem_m`, `climb_gps_m`).

## Sun — computed locally

`astral`: `sun(LocationInfo(...).observer, date=d, tzinfo=tz)` gives dawn, sunrise, noon, sunset and dusk. Compute for each workout's start point and local date. A workout is "in darkness" if it starts before sunrise or ends after sunset; also store minutes of darkness.

## Time zones — computed locally

`timezonefinder` (`TimezoneFinder().timezone_at(lng=..., lat=...)`) on each route's first point, then `zoneinfo` to convert GPX UTC times to local. Prefer the workout's `HKTimeZone` metadata when present and log disagreements.

## Streets — OpenStreetMap (optional, for exploration metrics)

As built (`pipeline/stride/osm.py`, `make osm`):

- **Network.** By default a Geofabrik regional extract (`exploration.osm_source: extract`): the smallest region in `https://download.geofabrik.de/index-v1.json` that contains home is picked locally, its `.osm.pbf` downloaded once to `data/cache/osm/`, filtered with pyosmium to walkable ways inside a box 3.5 mi around home (snapped outward to a 0.05° grid), written as OSM XML and loaded with `osmnx.graph_from_xml`. The live Overpass API (`osm_source: overpass`) asks for the same snapped box. The graph is cached as GraphML.
- **Classes.** Streets: residential, living street, unclassified, tertiary, secondary, primary, trunk (and links), pedestrian, road. Paths & trails: footway, path, track, steps, bridleway, cycleway, except sidewalks and crossings (`footway=sidewalk|crossing`), which belong to their street. Everything else (service roads, driveways, parking aisles) is drawn faintly and never counted.
- **Matching.** On-foot outdoor tracks resampled every 10 m; each point matches the nearest street within 20 m (walking the sidewalk counts) and, separately, the nearest path within 15 m (shapely STRtree). A segment is walked when 60% of its length lies inside ±6 m windows around its matched points; its walked date is the first walk by which it crossed 60%.
- **Output.** Coverage within 1, 2 and 3 miles for each class, a timeline, and `app/public/data/streets_*.bin` + `streets.json` (segment geometry and attributes; no home coordinates). Attribution: © OpenStreetMap contributors, ODbL.

Without OSM, fall back to the 30 m grid method in `METRICS.md`.

## Basemap — offline vector tiles (optional)

Extract a small Protomaps PMTiles file around each place cluster with the `pmtiles` CLI (`pmtiles extract <current build URL> home.pmtiles --bbox=<w,s,e,n> --maxzoom=15`), put it in `app/public/tiles/`, and load it in MapLibre with the `pmtiles` protocol and a dark style tuned to the app's palette. The map must still work with no basemap (the contour-only night view).

## Provenance columns

| Column | Values |
|---|---|
| `weather_source` | `health`, `api:open-meteo` |
| `climb_source` | `watch`, `dem`, `gps` |
| `elevation_profile_source` | `dem`, `gps` |
| `tz_source` | `metadata`, `timezonefinder` |
| `distance_source` | `watch`, `gps` |
