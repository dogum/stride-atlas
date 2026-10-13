"""Synthetic demo data: an Apple Health export and a Strava archive for a person who does not exist.

    python -m stride.demo --out demo-data        (or `make demo`, which then builds the dashboard from it)

writes
    demo-data/export.zip               apple_health_export/export.xml + workout-routes/*.gpx
    demo-data/export_strava_demo.zip   activities.csv + activities/*.tcx.gz|*.gpx (a Strava "Download your data" archive)
    demo-data/town.osm                 the town's walkable streets and trails as OSM XML, for the street-coverage step

"Alex" lives in Cedar Hollow, a procedural town laid over real terrain near Fort Collins, Colorado, so the weather
and elevation lookups return real values for its location. The data follows the shapes of a real export (see
docs/HEALTH_EXPORT.md) including its quirks, so every cleaning rule has something to do: watch and phone writing
the same steps, a walk saved twice, a watch left running after a pause, a drive home recorded at the end of a hike,
GPS jumps, accidental starts, walks that were really runs, missing GPX altitude, the export-time UTC offset on
every timestamp, humidity written as "5600 %". Everything comes from one seeded generator, so two runs write
byte-identical files.
"""
from __future__ import annotations

import argparse
import gzip
import io
import math
import zipfile
import zlib
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

R_EARTH = 6371008.8
MI = 1609.344
TZ = ZoneInfo("America/Denver")
HOME = (40.5530, -105.0930)          # Cedar Hollow: real terrain near Fort Collins, procedural streets
TRIP = (35.5951, -82.5515)           # a week away now and then, in the Blue Ridge
TRIP_TZ = ZoneInfo("America/New_York")
EXPORT_AT = datetime(2026, 9, 30, 19, 42, 10, tzinfo=TZ)
XOFF = timezone(EXPORT_AT.utcoffset())   # every export timestamp carries this offset, whatever the date
APPLE_FIRST = date(2018, 1, 1)           # the phone's first day in Health
WATCH_FROM, ULTRA_FROM = date(2019, 3, 16), date(2023, 10, 1)
MOBILITY_FROM, DAYLIGHT_FROM = date(2020, 9, 17), date(2023, 10, 1)
DENSE_HR_FROM = date(2025, 6, 1)         # the export only carries dense workout heart rate for recent workouts
STRAVA_FROM, STRAVA_TO = date(2016, 4, 2), date(2019, 3, 10)
NAME = "Alex"
WATCH_SRC = {"Watch4,2": f"{NAME}’s Apple Watch", "Watch7,5": f"{NAME}’s Apple Watch"}  # the second one has the non-breaking space
PHONE_SRC = f"{NAME}’s iPhone"
PHONES = [(date(2018, 1, 1), "iPhone10,6", "11.2"), (date(2021, 10, 14), "iPhone14,2", "15.0"), (date(2025, 9, 20), "iPhone18,1", "26.0")]


# ------------------------------------------------------------------ geometry
def to_ll(x, y, origin=HOME):
    lat = origin[0] + np.degrees(np.asarray(y) / R_EARTH)
    lon = origin[1] + np.degrees(np.asarray(x) / (R_EARTH * math.cos(math.radians(origin[0]))))
    return lat, lon


def elev_home(x, y):
    """Synthetic terrain for Cedar Hollow: a plain rising gently to the west, then foothills and a ridge."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    return (1522 + 0.006 * np.maximum(0, -x) + 430 / (1 + np.exp((x + 7300) / 420)) + 120 / (1 + np.exp((x + 8700) / 260))
            + 5 * np.sin(x / 330) * np.cos(y / 290) + 2.5 * np.sin((x + y) / 140))


def elev_trip(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    return 655 + 28 * np.sin(x / 420) * np.cos(y / 380) + 260 / (1 + np.exp((y - 5200) / 600))


def tobler(grade):
    return np.exp(-3.5 * (np.abs(grade + 0.05) - 0.05))  # walking speed relative to flat ground


# ------------------------------------------------------------------ street graph
class Graph:
    def __init__(self, name: str, origin, elev):
        self.name, self.origin, self.elev = name, origin, elev
        self.xy: list[tuple[float, float]] = []
        self.edges: list[dict] = []
        self.adj: dict[int, list[tuple[int, int]]] = defaultdict(list)
        self.kind: list[str] = []

    def node(self, x, y, kind="town"):
        self.xy.append((float(x), float(y)))
        self.kind.append(kind)
        return len(self.xy) - 1

    def edge(self, u, v, pts=None, cls="residential", name=None, walk=True, extra=None):
        p = np.array(pts if pts is not None else [self.xy[u], self.xy[v]], float)
        p[0], p[-1] = self.xy[u], self.xy[v]
        length = float(np.hypot(*np.diff(p, axis=0).T).sum())
        i = len(self.edges)
        self.edges.append({"u": u, "v": v, "pts": p, "cls": cls, "name": name, "len": max(length, 1.0), "walk": walk, "extra": extra or {}})
        if walk:
            self.adj[u].append((v, i))
            self.adj[v].append((u, i))
        return i

    def matrix(self, rng, jitter=0.0, prefer_trails=1.0):
        from scipy.sparse import csr_matrix

        if getattr(self, "_arr", None) is None or self._arr[0] != len(self.edges):
            ws = [e for e in self.edges if e["walk"]]
            self._arr = (len(self.edges), np.array([e["u"] for e in ws]), np.array([e["v"] for e in ws]), np.array([e["len"] for e in ws]),
                         np.array([e["cls"] in ("path", "footway", "track") for e in ws]))
        _, u, v, L, trail = self._arr
        c = L * (1 + jitter * rng.random(len(L))) * np.where(trail, prefer_trails, 1.0)
        n = len(self.xy)
        return csr_matrix((np.r_[c, c], (np.r_[u, v], np.r_[v, u])), shape=(n, n))

    def route(self, nodes_seq, rng, jitter=0.25, prefer_trails=1.0):
        """Shortest paths through a list of waypoint nodes, on edge weights jittered for this walk."""
        from scipy.sparse.csgraph import dijkstra

        M = self.matrix(rng, jitter, prefer_trails)
        path = [nodes_seq[0]]
        for a, b in zip(nodes_seq[:-1], nodes_seq[1:]):
            _, pred = dijkstra(M, indices=a, return_predecessors=True)
            if pred[b] < 0 and a != b:
                return None
            seg, c = [], b
            while c != a:
                seg.append(c)
                c = pred[c]
            path += seg[::-1]
        return path

    def polyline(self, path):
        out = [np.array([self.xy[path[0]]])]
        for a, b in zip(path[:-1], path[1:]):
            cand = [i for (o, i) in self.adj[a] if o == b]
            e = self.edges[min(cand, key=lambda i: self.edges[i]["len"])]
            p = e["pts"] if e["u"] == a else e["pts"][::-1]
            out.append(p[1:])
        return np.vstack(out)

    def nearest(self, x, y, kind=None):
        xy = np.array(self.xy)
        d = np.hypot(xy[:, 0] - x, xy[:, 1] - y)
        if kind:
            d = np.where(np.array(self.kind) == kind, d, np.inf)
        return int(np.argmin(d))


STREETS = ["Aspen", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo", "Hawthorn", "Ivy", "Juniper", "Linden", "Maple", "Oak", "Pine",
           "Quince", "Redbud", "Spruce", "Tamarack", "Walnut", "Willow", "Yarrow", "Alder", "Beech", "Chestnut", "Hazel", "Larch", "Magnolia",
           "Poplar", "Sumac", "Sycamore", "Laurel", "Locust", "Hemlock", "Mulberry", "Olive", "Plum", "Rowan", "Sage", "Thistle", "Clover"]
AVES = ["Harmony", "Prospect", "Horsetooth", "Drake", "Swallow", "Mulberry", "Laurel", "Plum", "Elizabeth", "Vine", "Lemay", "Shields",
        "Taft", "Overland", "Timberline", "Ziegler", "Trilby", "Kechter", "Rolland", "Stuart", "Mountain", "Lake", "Pitkin", "Garfield"]


def build_town(rng) -> Graph:
    g = Graph("home", HOME, elev_home)
    nx_, ny_, dx, dy = 44, 46, 152.0, 112.0
    x0, y0 = -nx_ * dx / 2, -ny_ * dy / 2
    ang = math.radians(7)
    rot = lambda x, y: (x * math.cos(ang) - y * math.sin(ang), x * math.sin(ang) + y * math.cos(ang))  # noqa: E731
    grid = {}
    for i in range(nx_ + 1):
        for j in range(ny_ + 1):
            x, y = rot(x0 + i * dx + rng.normal(0, 6), y0 + j * dy + rng.normal(0, 5))
            grid[i, j] = g.node(x, y)
    arterial_i = {i for i in range(nx_ + 1) if i % 9 == 4}
    arterial_j = {j for j in range(ny_ + 1) if j % 10 == 5}
    subdivision = lambda i, j: i >= 26 and j >= 24  # noqa: E731  curvy streets in the north-east
    for i in range(nx_ + 1):
        for j in range(ny_ + 1):
            for di, dj in ((1, 0), (0, 1)):
                a, b = (i, j), (i + di, j + dj)
                if b not in grid:
                    continue
                horiz = dj == 0
                art = (j in arterial_j) if horiz else (i in arterial_i)
                if not art and rng.random() < (0.16 if subdivision(i, j) else 0.07):
                    continue  # missing blocks and cul-de-sacs keep the grid from being a lattice
                u, v = grid[a], grid[b]
                pts = None
                if subdivision(i, j) and not art:
                    p0, p1 = np.array(g.xy[u]), np.array(g.xy[v])
                    t = np.linspace(0, 1, 7)[:, None]
                    nrm = np.array([-(p1 - p0)[1], (p1 - p0)[0]]) / max(1e-9, np.linalg.norm(p1 - p0))
                    pts = p0 + (p1 - p0) * t + nrm * (np.sin(np.pi * t) * rng.normal(0, 22))
                if art:
                    cls, name = ("secondary" if horiz else "tertiary"), (f"{AVES[(j * 3) % len(AVES)]} Road" if horiz else f"{AVES[(i * 5 + 7) % len(AVES)]} Avenue")
                else:
                    cls = "residential"
                    name = f"{STREETS[(j * 7 + i // 9) % len(STREETS)]} {'Drive' if subdivision(i, j) else 'Street'}" if horiz else f"{STREETS[(i * 3 + j // 10) % len(STREETS)]} {'Court' if subdivision(i, j) else 'Lane'}"
                g.edge(u, v, pts, cls, name)
    # driveways and parking aisles: walkable in OSM, never counted as streets
    for _ in range(260):
        i, j = rng.integers(1, nx_), rng.integers(1, ny_)
        u = grid[i, j]
        x, y = g.xy[u]
        a = rng.uniform(0, 2 * np.pi)
        v = g.node(x + 38 * math.cos(a), y + 38 * math.sin(a), "drive")
        g.edge(u, v, None, "service", None, walk=False, extra={"service": "driveway"})
    # Spring Creek greenway, crossing town south-west to north-east, tied to the grid every few hundred metres
    t = np.linspace(0, 1, 140)
    gx = -3300 + 6800 * t
    gy = -2200 + 3900 * t + 260 * np.sin(t * 9.5) + 90 * np.sin(t * 31)
    prev = g.node(gx[0], gy[0], "trail")
    for k in range(1, len(t)):
        cur = g.node(gx[k], gy[k], "trail")
        g.edge(prev, cur, None, "path", "Spring Creek Trail", extra={"surface": "concrete"})
        if k % 6 == 0:
            near = g.nearest(gx[k], gy[k], "town")
            g.edge(cur, near, None, "footway", None)
        prev = cur
    # parks with loop paths
    for cx, cy, r, nm in ((620, -480, 230, "Rolland Park Loop"), (-1450, 1250, 300, "Twin Silo Loop"), (1900, 1650, 180, "Pinecone Pond Path")):
        ring = [g.node(cx + r * math.cos(a), cy + r * 0.8 * math.sin(a), "trail") for a in np.linspace(0, 2 * np.pi, 19)[:-1]]
        for a, b in zip(ring, ring[1:] + ring[:1]):
            g.edge(a, b, None, "footway", nm)
        for k in (0, 9):
            g.edge(ring[k], g.nearest(*g.xy[ring[k]], "town"), None, "footway", None)
    # sidewalks along part of one arterial: walkable, but they belong to the street
    j = sorted(arterial_j)[2]
    for i in range(10, 30):
        a, b = g.xy[grid[i, j]], g.xy[grid[i + 1, j]]
        u = g.node(a[0], a[1] + 9, "town")
        v = g.node(b[0], b[1] + 9, "town")
        g.edge(u, v, None, "footway", None, extra={"footway": "sidewalk"})
        g.edge(u, grid[i, j], None, "footway", None, extra={"footway": "crossing"})
    # the road west to the trailhead, and the foothill trails
    start = grid[0, ny_ // 2]
    xs = np.linspace(g.xy[start][0], -6500, 18)
    prev = start
    for x in xs[1:]:
        cur = g.node(x, 250 + 40 * math.sin(x / 600), "road")
        g.edge(prev, cur, None, "secondary", "Overland Road")
        prev = cur
    th = g.node(-6560, 260, "trailhead")
    g.edge(prev, th, None, "service", "Trailhead Lot", extra={"service": "parking_aisle"})
    g.trailhead = th

    def trail(points, name, a=None):
        nodes = [a] if a is not None else []
        for p in points[(1 if a is not None else 0):]:
            nodes.append(g.node(p[0], p[1], "mountain"))
        for u, v in zip(nodes[:-1], nodes[1:]):
            g.edge(u, v, None, "path", name)
        return nodes

    sw = [(-6560 - 2200 * s, 260 + 900 * s + 160 * math.sin(s * 40)) for s in np.linspace(0, 1, 46)]   # switchbacks up
    main = trail(sw, "Granite Ridge Trail", th)
    ridge_pts = [(-8760 + 60 * math.sin(k / 3), y) for k, y in enumerate(np.linspace(-2600, 3800, 70))]
    ridge = trail(ridge_pts, "Skyline Ridge Trail")
    top = main[-1]
    g.edge(top, min(ridge, key=lambda n: math.dist(g.xy[n], g.xy[top])), None, "path", "Granite Ridge Trail")
    valley_pts = [(-6900 + 80 * math.sin(k / 4), y) for k, y in enumerate(np.linspace(-2400, 3600, 50))]
    valley = trail(valley_pts, "Reservoir Trail")
    g.edge(th, min(valley, key=lambda n: math.dist(g.xy[n], g.xy[th])), None, "path", "Reservoir Trail")
    for yy, nm in ((-2300, "Sundance Trail"), (3400, "Arthur's Spur")):
        a = min(valley, key=lambda n: abs(g.xy[n][1] - yy))
        b = min(ridge, key=lambda n: abs(g.xy[n][1] - yy))
        pts = [(g.xy[a][0] + (g.xy[b][0] - g.xy[a][0]) * s + 120 * math.sin(s * 25), g.xy[a][1] + 300 * math.sin(s * math.pi)) for s in np.linspace(0, 1, 30)]
        trail(pts[:-1] + [g.xy[b]], nm, a)
        g.edge(len(g.xy) - 1, b, None, "path", nm)
    g.home = grid[nx_ // 2 + 1, ny_ // 2 - 1]
    return g


def build_trip(rng) -> Graph:
    g = Graph("trip", TRIP, elev_trip)
    grid = {}
    for i in range(15):
        for j in range(15):
            grid[i, j] = g.node(-1050 + i * 150 + rng.normal(0, 8), -1050 + j * 150 + rng.normal(0, 8))
    for (i, j), u in grid.items():
        for di, dj in ((1, 0), (0, 1)):
            if (i + di, j + dj) in grid and rng.random() > 0.08:
                g.edge(u, grid[i + di, j + dj], None, "residential", None)
    g.home = grid[7, 7]
    g.trailhead = grid[7, 14]
    pts = [(math.sin(s * 6) * 400, 1050 + s * 4300) for s in np.linspace(0, 1, 40)]
    prev = g.trailhead
    for p in pts[1:]:
        cur = g.node(*p, "mountain")
        g.edge(prev, cur, None, "path", "Craggy Knob Trail")
        prev = cur
    g.summit = prev
    return g


# ------------------------------------------------------------------ people model
def fitness(d: date) -> float:
    """0..1: slow gains, a winter injury in 2023, a steady last stretch."""
    t = (d - date(2016, 1, 1)).days / 365.25
    f = 0.35 + 0.35 / (1 + math.exp(-(t - 5.0) * 1.3))
    if date(2023, 2, 1) <= d < date(2023, 6, 1):
        f -= 0.12 * (1 - (d - date(2023, 2, 1)).days / 120)
    return f


def temp_f(dt: datetime, place: str, rng) -> float:
    doy = dt.timetuple().tm_yday
    base = 50 + 23 * math.cos(2 * math.pi * (doy - 200) / 365.25) if place == "home" else 57 + 17 * math.cos(2 * math.pi * (doy - 200) / 365.25)
    hour = dt.hour + dt.minute / 60
    return float(base + 9 * math.cos(2 * math.pi * (hour - 15) / 24) + rng.normal(0, 5.5))


# ------------------------------------------------------------------ tracks
def make_track(g: Graph, poly: np.ndarray, start: datetime, kind: str, rng, fit: float, temp: float, *, step_s=5.0, drive_home=None, jump=False,
               pauses=0, no_alt=False):
    """A GPS track along a polyline: Tobler-shaped speed, stops, AR(1) GPS noise, barometric-looking altitude."""
    seg = np.hypot(*np.diff(poly, axis=0).T)
    s = np.r_[0, np.cumsum(seg)]
    total = s[-1]
    # resample the line every 10 m to get grades
    ss = np.arange(0, total, 10.0)
    px, py = np.interp(ss, s, poly[:, 0]), np.interp(ss, s, poly[:, 1])
    el = g.elev(px, py)
    grade = np.gradient(el, 10.0)
    grade = np.convolve(grade, np.ones(5) / 5, mode="same") if len(grade) >= 5 else grade
    base = {"walk": 1.31 + 0.16 * fit, "run": 2.35 + 0.75 * fit, "hike": 1.18 + 0.12 * fit, "fastwalk": 2.6 + 0.3 * fit}[kind]
    if temp > 82:
        base *= 1 - 0.006 * (temp - 82)
    wobble = np.cumsum(rng.normal(0, 0.012, len(ss)))
    kw = max(1, min(41, len(wobble)))
    wobble = (wobble - np.convolve(wobble, np.ones(kw) / kw, mode="same")) * 2
    sp = base * (tobler(grade) if kind in ("walk", "hike") else np.clip(1 - 2.2 * grade, 0.55, 1.3)) * (1 + wobble)
    sp = np.clip(sp, 0.35, 6.5)
    tt = np.r_[0, np.cumsum(10.0 / sp[:-1])]
    # stops: traffic lights, a chat with a neighbour; some are paused on the watch
    stops = []
    for _ in range(pauses):
        at = rng.uniform(0.1, 0.9) * tt[-1]
        dur = float(rng.uniform(20, 140))
        stops.append((at, dur, rng.random() < 0.45))
    stops.sort()
    # time axis with stops inserted
    times, dist = [], []
    shift = 0.0
    events = []
    k = 0
    T = tt[-1]
    t = 0.0
    while t <= T:
        while k < len(stops) and stops[k][0] <= t:
            at, dur, paused = stops[k]
            s_here = float(np.interp(at, tt, ss))
            if paused:
                events.append(("Pause", at + shift))
            for q in np.arange(0, dur, step_s):
                times.append(at + shift + q)
                dist.append(s_here)
            shift += dur
            if paused:
                events.append(("Resume", at + shift))
            k += 1
        times.append(t + shift)
        dist.append(float(np.interp(t, tt, ss)))
        t += step_s
    times, dist = np.array(times), np.array(dist)
    x, y = np.interp(dist, s, poly[:, 0]), np.interp(dist, s, poly[:, 1])
    # GPS noise: AR(1), a few bad fixes with poor accuracy
    from scipy.signal import lfilter

    n = len(x)
    nx_, ny_ = lfilter([1.0], [1.0, -0.88], rng.normal(0, 1.1, n)), lfilter([1.0], [1.0, -0.88], rng.normal(0, 1.1, n))
    hacc = rng.uniform(2.5, 6.5, n)
    bad = rng.random(n) < 0.004
    nx_[bad] += rng.normal(0, 35, bad.sum())
    ny_[bad] += rng.normal(0, 35, bad.sum())
    hacc[bad] = rng.uniform(42, 70, bad.sum())
    x, y = x + nx_, y + ny_
    if jump and n > 40:  # a tunnel: no fixes for a stretch, then a jump
        a = int(n * rng.uniform(0.3, 0.6))
        keep = np.ones(n, bool)
        keep[a:a + 12] = False
        x, y, times, dist, hacc = x[keep], y[keep], times[keep], dist[keep], hacc[keep]
        n = len(x)
    alt = g.elev(x, y) + rng.normal(0, 0.35, n).cumsum() * 0.08 + rng.uniform(-4, 4)
    vacc = rng.uniform(1.8, 4.5, n)
    if no_alt:  # newer GPX files sometimes carry ele 0 with vAcc -1 over a stretch
        a = int(n * 0.2)
        alt[a:] = 0.0
        vacc[a:] = -1.0
    speed = np.r_[np.diff(dist) / np.maximum(np.diff(times), 1e-6), 0.0]
    course = np.degrees(np.arctan2(np.r_[np.diff(x), 0], np.r_[np.diff(y), 1e-9])) % 360
    moving_end = times[-1]
    if drive_home is not None:  # the watch kept recording on the drive home
        dpoly = drive_home
        dseg = np.hypot(*np.diff(dpoly, axis=0).T)
        ds = np.r_[0, np.cumsum(dseg)]
        dt_ = np.arange(step_s, ds[-1] / 14.0, step_s)
        dd = dt_ * 14.0
        dx, dy = np.interp(dd, ds, dpoly[:, 0]), np.interp(dd, ds, dpoly[:, 1])
        x, y = np.r_[x, dx], np.r_[y, dy]
        times = np.r_[times, moving_end + 60 + dt_]
        alt = np.r_[alt, g.elev(dx, dy)]
        hacc, vacc = np.r_[hacc, np.full(len(dx), 4.0)], np.r_[vacc, np.full(len(dx), 3.0)]
        speed, course = np.r_[speed, np.full(len(dx), 14.0)], np.r_[course, np.full(len(dx), 90.0)]
    lat, lon = to_ll(x, y, g.origin)
    # values computed with exp, sin and arctan2 are rounded before they are written: those functions can differ in the
    # last bit between machines, and six printed decimals would show it now and then
    alt, speed, course = np.round(alt, 3), np.round(speed, 4), np.round(course, 2)
    return {"lat": lat, "lon": lon, "alt": alt, "t": np.array([start + timedelta(seconds=float(q)) for q in times]), "hacc": hacc, "vacc": vacc,
            "speed": speed, "course": course, "dist_m": float(total), "moving_s": float(T), "elapsed_s": float(times[-1]),
            "events": [(k_, start + timedelta(seconds=float(q))) for k_, q in events],
            "paused_s": float(sum(d for _, d, p in stops if p)), "ascent_m": float(np.clip(np.diff(g.elev(px, py)), 0, None).sum()),
            "grade": grade, "sp": sp}


# ------------------------------------------------------------------ XML helpers
def ts(dt: datetime) -> str:
    return dt.astimezone(XOFF).strftime("%Y-%m-%d %H:%M:%S %z")


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def device(hw: str, sw: str) -> str:
    name, model = ("Apple Watch", "Watch") if hw.startswith("Watch") else ("iPhone", "iPhone")
    return esc(f"<<HKDevice: 0x{zlib.crc32(hw.encode()) % 0xFFFFFF:06x}>, name:{name}, manufacturer:Apple Inc., model:{model}, hardware:{hw}, software:{sw}>")


def phone_on(d: date):
    cur = PHONES[0]
    for p in PHONES:
        if d >= p[0]:
            cur = p
    yrs = (d - cur[0]).days // 365
    major = int(cur[2].split(".")[0]) + yrs
    return cur[1], f"{major}.{(d.month % 6) + 1}"


def watch_on(d: date):
    if d < WATCH_FROM:
        return None
    hw = "Watch7,5" if d >= ULTRA_FROM else "Watch4,2"
    major = 5 + (d - WATCH_FROM).days // 365 if hw == "Watch4,2" else 10 + (d - ULTRA_FROM).days // 365
    return hw, f"{major}.{(d.month % 5) + 1}"


class Writer:
    """Accumulates export.xml lines; records are sorted by type then start, as in a real export."""

    def __init__(self):
        self.records: list[tuple[str, str, str]] = []
        self.workouts: list[tuple[str, str]] = []
        self.summaries: list[str] = []

    def rec(self, typ: str, src: str, hw_sw, unit: str | None, start: datetime, end: datetime, value, meta: str = "", cat=False):
        dev = f' device="{device(*hw_sw)}"' if hw_sw else ""
        ver = hw_sw[1] if hw_sw else "1.0"
        u = f' unit="{unit}"' if unit else ""
        v = value if cat else (f"{value:.4g}" if isinstance(value, float) else str(value))
        tag = "HKCategoryTypeIdentifier" if cat else "HKQuantityTypeIdentifier"
        line = (f' <Record type="{tag}{typ}" sourceName="{esc(src)}" sourceVersion="{ver}"{dev}{u} creationDate="{ts(end + timedelta(minutes=1))}" '
                f'startDate="{ts(start)}" endDate="{ts(end)}" value="{v}"')
        line += (">\n" + meta + " </Record>") if meta else "/>"
        self.records.append((typ, ts(start), line))


# ------------------------------------------------------------------ the generator
class Demo:
    def __init__(self, out: Path, seed: int = 7):
        self.out = out
        self.seed = seed
        self.town = build_town(self._rng("town"))
        self.trip = build_trip(self._rng("trip"))
        self.W = Writer()
        self.gpx: dict[str, bytes] = {}
        self.strava: list[dict] = []
        self.strava_files: dict[str, bytes] = {}
        self.workout_steps: dict[date, list] = defaultdict(list)
        self.trips = [(date(2019, 7, 13), date(2019, 7, 20)), (date(2022, 5, 21), date(2022, 5, 28)), (date(2025, 8, 9), date(2025, 8, 16))]
        self.favorites = self._favorites()
        self.n_workouts = 0

    def _rng(self, *key) -> np.random.Generator:
        """A random stream of its own for each part of the export (the town, the schedule, each workout, each day), keyed by
        what it is. Floating point can differ in the last bit between machines (Apple Silicon and x86 Linux evaluate exp and
        sin differently), which can change how many numbers one workout draws; with one shared stream that shifted every
        workout and day after it, so the same seed gave a different export on GitHub's runners."""
        return np.random.default_rng([self.seed, *(zlib.crc32(str(k).encode()) for k in key)])

    # ---- routes
    def _loop(self, g: Graph, target_m: float, rng, jitter=0.3, prefer=1.0, start=None, kinds=("town", "trail")):
        start = g.home if start is None else start
        sx, sy = g.xy[start]
        xy = np.array(g.xy)
        ok = np.isin(np.array(g.kind), kinds)
        for _ in range(6):
            r = target_m / rng.uniform(3.0, 3.9)
            th = rng.uniform(0, 2 * np.pi)
            dth = rng.uniform(1.0, 1.9)
            wps = []
            for a in (th, th + dth):
                tx, ty = sx + r * math.cos(a), sy + r * math.sin(a)
                d = np.where(ok, np.hypot(xy[:, 0] - tx, xy[:, 1] - ty), np.inf)
                wps.append(int(np.argmin(d)))
            path = g.route([start, wps[0], wps[1], start], rng, jitter, prefer)
            if path is None:
                continue
            poly = g.polyline(path)
            L = float(np.hypot(*np.diff(poly, axis=0).T).sum())
            if 0.7 * target_m < L < 1.35 * target_m:
                return poly
            target_m *= target_m / max(L, 1)
        return poly

    def _favorites(self):
        # people repeat a handful of loops: four walks from the door, three runs that use the greenway
        rng = np.random.default_rng(11)
        walks = [self._loop(self.town, d, rng, jitter=0.05) for d in (1.6 * MI, 2.4 * MI, 3.1 * MI, 4.0 * MI)]
        self.fav_runs = [self._loop(self.town, d, rng, jitter=0.05, prefer=0.45) for d in (3.1 * MI, 4.2 * MI, 6.2 * MI)]
        self.fav_long = [self._loop(self.town, d, rng, jitter=0.05, prefer=0.3) for d in (8.0 * MI, 10.5 * MI)]
        return walks

    def _hike(self, g: Graph, rng, target_m: float):
        if g is self.trip:
            path = g.route([g.trailhead, g.summit, g.trailhead], rng, 0.1)
            return g.polyline(path)
        mt = [i for i, k in enumerate(g.kind) if k == "mountain"]
        xy = np.array(g.xy)
        far = [i for i in mt if math.dist(xy[i], xy[g.trailhead]) > target_m / 4.2]
        best = None
        for _ in range(8):
            a, b = rng.choice(far if far else mt, 2, replace=False)
            path = g.route([g.trailhead, int(a), int(b), g.trailhead], rng, 0.2)
            if path is None:
                continue
            poly = g.polyline(path)
            L = float(np.hypot(*np.diff(poly, axis=0).T).sum())
            if best is None or abs(L - target_m) < abs(best[1] - target_m):
                best = (poly, L)
        return best[0]

    # ---- one workout
    def workout(self, kind: str, start: datetime, *, place="home", source="watch", indoor=False, fragment=False, dup=False,
                forgot=False, drive=False, jump=False, title=None, target=None, strava_only=False, long_run=False):
        rng = self._rng("workout", kind, start.isoformat(), source)
        d = start.date()
        fit = fitness(d)
        g = self.trip if place == "trip" else self.town
        temp = temp_f(start, place, rng)
        hk = {"walk": "Walking", "run": "Running", "hike": "Hiking", "ride": "Cycling", "strength": "TraditionalStrengthTraining",
              "swim": "Swimming", "fastwalk": "Walking"}[kind]
        tr, dur_s, dist_m, ascent = None, None, None, None
        if kind in ("walk", "run", "hike", "fastwalk") and not indoor:
            if fragment:
                poly = self.town.polyline(self.town.route([g.home, self.town.adj[g.home][0][0]], rng, 0.1))[:2]
                poly = np.vstack([poly[0], poly[0] + (poly[1] - poly[0]) * 0.15])
            elif kind == "hike":
                poly = self._hike(g, rng, target or rng.uniform(6.5, 14) * 1000)
            elif long_run and rng.random() < 0.97:  # two long courses, mostly on the greenway
                poly = self.fav_long[int(rng.random() < 0.4)]
            elif kind == "run" and place == "home" and target is None and rng.random() < 0.98:
                poly = self.fav_runs[int(rng.choice(3, p=[0.45, 0.35, 0.2]))]
            elif kind == "run":  # long runs mostly follow the greenway
                poly = self._loop(g, target or rng.uniform(3.1, 6.5) * MI / 1.6, rng, 0.35, prefer=0.3)
            elif place == "home" and rng.random() < 0.99 and target is None:
                poly = self.favorites[int(rng.choice(4, p=[0.35, 0.3, 0.22, 0.13]))]
            else:
                poly = self._loop(g, target or rng.uniform(1.4, 4.6) * MI, rng, 0.35)
            dpoly = None
            if drive:
                road = [i for i, k in enumerate(self.town.kind) if k == "road"]
                dpoly = np.array([self.town.xy[self.town.trailhead]] + [self.town.xy[i] for i in road[::-1]] + [self.town.xy[self.town.home]])
            # "fastwalk" is labelled a walk but paced like a run, so rule W4 suggests a relabel
            tr = make_track(g, poly, start, kind, rng, fit, temp, drive_home=dpoly, jump=jump,
                            pauses=int(rng.poisson(1.2 if kind == "walk" else 0.4)), no_alt=(d >= date(2025, 1, 1) and rng.random() < 0.12))
            dur_s = tr["moving_s"] + (tr["elapsed_s"] - tr["moving_s"] - tr["paused_s"])
            dist_m, ascent = tr["dist_m"] * (1 + rng.normal(0, 0.008)), tr["ascent_m"]
            if fragment:
                dur_s, dist_m = float(rng.uniform(25, 80)), float(rng.uniform(5, 40))
        else:
            dur_s = {"ride": rng.choice([20, 30, 45]) * 60.0, "strength": rng.uniform(25, 55) * 60, "swim": rng.uniform(28, 45) * 60,
                     "walk": rng.uniform(25, 50) * 60, "run": rng.uniform(20, 40) * 60}[kind]
            dist_m = {"ride": dur_s / 60 * 0.42 * 1000 * (0.8 + 0.4 * fit), "swim": round(dur_s / 60 * 34 / 22.86) * 22.86,
                      "walk": dur_s * (1.45 + 0.15 * fit), "run": dur_s * (2.5 + 0.6 * fit)}.get(kind)
        elapsed = tr["elapsed_s"] if tr else dur_s
        end = start + timedelta(seconds=float(elapsed))
        if forgot and tr:
            end = start + timedelta(seconds=float(elapsed) + rng.uniform(80, 150) * 60)
        if strava_only:
            if d >= APPLE_FIRST and tr is not None and kind in ("walk", "run", "hike"):  # the phone in the pocket counted the steps too
                self.workout_steps[d].append((start, end, dist_m / {"walk": 0.74, "run": 1.1, "hike": 0.68}[kind]))
            return self._strava_activity(kind, start, tr, dist_m, dur_s, title, temp, fit, rng)
        self.n_workouts += 1
        # heart rate
        w_hw = watch_on(d)
        hr_vals = []
        if w_hw and source in ("watch", "peloton"):
            rest = 61 - 6 * fit
            eff = {"walk": 38, "run": 88, "hike": 52, "ride": 70, "strength": 32, "swim": 55, "fastwalk": 72}[kind]
            if d >= DENSE_HR_FROM and tr:
                times = np.arange(0, elapsed - 5, 10.0)
            else:
                times = np.sort(rng.uniform(30, max(60, elapsed - 30), int(rng.integers(3, 9))))
            for q in times:
                g_ = 0.0
                if tr is not None and len(tr["grade"]):
                    g_ = float(tr["grade"][min(len(tr["grade"]) - 1, int(q / max(1, elapsed) * len(tr["grade"])))])
                bpm = rest + eff + 260 * max(0.0, g_) + 6 * q / 3600 + rng.normal(0, 3.2) - 6 * fit
                bpm = float(np.clip(bpm, 48, 192))
                at = start + timedelta(seconds=float(q))
                hr_vals.append(bpm)
                meta = '  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="2"/>\n'
                self.W.rec("HeartRate", WATCH_SRC[w_hw[0]], w_hw, "count/min", at, at, round(bpm), meta)
        # steps during the workout land in the watch and phone step records (see days())
        if kind in ("walk", "run", "hike", "fastwalk") and dist_m and not fragment:
            stride = {"walk": 0.74, "fastwalk": 0.95, "run": 1.1, "hike": 0.68}[kind]
            self.workout_steps[d].append((start, end if not forgot else start + timedelta(seconds=float(elapsed)), dist_m / stride))
        # the workout element
        lines = []
        if source == "peloton":
            src_attr = 'sourceName="Peloton" sourceVersion="1658"'
        elif source == "strava_app":
            src_attr = 'sourceName="Strava" sourceVersion="300"'
        else:
            src_attr = f'sourceName="{esc(WATCH_SRC[w_hw[0]])}" sourceVersion="{w_hw[1]}" device="{device(*w_hw)}"'
        lines.append(f' <Workout workoutActivityType="HKWorkoutActivityType{hk}" duration="{dur_s / 60:.6f}" durationUnit="min" {src_attr} '
                     f'creationDate="{ts(end + timedelta(minutes=1))}" startDate="{ts(start)}" endDate="{ts(end)}">')
        tzname = "America/New_York" if place == "trip" else "America/Denver"
        meta = []
        if source == "peloton":
            off = int(-start.astimezone(TZ).utcoffset().total_seconds() // 3600)
            meta.append(f'  <MetadataEntry key="HKTimeZone" value="Etc/GMT+{off}"/>')
        elif source == "watch":
            meta.append(f'  <MetadataEntry key="HKIndoorWorkout" value="{1 if indoor else 0}"/>')
            meta.append(f'  <MetadataEntry key="HKTimeZone" value="{tzname}"/>')
            if not indoor and kind not in ("swim", "strength") and d >= date(2019, 9, 20) and rng.random() < 0.9:
                meta.append(f'  <MetadataEntry key="HKWeatherTemperature" value="{round(temp)} degF"/>')
                meta.append(f'  <MetadataEntry key="HKWeatherHumidity" value="{int(rng.uniform(22, 88)) * 100} %"/>')
            if ascent is not None and not fragment:
                meta.append(f'  <MetadataEntry key="HKElevationAscended" value="{int(ascent * 100 * rng.uniform(0.9, 1.08))} cm"/>')
            if kind == "swim":
                meta.append('  <MetadataEntry key="HKSwimmingLocationType" value="1"/>')
                meta.append('  <MetadataEntry key="HKLapLength" value="25 yd"/>')
            meta.append(f'  <MetadataEntry key="HKAverageMETs" value="{3.2 + 3 * (kind in ("run", "ride")):.4g} kcal/hr·kg"/>')
        lines += meta
        for k_, at in (tr["events"] if tr else []):
            lines.append(f'  <WorkoutEvent type="HKWorkoutEventType{k_}" date="{ts(at)}"/>')
        if forgot and tr:  # paused near the end, never resumed, the watch ran on
            lines.append(f'  <WorkoutEvent type="HKWorkoutEventTypePause" date="{ts(start + timedelta(seconds=float(elapsed)))}"/>')
        if kind == "swim":
            lap_t, t0 = 0.0, start + timedelta(seconds=120)
            n_laps = int(dist_m / 22.86)
            styles = rng.choice([2, 2, 2, 4, 3], n_laps)
            for k in range(n_laps):
                sec = float(np.clip(rng.normal(31 - 6 * fitness(d), 2.5), 19, 50))
                strokes = int(np.clip(rng.normal(17, 2), 10, 26))
                at = t0 + timedelta(seconds=lap_t)
                lines.append(f'  <WorkoutEvent type="HKWorkoutEventTypeLap" date="{ts(at)}" duration="{sec / 60:.6f}" durationUnit="min">\n'
                             f'   <MetadataEntry key="HKSwimmingStrokeStyle" value="{styles[k]}"/>\n   <MetadataEntry key="HKSWOLFScore" value="{strokes + round(sec)}"/>\n  </WorkoutEvent>')
                self.W.rec("SwimmingStrokeCount", WATCH_SRC[w_hw[0]], w_hw, "count", at, at + timedelta(seconds=sec), strokes)
                lap_t += sec + (rng.uniform(15, 40) if k % 4 == 3 else 2)
        stat_end = end
        if dist_m and kind not in ("strength",) and not (kind == "ride" and source != "peloton"):
            dtype = {"ride": "DistanceCycling", "swim": "DistanceSwimming"}.get(kind, "DistanceWalkingRunning")
            unit_v = (f"{dist_m / MI:.6f}", "mi") if dtype != "DistanceSwimming" else (f"{dist_m / 0.9144:.0f}", "yd")
            lines.append(f'  <WorkoutStatistics type="HKQuantityTypeIdentifier{dtype}" startDate="{ts(start)}" endDate="{ts(stat_end)}" sum="{unit_v[0]}" unit="{unit_v[1]}"/>')
        kcal = (dur_s / 60) * {"walk": 5.2, "run": 11.5, "hike": 7.4, "ride": 8.9, "strength": 4.5, "swim": 8.2, "fastwalk": 9.5}[kind] * rng.uniform(0.9, 1.1)
        lines.append(f'  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="{ts(start)}" endDate="{ts(stat_end)}" sum="{kcal:.3f}" unit="Cal"/>')
        if hr_vals and d >= date(2022, 10, 1):  # watchOS 9 and later store the workout's own heart-rate statistics
            lines.append(f'  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="{ts(start)}" endDate="{ts(stat_end)}" '
                         f'average="{np.mean(hr_vals) + rng.normal(0, 0.6):.4f}" minimum="{min(hr_vals):.0f}" maximum="{max(hr_vals):.0f}" unit="count/min"/>')
        if tr is not None and source == "watch":
            local_end = end.astimezone(TRIP_TZ if place == "trip" else TZ)
            fname = f"route_{local_end:%Y-%m-%d}_{local_end.hour % 12 or 12}.{local_end:%M}{'am' if local_end.hour < 12 else 'pm'}.gpx"
            while fname in self.gpx:
                fname = fname.replace(".gpx", "_1.gpx")
            self.gpx[fname] = self._gpx(tr)
            lines.append(f'  <WorkoutRoute sourceName="{esc(WATCH_SRC[w_hw[0]])}" sourceVersion="{w_hw[1]}" creationDate="{ts(end)}" startDate="{ts(start)}" endDate="{ts(end)}">\n'
                         f'   <MetadataEntry key="HKMetadataKeySyncVersion" value="2"/>\n   <FileReference path="/workout-routes/{fname}"/>\n  </WorkoutRoute>')
        lines += meta  # real exports repeat the metadata after the children
        lines.append(" </Workout>")
        self.W.workouts.append((ts(start), "\n".join(lines)))
        if dup:  # the same walk, also saved by a second app
            self.workout(kind, start + timedelta(seconds=40), source="strava_app", indoor=True)

    def _gpx(self, tr) -> bytes:
        rows = [f'<trkpt lon="{lo:.6f}" lat="{la:.6f}"><ele>{a:.6f}</ele><time>{t.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}</time>'
                f'<extensions><speed>{s:.6f}</speed><course>{c:.6f}</course><hAcc>{h:.6f}</hAcc><vAcc>{v:.6f}</vAcc></extensions></trkpt>'
                for la, lo, a, t, s, c, h, v in zip(tr["lat"], tr["lon"], tr["alt"], tr["t"], tr["speed"], tr["course"], tr["hacc"], tr["vacc"])]
        head = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n <metadata><time>' + f"{tr['t'][0].astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}" + '</time></metadata>\n <trk>\n  <name>Route</name>\n  <trkseg>\n'
        return (head + "\n".join("   " + r for r in rows) + "\n  </trkseg>\n </trk>\n</gpx>\n").encode()

    # ---- Strava (Garmin years, and Peloton classes that were also sent to Strava)
    def _strava_activity(self, kind, start, tr, dist_m, dur_s, title, temp, fit, rng):
        aid = 900_000_000 + len(self.strava) * 7919
        stype = {"walk": "Walk", "run": "Run", "hike": "Hike", "ride": "Ride"}[kind]
        hour = start.astimezone(TZ).hour
        auto = f"{'Morning' if hour < 11 else 'Lunch' if hour < 14 else 'Afternoon' if hour < 18 else 'Evening'} {stype}"
        name = title or auto
        if tr is not None:
            fname = f"activities/{aid}.tcx.gz"
            rest = 63 - 6 * fit
            pts = []
            cum = np.r_[0, np.cumsum(np.hypot(np.diff(tr["lat"]) * 111_195, np.diff(tr["lon"]) * 111_195 * math.cos(math.radians(HOME[0]))))]
            gr = tr["grade"]
            drift = 0.0
            for i, (la, lo, a, t) in enumerate(zip(tr["lat"], tr["lon"], tr["alt"], tr["t"])):
                g_ = float(gr[min(len(gr) - 1, int(i / max(1, len(tr["t"])) * len(gr)))]) if len(gr) else 0.0
                drift = 0.97 * drift + rng.normal(0, 0.6)  # a chest strap's beat-to-beat wander, not white noise
                bpm = int(rest + (88 if kind == "run" else 42) + 300 * max(0.0, g_) + 5 * i / max(1, len(tr["t"])) + drift)
                pts.append(f'<Trackpoint><Time>{t.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%S.000Z}</Time><Position><LatitudeDegrees>{la:.7f}</LatitudeDegrees>'
                           f'<LongitudeDegrees>{lo:.7f}</LongitudeDegrees></Position><AltitudeMeters>{a:.1f}</AltitudeMeters><DistanceMeters>{cum[i]:.1f}</DistanceMeters>'
                           f'<HeartRateBpm><Value>{bpm}</Value></HeartRateBpm></Trackpoint>')
            sport = {"run": "Running", "hike": "Other", "walk": "Other", "ride": "Biking"}[kind]
            xml = ('\n<?xml version="1.0" encoding="UTF-8"?>\n<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">\n'
                   f'<Activities><Activity Sport="{sport}"><Id>{start.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}</Id>'
                   f'<Lap StartTime="{start.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}"><TotalTimeSeconds>{tr["moving_s"]:.1f}</TotalTimeSeconds>'
                   f'<DistanceMeters>{tr["dist_m"]:.1f}</DistanceMeters><Calories>{int(dur_s / 60 * 9)}</Calories><Track>{"".join(pts)}</Track></Lap>'
                   '<Creator><Name>Garmin Forerunner 235</Name></Creator></Activity></Activities>\n</TrainingCenterDatabase>\n')
            self.strava_files[fname] = gzip.compress(xml.encode(), mtime=0)
            moving, elapsed = tr["moving_s"], tr["elapsed_s"]
            gain = tr["ascent_m"]
        else:  # an indoor class: the Peloton file Strava keeps has no positions and 0 bpm when no strap was paired
            fname = f"activities/{aid}.tcx.gz"
            pts = "".join(f'<Trackpoint><Time>{(start + timedelta(seconds=q)).astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}</Time><DistanceMeters>{q * 7.2:.1f}</DistanceMeters>'
                          f'<HeartRateBpm><Value>0.0</Value></HeartRateBpm><Cadence>{int(rng.normal(78, 6))}</Cadence></Trackpoint>' for q in range(0, int(dur_s), 15))
            xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">\n'
                   f'<Activities><Activity Sport="Biking"><Id>{start.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}</Id><Lap StartTime="{start.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}">'
                   f'<TotalTimeSeconds>None</TotalTimeSeconds><DistanceMeters>{dist_m:.2f}</DistanceMeters><Calories>{dur_s / 60 * 8.7:.1f}</Calories><Track>{pts}</Track></Lap>'
                   '<Creator><Name>Peloton Bike</Name></Creator></Activity></Activities>\n</TrainingCenterDatabase>\n')
            self.strava_files[fname] = gzip.compress(xml.encode(), mtime=0)
            moving = elapsed = dur_s
            gain = 0.0
        self.strava.append({"id": aid, "date": start.astimezone(timezone.utc), "name": name, "type": stype, "elapsed": elapsed, "moving": moving,
                            "dist": dist_m, "file": fname, "gain": gain, "kcal": dur_s / 60 * 9})

    # ---- daily records
    def days(self):
        d, last = APPLE_FIRST, EXPORT_AT.date()
        W = self.W
        while d <= last:
            rng = self._rng("day", d.isoformat())
            f = fitness(d)
            dow = d.weekday()
            season = 1 + 0.12 * math.cos(2 * math.pi * (d.timetuple().tm_yday - 190) / 365.25)
            away = any(a <= d <= b for a, b in self.trips)
            injured = date(2023, 2, 10) <= d <= date(2023, 3, 5)
            base = (6400 + 3600 * f) * season * (1.12 if dow >= 5 else 1.0) * (0.45 if injured else 1.0) * (1.25 if away else 1.0)
            base *= 1.15 if date(2020, 4, 1) <= d <= date(2020, 9, 30) else 1.0
            total = max(800.0, rng.normal(base, base * 0.22))
            dead_phone = rng.random() < 0.006   # a few days with nothing recorded: missing, not zero
            ph = phone_on(d)
            wa = watch_on(d)
            tz = TRIP_TZ if away else TZ
            if not dead_phone:
                # spread the day over waking hours; workouts add their own steps at their own times
                hours = np.arange(7, 22)
                wts = rng.dirichlet(np.ones(len(hours)) * 2.2)
                chunks = [(datetime(d.year, d.month, d.day, int(h), int(rng.integers(0, 40)), tzinfo=tz), float(total * w_)) for h, w_ in zip(hours, wts)]
                for st, en, steps in self.workout_steps.get(d, []):  # a workout's steps, in ten-minute pieces across it
                    k = max(1, int((en - st).total_seconds() // 600))
                    chunks += [(st + timedelta(minutes=10 * i), steps / k) for i in range(k)]
                carry = 0.78 if wa else 0.93   # the phone stays on the desk sometimes
                for st, steps in chunks:
                    dur = timedelta(minutes=float(rng.uniform(6, 10)))
                    # phone
                    if rng.random() < carry:
                        ps = steps * rng.uniform(0.82, 1.0)
                        W.rec("StepCount", PHONE_SRC, ph, "count", st, st + dur, int(ps))
                        W.rec("DistanceWalkingRunning", PHONE_SRC, ph, "mi", st, st + dur, round(ps * 0.74 / MI, 5))
                    # watch: the same steps, minute-level overlap with the phone's
                    if wa:
                        W.rec("StepCount", WATCH_SRC[wa[0]], wa, "count", st + timedelta(minutes=1), st + dur + timedelta(minutes=1), int(steps * rng.uniform(0.95, 1.03)))
                        W.rec("DistanceWalkingRunning", WATCH_SRC[wa[0]], wa, "mi", st + timedelta(minutes=1), st + dur + timedelta(minutes=1), round(steps * 0.75 / MI, 5))
                fl = int(rng.poisson(6 + 4 * (dow >= 5)))
                if fl:
                    at = datetime(d.year, d.month, d.day, int(rng.integers(8, 20)), tzinfo=tz)
                    W.rec("FlightsClimbed", PHONE_SRC, ph, "count", at, at + timedelta(minutes=20), fl)
                if d >= MOBILITY_FROM and rng.random() < 0.8:
                    at = datetime(d.year, d.month, d.day, int(rng.integers(9, 19)), tzinfo=tz)
                    yrs = (d - MOBILITY_FROM).days / 365.25
                    W.rec("WalkingSpeed", PHONE_SRC, ph, "mi/hr", at, at + timedelta(minutes=8), round(float(rng.normal(3.05 + 0.15 * f - 0.03 * yrs, 0.18)), 3))
                    W.rec("WalkingStepLength", PHONE_SRC, ph, "in", at, at + timedelta(minutes=8), round(float(rng.normal(26.5 + 1.5 * f, 1.0)), 2))
                    W.rec("WalkingDoubleSupportPercentage", PHONE_SRC, ph, "%", at, at + timedelta(minutes=8), round(float(rng.normal(0.285 - 0.02 * f, 0.012)), 4))
                    W.rec("WalkingAsymmetryPercentage", PHONE_SRC, ph, "%", at, at + timedelta(minutes=8), round(float(abs(rng.normal(0.02, 0.015))), 4))
            if wa and not dead_phone:
                src = WATCH_SRC[wa[0]]
                rest = 61 - 6 * f + 1.5 * math.cos(2 * math.pi * (d.timetuple().tm_yday - 15) / 365.25) + rng.normal(0, 1.4)
                noon = datetime(d.year, d.month, d.day, 12, tzinfo=tz)
                W.rec("RestingHeartRate", src, wa, "count/min", datetime(d.year, d.month, d.day, 0, 5, tzinfo=tz), datetime(d.year, d.month, d.day, 23, 50, tzinfo=tz), round(rest))
                W.rec("WalkingHeartRateAverage", src, wa, "count/min", noon, noon + timedelta(hours=8), round(rest + 38 + rng.normal(0, 3)))
                for h in range(0, 24, 2):  # background heart rate, a sample every couple of hours
                    at = datetime(d.year, d.month, d.day, h, int(rng.integers(0, 59)), tzinfo=tz)
                    W.rec("HeartRate", src, wa, "count/min", at, at, round(rest + (2 if h < 6 else 18) + rng.normal(0, 5)))
                at = datetime(d.year, d.month, d.day, 3, int(rng.integers(0, 59)), tzinfo=tz)
                W.rec("HeartRateVariabilitySDNN", src, wa, "ms", at, at + timedelta(minutes=1), round(float(np.exp(rng.normal(math.log(38 + 20 * f), 0.25))), 2))
                if dow == 2 or rng.random() < 0.08:
                    W.rec("VO2Max", src, wa, "mL/min·kg", noon, noon, round(float(33.5 + 10 * f + rng.normal(0, 0.8)), 2))
                kcal = (380 + 260 * f) * season * (0.5 if injured else 1) * rng.uniform(0.7, 1.3)
                for h in (9, 12, 15, 18, 21):
                    at = datetime(d.year, d.month, d.day, h, tzinfo=tz)
                    W.rec("ActiveEnergyBurned", src, wa, "Cal", at, at + timedelta(minutes=55), round(kcal / 5, 3))
                ex = float(np.clip(rng.normal(24 + 20 * f, 14), 0, 140))
                if ex >= 1:
                    at = datetime(d.year, d.month, d.day, int(rng.integers(7, 19)), tzinfo=tz)
                    W.rec("AppleExerciseTime", src, wa, "min", at, at + timedelta(minutes=ex), round(ex))
                stood = 0
                for h in range(7, 22):
                    at = datetime(d.year, d.month, d.day, h, tzinfo=tz)
                    s_ = rng.random() < 0.82
                    stood += s_
                    W.rec("AppleStandHour", src, wa, None, at, at + timedelta(hours=1), "HKCategoryValueAppleStandHourStood" if s_ else "HKCategoryValueAppleStandHourIdle", cat=True)
                if d >= date(2020, 12, 1):
                    bed = datetime(d.year, d.month, d.day, 23, int(rng.integers(0, 50)), tzinfo=tz) - timedelta(days=1)
                    W.rec("SleepAnalysis", src, wa, None, bed, bed + timedelta(hours=float(rng.normal(7.1, 0.7))), "HKCategoryValueSleepAnalysisAsleepCore", cat=True)
                if d >= date(2021, 9, 21):
                    W.rec("RespiratoryRate", src, wa, "count/min", at, at + timedelta(minutes=10), round(float(rng.normal(14.2, 0.8)), 1))
                if d >= ULTRA_FROM:
                    W.rec("AppleSleepingWristTemperature", src, wa, "degF", datetime(d.year, d.month, d.day, 1, tzinfo=tz), datetime(d.year, d.month, d.day, 6, tzinfo=tz), round(float(rng.normal(96.6, 0.4)), 2))
                    W.rec("OxygenSaturation", src, wa, "%", datetime(d.year, d.month, d.day, 4, tzinfo=tz), datetime(d.year, d.month, d.day, 4, tzinfo=tz), round(float(np.clip(rng.normal(0.965, 0.01), 0.9, 1)), 3))
                if d >= DAYLIGHT_FROM:
                    W.rec("TimeInDaylight", src, wa, "min", noon, noon + timedelta(hours=4), int(np.clip(rng.normal(55 + 35 * season, 25), 2, 300)))
                W.summaries.append(f' <ActivitySummary dateComponents="{d.isoformat()}" activeEnergyBurned="{kcal:.4f}" activeEnergyBurnedGoal="520" activeEnergyBurnedUnit="Cal" '
                                   f'appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="{ex:.0f}" appleExerciseTimeGoal="30" appleStandHours="{stood}" appleStandHoursGoal="12"/>')
            d += timedelta(days=1)

    # ---- the schedule of workouts
    def schedule(self):
        rng = self._rng("schedule")  # only the decisions: each workout draws from its own stream
        # Strava years: a Garmin and a lot of running
        d = STRAVA_FROM
        while d <= STRAVA_TO:
            dow = d.weekday()
            if dow in (1, 3, 5) and rng.random() < 0.72:
                hh = 6.5 if dow != 5 else 8
                st = datetime(d.year, d.month, d.day, int(hh), int(rng.integers(0, 50)), tzinfo=TZ)
                self.workout("run", st, strava_only=True, long_run=(dow == 5),
                             title="Turkey Trot 10K" if (d.month == 11 and d.day >= 22 and dow == 3 and d.day <= 28) else None)
            if dow == 6 and d.month in (5, 6, 7, 8, 9, 10) and rng.random() < 0.45:
                st = datetime(d.year, d.month, d.day, 7, int(rng.integers(0, 50)), tzinfo=TZ)
                self.workout("hike", st, strava_only=True)
            d += timedelta(days=1)
        self.workout("hike", datetime(2017, 6, 17, 4, 50, tzinfo=TZ), strava_only=True, target=31_000, title="Ridge Challenge")
        self.workout("hike", datetime(2018, 8, 4, 5, 30, tzinfo=TZ), strava_only=True, target=19_000, title="Sunrise on Skyline")
        # Apple years
        d = WATCH_FROM
        last = EXPORT_AT.date() - timedelta(days=1)
        quirks = {"dup": 6, "forgot": 3, "drive": 2, "jump": 14, "fragment": 9, "fastwalk": 8}
        while d <= last:
            dow = d.weekday()
            away = next(((a, b) for a, b in self.trips if a <= d <= b), None)
            injured = date(2023, 2, 10) <= d <= date(2023, 3, 5)
            covid = date(2020, 3, 20) <= d <= date(2021, 3, 1)
            if injured:
                d += timedelta(days=1)
                continue
            if away:
                if rng.random() < 0.85:
                    st = datetime(d.year, d.month, d.day, int(rng.integers(8, 17)), int(rng.integers(0, 59)), tzinfo=TRIP_TZ)
                    self.workout("hike" if dow == 6 else "walk", st, place="trip")
                d += timedelta(days=1)
                continue
            p_walk = 0.62 if covid else 0.5 if d < date(2024, 1, 1) else 0.66
            if rng.random() < p_walk:
                hh = rng.choice([6.5, 7.5, 12.3, 17.5, 18.5, 19.5], p=[0.14, 0.2, 0.16, 0.2, 0.2, 0.1])
                st = datetime(d.year, d.month, d.day, int(hh), int((hh % 1) * 60 + rng.integers(0, 20)), tzinfo=TZ)
                q = None
                for k in quirks:
                    if quirks[k] and rng.random() < 0.006:
                        q = k
                        quirks[k] -= 1
                        break
                indoor = (d.month in (12, 1, 2) and rng.random() < 0.18)
                if q == "fragment":
                    self.workout("walk", st, fragment=True)
                elif q == "fastwalk":  # a one-off route, so the favourite loops keep honest walking records
                    self.workout("fastwalk", st, target=rng.uniform(2.2, 3.5) * MI)
                else:
                    self.workout("walk", st, indoor=indoor, dup=(q == "dup"), forgot=(q == "forgot"), jump=(q == "jump"),
                                 target=(rng.uniform(5.5, 8) * MI if dow == 6 and rng.random() < 0.3 else None))
            if date(2021, 4, 1) <= d <= date(2023, 1, 31) and dow in (1, 4) and rng.random() < 0.7:
                st = datetime(d.year, d.month, d.day, 6, int(rng.integers(0, 40)), tzinfo=TZ)
                self.workout("run", st)
            if dow == 6 and d.month in (4, 5, 6, 7, 8, 9, 10) and rng.random() < (0.32 if d.year >= 2024 else 0.22):
                st = datetime(d.year, d.month, d.day, 8, int(rng.integers(0, 50)), tzinfo=TZ)
                q = "drive" if quirks["drive"] and rng.random() < 0.25 else None
                if q:
                    quirks["drive"] -= 1
                self.workout("hike", st, drive=bool(q), jump=rng.random() < 0.05)
            if date(2020, 11, 2) <= d <= date(2022, 8, 31) and dow in (0, 2, 4) and rng.random() < 0.75:
                st = datetime(d.year, d.month, d.day, 19, int(rng.integers(0, 30)), tzinfo=TZ)
                self.workout("ride", st, source="peloton", indoor=True)
                if d.year == 2021 and rng.random() < 0.6:  # also sent to Strava, which keeps its own copy
                    self.workout("ride", st + timedelta(seconds=2), strava_only=True)
            if d >= date(2022, 1, 10) and dow in (1, 3) and rng.random() < 0.55:
                st = datetime(d.year, d.month, d.day, 17, int(rng.integers(0, 50)), tzinfo=TZ)
                self.workout("strength", st, indoor=True)
            if date(2023, 6, 5) <= d <= date(2024, 8, 30) and dow == 5 and rng.random() < 0.8:
                st = datetime(d.year, d.month, d.day, 7, int(rng.integers(0, 30)), tzinfo=TZ)
                self.workout("swim", st, indoor=True)
            d += timedelta(days=1)
        self.workout("hike", datetime(2024, 7, 13, 5, 10, tzinfo=TZ), target=24_000)

    # ---- outputs
    def town_osm(self) -> bytes:
        g = self.town
        lat, lon = to_ll(np.array([p[0] for p in g.xy]), np.array([p[1] for p in g.xy]))
        out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="stride-atlas demo">']
        nid = 1
        node_ids = {}
        for i, (la, lo) in enumerate(zip(lat, lon)):
            node_ids[i] = nid
            out.append(f'  <node id="{nid}" lat="{la:.7f}" lon="{lo:.7f}"/>')
            nid += 1
        way_lines = []
        for k, e in enumerate(g.edges):
            refs = [node_ids[e["u"]]]
            mid = e["pts"][1:-1]
            if len(mid):
                mla, mlo = to_ll(mid[:, 0], mid[:, 1])
                for la, lo in zip(mla, mlo):
                    out.append(f'  <node id="{nid}" lat="{la:.7f}" lon="{lo:.7f}"/>')
                    refs.append(nid)
                    nid += 1
            refs.append(node_ids[e["v"]])
            tags = [("highway", e["cls"])] + ([("name", e["name"])] if e["name"] else []) + sorted(e["extra"].items())
            way_lines.append(f'  <way id="{k + 1}">' + "".join(f'<nd ref="{r}"/>' for r in refs) + "".join(f'<tag k="{a}" v="{esc(b)}"/>' for a, b in tags) + "</way>")
        out += way_lines
        out.append("</osm>")
        return ("\n".join(out) + "\n").encode()

    def export_xml(self) -> bytes:
        W = self.W
        head = ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>\n'
                '<!ATTLIST HealthData locale CDATA #REQUIRED>\n<!ELEMENT ExportDate EMPTY>\n<!ATTLIST ExportDate value CDATA #REQUIRED>\n]>\n<HealthData locale="en_US">\n'
                f' <ExportDate value="{ts(EXPORT_AT)}"/>\n <Me HKCharacteristicTypeIdentifierDateOfBirth="" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet" '
                'HKCharacteristicTypeIdentifierBloodType="HKBloodTypeNotSet" HKCharacteristicTypeIdentifierFitzpatrickSkinType="HKFitzpatrickSkinTypeNotSet" '
                'HKCharacteristicTypeIdentifierCardioFitnessMedicationsUse="None"/>\n')
        recs = [r[2] for r in sorted(W.records, key=lambda r: (r[0], r[1]))]
        wk = [w[1] for w in sorted(W.workouts, key=lambda w: w[0])]
        return (head + "\n".join(recs) + "\n" + "\n".join(wk) + "\n" + "\n".join(W.summaries) + "\n</HealthData>\n").encode()

    def strava_csv(self) -> bytes:
        # the real export repeats some headers (display units first, SI second); pandas suffixes the second '.1'
        cols = ["Activity ID", "Activity Date", "Activity Name", "Activity Type", "Activity Description", "Elapsed Time", "Distance", "Max Heart Rate",
                "Relative Effort", "Commute", "Activity Private Note", "Activity Gear", "Filename", "Athlete Weight", "Bike Weight", "Elapsed Time",
                "Moving Time", "Distance", "Max Speed", "Average Speed", "Elevation Gain", "Elevation Loss", "Elevation Low", "Elevation High",
                "Max Grade", "Average Grade", "Max Heart Rate", "Average Heart Rate", "Calories"]
        import csv

        buf = io.StringIO()
        wr = csv.writer(buf, lineterminator="\n")
        wr.writerow(cols)
        for a in sorted(self.strava, key=lambda a: a["date"], reverse=True):
            dt = a["date"]
            stamp = f"{dt:%b} {dt.day}, {dt.year}, {dt.hour % 12 or 12}:{dt:%M:%S} {'AM' if dt.hour < 12 else 'PM'}"
            wr.writerow([a["id"], stamp, a["name"], a["type"], "", int(a["elapsed"]), f"{a['dist'] / 1000:.2f}", "", "", "false", "", "", a["file"], "", "",
                         f"{a['elapsed']:.1f}", f"{a['moving']:.1f}", f"{a['dist']:.1f}", "", "", f"{a['gain']:.1f}", "", "", "", "", "", "", "", f"{a['kcal']:.1f}"])
        return buf.getvalue().encode()

    def write(self):
        self.out.mkdir(parents=True, exist_ok=True)
        stamp = (2026, 9, 30, 19, 42, 10)

        def zwrite(path: Path, files: dict[str, bytes]):
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
                for name in sorted(files):
                    zi = zipfile.ZipInfo(name, stamp)
                    zi.compress_type = zipfile.ZIP_DEFLATED
                    zi.external_attr = 0o644 << 16
                    z.writestr(zi, files[name])

        files = {"apple_health_export/export.xml": self.export_xml()}
        files.update({f"apple_health_export/workout-routes/{k}": v for k, v in self.gpx.items()})
        zwrite(self.out / "export.zip", files)
        sfiles = {"activities.csv": self.strava_csv(), "profile.csv": b"Athlete ID,Email Address,First Name\n1,(not exported in the demo),Alex\n"}
        sfiles.update(self.strava_files)
        zwrite(self.out / "export_strava_demo.zip", sfiles)
        (self.out / "town.osm").write_bytes(self.town_osm())


def digest(out: Path) -> dict:
    """What the generator wrote, hashed by content: one hash per part and one for everything, plus a short hash per file
    for finding where two machines disagree. Zip and gzip bytes depend on each machine's zlib, so only contents count."""
    import hashlib

    def h(items) -> str:
        m = hashlib.sha256()
        for name, data in items:
            m.update(name.encode() + b"\0" + hashlib.sha256(data).digest())
        return m.hexdigest()

    files: dict[str, bytes] = {}
    for zp in ("export.zip", "export_strava_demo.zip"):
        with zipfile.ZipFile(out / zp) as z:
            for n in z.namelist():
                b = z.read(n)
                files[n] = gzip.decompress(b) if n.endswith(".gz") else b
    files["town.osm"] = (out / "town.osm").read_bytes()
    part = lambda n: "export.xml" if n.endswith("export.xml") else "routes" if "/workout-routes/" in n else "town.osm" if n == "town.osm" else "strava"
    parts = {k: h((n, files[n]) for n in sorted(files) if part(n) == k) for k in ("export.xml", "routes", "strava", "town.osm")}
    parts["all"] = h((k, v.encode()) for k, v in sorted(parts.items()))
    return {"parts": parts, "files": {n: hashlib.sha256(files[n]).hexdigest()[:12] for n in sorted(files)}}


def main() -> None:
    import json
    import sys

    ap = argparse.ArgumentParser(description="Write a synthetic Apple Health export and Strava archive (see the module docstring).")
    ap.add_argument("--out", default="demo-data")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--check", metavar="DIGEST", help="fail unless the export matches this digest file (what CI runs on Linux)")
    ap.add_argument("--write-digest", metavar="DIGEST", help="record this export's digest, after an intended change to the generator")
    a = ap.parse_args()
    out = Path(a.out)
    demo = Demo(out, a.seed)
    demo.schedule()
    demo.days()
    demo.write()
    print(f"demo: {demo.n_workouts:,} Health workouts, {len(demo.gpx):,} routes, {len(demo.W.records):,} records, {len(demo.strava)} Strava activities -> {out}/")
    dg = digest(out)
    (out / "demo_digest.json").write_text(json.dumps(dg, indent=1) + "\n")
    print(f"demo digest: {dg['parts']['all'][:16]}")
    if a.write_digest:
        Path(a.write_digest).write_text(json.dumps({"seed": a.seed, "parts": dg["parts"]}, indent=1) + "\n")
    if a.check:
        want = json.loads(Path(a.check).read_text())["parts"]
        bad = [k for k in want if want[k] != dg["parts"].get(k)]
        if bad:
            sys.exit(f"demo: the synthetic export differs from {a.check} in {', '.join(k for k in bad if k != 'all')}. If you changed the "
                     f"generator on purpose, run `make demo-digest` and commit {a.check}; if not, the generator is not deterministic on "
                     f"this machine (docs/PLAYBOOK.md, Determinism). Per-file hashes: {out}/demo_digest.json")
        print(f"demo: identical to {a.check}")


if __name__ == "__main__":
    main()
