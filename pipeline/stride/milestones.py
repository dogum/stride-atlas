"""Life milestones: the dates that explain the data (a child born, working from home, a new commute, an injury),
drawn faintly on every chart with a time axis. They live in data/milestones.yaml, next to the export and never
committed; milestones.example.yaml shows the format. The app's editor (make dev) writes the same file through this
module, so YAML is only ever read and written here.

    python -m stride.milestones            # print data/milestones.yaml as JSON (make export writes the app's copy)
    python -m stride.milestones --write    # read a JSON list on stdin, write data/milestones.yaml and the JSON
"""
from __future__ import annotations

import json
import re
import sys

import yaml

from . import paths

KINDS = ("family", "work", "home", "health", "travel", "other")
HEADER = """# Life milestones for Stride Atlas: drawn faintly on every chart with a time axis.
# One entry per milestone. date: 2021-08-14 (or 2021-08 for a month). end: for a period (working from home, an injury).
# kind: family, work, home, health, travel or other. public: true keeps the label visible in share mode.
# This file stays on your computer (data/ is never committed). The app's Milestones panel edits it too.
"""


def _date(v) -> tuple[str, str] | None:
    """2021-08-14, or 2021-08 for a month (placed on the 1st and marked approximate)."""
    if v is None or v == "":
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()[:10], "day"
    m = re.fullmatch(r"(\d{4})-(\d{1,2})(?:-(\d{1,2}))?", str(v).strip())
    if not m or not (1 <= int(m[2]) <= 12) or (m[3] and not 1 <= int(m[3]) <= 31):
        return None
    return f"{int(m[1]):04d}-{int(m[2]):02d}-{int(m[3] or 1):02d}", "day" if m[3] else "month"


def normalise(raw) -> list[dict]:
    out: list[dict] = []
    for i, e in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(e, dict) or not str(e.get("label") or "").strip():
            continue
        d = _date(e.get("date"))
        if not d:
            print(f"milestones: entry {i + 1} ({e.get('label')!r}) has no usable date, skipped", file=sys.stderr)
            continue
        m = {"date": d[0], "precision": d[1], "label": str(e["label"]).strip()[:120],
             "kind": e.get("kind") if e.get("kind") in KINDS else "other", "public": bool(e.get("public", False))}
        end = _date(e.get("end"))
        if end and end[0] > d[0]:
            m["end"] = end[0]
        out.append(m)
    out.sort(key=lambda m: (m["date"], m["label"]))
    for i, m in enumerate(out):
        m["id"] = i
    return out


def load() -> list[dict]:
    src = paths.DATA / "milestones.yaml"
    return normalise(yaml.safe_load(src.read_text()) or []) if src.exists() else []


def write_json(items: list[dict]) -> None:
    paths.APP_DATA.mkdir(parents=True, exist_ok=True)
    (paths.APP_DATA / "milestones.json").write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_yaml(items: list[dict]) -> None:
    rows = []
    for m in items:
        r = {"date": m["date"] if m.get("precision") != "month" else m["date"][:7]}
        if m.get("end"):
            r["end"] = m["end"]
        r.update(label=m["label"], kind=m["kind"])
        if m.get("public"):
            r["public"] = True
        rows.append(r)
    paths.DATA.mkdir(parents=True, exist_ok=True)
    (paths.DATA / "milestones.yaml").write_text(HEADER + "\n" + (yaml.safe_dump(rows, sort_keys=False, allow_unicode=True, width=120) if rows else "[]\n"))


def main() -> None:
    if "--write" in sys.argv:
        items = normalise(json.loads(sys.stdin.read() or "[]"))
        write_yaml(items)
        write_json(items)
    else:
        items = load()   # reading never writes
    print(json.dumps(items, ensure_ascii=False))


if __name__ == "__main__":
    main()
