"""Paths, config and the shared DuckDB connection."""
from __future__ import annotations

import json
import os
import time
import unicodedata
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
# STRIDE_DATA moves the whole working folder (raw export, cache, database); `make demo` uses demo-data/
DATA = Path(os.environ.get("STRIDE_DATA", ROOT / "data"))
if not DATA.is_absolute():
    DATA = ROOT / DATA
RAW = DATA / "raw"
EXPORT_DIR = RAW / "apple_health_export"
CACHE = DATA / "cache"
REPORTS = Path(os.environ.get("STRIDE_REPORTS", ROOT / "reports"))
APP_DATA = Path(os.environ.get("STRIDE_APP_DATA", ROOT / "app" / "public" / "data"))
DB_PATH = DATA / "stride.duckdb"


def export_xml() -> Path:
    return Path(os.environ.get("STRIDE_EXPORT_DIR", EXPORT_DIR)) / "export.xml"


def export_dir() -> Path:
    return Path(os.environ.get("STRIDE_EXPORT_DIR", EXPORT_DIR))


def db_path() -> Path:
    return Path(os.environ.get("STRIDE_DB", DB_PATH))


_CFG = None


def config() -> dict:
    global _CFG
    if _CFG is None:
        p = Path(os.environ["STRIDE_CONFIG"]) if os.environ.get("STRIDE_CONFIG") else ROOT / "config.yaml"
        if not p.is_absolute():
            p = ROOT / p
        if not p.exists():
            p = ROOT / "config.example.yaml"
        _CFG = yaml.safe_load(p.read_text())
    return _CFG


def connect(read_only: bool = False):
    import duckdb

    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(p), read_only=read_only)
    con.execute("SET TimeZone='UTC'")
    con.execute("SET preserve_insertion_order=true")
    return con


_CTRL = dict.fromkeys(c for c in range(32) if c not in (9,))


def norm(s: str | None) -> str | None:
    """NFC-normalize and strip control characters (source names, keys)."""
    if s is None:
        return None
    return unicodedata.normalize("NFC", s).translate(_CTRL).strip()


class Timer:
    def __init__(self, label: str):
        self.label = label

    def __enter__(self):
        self.t0 = time.time()
        print(f"[{self.label}] ...", flush=True)
        return self

    def __exit__(self, *a):
        print(f"[{self.label}] done in {time.time() - self.t0:.1f}s", flush=True)


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, sort_keys=True, default=str))
