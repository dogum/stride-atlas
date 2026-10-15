"""Unit normalization: SI inside (meters, seconds, °C, m/s, kg), imperial only at display time.

Energy stays in kcal (the unit every Health screen and every formula here uses);
heart-rate variability and ground-contact time stay in ms.
"""
from __future__ import annotations

import re

# unit -> (si_unit, scale, offset)  value_si = value * scale + offset
CONVERT: dict[str, tuple[str, float, float]] = {
    "m": ("m", 1.0, 0.0),
    "km": ("m", 1000.0, 0.0),
    "mi": ("m", 1609.344, 0.0),
    "ft": ("m", 0.3048, 0.0),
    "yd": ("m", 0.9144, 0.0),
    "in": ("m", 0.0254, 0.0),
    "cm": ("m", 0.01, 0.0),
    "mm": ("m", 0.001, 0.0),
    "s": ("s", 1.0, 0.0),
    "min": ("s", 60.0, 0.0),
    "hr": ("s", 3600.0, 0.0),
    "h": ("s", 3600.0, 0.0),
    "ms": ("ms", 1.0, 0.0),
    "kcal": ("kcal", 1.0, 0.0),
    "Cal": ("kcal", 1.0, 0.0),
    "cal": ("kcal", 0.001, 0.0),
    "kJ": ("kcal", 1 / 4.184, 0.0),
    "J": ("kcal", 1 / 4184.0, 0.0),
    "degC": ("degC", 1.0, 0.0),
    "degF": ("degC", 5 / 9, -32 * 5 / 9),
    "K": ("degC", 1.0, -273.15),
    "m/s": ("m/s", 1.0, 0.0),
    "mi/hr": ("m/s", 0.44704, 0.0),
    "km/hr": ("m/s", 1 / 3.6, 0.0),
    "ft/s": ("m/s", 0.3048, 0.0),
    "lb": ("kg", 0.45359237, 0.0),
    "kg": ("kg", 1.0, 0.0),
    "g": ("kg", 0.001, 0.0),
}

NUM_UNIT = re.compile(r"^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(.*?)\s*$")


def to_si(value: float | None, unit: str | None) -> tuple[float | None, str | None]:
    if value is None:
        return None, unit
    c = CONVERT.get(unit or "")
    if c is None:
        return value, unit
    si, k, off = c
    return value * k + off, si


def parse_num_unit(s: str | None) -> tuple[float | None, str | None]:
    """'64.4 degF' -> (64.4, 'degF'); '7400 %' -> (7400.0, '%'); 'America/New_York' -> (None, None)."""
    if s is None:
        return None, None
    m = NUM_UNIT.match(s)
    if not m:
        return None, None
    try:
        return float(m.group(1)), (m.group(2) or None)
    except ValueError:
        return None, None


def sql_case(value_col: str, unit_col: str) -> tuple[str, str]:
    """SQL expressions that convert (value, unit) columns to SI inside DuckDB."""
    vs = [f"WHEN {unit_col} = '{u}' THEN {value_col} * {k!r} + {off!r}" for u, (si, k, off) in CONVERT.items()]
    us = [f"WHEN {unit_col} = '{u}' THEN '{si}'" for u, (si, k, off) in CONVERT.items()]
    v = "CASE " + " ".join(vs) + f" ELSE {value_col} END"
    u = "CASE " + " ".join(us) + f" ELSE {unit_col} END"
    return v, u
