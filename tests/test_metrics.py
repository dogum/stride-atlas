"""Phase 4: metric functions against small hand-computed cases."""
import math

import numpy as np
import pytest

from stride.metrics import (best_effort, buffered_overlap, cells_along, components, eddington, fitness_model, gap_speed, jaccard,
                            longest_streak, loop_label, minetti_run, minetti_walk, signed_area, tobler_factor, trimp_samples)


# ---------------------------------------------------------------- best efforts
def test_best_effort_constant_speed():
    d = np.arange(0, 3001, 10.0)          # 3 km at 2 m/s
    t = d / 2.0
    sec, off = best_effort(d, t, 1000.0)
    assert sec == pytest.approx(500.0)


def test_best_effort_finds_fast_middle_and_interpolates():
    # 0-1000 m at 2 m/s, 1000-1500 m at 5 m/s, 1500-3000 m at 2 m/s
    d = np.array([0, 1000, 1500, 3000.0])
    t = np.array([0, 500, 600, 1350.0])
    sec, off = best_effort(d, t, 1000.0)
    # best 1000 m window must include the fast 500 m: 500 m at 5 m/s (100 s) + 500 m at 2 m/s (250 s)
    assert sec == pytest.approx(350.0)
    assert off == pytest.approx(500.0) or off == pytest.approx(1000.0)


def test_best_effort_skips_bad_segments():
    d = np.array([0, 500, 1000, 1500, 2000, 2500.0])
    t = np.array([0, 250, 260, 510, 760, 1010.0])  # segment 1->2 is "instant" (bad: signal loss)
    bad = np.array([False, False, True, False, False, False])
    sec, _ = best_effort(d, t, 1000.0, bad)
    assert sec == pytest.approx(500.0)  # only windows after the bad segment count
    assert best_effort(d, t, 1000.0)[0] == pytest.approx(260.0)


def test_best_effort_too_short():
    assert best_effort(np.array([0, 500.0]), np.array([0, 250.0]), 1000.0) is None


# ---------------------------------------------------------------- TRIMP, CTL/ATL
def test_trimp_hand_computed():
    # 10 min at HR exactly halfway between rest 60 and max 180: r = 0.5
    hr = np.full(120, 120.0)
    expected = 10 * 0.5 * 0.64 * math.exp(1.92 * 0.5)
    assert trimp_samples(hr, 5 / 60, 60, 180) == pytest.approx(expected)
    assert trimp_samples(np.full(10, 50.0), 5 / 60, 60, 180) == 0.0


def test_ctl_atl_step_response():
    trimp = np.r_[np.full(1, 100.0), np.zeros(9)]
    ctl, atl, tsb = fitness_model(trimp)
    kc, ka = 1 - math.exp(-1 / 42), 1 - math.exp(-1 / 7)
    assert ctl[0] == pytest.approx(100 * kc)
    assert atl[0] == pytest.approx(100 * ka)
    assert ctl[1] == pytest.approx(100 * kc * (1 - kc))
    # form on day t uses yesterday's values
    assert tsb[0] == 0.0
    assert tsb[1] == pytest.approx(ctl[0] - atl[0])


# ---------------------------------------------------------------- Eddington, streaks
def test_eddington():
    # six days >= 5 but only five days >= 6: E = 5, and one more 6-mile day makes it 6
    assert eddington([10, 9, 8, 7, 6, 5, 4]) == (5, 1)


def test_eddington_exact():
    e, need = eddington([3, 3, 3, 1, 1])
    assert e == 3 and need == 4
    assert eddington([]) == (0, 1)
    assert eddington([0.5, 2, 2]) == (2, 3)


def test_streaks():
    assert longest_streak([True, True, False, True, True, True, False]) == (3, 5)
    assert longest_streak([False, False]) == (0, -1)


# ---------------------------------------------------------------- GAP
def test_minetti_flat_and_uphill():
    assert minetti_walk(0.0) == pytest.approx(2.5)
    assert minetti_run(0.0) == pytest.approx(3.6)
    assert minetti_walk(0.1) > minetti_walk(0.0)
    # flat ground: grade-adjusted speed equals actual speed
    assert gap_speed(10.0, np.full(10, 5.0), np.zeros(10), False) == pytest.approx(2.0)
    # uphill: adjusted speed is faster than actual
    assert gap_speed(10.0, np.full(10, 5.0), np.full(10, 0.1), False) > 2.0


# ---------------------------------------------------------------- loops
def test_loop_clustering_pieces():
    # a 400 m square loop, sampled every 10 m on a 25 m grid
    side = np.linspace(0, 100, 11)
    x = np.r_[side, np.full(10, 100), side[::-1][1:], np.zeros(10)]
    y = np.r_[np.zeros(11), side[1:], np.full(10, 100), side[::-1][1:]]
    cum = np.r_[0, np.cumsum(np.hypot(np.diff(x), np.diff(y)))]
    a = cells_along(x, y, cum, 10, 25)
    b = cells_along(x + 2, y - 1, cum, 10, 25)   # same loop, shifted 2 m
    c = cells_along(x + 300, y, cum, 10, 25)     # a different loop
    assert jaccard(a, b) < 0.85                 # plain Jaccard is fragile on grid lines
    assert buffered_overlap(a, b) >= 0.85        # one cell of tolerance recovers the match
    assert buffered_overlap(a, c) == 0.0
    assert signed_area(x, y) > 0 and signed_area(x[::-1], y[::-1]) < 0
    assert components(4, [(0, 1), (2, 3)]) == [0, 0, 2, 2]
    assert components(3, [(0, 2), (2, 1)]) == [0, 0, 0]
    assert loop_label(0) == "Loop A" and loop_label(25) == "Loop Z" and loop_label(26) == "Loop AA"


def test_walking_gap_follows_tobler():
    # flat ground is unchanged; a gentle descent is the fastest ground, so its flat equivalent is slower;
    # steep ground either way is slow, so its flat equivalent is faster
    assert tobler_factor(0.0) == pytest.approx(1.0)
    assert tobler_factor(-0.05) < 1.0
    assert tobler_factor(-0.25) > 1.0 and tobler_factor(0.10) > 1.0
    assert tobler_factor(0.10) == pytest.approx(np.exp(0.35))
    flat = gap_speed(10.0, np.full(10, 5.0), np.zeros(10), False)
    down = gap_speed(10.0, np.full(10, 5.0), np.full(10, -0.084), False)
    assert flat == pytest.approx(2.0) and 0.9 * flat < down < flat  # a -8% mile is only a little easier walking
