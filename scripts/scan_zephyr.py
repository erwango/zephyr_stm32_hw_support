#!/usr/bin/env python3
"""Scan a Zephyr RTOS checkout for upstream STM32 hardware/API support.

For every STM32-specific devicetree binding (``dts/bindings/*/st,stm32*.yaml``)
this records, per STM32 series, whether the HW block is declared in that
series' devicetree (``dts/arm/st/<series>/*.dtsi``). Devicetree is treated as
the source of truth: a compatible node is only ever upstreamed together with
its driver, so a node being present in the devicetree is taken to mean the
peripheral is supported, without separately trying to match a driver source
file (that matching is unreliable for several subsystems, e.g. RCC/pinctrl,
where many compatibles are handled by family-wide driver files rather than
the common one-compatible-per-``DT_DRV_COMPAT`` convention).

When a driver file can be matched via the ``DT_DRV_COMPAT`` macro convention,
its path is still recorded for convenience (used by the site to link out to
the driver source), but it has no effect on the reported support status.

``clock`` and ``pinctrl`` bindings are mandatory baseline requirements for any
upstream SoC port, so they are reported as metadata only and excluded from
the per-series coverage grid.

The result is written as a single JSON document. See README for the schema.

This script never mutates the given --zephyr-path checkout: use --mode
worktree (default) to scan any ref via a temporary, isolated git worktree, or
--mode inplace when --zephyr-path is already a disposable clone checked out
at --ref (e.g. in CI).

Note: this script does not fetch or clone anything itself. --ref must already
be resolvable in --zephyr-path (run `git fetch`/`git clone` beforehand).
"""
from __future__ import annotations

import argparse
import contextlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

import yaml

# Binding category directory (dts/bindings/<CATEGORY>/) -> catalog group.
# Any category not listed here is bucketed into "other" and reported as a
# warning so the mapping can be kept up to date as zephyr evolves.
CATEGORY_GROUPS: dict[str, str] = {
    # base
    "power": "base",
    "reset": "base",
    "interrupt-controller": "base",
    "gpio": "base",
    "misc": "base",
    "clock": "base",
    "pinctrl": "base",
    "dma": "base",
    "regulator": "base",
    # system
    "timer": "system",
    "counter": "system",
    "rtc": "system",
    "watchdog": "system",
    "rng": "system",
    "crypto": "system",
    "crc": "system",
    "otp": "system",
    "pwm": "system",
    # communication
    "usb": "communication",
    "can": "communication",
    "i2c": "communication",
    "i3c": "communication",
    "spi": "communication",
    "serial": "communication",
    "smbus": "communication",
    "i2s": "communication",
    "ieee802154": "communication",
    "bluetooth": "communication",
    "modem": "communication",
    "wifi": "communication",
    "lora": "communication",
    "phy": "communication",
    "tcpc": "communication",
    "ipm": "communication",
    "mbox": "communication",
    "net": "communication",
    "ethernet": "communication",
    "input": "communication",
    # storage
    "flash_controller": "storage",
    "mtd": "storage",
    "memory-controllers": "storage",
    "ospi": "storage",
    "qspi": "storage",
    "xspi": "storage",
    "mspi": "storage",
    "sdhc": "storage",
    "arm": "storage",
    # analog / mixed-signal
    "adc": "analog",
    "dac": "analog",
    "comparator": "analog",
    "opamp": "analog",
    # multimedia
    "audio": "multimedia",
    "display": "multimedia",
    "video": "multimedia",
    "mipi-dbi": "multimedia",
    "mipi-dsi": "multimedia",
    # sensor (kept as its own group: ~100+ bindings)
    "sensor": "sensor",
}

# Categories that are mandatory baseline requirements for any upstream SoC
# port. Driver-presence detection is skipped for these (metadata only).
BASELINE_CATEGORIES = {"clock", "pinctrl"}

COMPATIBLE_RE = re.compile(r'compatible\s*=\s*"([^"]+)"')
CORE_RE = re.compile(r'compatible\s*=\s*"arm,cortex-([am]\d[0-9a-z+]*)"')
DT_DRV_COMPAT_RE = re.compile(r"DT_DRV_COMPAT\s+(\w+)")


def run_git(args: list[str], cwd: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


@contextlib.contextmanager
def checkout_ref(zephyr_path: Path, ref: str, mode: str) -> Iterator[Path]:
    """Yield a directory tree checked out at *ref*.

    mode="inplace" trusts *zephyr_path* to already be checked out at *ref*
    (used in CI with a disposable clone). mode="worktree" creates a temporary
    detached git worktree so a persistent/shared checkout is never modified.
    """
    if mode == "inplace":
        yield zephyr_path
        return

    tmp_dir = Path(tempfile.mkdtemp(prefix="stm32-hw-scan-"))
    worktree_dir = tmp_dir / "worktree"
    try:
        run_git(["worktree", "add", "--detach", str(worktree_dir), ref], zephyr_path)
        yield worktree_dir
    finally:
        run_git(["worktree", "remove", "--force", str(worktree_dir)], zephyr_path)
        shutil.rmtree(tmp_dir, ignore_errors=True)


def dts_dir_for_series(series: str) -> str:
    """Map a soc.yml series name (e.g. "stm32h7px") to its dts/arm/st
    sub-directory (e.g. "h7p")."""
    name = series.removeprefix("stm32")
    return name[:-1] if name.endswith("x") else name


def load_series_catalog(zephyr_root: Path) -> list[dict]:
    soc_yml = zephyr_root / "soc" / "st" / "stm32" / "soc.yml"
    data = yaml.safe_load(soc_yml.read_text())
    stm32_family = next(f for f in data.get("family", []) if f.get("name") == "stm32")
    return [
        {"name": s["name"], "socs": [soc["name"] for soc in s.get("socs", [])]}
        for s in stm32_family.get("series", [])
    ]


def scan_series_dts(zephyr_root: Path, dts_dir: str) -> tuple[set[str], set[str]]:
    """Return (declared_compatibles, core_names) for dts/arm/st/<dts_dir>."""
    base = zephyr_root / "dts" / "arm" / "st" / dts_dir
    compatibles: set[str] = set()
    cores: set[str] = set()
    if not base.is_dir():
        return compatibles, cores
    for dtsi in base.rglob("*.dtsi"):
        text = dtsi.read_text(errors="ignore")
        compatibles.update(m for m in COMPATIBLE_RE.findall(text) if m.startswith("st,stm32"))
        cores.update(CORE_RE.findall(text))
    return compatibles, cores


def discover_bindings(zephyr_root: Path) -> list[dict]:
    bindings_root = zephyr_root / "dts" / "bindings"
    entries = []
    for yaml_path in sorted(bindings_root.glob("*/st,stm32*.yaml")):
        try:
            doc = yaml.safe_load(yaml_path.read_text())
        except yaml.YAMLError:
            continue
        compatible = doc.get("compatible") if doc else None
        if not isinstance(compatible, str):
            continue
        entries.append(
            {
                "category": yaml_path.parent.name,
                "compatible": compatible,
                "title": (doc.get("title") or "").strip(),
                "binding_path": str(yaml_path.relative_to(zephyr_root)),
            }
        )
    return entries


def compatible_to_macro(compatible: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", compatible.lower())


def build_driver_index(zephyr_root: Path) -> dict[str, list[str]]:
    """Map DT_DRV_COMPAT macro -> driver source files declaring it."""
    index: dict[str, list[str]] = {}
    drivers_root = zephyr_root / "drivers"
    for src in drivers_root.rglob("*.c"):
        text = src.read_text(errors="ignore")
        for macro in DT_DRV_COMPAT_RE.findall(text):
            index.setdefault(macro, []).append(str(src.relative_to(zephyr_root)))
    return index


def build_report(zephyr_root: Path, ref: str) -> dict:
    commit = run_git(["rev-parse", "HEAD"], zephyr_root)
    series_catalog = load_series_catalog(zephyr_root)

    series_out = []
    declared_by_series: dict[str, set[str]] = {}
    for entry in series_catalog:
        name = entry["name"]
        compatibles, cores = scan_series_dts(zephyr_root, dts_dir_for_series(name))
        declared_by_series[name] = compatibles
        series_out.append({"name": name, "cores": sorted(cores), "socs": entry["socs"]})
    series_out.sort(key=lambda s: s["name"])

    driver_index = build_driver_index(zephyr_root)
    bindings = discover_bindings(zephyr_root)

    categories: dict[tuple[str, str], dict] = {}
    unmapped_categories: set[str] = set()
    for binding in bindings:
        category = binding["category"]
        group = CATEGORY_GROUPS.get(category)
        if group is None:
            group = "other"
            unmapped_categories.add(category)
        baseline = category in BASELINE_CATEGORIES

        cat_entry = categories.setdefault(
            (group, category),
            {"group": group, "name": category, "baseline": baseline, "apis": []},
        )

        api_entry = {
            "compatible": binding["compatible"],
            "title": binding["title"],
            "binding_path": binding["binding_path"],
        }

        if not baseline:
            macro = compatible_to_macro(binding["compatible"])
            driver_paths = driver_index.get(macro, [])
            series_support = {}
            for s in series_out:
                declared = binding["compatible"] in declared_by_series.get(s["name"], set())
                series_support[s["name"]] = "supported" if declared else "absent"
            api_entry["driver_paths"] = driver_paths
            api_entry["series_support"] = series_support

        cat_entry["apis"].append(api_entry)

    if unmapped_categories:
        print(
            f"warning: unmapped binding categories bucketed as 'other': "
            f"{sorted(unmapped_categories)}",
            file=sys.stderr,
        )

    categories_out = sorted(categories.values(), key=lambda c: (c["group"], c["name"]))
    for cat in categories_out:
        cat["apis"].sort(key=lambda a: a["compatible"])

    return {
        "ref": ref,
        "zephyr_commit": commit,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "series": series_out,
        "categories": categories_out,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zephyr-path", required=True, type=Path, help="Path to a local zephyr git checkout.")
    parser.add_argument("--ref", required=True, help="Git ref to scan (branch, tag, or commit). Must already be resolvable in --zephyr-path.")
    parser.add_argument("--output", required=True, type=Path, help="Output JSON file path.")
    parser.add_argument(
        "--mode",
        choices=["worktree", "inplace"],
        default="worktree",
        help="worktree (default): isolate via a temporary git worktree, safe for a "
        "shared/persistent checkout. inplace: scan --zephyr-path directly, assuming "
        "it is already checked out at --ref (used in CI with a disposable clone).",
    )
    args = parser.parse_args(argv)

    with checkout_ref(args.zephyr_path, args.ref, args.mode) as root:
        report = build_report(root, args.ref)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"wrote {args.output} ({len(report['categories'])} categories, {len(report['series'])} series)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
