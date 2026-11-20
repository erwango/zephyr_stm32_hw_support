#!/usr/bin/env python3
"""Rebuild data/manifest.json from the generated per-ref JSON files in data/.

The manifest lists available refs for the static site's ref selector, sorted
with "main" first, then stable releases newest-first.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def sort_key(ref: str) -> tuple:
    if ref == "main":
        return (0,)
    match = re.match(r"v(\d+)\.(\d+)\.(\d+)$", ref)
    if match:
        major, minor, patch = (int(g) for g in match.groups())
        return (1, -major, -minor, -patch)
    return (2, ref)


def main() -> int:
    entries = []
    for path in sorted(DATA_DIR.glob("*.json")):
        if path.name == "manifest.json":
            continue
        data = json.loads(path.read_text())
        entries.append(
            {
                "ref": data["ref"],
                "file": path.name,
                "zephyr_commit": data["zephyr_commit"],
                "generated_at": data["generated_at"],
            }
        )
    entries.sort(key=lambda e: sort_key(e["ref"]))
    manifest_path = DATA_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(entries, indent=2) + "\n")
    print(f"wrote {manifest_path} with {len(entries)} entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
