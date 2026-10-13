"""Geometry, home detection and the time-zone timeline.

Home coordinates live only in data/stride.duckdb (table `home`). Nothing in
this module writes them anywhere else.
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np
import pandas as pd

R_EARTH = 6_371_008.8
MI = 1609.344


def haversine(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = (np.radians(np.asarray(x, dtype=float)) for x in (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(np.minimum(1.0, a)))


def seg_dist(lat, lon):
    """Distance in meters between consecutive points (length n-1)."""
    if len(lat) < 2:
        return np.zeros(0)
    return haversine(lat[:-1], lon[:-1], lat[1:], lon[1:])


def local_xy(lat, lon, lat0, lon0):
    """Equirectangular projection in meters around (lat0, lon0); fine at city scale."""
    k = math.cos(math.radians(lat0))
    return (np.asarray(lon) - lon0) * (math.pi / 180) * R_EARTH * k, (np.asarray(lat) - lat0) * (math.pi / 180) * R_EARTH


def detect_home(starts: pd.DataFrame, radius_m: float = 300.0) -> dict:
    """Home = the densest cluster of route start points.

    For every start, count the starts within `radius_m`; the start with the most
    neighbours seeds the cluster and home is the median of that neighbourhood.
    """
    from scipy.spatial import cKDTree

    lat0, lon0 = float(starts.lat.median()), float(starts.lon.median())
    x, y = local_xy(starts.lat.values, starts.lon.values, lat0, lon0)
    tree = cKDTree(np.c_[x, y])
    counts = np.array([len(c) for c in tree.query_ball_point(np.c_[x, y], radius_m)])
    seed = int(np.argmax(counts))
    nb = tree.query_ball_point([x[seed], y[seed]], radius_m)
    hl, ho = float(np.median(starts.lat.values[nb])), float(np.median(starts.lon.values[nb]))
    return {"lat": hl, "lon": ho, "n_starts": int(len(nb)), "share": float(len(nb) / len(starts))}


@lru_cache(maxsize=1)
def _tf():
    from timezonefinder import TimezoneFinder

    return TimezoneFinder()


@lru_cache(maxsize=100_000)
def tz_at(lat: float, lon: float) -> str | None:
    return _tf().timezone_at(lng=lon, lat=lat)


def tz_segments(obs: pd.DataFrame, home_tz: str) -> pd.DataFrame:
    """Turn (t_utc, tz) observations into contiguous segments [from_utc, to_utc).

    Consecutive observations in the same zone form one segment. When the zone
    changes, the switch happens halfway between the last observation in the old
    zone and the first in the new one. Before the first observation the first
    zone applies, after the last the last zone applies.
    """
    obs = obs.dropna().sort_values("t_utc").reset_index(drop=True)
    if obs.empty:
        return pd.DataFrame({"from_utc": [pd.Timestamp("1900-01-01")], "to_utc": [pd.Timestamp("2200-01-01")], "tz": [home_tz]})
    rows = []
    cur_tz, cur_first, cur_last = obs.tz[0], obs.t_utc[0], obs.t_utc[0]
    for t, z in zip(obs.t_utc[1:], obs.tz[1:]):
        if z == cur_tz:
            cur_last = t
            continue
        rows.append([cur_tz, cur_first, cur_last])
        cur_tz, cur_first, cur_last = z, t, t
    rows.append([cur_tz, cur_first, cur_last])
    segs = []
    for i, (z, a, b) in enumerate(rows):
        start = pd.Timestamp("1900-01-01") if i == 0 else rows[i - 1][2] + (a - rows[i - 1][2]) / 2
        end = pd.Timestamp("2200-01-01") if i == len(rows) - 1 else b + (rows[i + 1][1] - b) / 2
        segs.append({"from_utc": start, "to_utc": end, "tz": z})
    return pd.DataFrame(segs)


def rdp(x: np.ndarray, y: np.ndarray, eps: float) -> np.ndarray:
    """Ramer–Douglas–Peucker; returns the indices of kept points (iterative)."""
    n = len(x)
    if n < 3:
        return np.arange(n)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        dx, dy = x[b] - x[a], y[b] - y[a]
        seg = math.hypot(dx, dy)
        xs, ys = x[a + 1:b], y[a + 1:b]
        if seg == 0:
            d = np.hypot(xs - x[a], ys - y[a])
        else:
            d = np.abs(dy * xs - dx * ys + x[b] * y[a] - y[b] * x[a]) / seg
        i = int(np.argmax(d))
        if d[i] > eps:
            m = a + 1 + i
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return np.flatnonzero(keep)
