"""Compare the weather providers against the temperatures Apple recorded with each workout.

`make weather-compare` (or python -m stride.weather_compare) picks the 0.25° cell-years with the most
Health-recorded temperatures, runs every provider in weather.py over those workouts, and writes
reports/weather_sources.md. Apple's number comes from its weather service at the start of the workout, so it
is a reference, not ground truth; agreement with it is still the best check available inside an export.
Responses go through the same on-disk cache, so a second run makes no calls.
"""
from __future__ import annotations

from datetime import date

import numpy as np

from . import paths
from .enrich import Net, weather_for_workouts
from .paths import Timer
from .weather import PROVIDERS

MAX_CELL_YEARS = 24
F = lambda c: c * 9 / 5 + 32  # noqa: E731


def main() -> None:
    con = paths.connect()
    export_date = con.execute("SELECT v FROM _meta WHERE k='export_date'").fetchone()[0]
    last_day = date.fromisoformat(export_date[:10])
    w = con.execute("""SELECT workout_id, start_utc, end_utc, start_lat, start_lon, temp_health_c, humidity_health
                       FROM workouts_enriched WHERE setting = 'outdoor' AND start_lat IS NOT NULL ORDER BY start_utc, workout_id""").df()
    con.close()
    g = 0.25
    w["cell"] = ((w.start_lat / g).round() * g).round(2).astype(str) + "," + ((w.start_lon / g).round() * g).round(2).astype(str)
    w["year"] = w.start_utc.dt.year
    ref = w[w.temp_health_c.notna()]
    top = ref.groupby(["cell", "year"]).size().sort_values(ascending=False).head(MAX_CELL_YEARS)
    keep = set(top.index)
    sample = ref[[k in keep for k in zip(ref.cell, ref.year)]]
    print(f"weather-compare: {len(sample):,} workouts with an Apple temperature in {len(keep)} cell-years", flush=True)
    net = Net()
    res, rows = {}, {}
    for src in PROVIDERS:
        with Timer(f"compare {src}"):
            wx = weather_for_workouts(net, sample, last_day, src).set_index("workout_id")
        j = sample.set_index("workout_id").join(wx[["temp_api_c", "humidity_api", "condition", "wx_station_km"]])
        d = F(j.temp_api_c) - F(j.temp_health_c)
        ok = d.notna()
        dh = (j.humidity_api - j.humidity_health)[j.humidity_health.notna() & j.humidity_api.notna()]
        res[src] = {"n": int(ok.sum()), "coverage": round(float(ok.mean()), 4), "bias_f": round(float(d[ok].mean()), 2),
                    "mae_f": round(float(d[ok].abs().mean()), 2), "rmse_f": round(float(np.sqrt((d[ok] ** 2).mean())), 2),
                    "within_3f": round(float((d[ok].abs() <= 3).mean()), 4), "p95_abs_f": round(float(d[ok].abs().quantile(0.95)), 1),
                    "humidity_mae_pct": round(float(dh.abs().mean()), 1) if len(dh) else None,
                    "has_condition": round(float(j.condition.notna().mean()), 4),
                    "station_km_median": round(float(j.wx_station_km.median()), 1) if j.wx_station_km.notna().any() else None}
        rows[src] = j
        print(f"  {src}: {res[src]}", flush=True)
    # where both report sky state, how often do the reanalysis and the station agree?
    both = rows["open-meteo"].condition.notna() & rows["noaa"].condition.notna()
    agree = float((rows["open-meteo"].condition[both] == rows["noaa"].condition[both]).mean()) if both.any() else None
    wet = rows["noaa"].condition.isin(["Rain", "Snow", "Storm"])
    wet_om = rows["open-meteo"].condition.isin(["Rain", "Snow", "Storm"])
    out = {"sample": int(len(sample)), "cell_years": len(keep), "providers": res, "condition_agreement_om_noaa": round(agree, 4) if agree is not None else None,
           "wet_share": {"open-meteo": round(float(wet_om[both].mean()), 4) if both.any() else None, "noaa": round(float(wet[both].mean()), 4) if both.any() else None},
           "network_calls": net.calls}
    paths.write_json(paths.DATA / "weather_compare.json", out)

    best = min(res, key=lambda k: (res[k]["mae_f"], -res[k]["coverage"]))
    L = ["# Weather sources compared", "",
         f"Sample: {len(sample):,} outdoor workouts that carry Apple's own start temperature, in the {len(keep)} busiest 0.25° cell-years. "
         "Apple's value comes from its weather service, so this measures agreement with a second estimate, not error against a thermometer on your wrist.", "",
         "| Source | What it is | Workouts filled | Bias | Mean abs. diff. | RMSE | Within 3 °F | 95th pct. | Humidity diff. | Sky state |",
         "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    what = {"auto": "NOAA station within 30 km where it reported, Open-Meteo for the rest",
            "open-meteo": "ERA5 / ERA5-Land reanalysis grid", "noaa": "Nearest station observations, NOAA GHCNh" + (f" (median {res['noaa']['station_km_median']} km away)" if res["noaa"]["station_km_median"] else ""),
            "nasa-power": "MERRA-2 reanalysis, 0.5° grid"}
    for k, r in res.items():
        hum = "—" if r["humidity_mae_pct"] is None else f"{r['humidity_mae_pct']:.1f} pts"
        L.append(f"| `{k}` | {what[k]} | {r['coverage']:.0%} | {r['bias_f']:+.1f} °F | {r['mae_f']:.1f} °F | {r['rmse_f']:.1f} °F | "
                 f"{r['within_3f']:.0%} | {r['p95_abs_f']:.1f} °F | {hum} | {r['has_condition']:.0%} |")
    L += ["", f"Closest to Apple's numbers: **`{best}`**.", ""]
    if agree is not None:
        L.append(f"Sky state, Open-Meteo against the station where both report it: same class {agree:.0%} of the time; "
                 f"wet at the start {out['wet_share']['open-meteo']:.0%} (Open-Meteo) against {out['wet_share']['noaa']:.0%} (station).")
    L += ["", "Choose with `weather.source` in `config.yaml`. Only workouts without an Apple temperature use the provider, and each row keeps its source in `weather_source`.", ""]
    (paths.REPORTS / "weather_sources.md").write_text("\n".join(L))
    print(f"wrote {paths.REPORTS / 'weather_sources.md'}; {net.calls} network calls")


if __name__ == "__main__":
    main()
