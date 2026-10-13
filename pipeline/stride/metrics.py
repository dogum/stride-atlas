"""Pure metric functions from docs/METRICS.md, unit-tested in tests/test_metrics.py."""
from __future__ import annotations

import math

import numpy as np

MI = 1609.344


# ------------------------------------------------------------------ best efforts
def best_effort(d: np.ndarray, t: np.ndarray, D: float, bad: np.ndarray | None = None) -> tuple[float, float] | None:
    """Fastest time to cover distance D inside one track.

    d: cumulative distance (m), non-decreasing. t: cumulative moving time (s).
    bad: boolean per segment k (between points k-1 and k) that a window may not contain
    (signal loss, excised drive). For every end j, the start i is the latest point with
    d[j] - d[i] >= D; the start is interpolated to exactly D. O(n).
    Returns (seconds, start_offset_m) or None.
    """
    n = len(d)
    if n < 2 or d[-1] - d[0] < D:
        return None
    if bad is None:
        bad = np.zeros(n, dtype=bool)
    best = math.inf
    best_off = 0.0
    i = 0
    last_bad = -1  # index of the most recent bad segment end seen
    for j in range(1, n):
        if bad[j]:
            last_bad = j
        # advance i while the window [i+1, j] still covers D
        while i + 1 < j and d[j] - d[i + 1] >= D:
            i += 1
        if d[j] - d[i] < D:
            continue
        if last_bad > i:  # window contains a bad segment
            continue
        # interpolate the start between i and i+1 so the window is exactly D
        target = d[j] - D
        if i + 1 <= j and d[i + 1] > d[i]:
            f = (target - d[i]) / (d[i + 1] - d[i])
            f = min(max(f, 0.0), 1.0)
            ts = t[i] + f * (t[i + 1] - t[i])
        else:
            ts = t[i]
        sec = t[j] - ts
        if 0 < sec < best:
            best, best_off = sec, target
    return (best, best_off) if best < math.inf else None


# ------------------------------------------------------------------ fitness
def trimp_samples(hr: np.ndarray, dt_min: float, hr_rest: float, hr_max: float) -> float:
    """Banister TRIMP over equally spaced samples: sum dt * r * 0.64 * e^(1.92 r)."""
    hr = hr[np.isfinite(hr)]
    if not len(hr) or hr_max <= hr_rest:
        return 0.0
    r = np.clip((hr - hr_rest) / (hr_max - hr_rest), 0.0, 1.2)
    return float(np.sum(dt_min * r * 0.64 * np.exp(1.92 * r)))


def fitness_model(trimp: np.ndarray, tau_fit: float = 42.0, tau_fat: float = 7.0):
    """CTL/ATL with exponential smoothing; TSB is yesterday's CTL - ATL."""
    kc, ka = 1 - math.exp(-1 / tau_fit), 1 - math.exp(-1 / tau_fat)
    n = len(trimp)
    ctl, atl, tsb = np.zeros(n), np.zeros(n), np.zeros(n)
    c = a = 0.0
    for k in range(n):
        tsb[k] = c - a
        x = trimp[k] if np.isfinite(trimp[k]) else 0.0
        c += (x - c) * kc
        a += (x - a) * ka
        ctl[k], atl[k] = c, a
    return ctl, atl, tsb


# ------------------------------------------------------------------ Eddington, streaks
def eddington(values: np.ndarray) -> tuple[int, int]:
    """Largest E with at least E days >= E; and how many more days of E+1 reach the next number."""
    v = np.sort(np.asarray([x for x in values if x is not None and np.isfinite(x)], dtype=float))[::-1]
    e = 0
    for i, x in enumerate(v):
        if x >= i + 1:
            e = i + 1
        else:
            break
    need = (e + 1) - int(np.sum(v >= e + 1))
    return e, max(0, need)


def longest_streak(flags: list[bool]) -> tuple[int, int]:
    """Longest run of True; returns (length, index of the last element of that run)."""
    best = cur = 0
    end = -1
    for i, f in enumerate(flags):
        cur = cur + 1 if f else 0
        if cur > best:
            best, end = cur, i
    return best, end


# ------------------------------------------------------------------ grade-adjusted pace
def minetti_walk(i):
    return 280.5 * i**5 - 58.7 * i**4 - 76.8 * i**3 + 51.9 * i**2 + 19.6 * i + 2.5


def minetti_run(i):
    return 155.4 * i**5 - 30.4 * i**4 - 43.3 * i**3 + 46.3 * i**2 + 19.5 * i + 3.6


def tobler_factor(i):
    """Flat-equivalent metres per metre walked at grade i, from Tobler's hiking function (walking speed
    6·exp(-3.5·|i + 0.05|) km/h): the ratio of flat speed to the speed the same walker keeps on that slope.
    A gentle descent (around -5%) is the fastest ground; steeper descents slow walkers down again."""
    return np.exp(3.5 * (np.abs(np.asarray(i) + 0.05) - 0.05))


def gap_speed(step_m: float, dt: np.ndarray, grade: np.ndarray, running: bool) -> float | None:
    """Moving-time-weighted grade-adjusted speed over equal distance steps.

    Runs use Minetti's running energy cost (METRICS.md). Walks and hikes use Tobler's hiking function: Minetti's
    walking polynomial is a metabolic cost that makes a -8% descent cost half of flat ground, so a downhill mile
    read as twice as slow on flat ground, which is not how walking pace behaves."""
    ok = np.isfinite(dt) & (dt > 0) & np.isfinite(grade)
    if not ok.any():
        return None
    g = np.clip(grade[ok], -0.45, 0.45)
    adj = step_m * (minetti_run(g) / minetti_run(0.0) if running else tobler_factor(g))
    return float(adj.sum() / dt[ok].sum())


# ------------------------------------------------------------------ loops
def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def cells_along(x: np.ndarray, y: np.ndarray, cum: np.ndarray, step: float, grid: float) -> set:
    """Rasterize a track to grid cells, sampling the path every `step` meters."""
    if len(x) < 2 or cum[-1] <= 0:
        return set()
    s = np.arange(0, cum[-1] + 1e-9, step)
    xs, ys = np.interp(s, cum, x), np.interp(s, cum, y)
    ix, iy = np.floor(xs / grid).astype(np.int64), np.floor(ys / grid).astype(np.int64)
    return set((ix * 1_000_003 + iy).tolist())


def signed_area(x: np.ndarray, y: np.ndarray) -> float:
    return 0.5 * float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]) + (x[-1] * y[0] - x[0] * y[-1]))


def components(n: int, pairs: list[tuple[int, int]]) -> list[int]:
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    return [find(i) for i in range(n)]


def loop_label(rank: int) -> str:
    s = ""
    rank += 1
    while rank:
        rank, r = divmod(rank - 1, 26)
        s = chr(65 + r) + s
    return f"Loop {s}"


K_CELL = 1_000_003


def dilate(cells: set) -> set:
    out = set()
    for k in cells:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                out.add(k + dx * K_CELL + dy)
    return out


def buffered_overlap(a: set, b: set, da: set | None = None, db: set | None = None) -> float:
    """Share of each track's cells that fall within one cell of the other track (symmetric).

    Plain Jaccard on a 25 m grid drops to ~0.3 when the same loop is shifted 2 m across a grid
    line; allowing one cell of tolerance makes the 0.85 threshold mean "the same streets".
    """
    if not a or not b:
        return 0.0
    da = da if da is not None else dilate(a)
    db = db if db is not None else dilate(b)
    return (len(a & db) + len(b & da)) / (len(a) + len(b))
