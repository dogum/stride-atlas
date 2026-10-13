"""The synthetic demo generator: a connected town, plausible tracks, real-export quirks."""
from datetime import datetime

import numpy as np

from stride.demo import TZ, XOFF, Demo, build_town, make_track, ts


def test_town_is_connected_from_home_to_the_trailhead():
    g = build_town(np.random.default_rng(1))
    path = g.route([g.home, g.trailhead], np.random.default_rng(2), jitter=0.0)
    assert path is not None and path[0] == g.home and path[-1] == g.trailhead
    classes = {e["cls"] for e in g.edges}
    assert {"residential", "secondary", "path", "footway", "service"} <= classes  # streets, trails, and driveways never counted


def test_a_walk_track_is_plausible(tmp_path):
    d = Demo(tmp_path, seed=3)
    poly = d.favorites[0]
    tr = make_track(d.town, poly, datetime(2024, 6, 1, 7, 30, tzinfo=TZ), "walk", np.random.default_rng(4), 0.6, 65.0, pauses=1)
    t = np.array([x.timestamp() for x in tr["t"]])
    assert np.all(np.diff(t) > 0)
    pace_min_per_mi = tr["moving_s"] / 60 / (tr["dist_m"] / 1609.344)
    assert 14 < pace_min_per_mi < 24
    assert 1.2 * 1609 < tr["dist_m"] < 2.2 * 1609        # the shortest favourite loop is about 1.6 mi
    assert 2 < tr["hacc"].min() and tr["hacc"].max() < 75   # good fixes, with the odd poor one for rule G1 to drop


def test_every_timestamp_carries_the_export_offset():
    winter = datetime(2024, 1, 15, 8, 0, tzinfo=TZ)      # MST, -0700 on the day
    assert ts(winter).endswith(datetime.now(XOFF).strftime("%z"))  # but written with the export's offset
    assert ts(winter) == "2024-01-15 09:00:00 -0600"
