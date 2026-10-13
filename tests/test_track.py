"""Phase 2: GPS cleaning rules on hand-made tracks."""
import numpy as np
import pytest

from stride.track import MPH, TrackParams, clean_track, climb_hysteresis

M_PER_DEG_LAT = 111_195.0


def straight(n, speed_ms, lat0=40.0, lon0=-75.0, dt=1.0):
    """n points heading north at a constant speed, 1 s apart."""
    t = np.arange(n) * dt
    lat = lat0 + t * speed_ms / M_PER_DEG_LAT
    lon = np.full(n, lon0)
    return t, lat, lon, np.full(n, 50.0), np.full(n, 4.0)


def test_spike_removed_g2():
    t, lat, lon, ele, hacc = straight(200, 1.4)
    lon = lon.copy()
    lon[100] += 300 / 85_000  # one point 300 m off to the side
    r = clean_track(t, lat, lon, ele, hacc, TrackParams())
    assert 100 not in r.keep_idx
    assert any(x[0] == "G2" and x[5] == 100 for x in r.log)
    assert r.stats["gps_distance_m"] == pytest.approx(199 * 1.4, rel=0.01)


def test_accuracy_filter_g1():
    t, lat, lon, ele, hacc = straight(100, 1.4)
    hacc = hacc.copy()
    hacc[50] = 65.0
    r = clean_track(t, lat, lon, ele, hacc, TrackParams())
    assert 50 not in r.keep_idx


def test_door_jitter_g3():
    # 60 s milling within 10 m of the door, then a straight walk
    n0 = 60
    rng = np.random.default_rng(1)
    jit_lat = 40.0 + rng.uniform(-8, 8, n0) / M_PER_DEG_LAT
    jit_lon = -75.0 + rng.uniform(-8, 8, n0) / 85_000
    t2, lat2, lon2, _, _ = straight(200, 1.4)
    t = np.r_[np.arange(n0), n0 + t2]
    lat = np.r_[jit_lat, lat2]
    lon = np.r_[jit_lon, lon2]
    r = clean_track(t, lat, lon, np.full(len(t), 50.0), np.full(len(t), 4.0), TrackParams())
    assert r.keep_idx[0] >= n0 - 1
    assert r.stats["g3_start_s"] > 45


def test_forgot_to_stop_g4():
    # 30 min walk at 1.4 m/s then 10 min drive at 20 m/s (45 mph)
    t1, lat1, lon1, _, _ = straight(1800, 1.4)
    t2, lat2, lon2, _, _ = straight(600, 20.0, lat0=lat1[-1] + 20 / M_PER_DEG_LAT)
    t = np.r_[t1, t1[-1] + 1 + t2]
    lat, lon = np.r_[lat1, lat2], np.r_[lon1, lon2]
    r = clean_track(t, lat, lon, np.full(len(t), 50.0), np.full(len(t), 4.0), TrackParams(), watch_distance_m=1800 * 1.4 + 600 * 20, duration_s=2400)
    assert r.stats["g4_cut"]
    assert r.keep_idx[-1] < 1810
    # more than 20% of distance removed: headline falls back to GPS distance
    assert r.stats["distance_source"] == "gps"
    assert r.stats["distance_m"] == pytest.approx(1799 * 1.4, rel=0.02)
    # no remaining segment above 12 mph
    d = np.diff(r.cum_gps_m)
    assert (d / np.diff(t[r.keep_idx]) < 12 * MPH).all()


def test_pause_and_signal_loss_g5():
    t, lat, lon, ele, hacc = straight(300, 1.4)
    t = t.copy()
    t[150:] += 120          # 2-minute stop: >30 s, moved <10 m
    lat = lat.copy()
    lat[250:] += 400 / M_PER_DEG_LAT
    t[250:] += 40           # 40 s gap and 400 m jump: signal loss
    r = clean_track(t, lat, lon, ele, hacc, TrackParams())
    assert r.gap[np.flatnonzero(r.keep_idx == 150)[0]] == 1
    assert r.gap[np.flatnonzero(r.keep_idx == 250)[0]] == 2
    # the pause does not count as moving time
    assert r.cum_moving_s[-1] == pytest.approx(t[-1] - t[0] - 120, abs=1.0)


def test_distance_reconciliation_g6():
    t, lat, lon, ele, hacc = straight(1000, 1.4)
    r = clean_track(t, lat, lon, ele, hacc, TrackParams(), watch_distance_m=1999 * 0.75)
    assert r.stats["distance_source"] == "watch"
    assert r.cum_m[-1] == pytest.approx(1999 * 0.75, rel=1e-6)
    assert any(x[0] == "G6" for x in r.log)


def test_climb_hysteresis_e2():
    # noise of +-1 m adds nothing; one 10 m hill adds 10 m up and 10 m down
    e = np.r_[np.tile([100.0, 101.0], 50), np.linspace(100, 110, 20), np.linspace(110, 100, 20)]
    up, down = climb_hysteresis(e, 2.0)
    assert up == pytest.approx(10.0, abs=1.01)
    assert down == pytest.approx(10.0, abs=1.01)
    up0, _ = climb_hysteresis(np.tile([100.0, 101.5], 200), 2.0)
    assert up0 == 0


def test_forgot_to_stop_watch_without_drive_keeps_watch_distance():
    t1, lat1, lon1, _, _ = straight(1800, 1.4)
    t2, lat2, lon2, _, _ = straight(600, 20.0, lat0=lat1[-1] + 20 / M_PER_DEG_LAT)
    t = np.r_[t1, t1[-1] + 1 + t2]
    lat, lon = np.r_[lat1, lat2], np.r_[lon1, lon2]
    r = clean_track(t, lat, lon, np.full(len(t), 50.0), np.full(len(t), 4.0), TrackParams(), watch_distance_m=2600.0, duration_s=2400)
    assert r.stats["g4_cut"] and r.stats["distance_source"] == "watch" and r.stats["distance_m"] == 2600.0
