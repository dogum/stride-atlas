"""Street coverage from OpenStreetMap (ENRICHMENT.md, optional): which walkable streets near home you have walked.

The walk network comes from a Geofabrik extract of the region containing home (one download, then offline;
Overpass is an option in config.yaml), cut to a box around home snapped outward to a 0.05° grid (never
centred on home), and saved as GraphML in data/cache/osm/. Cleaned tracks are sampled
every 10 m and matched to the nearest edge within 15 m; an edge counts as walked when matched points
cover at least 60% of its length. Coverage = walked length / walkable length within 1, 2 and 3 miles
of home. The app receives street geometry with walked flags and the percentages, never home itself.
"""
from __future__ import annotations

import ast
import json
import math
import re
from pathlib import Path

import numpy as np
import pandas as pd

from . import paths
from .geo import MI
from .paths import Timer

GRID = 0.05
MATCH_M = 15.0
STEP_M = 10.0
HALF_W = 6.0      # each matched point covers ±6 m along its edge
WALKED_SHARE = 0.6


def snapped_bbox(home, miles: float) -> tuple[float, float, float, float]:
    dlat = miles * MI / 111_195
    dlon = miles * MI / (111_195 * math.cos(math.radians(home[0])))
    w, s = math.floor((home[1] - dlon) / GRID) * GRID, math.floor((home[0] - dlat) / GRID) * GRID
    e, n = math.ceil((home[1] + dlon) / GRID) * GRID, math.ceil((home[0] + dlat) / GRID) * GRID
    return round(w, 4), round(s, 4), round(e, 4), round(n, 4)


GEOFABRIK_INDEX = "https://download.geofabrik.de/index-v1.json"
# the same rules as osmnx's "walk" network filter
WALK_EXCLUDE = re.compile("abandoned|bus_guideway|construction|cycleway|motor|no|planned|platform|proposed|raceway|razed")


def is_walkable(t: dict) -> bool:
    hw = t.get("highway")
    if not hw or t.get("area") == "yes" or WALK_EXCLUDE.search(hw):
        return False
    if "no" in t.get("foot", "") or "private" in t.get("service", "") or "private" in t.get("access", ""):
        return False
    return True


def pick_region(home) -> tuple[str, str]:
    """The smallest Geofabrik region whose polygon contains home, decided locally from the public index."""
    from shapely.geometry import Point, shape

    from .enrich import Net

    idx = Net().get(GEOFABRIK_INDEX, {}).json()
    p = Point(home[1], home[0])
    best = None
    for f in idx["features"]:
        url = f["properties"].get("urls", {}).get("pbf")
        if not url or not f.get("geometry"):
            continue
        g = shape(f["geometry"])
        if g.contains(p) and (best is None or g.area < best[0]):
            best = (g.area, f["properties"]["id"], url)
    if best is None:
        raise RuntimeError("no Geofabrik region contains home")
    return best[1], best[2]


def extract_walk_xml(pbf: Path, bbox, out: Path) -> int:
    """Walkable ways that touch the box, with their nodes, as a small OSM XML file osmnx can read."""
    import osmium
    from xml.sax.saxutils import quoteattr

    W_, S_, E_, N_ = bbox
    nodes: dict[int, tuple[float, float]] = {}
    ways = []
    # nodes must be read for the location cache; only ways are used
    fp = osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations()
    for w in fp:
        if not w.is_way() or "highway" not in w.tags:
            continue
        tags = {t.k: t.v for t in w.tags}
        if not is_walkable(tags):
            continue
        locs = [(n.ref, n.location.lon, n.location.lat) for n in w.nodes if n.location.valid()]
        if len(locs) < 2 or not any(W_ < lo < E_ and S_ < la < N_ for _, lo, la in locs):
            continue
        ways.append((w.id, [r for r, _, _ in locs], tags))
        for r, lo, la in locs:
            nodes[r] = (lo, la)
    with open(out, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="stride-atlas">\n')
        for r in sorted(nodes):
            lo, la = nodes[r]
            f.write(f'<node id="{r}" lat="{la:.7f}" lon="{lo:.7f}"/>\n')
        for wid, refs, tags in sorted(ways, key=lambda x: x[0]):
            f.write(f'<way id="{wid}">' + "".join(f'<nd ref="{r}"/>' for r in refs) + "".join(f"<tag k={quoteattr(k)} v={quoteattr(v)}/>" for k, v in sorted(tags.items())) + "</way>\n")
        f.write("</osm>\n")
    return len(ways)


def load_graph(bbox, home, ex: dict):
    """Walk network for the box: from a Geofabrik extract (default, offline after one download) or Overpass."""
    import osmnx as ox

    folder = paths.CACHE / "osm"
    folder.mkdir(parents=True, exist_ok=True)
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(folder / "http")
    ox.settings.log_console = False
    ox.settings.http_user_agent = "stride-atlas/0.1 (personal, local)"
    ox.settings.requests_timeout = 120
    f = folder / f"walk_{bbox[0]}_{bbox[1]}_{bbox[2]}_{bbox[3]}.graphml"
    if f.exists():
        G = ox.load_graphml(f)
        return G, G.graph.get("stride_source", "cache")
    if ex.get("osm_source") == "file":  # a ready OSM XML of walkable ways (the demo's synthetic town)
        xml = Path(ex["osm_file"])
        xml = xml if xml.is_absolute() else paths.ROOT / xml
        G = ox.graph_from_xml(xml, retain_all=True)
        G.graph["stride_source"] = f"file:{xml.name}"
        return G, f"file:{xml.name}"
    if ex.get("osm_source", "extract") == "overpass":
        if ex.get("overpass_url"):
            ox.settings.overpass_url = ex["overpass_url"]
        G = ox.graph_from_bbox(bbox, network_type="walk")
        src = "overpass"
    else:
        url = ex.get("osm_extract_url")
        if not url:
            _, url = pick_region(home)
        pbf = folder / Path(url).name
        rid = pbf.name.split("-latest")[0]
        if not pbf.exists():
            print(f"osm: downloading {url}", flush=True)
            import requests

            with requests.get(url, stream=True, timeout=600) as r:
                r.raise_for_status()
                tmp = pbf.with_suffix(".part")
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(1 << 20):
                        fh.write(chunk)
                tmp.rename(pbf)
        xml = folder / f"walk_{bbox[0]}_{bbox[1]}_{bbox[2]}_{bbox[3]}.osm"
        if not xml.exists():
            n = extract_walk_xml(pbf, bbox, xml)
            print(f"osm: {n:,} walkable ways from {pbf.name}", flush=True)
        G = ox.graph_from_xml(xml, retain_all=True)
        src = f"geofabrik:{rid}"
    G.graph["stride_source"] = src
    ox.save_graphml(G, f)
    return G, src


def union_length(iv: list[tuple[float, float]]) -> float:
    if not iv:
        return 0.0
    iv.sort()
    tot, (a, b) = 0.0, iv[0]
    for x, y in iv[1:]:
        if x > b:
            tot += b - a
            a, b = x, y
        else:
            b = max(b, y)
    return tot + (b - a)


STREET = {"residential", "living_street", "unclassified", "tertiary", "tertiary_link", "secondary", "secondary_link", "primary",
          "primary_link", "trunk", "trunk_link", "pedestrian", "road"}
PATH = {"footway", "path", "track", "steps", "bridleway", "cycleway"}
TOL = {0: 20.0, 1: 15.0}   # streets: walking the sidewalk counts; paths: tighter


def edge_class(hw, fw) -> int:
    """0 street, 1 path or trail, 2 other (driveways, parking aisles, sidewalks and crossings, which belong to their street)."""
    vals = hw if isinstance(hw, list) else ast.literal_eval(hw) if isinstance(hw, str) and hw.startswith("[") else [hw]
    fws = fw if isinstance(fw, list) else [fw]
    if any(v in STREET for v in vals):
        return 0
    if any(v in PATH for v in vals) and not any(f in ("sidewalk", "crossing") for f in fws):
        return 1
    return 2


def covered(pos: np.ndarray, length: float) -> float:
    """Length of the union of ±HALF_W windows around matched positions along one edge."""
    p = np.sort(pos)
    lo, hi = np.clip(p - HALF_W, 0, length), np.clip(p + HALF_W, 0, length)
    brk = np.r_[True, lo[1:] > np.maximum.accumulate(hi)[:-1]]
    starts = lo[brk]
    ends = np.maximum.reduceat(hi, np.flatnonzero(brk))
    return float((ends - starts).sum())


def run() -> dict:
    import osmnx as ox
    import shapely
    from pyproj import Transformer

    cfg = paths.config()
    ex = cfg.get("exploration", {})
    if not ex.get("use_osm", True):
        print("osm: disabled in config.yaml")
        return {}
    con = paths.connect()
    home = con.execute("SELECT lat, lon FROM home").fetchone()
    out: dict = {}
    with Timer("osm walk network"):
        bbox = snapped_bbox(home, 3.5)
        if "footway" not in ox.settings.useful_tags_way:
            ox.settings.useful_tags_way = list(ox.settings.useful_tags_way) + ["footway"]
        try:
            G, src = load_graph(bbox, home, ex)
        except Exception as e:  # optional enrichment: a missing street layer must not stop the build
            con.close()
            print(f"osm: could not get the walk network ({type(e).__name__}: {str(e)[:120]}); street coverage skipped.")
            return {"skipped": str(e)[:200]}
        out["source"] = src
        Gu = ox.convert.to_undirected(G)
        Gp = ox.project_graph(Gu)
        edges = ox.graph_to_gdfs(Gp, nodes=False).reset_index()
        edges_ll = ox.graph_to_gdfs(Gu, nodes=False).reset_index()
        fw = edges["footway"] if "footway" in edges else pd.Series([None] * len(edges))
        edges["cls"] = [edge_class(h, f) for h, f in zip(edges.highway, fw)]
        edges["k"] = list(zip(edges.u, edges.v, edges.key))
        out["edges"] = int(len(edges))
    with Timer("match tracks"):
        w = con.execute("""SELECT workout_id, local_date FROM workouts_clean WHERE setting = 'outdoor' AND type IN ('walk','run','hike') AND NOT is_fragment""").df()
        pts = con.execute("SELECT workout_id, lat, lon, cum_gps_m FROM route_points_clean ORDER BY workout_id, seq").fetchnumpy()
        date_of = dict(zip(w.workout_id, w.local_date))
        wid = pts["workout_id"]
        u_, f_ = np.unique(wid, return_index=True)
        bnd = dict(zip(u_, zip(f_, np.r_[f_[1:], len(wid)])))
        W_, S_, E_, N_ = bbox
        # day numbers count from 1 January of the first on-foot year (an older watch's archive can start years before the phone)
        d0 = pd.Timestamp(year=pd.Timestamp(min(date_of.values())).year, month=1, day=1) if date_of else pd.Timestamp("2018-01-01")
        xs, ys, ds = [], [], []
        for k, (a, b) in bnd.items():
            if k not in date_of:
                continue
            la, lo, cm = pts["lat"][a:b], pts["lon"][a:b], pts["cum_gps_m"][a:b]
            if len(la) < 2 or not ((la > S_) & (la < N_) & (lo > W_) & (lo < E_)).any():
                continue
            cmu = np.maximum.accumulate(cm)
            ok = np.r_[True, np.diff(cmu) > 0]
            g = np.arange(0, cmu[ok][-1], STEP_M)
            gl, go = np.interp(g, cmu[ok], la[ok]), np.interp(g, cmu[ok], lo[ok])
            inb = (gl > S_) & (gl < N_) & (go > W_) & (go < E_)
            xs.append(go[inb]); ys.append(gl[inb])
            ds.append(np.full(int(inb.sum()), (pd.Timestamp(date_of[k]) - d0).days, dtype=np.int32))
        X, Y = Transformer.from_crs("EPSG:4326", Gp.graph["crs"], always_xy=True).transform(np.concatenate(xs), np.concatenate(ys))
        day = np.concatenate(ds)
        P = shapely.points(X, Y)
        geoms = edges.geometry.values
        cov = np.zeros(len(edges))
        first = np.full(len(edges), -1, dtype=np.int64)
        matched = np.zeros(len(P), dtype=bool)
        for c, tol in TOL.items():
            idx = np.flatnonzero(edges.cls.values == c)
            if not len(idx):
                continue
            tree = shapely.STRtree(geoms[idx])
            (pi, ei), _ = tree.query_nearest(P, max_distance=tol, return_distance=True)
            matched[pi] = True
            ge = idx[ei]
            pos = shapely.line_locate_point(geoms[ge], P[pi])
            df = pd.DataFrame({"e": ge, "pos": pos, "d": day[pi]})
            for e, g in df.groupby("e"):
                L, p_, d_ = float(edges.length.iat[e]), g.pos.to_numpy(), g.d.to_numpy()
                cov[e] = covered(p_, L)
                if cov[e] >= WALKED_SHARE * L:
                    # the day the edge became walked: coverage only grows with time, so binary-search the walk dates
                    days = np.unique(d_)
                    lo, hi = 0, len(days) - 1
                    while lo < hi:
                        mid = (lo + hi) // 2
                        lo, hi = (lo, mid) if covered(p_[d_ <= days[mid]], L) >= WALKED_SHARE * L else (mid + 1, hi)
                    first[e] = int(days[lo])
        out["points"] = int(len(P))
        out["matched_share"] = float(matched.mean())
    with Timer("coverage"):
        edges["covered_m"] = cov
        edges["walked"] = (edges.cls < 2) & (edges.covered_m >= WALKED_SHARE * edges.length)
        edges["first_day"] = np.where(edges.walked, first, -1)
        mid = edges.geometry.interpolate(0.5, normalized=True)  # projected metres, so the midpoint is a true midpoint
        hx, hy = Transformer.from_crs("EPSG:4326", Gp.graph["crs"], always_xy=True).transform(home[1], home[0])
        edges["home_m"] = np.hypot(mid.x.values - hx, mid.y.values - hy)
        rings = []
        for r_mi in (1, 2, 3):
            row = {"miles": r_mi}
            for c, name in ((0, "streets"), (1, "paths")):
                inside = (edges.home_m <= r_mi * MI) & (edges.cls == c)
                tot = float(edges.length[inside].sum())
                wk = float(edges.length[inside & edges.walked].sum())
                row[name] = {"total_m": round(tot, 1), "walked_m": round(wk, 1), "share": round(wk / tot, 4) if tot else None}
            rings.append(row)
        out["rings"] = rings
        in3 = edges[(edges.home_m <= 3 * MI) & edges.walked & (edges.cls == 0)]
        tl = in3.assign(month=[(d0 + pd.Timedelta(days=int(x))).strftime("%Y-%m") for x in in3.first_day]).groupby("month").length.sum().sort_index().cumsum()
        out["timeline"] = [[k, round(float(v), 1)] for k, v in tl.items()]
    with Timer("export streets"):
        from .export import share_visible, zone_center  # same privacy zone as the routes

        zc = zone_center(home)
        ring = np.select([edges.home_m <= MI, edges.home_m <= 2 * MI, edges.home_m <= 3 * MI], [1, 2, 3], 0)
        first_val = lambda v: (v[0] if isinstance(v, list) else ast.literal_eval(v)[0] if isinstance(v, str) and v.startswith("[") else v)  # noqa: E731
        nm = [first_val(v) if isinstance(v, (str, list)) else None for v in edges.get("name", pd.Series([None] * len(edges)))]
        hw = [first_val(v) for v in edges.highway]
        names, hws = sorted({v for v in nm if v}), sorted({v for v in hw if v})
        ni, hi_ = {v: i for i, v in enumerate(names)}, {v: i for i, v in enumerate(hws)}
        attr_k = dict(zip(edges.k, zip(edges.walked.astype(int), edges.first_day, edges.cls, ring, np.round(edges.length * 10).astype(int),
                                       np.round(edges.covered_m * 10).astype(int), [ni.get(v, -1) for v in nm], [hi_.get(v, -1) for v in hw])))
        coords, offs, attr = [], [0], []
        for r in edges_ll.itertuples():
            c = np.asarray(r.geometry.coords, dtype=np.float64)
            coords.append(c.astype(np.float32))
            offs.append(offs[-1] + len(c))
            wk, fd, cl, rg, dm, cv, na, hx = attr_k[(r.u, r.v, r.key)]
            hid = not share_visible(c[:, 1], c[:, 0], np.zeros(len(c)), home, zc, trim=0.0).all()
            attr.append([int(wk), int(hid), int(fd), int(cl), int(rg), int(dm), int(cv), int(na), int(hx)])  # walked_day counts from day0; lengths in dm
        OUT = paths.APP_DATA
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "streets_xy.bin").write_bytes(np.concatenate(coords).ravel().astype(np.float32).tobytes())
        (OUT / "streets_idx.bin").write_bytes(np.asarray(offs, dtype=np.uint32).tobytes())
        (OUT / "streets_attr.bin").write_bytes(np.asarray(attr, dtype=np.int32).tobytes())
        stats = {"network_source": src, "edges": out["edges"], "points": out["points"], "matched_share": round(out["matched_share"], 4),
                 "rings": rings, "timeline": out["timeline"], "match_m": TOL, "walked_share": WALKED_SHARE, "day0": str(d0.date()),
                 "attr_cols": ["walked", "share_hidden", "walked_day", "class", "ring", "length_dm", "covered_dm", "name", "highway"],
                 "classes": ["street", "path", "other"], "names": names, "highways": hws,
                 "attribution": ex.get("osm_attribution") or ("© OpenStreetMap contributors (ODbL), extract via Geofabrik" if src.startswith("geofabrik") else "© OpenStreetMap contributors (ODbL)")}
        (OUT / "streets.json").write_text(json.dumps(stats, separators=(",", ":"), sort_keys=True))
    con.execute("CREATE OR REPLACE TABLE street_coverage AS SELECT ?::VARCHAR AS stats", [json.dumps(out, default=str)])
    con.close()
    paths.write_json(paths.DATA / "osm_log.json", out)
    return out


def main() -> None:
    print(json.dumps(run(), indent=1, default=str))


if __name__ == "__main__":
    main()
