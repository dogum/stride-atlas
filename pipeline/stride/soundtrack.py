"""An original soundtrack for the video tour, synthesised from scratch so there is nothing to license.

House-tempo electronic bed in A minor (Am – F – C – G), written to the tour's own timeline: a filtered build under the
opening replay, the drop on the bar the first caption lands, a crash every eight bars and on accented sections, and an
outro that resolves under the end card. scripts/record.mjs calls it with the bars the page reported:

    uv run python -m stride.soundtrack --bpm 128 --bars 37 --drop 2 --outro 34 --lead 0.52 --length 70.3 --out x.wav

Everything is deterministic (fixed seed), 44.1 kHz stereo, peak-limited; record.mjs normalises loudness when it muxes.
"""
from __future__ import annotations

import argparse
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, lfilter, sosfilt

SR = 44100
RNG = np.random.default_rng(128)
# Am, F, C, G: pad voicings, bass roots and arpeggio tones (MIDI)
PROG = [
    {"pad": [57, 60, 64, 71], "bass": 45, "arp": [69, 72, 76, 79]},   # Am(add9)
    {"pad": [53, 57, 60, 64], "bass": 41, "arp": [65, 69, 72, 76]},   # Fmaj7
    {"pad": [55, 60, 64, 67], "bass": 48, "arp": [67, 72, 76, 79]},   # C
    {"pad": [55, 59, 62, 67], "bass": 43, "arp": [67, 71, 74, 79]},   # G
]
ARP = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 0]   # sixteenths through the four chord tones
HOOK = [(0, 3, 2), (2, 2, 1), (3, 1, 2), (5, 2, 1), (6, 0, 2)]  # (eighth, tone, eighths long): a short motif, every other phrase


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def saw(f: float, n: int, phase: float = 0.0) -> np.ndarray:
    """Band-limited sawtooth (PolyBLEP)."""
    dt = f / SR
    ph = (phase + dt * np.arange(n)) % 1.0
    y = 2 * ph - 1
    a = ph < dt
    t = ph[a] / dt
    y[a] -= t + t - t * t - 1
    b = ph > 1 - dt
    t = (ph[b] - 1) / dt
    y[b] -= t * t + t + t + 1
    return y


def lp(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, min(fc, SR * 0.45) / (SR / 2), output="sos"), x)


def hp(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, fc / (SR / 2), "high", output="sos"), x)


def bp(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return sosfilt(butter(2, [lo / (SR / 2), min(hi, SR * 0.45) / (SR / 2)], "band", output="sos"), x)


def tail(x: np.ndarray, ms: float = 12) -> np.ndarray:
    """Fade the last few milliseconds of a note to zero, so nothing ends in a click."""
    k = min(int(ms / 1000 * SR), len(x) // 2)
    if k < 2:
        return x
    x = x.copy()
    x[-k:] *= np.linspace(1, 0, k)
    return x


def env_adsr(n: int, a: float, d: float, s: float, r: float, hold: int) -> np.ndarray:
    """Attack, decay to sustain until `hold` samples, then release; all times in seconds."""
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = np.arange(n) >= hold
    if rel.any():
        e[rel] = e[hold - 1 if hold > 0 else 0] * np.exp(-(np.arange(rel.sum())) / SR / max(r, 1e-4))
    return e


# ------------------------------------------------------------------ drums
def kick() -> np.ndarray:
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 44 + 120 * np.exp(-t * 30) + 60 * np.exp(-t * 120)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5)
    y += 0.35 * lp(RNG.standard_normal(n), 4000) * np.exp(-t * 400)
    return np.tanh(1.8 * y) * 0.95


def clap() -> np.ndarray:
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    noise = bp(RNG.standard_normal(n), 900, 3200)
    e = np.zeros(n)
    for k, off in enumerate((0.0, 0.010, 0.021)):
        m = t >= off
        e[m] += np.exp(-(t[m] - off) * (160 if k < 2 else 13)) * (0.7 if k < 2 else 1.0)
    return noise * e * 0.9


def snare() -> np.ndarray:
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t * 28)
    return 0.5 * body + 0.7 * bp(RNG.standard_normal(n), 1500, 9000) * np.exp(-t * 24)


def hat(open_: bool = False) -> np.ndarray:
    n = int((0.32 if open_ else 0.07) * SR)
    t = np.arange(n) / SR
    return hp(RNG.standard_normal(n), 7500, 4) * np.exp(-t * (11 if open_ else 75))


def crash() -> np.ndarray:
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    x = hp(RNG.standard_normal(n), 3800, 2) * np.exp(-t * 1.9)
    return x + 0.4 * bp(RNG.standard_normal(n), 2500, 6000) * np.exp(-t * 4)


def subdrop() -> np.ndarray:
    n = int(1.1 * SR)
    t = np.arange(n) / SR
    f = 32 + 70 * np.exp(-t * 4)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3.2)


# ------------------------------------------------------------------ voices
def bass_note(m: int, dur: float) -> np.ndarray:
    n = int((dur + 0.03) * SR)
    f = hz(m)
    y = 0.75 * lp(saw(f, n), 650) + 0.55 * np.sin(2 * np.pi * (f / 2) * np.arange(n) / SR)
    return y * env_adsr(n, 0.003, 0.12, 0.65, 0.02, int(dur * SR))


def pad_chord(notes: list[int], dur: float) -> tuple[np.ndarray, np.ndarray]:
    n = int((dur + 0.5) * SR)
    L, R = np.zeros(n), np.zeros(n)
    for k, m in enumerate(notes):
        for j, cents in enumerate((-9, 0, 9)):
            v = saw(hz(m) * 2 ** (cents / 1200), n, phase=RNG.random())
            pan = (-0.65, 0.0, 0.65)[j] * (1 if k % 2 else -1)
            L += v * (1 - pan) / 2
            R += v * (1 + pan) / 2
    e = env_adsr(n, 0.22, 0.6, 0.8, 0.28, int(dur * SR))
    return lp(L, 2300) * e / len(notes), lp(R, 2300) * e / len(notes)


def pluck(m: int, dur: float = 0.2) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = saw(hz(m), n)
    sq = s - saw(hz(m), n, phase=0.5)
    x = 0.6 * s + 0.3 * sq
    bright, dark = lp(x, 6500), lp(x, 1100)
    k = np.exp(-t * 26)
    return (bright * k + dark * (1 - k)) * np.exp(-t * 13) * np.clip(t / 0.002, 0, 1)


def lead_note(m: int, dur: float) -> np.ndarray:
    n = int((dur + 0.12) * SR)
    t = np.arange(n) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.12) * 4, 0, 1)
    ph = np.cumsum(hz(m) * vib) / SR
    y = 0.6 * np.sin(2 * np.pi * ph) + 0.25 * np.sin(4 * np.pi * ph) + 0.12 * lp(saw(hz(m), n), 3000)
    return y * env_adsr(n, 0.012, 0.25, 0.7, 0.09, int(dur * SR))


def reverb_ir(secs: float = 2.2) -> tuple[np.ndarray, np.ndarray]:
    n = int(secs * SR)
    t = np.arange(n) / SR
    d = np.exp(-t / 0.33)
    L, R = lp(RNG.standard_normal(n), 5500) * d, lp(RNG.standard_normal(n), 5500) * d
    pre = int(0.018 * SR)
    L[:pre] = 0
    R[:pre] = 0
    return L / np.sqrt((L ** 2).sum()), R / np.sqrt((R ** 2).sum())


# ------------------------------------------------------------------ arrangement
def render(bpm: float, bars: int, drop: int, outro: int, lead: float, length: float, accents: list[int]) -> np.ndarray:
    global RNG
    RNG = np.random.default_rng(128)  # the same noise every time: the same file for the same timeline
    beat = 60 / bpm
    bar = 4 * beat
    total = max(length, lead + bars * bar) + 0.05
    n = int(total * SR)
    bus = {k: np.zeros((2, n)) for k in ("drums", "bass", "pad", "arp", "fx", "verb")}

    def put(name: str, x, t: float, gain: float = 1.0, pan: float = 0.0, send: float = 0.0):
        i = int(round((lead + t) * SR))
        if i >= n or i < 0:
            return
        if isinstance(x, tuple):
            L, R = tail(x[0]), tail(x[1])
        else:
            x = tail(x)
            L, R = x * (1 - pan) / 2 * 2 ** 0.5, x * (1 + pan) / 2 * 2 ** 0.5
        m = min(len(L), n - i)
        bus[name][0, i:i + m] += L[:m] * gain
        bus[name][1, i:i + m] += R[:m] * gain
        if send:
            bus["verb"][0, i:i + m] += L[:m] * gain * send
            bus["verb"][1, i:i + m] += R[:m] * gain * send

    K, CL, SN, CH, OH, CR, SUB = kick(), clap(), snare(), hat(), hat(True), crash(), subdrop()
    kicks: list[float] = []
    main = range(drop, outro)
    for b in range(bars):
        t0 = b * bar
        ch = PROG[b % 4] if b < outro else PROG[0]
        intro = b < drop
        # drums
        if b < outro:
            for q in range(4):
                put("drums", K, t0 + q * beat, 0.62 if intro else 1.0)
                kicks.append(t0 + q * beat)
            if not intro:
                for q in (1, 3):
                    put("drums", CL, t0 + q * beat, 0.5, send=0.22)
                for e in range(8):
                    if e % 2:
                        put("drums", OH, t0 + e * beat / 2, 0.09, pan=0.25)
                for s in range(16):
                    if s % 4:
                        put("drums", CH, t0 + s * beat / 4, 0.045 + 0.025 * (s % 2 == 0), pan=-0.3)
            phrase_end = (not intro) and (b - drop) % 8 == 7 and b + 1 < outro
            if b == drop - 1 or phrase_end:   # a roll into the drop and into every phrase
                start = 0 if b == drop - 1 else 12
                for s in range(start, 16):
                    put("drums", SN, t0 + s * beat / 4, 0.12 + 0.3 * (s - start) / (16 - start), send=0.15)
        if b == outro:
            put("drums", K, t0, 1.0)
        if (b in main and (b - drop) % 8 == 0) or b in accents or b == outro:
            put("fx", CR, t0, 0.24, send=0.2)
            put("fx", SUB, t0, 0.5 if b in (drop, outro) else 0.3)
        # bass: off-beat eighths, a gallop on the last beat of each bar
        if drop <= b < outro:
            for e in range(8):
                if e % 2:
                    put("bass", bass_note(ch["bass"], beat * 0.42), t0 + e * beat / 2, 0.36)
            put("bass", bass_note(ch["bass"] + 12, beat * 0.2), t0 + 3.75 * beat, 0.22)
        # pad: every bar, longer in the outro
        dur = bar * (bars - outro) if b == outro else bar
        if b <= outro:
            put("pad", pad_chord(ch["pad"], dur), t0, 0.5 if b >= drop else 0.42, send=0.35)
        # arpeggio, and a short hook every other phrase
        if b < outro or b < outro + 2:
            fade = 1.0 if b < outro else (0.6 if b == outro else 0.3)
            for s in range(16):
                m = ch["arp"][ARP[s]] + (12 if (b >= drop and (b - drop) % 8 >= 4 and s % 8 == 7) else 0)
                put("arp", pluck(m), t0 + s * beat / 4, 0.16 * fade, pan=(0.35 if s % 2 else -0.35), send=0.3)
        if b in main and (b - drop) % 16 >= 8:
            for e, tone, ln in HOOK:
                put("arp", lead_note(ch["arp"][tone] + 12, ln * beat / 2), t0 + e * beat / 2, 0.075, send=0.4)
    # riser into the drop
    if drop > 0:
        t0 = max(0, drop - 1.5) * bar
        m = int((drop * bar - t0) * SR)
        x = RNG.standard_normal(m)
        k = np.linspace(0, 1, m)
        chunks = np.array_split(np.arange(m), 48)
        y = np.zeros(m)
        for j, idx in enumerate(chunks):
            fc = 300 * (6000 / 300) ** (j / (len(chunks) - 1))
            y[idx] = bp(x[max(0, idx[0] - 2000):idx[-1] + 1], fc * 0.6, fc * 1.6)[-len(idx):]
        put("fx", y * k ** 2.2, t0, 0.32, send=0.25)

    # sidechain from the kick, on the tonal busses
    sc = np.ones(n)
    for kt in kicks:
        i = int(round((lead + kt) * SR))
        m = min(int(0.4 * SR), n - i)
        if m <= 0:
            continue
        t = np.arange(m) / SR
        sc[i:i + m] = np.minimum(sc[i:i + m], 1 - 0.6 * np.exp(-t / 0.085) * np.clip(t / 0.004, 0, 1) ** 0.5)
    for k in ("bass", "pad", "arp"):
        bus[k] *= sc
    # the arpeggio echoes on a dotted eighth, ping-pong
    d = int(0.75 * beat * SR)
    mono = bus["arp"].mean(axis=0)
    for tap in range(1, 4):
        bus["arp"][tap % 2, d * tap:] += mono[:n - d * tap] * 0.33 ** tap
    IL, IR = reverb_ir()
    wet = np.vstack([fftconvolve(bus["verb"][0], IL)[:n], fftconvolve(bus["verb"][1], IR)[:n]])
    mix = bus["drums"] + bus["bass"] * 0.9 + bus["pad"] * 0.85 + bus["arp"] * 1.05 + wet * 0.55
    # the build: everything before the drop is low-passed, opening up to the drop (the riser stays bright)
    e = int(round((lead + drop * bar) * SR)) if drop > 0 else 0
    if e > 0:
        idxs = np.array_split(np.arange(e), 64)
        zi = np.zeros((2, 2))
        for j, idx in enumerate(idxs):
            fc = 350 * (16000 / 350) ** ((j / (len(idxs) - 1)) ** 2)
            b_, a_ = butter(2, min(fc, SR * 0.45) / (SR / 2))
            for c in range(2):
                mix[c, idx], zi[c] = lfilter(b_, a_, mix[c, idx], zi=zi[c])
    mix = mix + bus["fx"]
    mix = np.vstack([hp(mix[0], 28), hp(mix[1], 28)])
    # fades: in over the first frames, out under the last second
    fi = int(0.02 * SR)
    mix[:, :fi] *= np.linspace(0, 1, fi)
    fo = int(1.4 * SR)
    end = int(length * SR) if length else n
    mix = mix[:, :end]
    mix[:, -fo:] *= np.linspace(1, 0, min(fo, mix.shape[1])) ** 1.5
    peak = np.abs(mix).max() or 1
    mix = np.tanh(1.3 * mix / peak) / np.tanh(1.3)       # gentle saturation as a limiter
    return (mix * 10 ** (-1.0 / 20)).astype(np.float32)


def write_wav(path: str, x: np.ndarray) -> None:
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").T.copy()
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--bpm", type=float, default=128)
    ap.add_argument("--bars", type=int, default=36)
    ap.add_argument("--drop", type=int, default=2)
    ap.add_argument("--outro", type=int, default=33)
    ap.add_argument("--lead", type=float, default=0.0, help="seconds of video before the tour's first bar")
    ap.add_argument("--length", type=float, default=0.0, help="total length in seconds (the video's)")
    ap.add_argument("--accents", default="", help="comma-separated bars that get a crash")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    acc = [int(v) for v in a.accents.split(",") if v.strip()]
    x = render(a.bpm, a.bars, a.drop, a.outro, a.lead, a.length, acc)
    write_wav(a.out, x)
    print(f"{a.out}: {x.shape[1] / SR:.1f} s, {a.bpm:g} BPM, {a.bars} bars, drop at bar {a.drop}, outro at bar {a.outro}")


if __name__ == "__main__":
    main()
