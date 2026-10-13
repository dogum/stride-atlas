"""Hourly weather providers for the enrichment step (docs/ENRICHMENT.md).

Every provider returns one year of hourly rows for a 0.25° cell in the same shape as the Open-Meteo archive, so
the rest of enrich.py does not care where the numbers came from:
    time (UTC, naive), temperature_2m °C, relative_humidity_2m %, dew_point_2m °C, apparent_temperature °C,
    precipitation mm, snowfall cm, weather_code (WMO, may be null), cloud_cover %, wind_speed_10m km/h,
    wind_gusts_10m km/h, and optionally condition (one of COND) when the provider reports sky state directly.
Columns a provider cannot supply are null, never zero (ground rule 4).

    open-meteo   ERA5 / ERA5-Land reanalysis, about 9-25 km grid, every variable.
    noaa         NOAA NCEI GHCNh (Global Historical Climatology Network, hourly; the successor to ISD, which
                 stopped updating in August 2025): real observations from the nearest station that has a file for
                 that year, airports preferred (station id kept as provenance). US-run, no key.
    nasa-power   NASA POWER (MERRA-2), a coarse 0.5° x 0.625° reanalysis. US-run, no key. No sky state, so
                 condition is null.
    auto         NOAA where a station within 30 km reported that hour (temperature, humidity, wind, precipitation,
                 rain/snow/storm), Open-Meteo for the rest and for sky cover. The default.
"""
from __future__ import annotations

import io
from datetime import date

import numpy as np
import pandas as pd

from .geo import haversine

OPEN_METEO = "https://archive-api.open-meteo.com/v1/archive"
OM_HOURLY = "temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m"
GHCNH = "https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly"
POWER = "https://power.larc.nasa.gov/api/temporal/hourly/point"
SOURCES = ("open-meteo", "noaa", "nasa-power")
COLS = ["time", "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature", "precipitation", "snowfall",
        "weather_code", "cloud_cover", "wind_speed_10m", "wind_gusts_10m"]


def _year_end(year: int, last_day: date) -> date:
    return min(date(year, 12, 31), last_day)


# ------------------------------------------------------------------ helpers
def rh_from_dew(t, td) -> np.ndarray:
    """Relative humidity (%) from temperature and dew point (Magnus, Alduchov and Eskridge 1996)."""
    a, b = 17.625, 243.04
    return 100 * np.exp(a * td / (b + td) - a * t / (b + t))


def feels_like(t: np.ndarray, rh: np.ndarray, wind_ms: np.ndarray) -> np.ndarray:
    """NWS heat index above 26.7 °C, NWS wind chill at or below 10 °C with wind, otherwise the air temperature."""
    t, rh, v = (np.asarray(x, dtype=float) for x in (t, rh, wind_ms))
    f = t * 9 / 5 + 32
    hi = (-42.379 + 2.04901523 * f + 10.14333127 * rh - 0.22475541 * f * rh - 6.83783e-3 * f * f - 5.481717e-2 * rh * rh
          + 1.22874e-3 * f * f * rh + 8.5282e-4 * f * rh * rh - 1.99e-6 * f * f * rh * rh)
    mph = v * 2.23694
    wc = 35.74 + 0.6215 * f - 35.75 * np.power(np.maximum(mph, 1e-9), 0.16) + 0.4275 * f * np.power(np.maximum(mph, 1e-9), 0.16)
    out = np.where((t >= 26.7) & (rh >= 40), (hi - 32) * 5 / 9, t)
    return np.where((t <= 10) & (mph > 3), (wc - 32) * 5 / 9, out)


# ------------------------------------------------------------------ Open-Meteo
def open_meteo(net, cell_lat: float, cell_lon: float, year: int, last_day: date) -> pd.DataFrame:
    r = net.get(OPEN_METEO, {"latitude": f"{cell_lat:.2f}", "longitude": f"{cell_lon:.2f}", "start_date": f"{year}-01-01",
                             "end_date": _year_end(year, last_day).isoformat(), "hourly": OM_HOURLY, "timezone": "GMT"}, pace_s=4.0)
    df = pd.DataFrame(r.json()["hourly"])
    df["time"] = pd.to_datetime(df["time"])
    df.attrs["source"] = "api:open-meteo"
    return df


# ------------------------------------------------------------------ NOAA GHCNh
_stations: pd.DataFrame | None = None
BAD_QC = {"2", "3", "6", "7"}  # legacy ISD quality codes for suspect or erroneous values, carried into GHCNh
OKTAS = {"CLR": 0, "SKC": 0, "FEW": 1.5, "SCT": 3.5, "BKN": 6, "OVC": 8, "VV": 8}  # METAR sky cover to eighths (range midpoints)


def ghcnh_stations(net) -> pd.DataFrame:
    global _stations
    if _stations is None:
        st = pd.read_csv(io.StringIO(net.get(f"{GHCNH}/doc/ghcnh-station-list.csv", {}).text), dtype=str)
        st["lat"] = pd.to_numeric(st.LATITUDE, errors="coerce")
        st["lon"] = pd.to_numeric(st.LONGITUDE, errors="coerce")
        _stations = st.dropna(subset=["lat", "lon"]).reset_index(drop=True)
    return _stations


def _present_weather(code) -> str | None:
    """WMO 4677 (MW, manual) and 4680 (AW, automated) present-weather codes, folded into the app's conditions."""
    if code is None or pd.isna(code):
        return None
    c = int(code)
    if 90 <= c <= 99:
        return "Storm"
    if 70 <= c <= 79 or 85 <= c <= 87:
        return "Snow"
    if 50 <= c <= 69 or 80 <= c <= 84:
        return "Rain"
    if 10 <= c <= 12 or 30 <= c <= 49:
        return "Overcast"  # mist and fog
    return None


def _code(s: pd.Series) -> pd.Series:
    """'RA:61' or 'SCT:04;' -> the number after the colon."""
    return pd.to_numeric(s.astype("string").str.extract(r":(\d+)")[0], errors="coerce").astype("float64")


def noaa(net, cell_lat: float, cell_lon: float, year: int, last_day: date, max_km: float = 60.0) -> pd.DataFrame:
    empty = pd.DataFrame({c: pd.Series(dtype="float64") for c in COLS}).assign(time=pd.Series(dtype="datetime64[ns]"), condition=pd.Series(dtype="object"))
    empty.attrs["source"] = "api:noaa"
    st = ghcnh_stations(net).copy()
    st["km"] = haversine(st.lat.values, st.lon.values, cell_lat, cell_lon) / 1000
    # airports (an ICAO code) report every hour; prefer them unless a plain station is 10+ km closer
    st["rank"] = st.km - np.where(st.ICAO.fillna("").str.len() > 0, 10.0, 0.0)
    raw, stn = None, None
    for c in st[st.km <= max_km].sort_values(["rank", "GHCN_ID"]).head(4).itertuples():
        r = net.get(f"{GHCNH}/access/by-year/{year}/parquet/GHCNh_{c.GHCN_ID}_{year}.parquet", {}, timeout=300, pace_s=1.0, missing_ok=True)
        if r is not None:
            raw, stn = pd.read_parquet(io.BytesIO(r.content)), {"id": c.GHCN_ID, "name": str(c.NAME).strip().title(), "km": round(float(c.km), 1)}
            break
    if raw is None or not len(raw):
        return empty
    t = pd.to_datetime(raw.DATE)
    bad = lambda c: raw.get(f"{c}_Quality_Code", pd.Series([None] * len(raw))).astype("string").isin(BAD_QC).fillna(False).to_numpy(dtype=bool)  # noqa: E731
    val = lambda c: np.where(bad(c), np.nan, pd.to_numeric(raw.get(c, pd.Series([np.nan] * len(raw))), errors="coerce"))  # noqa: E731
    sky = raw.get("sky_cover_summation_1", pd.Series([None] * len(raw))).astype("string").str.extract(r"^([A-Z]+):")[0]
    for k in ("2", "3", "4"):  # the most covered summation layer is the total
        more = raw.get(f"sky_cover_summation_{k}", pd.Series([None] * len(raw))).astype("string").str.extract(r"^([A-Z]+):")[0]
        sky = sky.where(more.map(OKTAS).fillna(-1) <= sky.map(OKTAS).fillna(-1), more)
    hourly = (raw.get("temperature_Report_Type", pd.Series([""] * len(raw))).astype("string").str.strip() == "FM15").fillna(False).to_numpy(dtype=bool)
    d = pd.DataFrame({
        "time": t.dt.round("h"), "t": val("temperature"), "td": val("dew_point_temperature"), "rh": val("relative_humidity"),
        "wind": val("wind_speed"), "gust": val("wind_gust"),
        # hourly METARs carry the hour's precipitation; specials in between carry partial sums, so only FM-15 counts
        "p_mm": np.where(hourly, val("precipitation"), np.nan),
        "oktas": sky.map(OKTAS).astype("float").to_numpy(),
        "pw": [max((x for x in (_present_weather(a), _present_weather(b)) if x), key=lambda k: {"Storm": 4, "Snow": 3, "Rain": 2, "Overcast": 1}[k], default=None)
               for a, b in zip(_code(raw.get("pres_wx_MW1", pd.Series([None] * len(raw)))), _code(raw.get("pres_wx_AW1", pd.Series([None] * len(raw)))))],
    })
    sev = {"Storm": 4, "Snow": 3, "Rain": 2, "Overcast": 1}
    d["pw_rank"] = d.pw.map(sev)
    g = d.groupby("time")
    h = pd.DataFrame({"temperature_2m": g.t.mean(), "dew_point_2m": g.td.mean(), "rh": g.rh.mean(), "wind_ms": g.wind.mean(), "gust_ms": g.gust.max(),
                      "precipitation": g.p_mm.max(), "oktas": g.oktas.max(), "pw_rank": g.pw_rank.max()}).reset_index()
    h["relative_humidity_2m"] = h.rh.where(h.rh.notna(), pd.Series(rh_from_dew(h.temperature_2m.values, h.dew_point_2m.values)))
    h["apparent_temperature"] = feels_like(h.temperature_2m.values, h.relative_humidity_2m.values, h.wind_ms.values)
    h["wind_speed_10m"] = h.wind_ms * 3.6
    h["wind_gusts_10m"] = h.gust_ms * 3.6
    h["cloud_cover"] = h.oktas / 8 * 100
    h["snowfall"] = np.nan
    h["weather_code"] = np.nan
    cond = h.pw_rank.map({v: k for k, v in sev.items()})
    wet = h.precipitation >= 0.2
    cond = cond.where(cond.notna() & (cond != "Overcast") | ~wet, np.where(h.temperature_2m <= 0, "Snow", "Rain"))
    # the same cloud-cover thresholds Open-Meteo's weather codes use (0-1 below 50%, 2 below 80%, 3 above), so
    # station and reanalysis hours mean the same thing when `auto` mixes them
    cc = h.cloud_cover
    clouds = pd.Series(np.select([cc < 50, cc < 80, cc <= 100], ["Clear", "Partly cloudy", "Overcast"], None), index=h.index)
    h["condition"] = cond.where(cond.notna(), clouds.where(h.oktas.notna()))
    out = h[COLS + ["condition"]]
    out.attrs["source"] = f"api:noaa:{stn['id']}"
    out.attrs["station"] = stn
    return out


# ------------------------------------------------------------------ NASA POWER
def nasa_power(net, cell_lat: float, cell_lon: float, year: int, last_day: date) -> pd.DataFrame:
    r = net.get(POWER, {"parameters": "T2M,RH2M,T2MDEW,WS10M,PRECTOTCORR", "community": "RE", "latitude": f"{cell_lat:.2f}",
                        "longitude": f"{cell_lon:.2f}", "start": f"{year}0101", "end": _year_end(year, last_day).strftime("%Y%m%d"),
                        "format": "JSON", "time-standard": "UTC"}, timeout=300, pace_s=1.0)
    j = r.json()
    p = j["properties"]["parameter"]
    fill = j.get("header", {}).get("fill_value", -999.0)
    df = pd.DataFrame(p).replace(fill, np.nan)
    df.index = pd.to_datetime(df.index, format="%Y%m%d%H")
    h = pd.DataFrame({"time": df.index, "temperature_2m": df.T2M.values, "relative_humidity_2m": df.RH2M.values, "dew_point_2m": df.T2MDEW.values,
                      "precipitation": df.PRECTOTCORR.values, "wind_speed_10m": df.WS10M.values * 3.6})
    h["apparent_temperature"] = feels_like(h.temperature_2m.values, h.relative_humidity_2m.values, df.WS10M.values)
    for c in ("snowfall", "weather_code", "cloud_cover", "wind_gusts_10m"):
        h[c] = np.nan
    out = h[COLS].reset_index(drop=True)
    out["condition"] = None  # POWER has no sky state: unknown, not clear
    out.attrs["source"] = "api:nasa-power"
    return out


# ------------------------------------------------------------------ station first, reanalysis to fill
AUTO_STATION_KM = 30.0


def auto(net, cell_lat: float, cell_lon: float, year: int, last_day: date) -> pd.DataFrame:
    """Observations from a NOAA station within 30 km where it reported, Open-Meteo for every hour and column it
    did not. The row's source names whichever supplied the temperature for that hour."""
    om = open_meteo(net, cell_lat, cell_lon, year, last_day).set_index("time")
    om["condition"] = [condition_class(c) for c in om.weather_code]
    om["src"] = "api:open-meteo"
    st = noaa(net, cell_lat, cell_lon, year, last_day)
    stn = st.attrs.get("station")
    if stn and stn["km"] <= AUTO_STATION_KM and len(st):
        st = st.set_index("time").reindex(om.index)
        for c in ("temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature", "precipitation",
                  "wind_speed_10m", "wind_gusts_10m"):
            om[c] = st[c].where(st[c].notna(), om[c])
        # the station decides wet or dry (present-weather sensors, rain gauge); sky cover stays with the model,
        # because airport ceilometers see nothing above 12,000 ft and report high cloud as clear
        has = st.temperature_2m.notna()
        wet = st.condition.isin(["Rain", "Snow", "Storm"])
        cc = om.cloud_cover
        sky = pd.Series(np.select([cc < 50, cc < 80, cc <= 100], ["Clear", "Partly cloudy", "Overcast"], None), index=om.index).where(cc.notna(), om.condition)
        om["condition"] = np.where(has & wet, st.condition, np.where(has, sky, om.condition))
        om["src"] = np.where(has, f"api:noaa:{stn['id']}", "api:open-meteo")
    out = om.reset_index()
    out.attrs["source"] = "api:auto"
    out.attrs["station"] = stn if stn and stn["km"] <= AUTO_STATION_KM else None
    return out


def condition_class(code) -> str | None:
    """WMO weather_code (Open-Meteo) to the app's sky classes."""
    if code is None or pd.isna(code):
        return None
    c = int(code)
    if c in (0, 1):
        return "Clear"
    if c == 2:
        return "Partly cloudy"
    if c in (3, 45, 48):
        return "Overcast"
    if 51 <= c <= 67 or 80 <= c <= 82:
        return "Rain"
    if 71 <= c <= 77 or c in (85, 86):
        return "Snow"
    if 95 <= c <= 99:
        return "Storm"
    return "Overcast"


PROVIDERS = {"auto": auto, "open-meteo": open_meteo, "noaa": noaa, "nasa-power": nasa_power}
