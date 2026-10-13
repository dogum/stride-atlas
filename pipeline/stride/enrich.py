"""Phase 3: weather, DEM elevation and climb, sun times, place clusters.

All HTTP goes through requests-cache (data/cache/http.sqlite, never expires), so
a re-run makes zero network calls. Privacy: weather requests use the start point
rounded to a 0.25° grid; DEM and OSM requests use fixed grid tiles (0.1°), never a
box centred on home.
"""
from __future__ import annotations

import json
import os
import time
from datetime import date
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests_cache

from . import paths
from .geo import haversine
from .paths import Timer
from .track import TrackParams, climb_hysteresis, smooth_elevation
from .weather import PROVIDERS, condition_class

OPEN_METEO_ELEV = "https://api.open-meteo.com/v1/elevation"
DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
TILE = 0.1          # degrees per DEM tile
DEM_RES = 1 / 10800  # 1/3 arc-second, about 10 m


class Offline(Exception):
    """STRIDE_OFFLINE=1 and the response is not in the cache: the caller leaves the value missing."""


class Net:
    """Cached HTTP with a count of real network calls. With STRIDE_OFFLINE=1 only cached responses are used."""

    def __init__(self):
        (paths.CACHE).mkdir(parents=True, exist_ok=True)
        self.s = requests_cache.CachedSession(str(paths.CACHE / "http"), backend="sqlite", expire_after=requests_cache.NEVER_EXPIRE,
                                              allowable_codes=(200, 404), stale_if_error=True)
        self.s.headers["User-Agent"] = "stride-atlas/0.1 (personal, local)"
        self.calls = 0
        self.hits = 0

    def get(self, url, params, timeout=120, pace_s=0.25, missing_ok=False):
        """pace_s: pause after a real network call. Open-Meteo weights a year of hourly data as ~30 calls
        against a 600/minute limit, so archive requests are spaced out; a 429 waits out the minute."""
        if os.environ.get("STRIDE_OFFLINE"):
            r = self.s.get(url, params=params, timeout=timeout, only_if_cached=True)
            if not getattr(r, "from_cache", False):
                raise Offline(url)
            self.hits += 1
            if r.status_code == 404 and missing_ok:
                return None
            r.raise_for_status()
            return r
        for attempt in range(6):
            try:
                r = self.s.get(url, params=params, timeout=timeout)
                if getattr(r, "from_cache", False):
                    self.hits += 1
                else:
                    self.calls += 1
                    if r.status_code == 429:
                        print("  rate limited; waiting 65 s", flush=True)
                        time.sleep(65)
                        continue
                    time.sleep(pace_s)
                if r.status_code == 404 and missing_ok:  # cached too, so asking again costs nothing
                    return None
                r.raise_for_status()
                return r
            except Exception as e:  # transient network failure: back off and retry
                if attempt == 5:
                    raise
                print(f"  retry {attempt + 1} after {e}", flush=True)
                time.sleep(5 * (attempt + 1))
        raise RuntimeError(f"gave up on {url}")


# ------------------------------------------------------------------ places
def place_clusters(starts: pd.DataFrame, eps_m: float = 2000.0) -> np.ndarray:
    """DBSCAN with min_samples=1 on start points: connected components of the 2 km neighbourhood graph."""
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    # 3D unit vectors rather than a local plane, so clusters anywhere on the globe come out right
    la, lo = np.radians(starts.lat.values), np.radians(starts.lon.values)
    xyz = np.c_[np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)] * 6_371_008.8
    tree = cKDTree(xyz)
    pairs = tree.query_pairs(eps_m, output_type="ndarray")
    from scipy.sparse import coo_matrix

    n = len(starts)
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n)) if len(pairs) else coo_matrix((n, n))
    _, labels = connected_components(g, directed=False)
    return labels


# ------------------------------------------------------------------ weather
def weather_for_workouts(net: Net, w: pd.DataFrame, last_day: date, source: str = "open-meteo") -> pd.DataFrame:
    """Weather at the start of each outdoor workout, plus duration-weighted means, from one provider (weather.py)."""
    fetch = PROVIDERS[source]
    g = 0.25
    w = w.copy()
    w["cell_lat"] = (w.start_lat / g).round() * g
    w["cell_lon"] = (w.start_lon / g).round() * g
    w["year"] = w.start_utc.dt.year
    out = []

    def wmean(v, f):  # weighted mean over the hours that have a value; None when none do (missing is not zero)
        m = np.isfinite(v)
        return float((v[m] * f[m]).sum() / f[m].sum()) if m.any() and f[m].sum() > 0 else None

    for (cla, clo, yr), grp in w.groupby(["cell_lat", "cell_lon", "year"]):
        try:
            parts = [fetch(net, cla, clo, int(yr), last_day)]
            if (grp.end_utc.dt.year > yr).any() and yr < last_day.year:
                parts.append(fetch(net, cla, clo, int(yr) + 1, last_day))
        except Offline:
            out.extend({"workout_id": r.workout_id, "wx_cell": f"{cla:.2f},{clo:.2f}"} for r in grp.itertuples())
            continue
        src = parts[0].attrs.get("source", f"api:{source}")
        stn = parts[0].attrs.get("station")
        hours = pd.concat(parts, ignore_index=True).drop_duplicates("time").set_index("time").sort_index()
        has_cond = "condition" in hours.columns
        for r in grp.itertuples():
            h0 = r.start_utc.floor("h")
            row = {"workout_id": r.workout_id, "wx_cell": f"{cla:.2f},{clo:.2f}", "wx_source": src,
                   "wx_station_km": stn["km"] if stn else None}
            if h0 in hours.index:
                s = hours.loc[h0]
                if "src" in hours.columns:  # auto: the provider that supplied this hour
                    row["wx_source"] = s.src
                    if not str(s.src).startswith("api:noaa"):
                        row["wx_station_km"] = None
                kmh = lambda v: v / 3.6 if pd.notna(v) else None  # noqa: E731
                row.update(temp_api_c=s.temperature_2m, feels_c=s.apparent_temperature, humidity_api=s.relative_humidity_2m, dew_c=s.dew_point_2m,
                           wcode=s.weather_code, cloud=s.cloud_cover, wind_ms=kmh(s.wind_speed_10m), gust_ms=kmh(s.wind_gusts_10m))
                if has_cond:
                    row["condition"] = s.condition if isinstance(s.condition, str) else None
            # duration-weighted means over the workout, and total precipitation
            span = hours.loc[h0: r.end_utc.floor("h")]
            if len(span):
                wts = np.array([max(0.0, (min(t + pd.Timedelta(hours=1), r.end_utc) - max(t, r.start_utc)).total_seconds()) for t in span.index])
                if wts.sum() > 0:
                    f = wts / wts.sum()
                    col = lambda c: span[c].to_numpy(dtype=float)  # noqa: E731
                    row["temp_mean_c"] = wmean(col("temperature_2m"), f)
                    row["humidity_mean"] = wmean(col("relative_humidity_2m"), f)
                    wm = wmean(col("wind_speed_10m"), f)
                    row["wind_mean_ms"] = wm / 3.6 if wm is not None else None
                    for c, k in (("precipitation", "precip_mm"), ("snowfall", "snow_cm")):
                        v = col(c)
                        row[k] = float(np.nansum(v * wts / 3600.0)) if np.isfinite(v).any() else None
            if not has_cond:
                row["condition"] = condition_class(row.get("wcode"))
            out.append(row)
    return pd.DataFrame(out)


# ------------------------------------------------------------------ DEM
def in_3dep(lat, lon) -> np.ndarray:
    lat, lon = np.asarray(lat), np.asarray(lon)
    conus = (lat > 24) & (lat < 50) & (lon > -125.5) & (lon < -66)
    ak = (lat > 51) & (lat < 72) & (lon > -170) & (lon < -129)
    hi = (lat > 18.5) & (lat < 22.5) & (lon > -161) & (lon < -154)
    return conus | ak | hi


def fetch_tile(net: Net, ti: int, tj: int):
    import rasterio

    s, w = ti * TILE, tj * TILE
    n_, e = s + TILE, w + TILE
    npx = int(round(TILE / DEM_RES))
    path = paths.CACHE / "dem" / f"dem_{ti}_{tj}.tif"
    path.parent.mkdir(parents=True, exist_ok=True)
    r = net.get(DEM_URL, {"bbox": f"{w:.4f},{s:.4f},{e:.4f},{n_:.4f}", "bboxSR": 4326, "imageSR": 4326, "size": f"{npx},{npx}",
                          "format": "tiff", "pixelType": "F32", "noData": "-9999", "interpolation": "RSP_BilinearInterpolation", "f": "image"}, timeout=300)
    if not path.exists():
        path.write_bytes(r.content)
    with rasterio.MemoryFile(r.content) as mf, mf.open() as ds:
        a = ds.read(1).astype(np.float64)
        tr = ds.transform
    a[(a < -500) | (a > 9000)] = np.nan
    return a, tr


def sample_bilinear(a: np.ndarray, tr, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    inv = ~tr
    col, row = inv * (lon, lat)
    col, row = np.asarray(col) - 0.5, np.asarray(row) - 0.5  # pixel centres
    c0, r0 = np.floor(col).astype(int), np.floor(row).astype(int)
    fc, fr = col - c0, row - r0
    H, W = a.shape
    c0 = np.clip(c0, 0, W - 2)
    r0 = np.clip(r0, 0, H - 2)
    v = (a[r0, c0] * (1 - fc) * (1 - fr) + a[r0, c0 + 1] * fc * (1 - fr) + a[r0 + 1, c0] * (1 - fc) * fr + a[r0 + 1, c0 + 1] * fc * fr)
    return v


def dem_for_points(net: Net, lat: np.ndarray, lon: np.ndarray, cum_m: np.ndarray, wid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Elevation for every cleaned point: 3DEP tiles in the US, Open-Meteo (90 m) elsewhere."""
    ele = np.full(len(lat), np.nan)
    src = np.full(len(lat), "", dtype=object)
    us = in_3dep(lat, lon)
    ti, tj = np.floor(lat / TILE).astype(int), np.floor(lon / TILE).astype(int)
    keys = sorted(set(zip(ti[us].tolist(), tj[us].tolist())))
    print(f"  {len(keys)} DEM tiles", flush=True)
    for k, (a_, b_) in enumerate(keys):
        try:
            a, tr = fetch_tile(net, a_, b_)
        except Offline:
            continue  # missing, not zero: these points keep their GPS altitude
        m = us & (ti == a_) & (tj == b_)
        ele[m] = sample_bilinear(a, tr, lat[m], lon[m])
        src[m] = "dem"
        if (k + 1) % 10 == 0:
            print(f"  tile {k + 1}/{len(keys)}", flush=True)
    # outside 3DEP: Open-Meteo elevation every ~100 m along each route, interpolated by distance
    rest = ~us
    if rest.any():
        idx = np.flatnonzero(rest)
        samples = []
        for w_ in np.unique(wid[idx]):
            ii = idx[wid[idx] == w_]
            d = cum_m[ii]
            pick = np.unique(np.r_[0, np.searchsorted(d, np.arange(0, d[-1], 100.0)), len(ii) - 1])
            samples.append((w_, ii, pick))
        flat = [(ii[p_], lat[ii[p_]], lon[ii[p_]]) for _, ii, pk in samples for p_ in pk]
        got = {}
        for c in range(0, len(flat), 100):
            ch = flat[c:c + 100]
            try:
                r = net.get(OPEN_METEO_ELEV, {"latitude": ",".join(f"{x[1]:.5f}" for x in ch), "longitude": ",".join(f"{x[2]:.5f}" for x in ch)})
            except Offline:
                break
            for (gi, _, _), e in zip(ch, r.json()["elevation"]):
                got[gi] = e
        for _, ii, pk in samples:
            xs = cum_m[ii[pk]]
            ys = np.array([got.get(ii[p_], np.nan) for p_ in pk], dtype=float)
            ok = np.isfinite(ys)
            if ok.sum() >= 2:
                ele[ii] = np.interp(cum_m[ii], xs[ok], ys[ok])
                src[ii] = "api:open-meteo-elevation"
    return ele, src


# ------------------------------------------------------------------ sun
def sun_times(lat: float, lon: float, d: date, tz: str) -> dict:
    from astral import LocationInfo
    from astral.sun import sun

    try:
        s = sun(LocationInfo(latitude=lat, longitude=lon, timezone=tz).observer, date=d, tzinfo=ZoneInfo(tz))
        return {k: s[k].replace(tzinfo=None) for k in ("dawn", "sunrise", "noon", "sunset", "dusk")}
    except Exception:  # polar day/night
        return {}


# ------------------------------------------------------------------ main
def run() -> dict:
    cfg = paths.config()
    con = paths.connect()
    net = Net()
    out = {}
    export_date = con.execute("SELECT v FROM _meta WHERE k='export_date'").fetchone()[0]
    last_day = date.fromisoformat(export_date[:10])
    w = con.execute("SELECT * FROM workouts_clean ORDER BY start_utc, workout_id").df()
    home = con.execute("SELECT lat, lon FROM home").fetchone()

    with Timer("place clusters"):
        has = w.setting.eq("outdoor") & w.start_lat.notna()
        starts = w.loc[has, ["workout_id", "start_lat", "start_lon"]].rename(columns={"start_lat": "lat", "start_lon": "lon"}).reset_index(drop=True)
        lab = place_clusters(starts)
        starts["cluster"] = lab
        # order clusters by size; place 0 is the one containing home
        d_home = haversine(starts.lat, starts.lon, home[0], home[1])
        home_cl = int(starts.cluster[np.argmin(d_home)])
        sizes = starts.groupby("cluster").size().sort_values(ascending=False)
        order = [home_cl] + [c for c in sizes.index if c != home_cl]
        remap = {c: i for i, c in enumerate(order)}
        starts["place_id"] = starts.cluster.map(remap)
        w = w.merge(starts[["workout_id", "place_id"]], on="workout_id", how="left")
        out["places"] = int(len(order))

    wx_src = cfg.get("weather", {}).get("source", "auto")
    if wx_src not in PROVIDERS:
        raise SystemExit(f"weather.source must be one of {', '.join(PROVIDERS)} (config.yaml), not {wx_src!r}")
    with Timer(f"weather ({wx_src})"):
        ow = w[w.setting.eq("outdoor") & w.start_lat.notna()]
        wx = weather_for_workouts(net, ow, last_day, wx_src)
        w = w.merge(wx, on="workout_id", how="left")
        w["temp_c"] = w.temp_health_c.where(w.temp_health_c.notna(), w.temp_api_c)
        w["humidity"] = w.humidity_health.where(w.humidity_health.notna(), w.humidity_api)  # both in percent
        w["weather_source"] = np.where(w.temp_health_c.notna(), "health", np.where(w.temp_api_c.notna(), w.wx_source, None))
        out["weather_provider"] = wx_src
        out["weather_calls"] = net.calls

    with Timer("elevation (USGS 3DEP)"):
        pts = con.execute("SELECT workout_id, seq, lat, lon, cum_m FROM route_points_clean ORDER BY workout_id, seq").fetchnumpy()
        ele, src = dem_for_points(net, pts["lat"], pts["lon"], pts["cum_m"], pts["workout_id"])
        dem = pd.DataFrame({"workout_id": pts["workout_id"], "seq": pts["seq"], "ele_dem_m": ele, "ele_dem_src": src})
        con.register("dem_df", dem)
        con.execute("""CREATE OR REPLACE TABLE route_points_enriched AS
            SELECT p.*, d.ele_dem_m, NULLIF(d.ele_dem_src, '') AS ele_dem_src FROM route_points_clean p JOIN dem_df d USING (workout_id, seq)
            ORDER BY workout_id, seq""")
        con.unregister("dem_df")
        # DEM climb with the same smoothing and hysteresis as E1/E2
        t = con.execute("SELECT workout_id, epoch(t_utc) AS t FROM route_points_clean ORDER BY workout_id, seq").fetchnumpy()["t"]
        u, f = np.unique(pts["workout_id"], return_index=True)
        bnd = np.r_[f, len(t)]
        p = TrackParams(climb_hysteresis_m=cfg["cleaning"]["climb_hysteresis_m"])
        rows = []
        for i, wid in enumerate(u):
            a, b = bnd[i], bnd[i + 1]
            e = ele[a:b]
            if np.isfinite(e).mean() < 0.7 or b - a < 10:
                rows.append({"workout_id": wid, "climb_dem_m": None, "descent_dem_m": None, "dem_source": None})
                continue
            es = smooth_elevation(t[a:b].astype(float), e, p)
            up, down = climb_hysteresis(es, p.climb_hysteresis_m)
            rows.append({"workout_id": wid, "climb_dem_m": up, "descent_dem_m": down, "dem_source": src[a]})
        w = w.merge(pd.DataFrame(rows), on="workout_id", how="left")
        # E3 headline climb: watch, else DEM, else GPS
        w["climb_m"] = w.climb_watch_m.where(w.climb_watch_m.notna(), w.climb_dem_m.where(w.climb_dem_m.notna(), w.climb_gps_m))
        w["climb_source"] = np.where(w.climb_watch_m.notna(), "watch", np.where(w.climb_dem_m.notna(), "dem", np.where(w.climb_gps_m.notna(), "gps", None)))
        w["descent_m"] = w.descent_dem_m.where(w.descent_dem_m.notna(), w.descent_gps_m)
        w["elevation_profile_source"] = np.where(w.climb_dem_m.notna(), "dem", np.where(w.climb_gps_m.notna(), "gps", None))
        out["dem_calls_total"] = net.calls

    with Timer("sun"):
        sun_rows = []
        for r in w.itertuples():
            la, lo = (r.start_lat, r.start_lon) if pd.notna(r.start_lat) else home
            st = sun_times(float(la), float(lo), r.local_date if isinstance(r.local_date, date) else pd.Timestamp(r.local_date).date(), r.tz)
            row = {"workout_id": r.workout_id}
            if st:
                # the end uses elapsed time, so a workout left running after a final pause (W5) is not "in darkness" all night
                s0 = pd.Timestamp(r.start_local)
                e0 = s0 + pd.Timedelta(seconds=float(r.elapsed_s)) if pd.notna(r.elapsed_s) else pd.Timestamp(r.end_local)
                rise, sset = pd.Timestamp(st["sunrise"]), pd.Timestamp(st["sunset"])
                row.update(sunrise_local=rise, sunset_local=sset, dawn_local=pd.Timestamp(st["dawn"]), dusk_local=pd.Timestamp(st["dusk"]),
                           in_dark=bool(s0 < rise or e0 > sset),
                           dark_min=max(0.0, (min(e0, rise) - s0).total_seconds() / 60) + max(0.0, (e0 - max(s0, sset)).total_seconds() / 60))
            sun_rows.append(row)
        w = w.merge(pd.DataFrame(sun_rows), on="workout_id", how="left")
        # home sun table for the Rhythm chapter (each day of a reference year and every date in range)
        tz_home = con.execute("SELECT home_tz FROM tz_segments LIMIT 1").fetchone()[0]
        days = pd.date_range("2014-01-01", last_day.isoformat(), freq="D")
        hs = []
        for d in days:
            st = sun_times(home[0], home[1], d.date(), tz_home)
            if st:
                hs.append({"date": d.date(), **{k + "_h": st[k].hour + st[k].minute / 60 + st[k].second / 3600 for k in ("dawn", "sunrise", "sunset", "dusk")}})
        con.register("hs_df", pd.DataFrame(hs))
        con.execute("CREATE OR REPLACE TABLE sun_home AS SELECT * FROM hs_df ORDER BY date")

    w["tz_source"] = w.tz_source
    con.register("we_df", w)
    con.execute("CREATE OR REPLACE TABLE workouts_enriched AS SELECT * FROM we_df ORDER BY start_utc, workout_id")
    out["network_calls"] = net.calls
    out["cache_hits"] = net.hits
    miss = con.execute("SELECT count(*) FROM workouts_enriched WHERE setting='outdoor' AND temp_c IS NULL").fetchone()[0]
    out["outdoor_without_temperature"] = int(miss)
    con.execute("CREATE TABLE IF NOT EXISTS enrich_log (k VARCHAR, v VARCHAR)")
    con.execute("DELETE FROM enrich_log")
    con.executemany("INSERT INTO enrich_log VALUES (?, ?)", [(k, json.dumps(v, default=str)) for k, v in out.items()])
    con.close()
    paths.write_json(paths.DATA / "enrich_log.json", out)
    return out


def main() -> None:
    print(json.dumps(run(), indent=1, default=str))


if __name__ == "__main__":
    main()
