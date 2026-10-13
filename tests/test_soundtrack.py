"""The video soundtrack: deterministic, the length asked for, never clipping, silent only where it should be."""
import numpy as np

from stride.soundtrack import SR, render


def test_soundtrack_is_deterministic_and_fits_the_video():
    kw = dict(bpm=128, bars=8, drop=2, outro=6, lead=0.5, length=16.0, accents=[4])
    a, b = render(**kw), render(**kw)
    assert a.shape == (2, int(16.0 * SR))
    assert np.array_equal(a, b)
    assert np.isfinite(a).all() and np.abs(a).max() <= 10 ** (-0.9 / 20)


def test_music_starts_on_the_tours_first_bar():
    x = render(bpm=128, bars=8, drop=2, outro=6, lead=0.5, length=16.0, accents=[])
    lead = np.abs(x[:, : int(0.49 * SR)]).max()
    first_bar = np.abs(x[:, int(0.5 * SR): int(1.0 * SR)]).max()
    assert lead < 1e-3 < first_bar
