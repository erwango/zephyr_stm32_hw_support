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

``pinctrl`` bindings are a mandatory baseline requirement for any upstream
SoC port, so they are reported as metadata only and excluded from the
per-series coverage grid.

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
#
# "base" and "system" were previously two separate groups, but the line
# between them (e.g. is PWM "base" or "system"?) was not obvious to readers,
# so they are merged into a single "system" group.
CATEGORY_GROUPS: dict[str, str] = {
    # system: core enablement + system-level services
    "power": "system",
    "reset": "system",
    "interrupt-controller": "system",
    "gpio": "system",
    "clock": "system",
    "pinctrl": "system",
    "dma": "system",
    "regulator": "system",
    "timer": "system",
    "counter": "system",
    "rtc": "system",
    "watchdog": "system",
    "pwm": "system",
    # security: crypto accelerators, RNG/TRNG, integrity/CRC, OTP key storage
    "rng": "security",
    "crypto": "security",
    "crc": "security",
    "otp": "security",
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
    # memory
    "flash_controller": "memory",
    "mtd": "memory",
    "memory-controllers": "memory",
    "ospi": "memory",
    "qspi": "memory",
    "xspi": "memory",
    "mspi": "memory",
    "sdhc": "memory",
    "arm": "memory",
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

# Explicit (group, category) overrides applied before CATEGORY_GROUPS lookup.
# - "phy": all current st,stm32* phy bindings are USB HS PHY controllers, so
#   they are folded into the "usb" category rather than kept as a separate
#   one-off "phy" category.
# - "misc": the few bindings genuinely filed under dts/bindings/misc/ (e.g.
#   NPU, RAM config) are bucketed into their own dedicated "misc"
#   group/category. Unlike an earlier version of this script, a compatible
#   is never moved into "misc" just because only one series supports it so
#   far: series-count has no bearing on which peripheral category it
#   belongs to (e.g. st,stm32-bdma is still a "dma" binding regardless of
#   how many series have it upstream).
CATEGORY_OVERRIDES: dict[str, tuple[str, str]] = {
    "phy": ("communication", "usb"),
    "misc": ("misc", "misc"),
}

# Categories that are mandatory baseline requirements for any upstream SoC
# port. Driver-presence detection is skipped for these (metadata only).
#
# "clock" used to be baseline too, but RCC/clock-tree bindings vary
# significantly across series (e.g. PLL topology, HSI/MSI variants), so a
# per-series supported/absent grid is still meaningful there, unlike
# pinctrl which is a uniform, always-present requirement.
BASELINE_CATEGORIES = {"pinctrl"}

# `HAS_<FOO>` Kconfig select symbols reported as their own, Kconfig-sourced
# category (group, category, display title), parallel to the devicetree
# categories above. Add an entry here for each new Kconfig-only capability
# to report; anything else matching HAS_SELECT_RE is either ignored (see
# KCONFIG_IGNORED_HAS_SELECTS) or surfaced as a warning so new capability
# selects don't silently go unreported.
KCONFIG_CAPABILITIES: dict[str, dict[str, str]] = {
    "HAS_POWEROFF": {
        "group": "system",
        "category": "poweroff",
        "title": "System power off (CONFIG_POWEROFF)",
    },
}

# `HAS_<FOO>` selects that are implementation details (toolchain/vendor HAL
# availability, SWO trace, flash prefetch, RTC/OTP erratas, ...) rather than
# a user-facing capability worth reporting. HAS_PM is deliberately excluded
# as a *capability* here too: it is reported instead via the devicetree
# power-states-backed "pm" category, which also conveys which CPU low power
# states are implemented (HAS_PM alone is a strict subset of that).
KCONFIG_IGNORED_HAS_SELECTS = {
    "HAS_STM32CUBE",
    "HAS_SWO",
    "HAS_STM32_FLASH_PREFETCH",
    "HAS_STM32_UNCACHED_ACCESS_ONLY_OTP",
    "HAS_STM32_RTC_READ_GATED_BY_BKP_DOMAIN",
    "HAS_PM",
    "HAS_PM_S2RAM_CUSTOM_MARKING",
}

# Devicetree nodes may declare a fallback list, e.g.
#   compatible = "st,stm32f4-flash-controller", "st,stm32-flash-controller";
# A regex that only captures the first quoted string misses every
# compatible listed after it. COMPATIBLE_PROP_RE grabs the whole
# comma-separated property value so every string in it can be extracted.
COMPATIBLE_PROP_RE = re.compile(r'compatible\s*=\s*((?:"[^"]*"\s*,\s*)*"[^"]*")\s*;')
DT_DRV_COMPAT_RE = re.compile(r"DT_DRV_COMPAT\s+(\w+)")

# Generic (non-ST) `zephyr,power-state` devicetree nodes declare the CPU low
# power states a series' `power.c` PM hooks actually implement, e.g.
#   power-states {
#       state0 { compatible = "zephyr,power-state"; power-state-name = "suspend-to-idle"; ... };
#   };
# This is a stronger, per-state signal than the boolean HAS_PM Kconfig select
# (which every series with any power-states node also selects), so PM
# support is reported from devicetree like every other peripheral category
# instead of as a second, coarser Kconfig-sourced boolean.
POWER_STATE_NAME_RE = re.compile(r'power-state-name\s*=\s*"([^"]*)"\s*;')

# `select HAS_<FOO>` lines in a series' top-level Kconfig follow Zephyr's
# "hidden capability symbol" convention (see e.g. HAS_POWEROFF/HAS_PM in
# lib/os/Kconfig and subsys/pm/Kconfig): the SoC self-declares that it
# implements a given optional subsystem hook. Unlike devicetree compatibles,
# these have no hardware-absence meaning -- an "absent" cell here means
# "not yet implemented for this series in Zephyr", not "not present on the
# silicon".
HAS_SELECT_RE = re.compile(r"^\s*select\s+(HAS_\w+)\b", re.MULTILINE)


def extract_compatibles(text: str) -> list[str]:
    """Return every individual compatible string declared in `text`,
    including fallback entries after the first in a multi-value list."""
    out: list[str] = []
    for prop in COMPATIBLE_PROP_RE.findall(text):
        out.extend(re.findall(r'"([^"]*)"', prop))
    return out


# soc.yml's `cpuclusters` entries use short core identifiers (e.g. "m7",
# "m4") that don't always match the devicetree's `arm,cortex-<core>` naming
# (e.g. the dualcore H7 companion core is declared in dts as "m4f", with an
# FPU suffix, not "m4"). This maps the known exceptions.
CPU_CLUSTER_CORE_ALIASES = {"m4": "m4f"}


def normalize_cpucluster_core(name: str) -> str:
    return CPU_CLUSTER_CORE_ALIASES.get(name, name)


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
    series = []
    for s in stm32_family.get("series", []):
        socs = []
        for soc in s.get("socs", []):
            # Most SoCs have a single, implicit core shared by the whole
            # series (determined later from devicetree). Some SoCs are
            # heterogeneous multi-core parts (e.g. only 4 of the 19 H7x
            # SoCs are dual-core M7+M4F) and declare their exact cores
            # explicitly via `cpuclusters` -- this is the authoritative,
            # per-SoC source of truth for that case.
            clusters = soc.get("cpuclusters") or []
            cores = [normalize_cpucluster_core(c["name"]) for c in clusters]
            socs.append({"name": soc["name"], "cores": cores})
        series.append({"name": s["name"], "socs": socs})
    return series


def scan_series_dts(zephyr_root: Path, dts_dir: str) -> tuple[set[str], set[str], set[str]]:
    """Return (declared_compatibles, core_names, power_state_names) for
    dts/arm/st/<dts_dir>."""
    base = zephyr_root / "dts" / "arm" / "st" / dts_dir
    compatibles: set[str] = set()
    cores: set[str] = set()
    power_states: set[str] = set()
    if not base.is_dir():
        return compatibles, cores, power_states
    for dtsi in base.rglob("*.dtsi"):
        text = dtsi.read_text(errors="ignore")
        for compat in extract_compatibles(text):
            if compat.startswith("arm,cortex-"):
                cores.add(compat.removeprefix("arm,cortex-"))
            elif compat.startswith("st,"):
                compatibles.add(compat)
        power_states.update(POWER_STATE_NAME_RE.findall(text))
    return compatibles, cores, power_states


def scan_series_kconfig_selects(zephyr_root: Path, series_name: str) -> set[str]:
    """Return every `select HAS_<FOO>` symbol in a series' top-level Kconfig
    (soc/st/stm32/<series_name>/Kconfig). The soc.yml series name matches
    this directory name directly, unlike dts_dir_for_series()."""
    kconfig_path = zephyr_root / "soc" / "st" / "stm32" / series_name / "Kconfig"
    if not kconfig_path.is_file():
        return set()
    text = kconfig_path.read_text(errors="ignore")
    return set(HAS_SELECT_RE.findall(text))


def discover_bindings(zephyr_root: Path) -> list[dict]:
    """Discover candidate ST-authored devicetree bindings.

    This purposely casts a wide net (every ``st,*.yaml`` binding, not just
    ones named ``st,stm32*.yaml``): some genuine on-chip STM32 peripherals
    use a different naming scheme, e.g. ``st,hci-stm32wba.yaml`` (Bluetooth
    HCI) or ``st,mbox-stm32-hsem.yaml`` (HSEM mailbox). Bindings for
    external/companion chips (sensors, PMICs, IO expanders, etc.) are also
    matched here, but get filtered out later in build_report() based on
    whether their compatible is actually declared by any STM32 series'
    SoC devicetree.
    """
    bindings_root = zephyr_root / "dts" / "bindings"
    entries = []
    for yaml_path in sorted(bindings_root.glob("*/st,*.yaml")):
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
    power_states_by_series: dict[str, set[str]] = {}
    kconfig_selects_by_series: dict[str, set[str]] = {}
    unknown_has_selects: set[str] = set()
    for entry in series_catalog:
        name = entry["name"]
        compatibles, scanned_cores, power_states = scan_series_dts(zephyr_root, dts_dir_for_series(name))
        declared_by_series[name] = compatibles
        power_states_by_series[name] = power_states

        has_selects = scan_series_kconfig_selects(zephyr_root, name)
        kconfig_selects_by_series[name] = has_selects
        unknown_has_selects.update(
            has_selects - set(KCONFIG_CAPABILITIES) - KCONFIG_IGNORED_HAS_SELECTS
        )

        # Series-wide dtsi scanning can't tell which specific SoCs have
        # which core when a series mixes single- and multi-core parts
        # (e.g. stm32h7x: only 4 of 19 SoCs are dual-core M7+M4F). Where
        # soc.yml's per-SoC `cpuclusters` is explicit, trust it. Any core
        # beyond the first in a `cpuclusters` list is treated as exclusive
        # to the SoCs that declare it; SoCs without an explicit
        # `cpuclusters` fall back to the series' remaining ("default")
        # cores.
        explicit_core_lists = [soc["cores"] for soc in entry["socs"] if soc["cores"]]
        exclusive_cores = {c for cores in explicit_core_lists for c in cores[1:]}
        default_cores = sorted(scanned_cores - exclusive_cores)

        socs_out = [
            {"name": soc["name"], "cores": soc["cores"] or default_cores}
            for soc in entry["socs"]
        ]
        series_out.append({"name": name, "cores": sorted(scanned_cores), "socs": socs_out})
    series_out.sort(key=lambda s: s["name"])

    driver_index = build_driver_index(zephyr_root)
    bindings = discover_bindings(zephyr_root)

    # Only compatibles actually declared by at least one STM32 series' own
    # SoC devicetree are genuine on-chip peripherals; discover_bindings()
    # casts a wide net that also matches external/companion-chip bindings
    # (sensors, PMICs, IO expanders, generic SPI HCI framing, ...), which
    # are dropped here instead of relying on a fragile filename convention.
    all_declared_compatibles: set[str] = set().union(*declared_by_series.values())

    categories: dict[tuple[str, str], dict] = {}
    unmapped_categories: set[str] = set()
    for binding in bindings:
        if binding["compatible"] not in all_declared_compatibles:
            continue
        raw_category = binding["category"]
        if raw_category in CATEGORY_OVERRIDES:
            group, category = CATEGORY_OVERRIDES[raw_category]
        else:
            category = raw_category
            group = CATEGORY_GROUPS.get(category)
            if group is None:
                group = "other"
                unmapped_categories.add(category)
        baseline = category in BASELINE_CATEGORIES

        cat_entry = categories.setdefault(
            (group, category),
            {
                "group": group,
                "name": category,
                "baseline": baseline,
                "source": "devicetree",
                "section": "hardware",
                "apis": [],
            },
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
    if unknown_has_selects:
        print(
            f"warning: unmapped 'select HAS_*' Kconfig symbols (add to "
            f"KCONFIG_CAPABILITIES or KCONFIG_IGNORED_HAS_SELECTS): "
            f"{sorted(unknown_has_selects)}",
            file=sys.stderr,
        )

    # Kconfig-sourced capability categories (e.g. "poweroff"): unlike
    # devicetree categories, "absent" here means "not yet implemented in
    # Zephyr for this series", not "not present on the silicon". Reported
    # under a separate "software" section (rendered after a visual
    # separator) rather than interleaved alphabetically among hardware
    # peripheral categories, since their supported/absent semantics differ.
    for symbol, meta in KCONFIG_CAPABILITIES.items():
        cat_entry = categories.setdefault(
            (meta["group"], meta["category"]),
            {
                "group": meta["group"],
                "name": meta["category"],
                "baseline": False,
                "source": "kconfig",
                "section": "software",
                "apis": [],
            },
        )
        series_support = {
            s["name"]: ("supported" if symbol in kconfig_selects_by_series.get(s["name"], set()) else "absent")
            for s in series_out
        }
        cat_entry["apis"].append(
            {"kconfig": symbol, "title": meta["title"], "series_support": series_support}
        )

    # Devicetree-sourced "pm" category: reports which CPU low power states
    # (e.g. "suspend-to-idle", "suspend-to-ram") each series declares via
    # generic `zephyr,power-state` devicetree nodes, a stronger signal than
    # the plain boolean HAS_PM/CONFIG_PM Kconfig select. Grouped into the
    # "software" section alongside "poweroff" (see above) rather than
    # sorted alphabetically among hardware categories.
    if any(power_states_by_series.values()):
        series_support = {}
        series_states = {}
        for s in series_out:
            states = power_states_by_series.get(s["name"], set())
            series_support[s["name"]] = "supported" if states else "absent"
            if states:
                series_states[s["name"]] = sorted(states)
        categories[("system", "pm")] = {
            "group": "system",
            "name": "pm",
            "baseline": False,
            "source": "devicetree",
            "section": "software",
            "apis": [
                {
                    "title": "Power management (CONFIG_PM)",
                    "binding_path": "dts/bindings/power/zephyr,power-state.yaml",
                    "series_support": series_support,
                    "series_states": series_states,
                }
            ],
        }

    categories = {key: cat for key, cat in categories.items() if cat["apis"]}

    categories_out = sorted(
        categories.values(),
        key=lambda c: (c.get("section", "hardware") != "hardware", c["group"], c["name"]),
    )
    for cat in categories_out:
        cat["apis"].sort(key=lambda a: a.get("compatible") or a.get("kconfig") or a.get("title") or "")

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
