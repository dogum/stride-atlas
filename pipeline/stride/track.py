"""Per-track GPS cleaning (CLEANING.md rules G1–G6, E1–E2) as pure numpy.

`clean_track` takes one route's raw points and returns the cleaned arrays plus
the log entries describing every change. It has no database access so it can
run in a process pool and be unit-tested on hand-made tracks.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.signal import savgol_filter

from .geo import haversine, seg_dist

MPH = 0.44704


@dataclass
class TrackParams:
    ceiling_mph: float = 9.0
    on_foot: bool = True
    hacc_drop_m: float = 40.0
    hacc_good_m: float = 15.0
    hacc_window_s: float = 10.0
    spike_factor: float = 3.0
    spike_window_s: float = 30.0
    jitter_radius_m: float = 25.0
    jitter_seconds: float = 45.0
    drive_mph: float = 12.0
    drive_seconds: float = 60.0
    drive_tail_share: float = 0.4
    g4_major_share: float = 0.20
    pause_gap_s: float = 30.0
    pause_move_m: float = 10.0
    loss_move_m: float = 200.0
    g6_tolerance: float = 0.05
    watch_includes_drive_mph: float = 5.0
    sg_window_s: float = 30.0
    sg_order: int = 2
    climb_hysteresis_m: float = 2.0
    ele_min_valid: float = 0.7


@dataclass
class TrackResult:
    keep_idx: np.ndarray            # indices into the raw arrays that survive
    gap: np.ndarray                 # before this point: 0 normal, 1 pause, 2 signal loss, 3 excised drive, 4 position jump
    cum_gps_m: np.ndarray           # cumulative haversine distance on cleaned points
    cum_m: np.ndarray               # cumulative distance scaled to the headline (G6)
    cum_moving_s: np.ndarray        # cumulative moving time
    ele_smooth: np.ndarray          # smoothed GPS elevation (nan when unusable)
    stats: dict = field(default_factory=dict)
    log: list = field(default_factory=list)  # (rule, field, before, after, note, orig_seq or None)


def climb_hysteresis(e: np.ndarray, h: float) -> tuple[float, float]:
    """E2: ascent starts counting once elevation rises more than h above the last local low, then counts
    up to the peak; descent is symmetric. Noise smaller than h adds nothing."""
    e = e[np.isfinite(e)]
    if len(e) < 2:
        return float("nan"), float("nan")
    up = down = 0.0
    ref = float(e[0])
    state = 0  # 0 unknown, 1 climbing, -1 descending
    for x in e[1:].tolist():
        if state == 1:
            if x > ref:
                up += x - ref
                ref = x
            elif ref - x > h:
                down += ref - x
                ref, state = x, -1
        elif state == -1:
            if x < ref:
                down += ref - x
                ref = x
            elif x - ref > h:
                up += x - ref
                ref, state = x, 1
        else:
            if x - ref > h:
                up += x - ref
                ref, state = x, 1
            elif ref - x > h:
                down += ref - x
                ref, state = x, -1
    return up, down


def smooth_elevation(t: np.ndarray, ele: np.ndarray, p: TrackParams) -> np.ndarray:
    """E1: fill short gaps linearly over time, then Savitzky–Golay (about 30 s, order 2)."""
    n = len(ele)
    ok = np.isfinite(ele)
    if n < 7 or ok.mean() < p.ele_min_valid:
        return np.full(n, np.nan)
    # Hampel filter: altitude readings far from the 61-point rolling median are glitches, not terrain
    s = pd.Series(np.where(ok, ele, np.nan))
    med = s.rolling(61, center=True, min_periods=5).median()
    mad = (s - med).abs().rolling(61, center=True, min_periods=5).median()
    bad = ((s - med).abs() > np.maximum(15.0, 5 * 1.4826 * mad.fillna(0))).to_numpy()
    ok &= ~bad
    if ok.mean() < p.ele_min_valid:
        return np.full(n, np.nan)
    e = np.interp(t, t[ok], ele[ok])
    dt = np.median(np.diff(t)) if n > 1 else 1.0
    w = int(round(p.sg_window_s / max(dt, 0.5)))
    w = max(5, w + (1 - w % 2))
    if w >= n:
        w = n - 1 if (n - 1) % 2 else n - 2
    if w <= p.sg_order:
        return e
    return savgol_filter(e, w, p.sg_order, mode="interp")


def _rolling_median(t: np.ndarray, v: np.ndarray, window_s: float) -> np.ndarray:
    s = pd.Series(v, index=pd.to_datetime(t, unit="s"))
    return s.rolling(pd.Timedelta(seconds=window_s), center=True, min_periods=1).median().to_numpy()


def clean_track(t, lat, lon, ele, hacc, p: TrackParams, watch_distance_m=None, pauses=(), duration_s=None) -> TrackResult:
    """t: seconds (float) since an arbitrary epoch, increasing. pauses: [(a, b)] in the same clock."""
    n0 = len(t)
    log = []
    idx = np.arange(n0)
    ok = np.isfinite(lat) & np.isfinite(lon) & np.isfinite(t)
    # keep strictly increasing time
    if ok.any():
        tt = t.copy()
        tt[~ok] = -np.inf
        ok &= np.r_[True, np.diff(np.maximum.accumulate(tt)) > 0] | (np.arange(n0) == 0)
    idx = idx[ok]

    # ---- G1 accuracy filter
    if len(idx):
        h = hacc[idx]
        bad = np.flatnonzero(np.isfinite(h) & (h > p.hacc_drop_m))
        drop = []
        if len(bad):
            tt = t[idx]
            for b in bad:
                lo, hi = np.searchsorted(tt, tt[b] - p.hacc_window_s), np.searchsorted(tt, tt[b] + p.hacc_window_s, side="right")
                nb = np.r_[h[lo:b], h[b + 1:hi]]
                if len(nb) and np.nanmin(nb) < p.hacc_good_m:
                    drop.append(b)
        for b in drop:
            log.append(("G1", "hacc_m", float(hacc[idx[b]]), None, "dropped: accuracy worse than 40 m with good neighbours", int(idx[b])))
        if drop:
            idx = np.delete(idx, drop)

    # ---- G2 spikes, two passes
    ceil = p.ceiling_mph * MPH
    for _pass in range(2):
        if len(idx) < 3:
            break
        tt, la, lo = t[idx], lat[idx], lon[idx]
        d = seg_dist(la, lo)
        dt = np.maximum(np.diff(tt), 1e-3)
        v = d / dt
        vmid = np.r_[v[0], (v[:-1] + v[1:]) / 2, v[-1]]
        med = _rolling_median(tt, vmid, p.spike_window_s)
        vin, vout = v[:-1], v[1:]
        m = med[1:-1]
        spike = (vin > p.spike_factor * m) & (vout > p.spike_factor * m) & (vin > ceil) & (vout > ceil)
        sp = np.flatnonzero(spike) + 1
        if not len(sp):
            break
        for s in sp:
            log.append(("G2", "speed_ms", float(max(vin[s - 1], vout[s - 1])), None, f"dropped spike (pass {_pass + 1})", int(idx[s])))
        idx = np.delete(idx, sp)

    # ---- G3 door jitter at both ends
    trimmed = {}
    for end in ("start", "end"):
        if len(idx) < 5:
            break
        seq = idx if end == "start" else idx[::-1]
        c_la, c_lo = lat[seq[0]], lon[seq[0]]
        dist0 = haversine(c_la, c_lo, lat[seq], lon[seq])
        out = np.flatnonzero(dist0 > p.jitter_radius_m)
        if not len(out):
            continue
        k = int(out[0])  # first point outside the circle
        span = abs(t[seq[k - 1]] - t[seq[0]])
        if k >= 2 and span > p.jitter_seconds:
            trimmed[end] = (k - 1, float(span))
            cut = seq[: k - 1]
            if end == "start":
                idx = idx[k - 1:]
            else:
                idx = idx[: len(idx) - (k - 1)]
            log.append(("G3", "points", int(len(cut)), 0, f"trimmed {span:.0f} s of door jitter at the {end}", None))

    # ---- G4 forgot to stop (on foot only), generalized to driving at either end or in the middle
    g4 = None
    vehicle_breaks: list[int] = []  # raw indices of points that follow an excised drive
    if p.on_foot and len(idx) > 10:
        tt, la, lo = t[idx], lat[idx], lon[idx]
        d = seg_dist(la, lo)
        total = float(d.sum())
        dt = np.maximum(np.diff(tt), 1e-3)
        v = np.r_[0.0, d / dt]
        vs = _rolling_median(tt, v, 5.0)
        fast = vs > p.drive_mph * MPH
        starts = np.flatnonzero(fast & ~np.r_[False, fast[:-1]])
        ends = np.flatnonzero(fast & ~np.r_[fast[1:], False])
        runs = [(int(a_), int(b_)) for a_, b_ in zip(starts, ends) if tt[b_] - tt[a_] >= p.drive_seconds]
        if runs:
            drop = np.zeros(len(idx), dtype=bool)
            removed_s = 0.0
            notes = []
            head_end = tail_start = None
            for a_, b_ in runs:
                # widen to the slower approach and departure (still above walking ceiling)
                while a_ > 0 and vs[a_ - 1] > p.ceiling_mph * MPH:
                    a_ -= 1
                while b_ < len(idx) - 1 and vs[b_ + 1] > p.ceiling_mph * MPH:
                    b_ += 1
                tail_t, head_t = tt[-1] - tt[a_], tt[b_] - tt[0]
                tail_fast = float(np.sum(dt[a_:][fast[a_ + 1:]])) if a_ < len(idx) - 1 else 0.0
                head_fast = float(np.sum(dt[:b_][fast[1:b_ + 1]])) if b_ > 0 else 0.0
                mph = float(vs[a_:b_ + 1].max() / MPH)
                if tail_t > 0 and tail_fast / tail_t >= p.drive_tail_share:
                    tail_start = a_ if tail_start is None else min(tail_start, a_)
                    notes.append(f"end: {mph:.0f} mph")
                    break
                if head_t > 0 and head_fast / head_t >= p.drive_tail_share:
                    head_end = b_ if head_end is None else max(head_end, b_)
                    notes.append(f"start: {mph:.0f} mph")
                    continue
                drop[a_:b_ + 1] = True
                removed_s += tt[b_] - tt[a_]
                if b_ + 1 < len(idx):
                    vehicle_breaks.append(int(idx[b_ + 1]))
                notes.append(f"middle: {mph:.0f} mph")
            if head_end is not None:
                removed_s += tt[head_end] - tt[0]
                drop[: head_end + 1] = True
            if tail_start is not None:
                removed_s += tt[-1] - tt[tail_start]
                drop[tail_start:] = True
            if drop.any() and not drop.all():
                kept_idx = idx[~drop]
                kd = seg_dist(lat[kept_idx], lon[kept_idx])
                # distance that remains, not counting the straight jumps across excised drives
                brk = np.isin(kept_idx[1:], vehicle_breaks)
                kept = float(kd[~brk].sum())
                g4 = {"removed_m": total - kept, "removed_share": (total - kept) / total if total else 0.0, "removed_s": float(removed_s),
                      "max_mph": float(vs[drop].max() / MPH)}
                log.append(("G4", "distance_m", round(total, 1), round(kept, 1), f"removed {g4['removed_share']:.0%} of the track driven at up to {g4['max_mph']:.0f} mph ({'; '.join(notes)})", None))
                idx = kept_idx
    # ---- isolated one-sided jumps faster than the ceiling: the receiver re-acquired somewhere else
    jumps: list[int] = []
    if len(idx) > 2:
        tt, la, lo = t[idx], lat[idx], lon[idx]
        d = seg_dist(la, lo)
        dts = np.diff(tt)
        v = d / np.maximum(dts, 1e-3)
        # gaps over 30 s are G5's business (pause or signal loss); jumps are fast moves between consecutive fixes
        over = np.flatnonzero((v > max(p.ceiling_mph, p.drive_mph if p.on_foot else p.ceiling_mph) * MPH) & (dts <= p.pause_gap_s)
                              & ~np.isin(idx[1:], vehicle_breaks))
        jumps = [int(idx[k + 1]) for k in over]
        if jumps:
            log.append(("G5", "jumps", len(jumps), None, f"{len(jumps)} position jumps faster than {max(p.ceiling_mph, p.drive_mph if p.on_foot else p.ceiling_mph):.0f} mph: drawn dashed, no distance or moving time", None))

    n = len(idx)
    tt, la, lo = t[idx], lat[idx], lon[idx]
    d = seg_dist(la, lo)
    dt = np.diff(tt)
    # ---- G5 gaps
    gap = np.zeros(n, dtype=np.int8)
    if n > 1:
        gp = np.flatnonzero((dt > p.pause_gap_s) & (d < p.pause_move_m)) + 1
        gl = np.flatnonzero((dt > p.pause_gap_s) & (d > p.loss_move_m)) + 1
        gap[gp] = 1
        gap[gl] = 2
        gap[np.isin(idx, jumps)] = 4
        gap[np.isin(idx, vehicle_breaks)] = 3
        if len(gp) or len(gl):
            log.append(("G5", "gaps", None, None, f"{len(gp)} pauses ({dt[gp - 1].sum():.0f} s), {len(gl)} signal losses ({d[gl - 1].sum():.0f} m)", None))
    # paused segments: GPS pause gaps, plus segments whose midpoint falls in an event pause
    paused = np.zeros(max(n - 1, 0), dtype=bool)
    if n > 1:
        paused |= (gap[1:] == 1) | (gap[1:] == 3) | (gap[1:] == 4)
        mid = (tt[:-1] + tt[1:]) / 2
        for a, b in pauses:
            paused |= (mid >= a) & (mid <= b)
    gps_pause_s = float(dt[(gap[1:] == 1)].sum()) if n > 1 else 0.0
    event_pause_overlap = 0.0
    if n > 1 and len(pauses):
        mid = (tt[:-1] + tt[1:]) / 2
        inside = np.zeros(n - 1, dtype=bool)
        for a, b in pauses:
            inside |= (mid >= a) & (mid <= b)
        event_pause_overlap = float(dt[(gap[1:] == 1) & inside].sum())
    cum_moving = np.r_[0.0, np.cumsum(np.where(paused, 0.0, dt))] if n > 1 else np.zeros(n)

    # ---- G6 distance reconciliation
    if n > 1:
        d = np.where((gap[1:] == 3) | (gap[1:] == 4), 0.0, d)  # excised drives and position jumps are not distance travelled
    gps_m = float(d.sum()) if n > 1 else 0.0
    cum_gps = np.r_[0.0, np.cumsum(d)] if n > 1 else np.zeros(n)
    head, src = gps_m, "gps"
    ratio = None
    if watch_distance_m and watch_distance_m > 0 and gps_m > 0:
        ratio = watch_distance_m / gps_m
        watch_mph = (watch_distance_m / duration_s) / MPH if duration_s else 0.0
        if g4 is not None and g4["removed_share"] > p.g4_major_share and watch_mph > p.watch_includes_drive_mph:
            head, src = gps_m, "gps"
            log.append(("G6", "distance_m", float(watch_distance_m), gps_m, f"G4 cut over 20% and the watch averaged {watch_mph:.1f} mph, so it counted the drive: headline uses GPS distance of the remainder", None))
        elif g4 is not None and g4["removed_share"] > p.g4_major_share:
            head, src = float(watch_distance_m), "watch"
            log.append(("G6", "distance_m", float(watch_distance_m), float(watch_distance_m), f"G4 cut over 20% but the watch averaged {watch_mph:.1f} mph over the workout, so it did not count the drive: watch distance kept", None))
        else:
            head, src = float(watch_distance_m), "watch"
            if abs(ratio - 1) > p.g6_tolerance:
                log.append(("G6", "distance_ratio", round(ratio, 4), None, f"watch {watch_distance_m:.0f} m vs GPS {gps_m:.0f} m; cumulative distance scaled", None))
    # G6 scaling only makes sense when the track covers the workout; a 10-second track scaled to 2.6 km is nonsense
    span = float(tt[-1] - tt[0]) if n > 1 else 0.0
    coverage = span / duration_s if duration_s else 1.0
    partial = bool(coverage < 0.5 or (ratio is not None and ratio > 1.5 and src == "watch"))
    scale = head / gps_m if (gps_m > 0 and not partial) else 1.0
    if partial and n > 1:
        log.append(("G6", "coverage", round(coverage, 3), None, f"GPS covers {coverage:.0%} of the workout ({gps_m:.0f} m vs {head:.0f} m): not scaled, kept out of best efforts", None))
    cum = cum_gps * scale

    # ---- E1/E2 elevation from GPS
    e_raw = ele[idx]
    e_s = smooth_elevation(tt, e_raw, p)
    if np.isfinite(e_s).any():
        climb, desc = climb_hysteresis(e_s, p.climb_hysteresis_m)
        raw_up = float(np.nansum(np.clip(np.diff(e_raw), 0, None)))
        log.append(("E2", "climb_gps_m", round(raw_up, 1), round(climb, 1), "Savitzky–Golay smoothing then 2 m hysteresis", None))
    else:
        climb = desc = float("nan")

    moving_s = None
    if duration_s is not None:
        moving_s = float(duration_s) - max(0.0, gps_pause_s - event_pause_overlap) - (g4["removed_s"] if g4 else 0.0)
        if moving_s <= 0:
            moving_s = float(cum_moving[-1]) if n else 0.0
    stats = {
        "n_raw": int(n0), "n_clean": int(n), "gps_distance_m": gps_m, "distance_m": head, "distance_source": src,
        "distance_ratio": ratio, "climb_gps_m": climb, "descent_gps_m": desc, "gps_pause_s": gps_pause_s,
        "n_pauses": int((gap == 1).sum()), "n_signal_loss": int((gap == 2).sum()), "moving_s": moving_s,
        "track_moving_s": float(cum_moving[-1]) if n else 0.0,
        "g4_cut": g4 is not None, "g4_removed_share": g4["removed_share"] if g4 else 0.0, "g4_max_mph": g4["max_mph"] if g4 else None,
        "n_jumps": len(jumps), "n_vehicle_breaks": len(vehicle_breaks), "gps_coverage": coverage, "partial_track": partial,
        "g3_start_s": trimmed.get("start", (0, 0.0))[1], "g3_end_s": trimmed.get("end", (0, 0.0))[1],
        "ele_valid_share": float(np.isfinite(e_raw).mean()) if n else 0.0,
    }
    return TrackResult(idx, gap, cum_gps, cum, cum_moving, e_s, stats, log)
