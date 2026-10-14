"""Clean-room reproducibility check for Phase 6.

Rebuilds parse → strava → clean → enrich → osm → derive → export from data/raw into a scratch database and a scratch
output folder (reusing only the on-disk HTTP cache, as a refresh would), then compares the SHA-256 of
every Parquet file, route buffer and stream file with the live build in app/public/data. The clean
build's hashes become data/export_hashes.reference.json, which `make validate` checks against.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import paths


def digest(root: Path) -> dict[str, str]:
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix in (".parquet", ".bin", ".json"):
            out[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def main() -> None:
    scratch = Path(tempfile.mkdtemp(prefix="stride-clean-", dir=os.environ.get("TMPDIR")))
    env = dict(os.environ, STRIDE_DB=str(scratch / "stride.duckdb"), STRIDE_APP_DATA=str(scratch / "app_data"), STRIDE_REPORTS=str(scratch / "reports"))
    steps = [["parse", "--force"], ["strava", "--force"], ["clean"], ["enrich"], ["osm"], ["derive"], ["sleep"], ["export"]]
    try:
        for s in steps:
            print(f"clean-room: {s[0]}", flush=True)
            r = subprocess.run([sys.executable, "-m", f"stride.{s[0]}", *s[1:]], cwd=paths.ROOT, env=env, capture_output=True, text=True)
            if r.returncode:
                print(r.stdout[-2000:], r.stderr[-2000:])
                raise SystemExit(f"clean-room {s[0]} failed")
        a, b = digest(scratch / "app_data"), digest(paths.APP_DATA)
        diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
        (paths.DATA / "export_hashes.reference.json").write_text(json.dumps({k: v for k, v in a.items() if not k.startswith("streams/")}, indent=1, sort_keys=True))
        print(f"compared {len(a)} files: {'identical' if not diff else str(len(diff)) + ' differ: ' + ', '.join(diff[:20])}")
        if diff:
            raise SystemExit(1)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
