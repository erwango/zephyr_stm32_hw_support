#!/usr/bin/env python3
"""Discover STM32 on-chip IP presence per series from a hal_stm32 checkout.

This answers a narrower question than scan_zephyr.py: for a given STM32
series, which STM32Cube peripheral IPs does the silicon actually have,
independent of whether Zephyr has upstreamed a binding/driver for it?

STM32Cube HAL driver files are consistently named
``<series-hal-dir>_hal_<ip>.{h,c}``, optionally with an ``_ex`` extended-API
suffix (e.g. ``stm32f4xx_hal_adc_ex.h``). The ``<ip>`` token is STM32Cube's
own name for the peripheral; ip_catalog.yaml maps it to a dashboard
"group/category" so scan_zephyr.py can tell "not ported yet" (on-chip per
STM32Cube, no Zephyr binding) apart from "not available" (STM32Cube has no
such IP for this series either).

This module never mutates the given --hal-stm32-path checkout: it only
reads files.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

# HAL-internal suffixes that match the <ip> capture group in
# IP_FILENAME_RE_TEMPLATE but are not peripheral names (implementation
# details shared by every series, not silicon IPs).
IGNORED_IP_SUFFIXES = {"def", "msp", "conf", "cortex", "legacy"}

# Anchored on the series' own hal-dir prefix (computed per series by
# hal_series_dir()) rather than a bare "*_hal_*" glob, so this never
# matches unrelated files such as the shared "stm32_hal_legacy.h" (prefix
# "stm32", not "<hal-dir>").
IP_FILENAME_RE_TEMPLATE = r"^{prefix}_hal_([a-z0-9]+)(?:_ex)?\.[hc]$"


def hal_series_dir(hal_root: Path, series_name: str) -> Path | None:
    """Map a zephyr soc.yml series name (e.g. "stm32c0x") to its
    stm32cube/<dir> in a hal_stm32 checkout, or None if not found.

    Mirrors hal_stm32's own stm32cube/CMakeLists.txt lookup: try
    "<short>xx" first (the common case), then fall back to "<short>x"
    (e.g. stm32wb0x, which uses a single-x CMSIS device directory).
    """
    short = series_name.removesuffix("x")
    for candidate in (f"{short}xx", f"{short}x"):
        candidate_dir = hal_root / "stm32cube" / candidate
        if candidate_dir.is_dir():
            return candidate_dir
    return None


def discover_series_ip_tokens(series_dir: Path) -> set[str]:
    """Return the STM32Cube IP tokens with a HAL driver file somewhere
    under *series_dir* (drivers/include, drivers/hal, ...)."""
    pattern = re.compile(IP_FILENAME_RE_TEMPLATE.format(prefix=re.escape(series_dir.name)))
    tokens: set[str] = set()
    for path in series_dir.rglob("*_hal_*"):
        if not path.is_file():
            continue
        match = pattern.match(path.name)
        if not match:
            continue
        token = match.group(1)
        if token not in IGNORED_IP_SUFFIXES:
            tokens.add(token)
    return tokens


def load_ip_catalog(path: Path) -> tuple[dict[str, list[tuple[str, str]]], set[str]]:
    """Load ip_catalog.yaml.

    Returns (token -> [(group, category), ...], ignored tokens).
    """
    data = yaml.safe_load(path.read_text()) or {}
    ips: dict[str, list[tuple[str, str]]] = {}
    for token, entry in (data.get("ips") or {}).items():
        categories = []
        for ref in entry.get("categories", []):
            group, _, category = ref.partition("/")
            categories.append((group, category))
        ips[token] = categories
    ignored = set(data.get("ignored") or [])
    return ips, ignored


def load_series_names(zephyr_root: Path) -> list[str]:
    soc_yml = zephyr_root / "soc" / "st" / "stm32" / "soc.yml"
    data = yaml.safe_load(soc_yml.read_text())
    stm32_family = next(f for f in data.get("family", []) if f.get("name") == "stm32")
    return [s["name"] for s in stm32_family.get("series", [])]


def build_token_report(hal_root: Path, series_names: list[str]) -> dict[str, list[str]]:
    """Return {series_name: sorted IP tokens} for every series found under
    hal_root. A series with no matching hal_stm32 directory is omitted."""
    report: dict[str, list[str]] = {}
    for series_name in series_names:
        series_dir = hal_series_dir(hal_root, series_name)
        if series_dir is not None:
            report[series_name] = sorted(discover_series_ip_tokens(series_dir))
    return report


def unclassified_tokens(
    tokens_by_series: dict[str, list[str]], ips: dict[str, list[tuple[str, str]]], ignored: set[str]
) -> set[str]:
    all_tokens: set[str] = set()
    for tokens in tokens_by_series.values():
        all_tokens.update(tokens)
    return all_tokens - set(ips) - ignored


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hal-stm32-path", required=True, type=Path, help="Path to a local hal_stm32 git checkout.")
    parser.add_argument(
        "--zephyr-path", required=True, type=Path, help="Zephyr checkout, used only to list series from soc.yml."
    )
    parser.add_argument(
        "--ip-catalog", type=Path, default=Path(__file__).parent / "ip_catalog.yaml", help="Path to ip_catalog.yaml."
    )
    parser.add_argument("--output", required=True, type=Path, help="Output JSON file path.")
    args = parser.parse_args(argv)

    series_names = load_series_names(args.zephyr_path)
    tokens_by_series = build_token_report(args.hal_stm32_path, series_names)

    ips, ignored = load_ip_catalog(args.ip_catalog)
    unclassified = unclassified_tokens(tokens_by_series, ips, ignored)
    if unclassified:
        print(
            f"warning: IP tokens discovered in hal_stm32 with no ip_catalog.yaml "
            f"entry (add to 'ips' or 'ignored'): {sorted(unclassified)}",
            file=sys.stderr,
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(tokens_by_series, indent=2) + "\n")
    print(f"wrote {args.output} ({len(tokens_by_series)} series)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
