"use strict";

const GITHUB_BLOB_BASE = "https://github.com/zephyrproject-rtos/zephyr/blob/";
const ZEPHYR_DOCS_BASE = "https://docs.zephyrproject.org/";
const BINDINGS_PREFIX = "dts/bindings/";

const state = {
  manifest: [],
  report: null,
  search: "",
  expandedCategories: new Set(),
  expandedSeries: new Set(),
  showStats: false,
};

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`failed to fetch ${path}: ${res.status}`);
  }
  return res.json();
}

function seriesShortName(name) {
  return name.replace(/^stm32/, "").replace(/x$/, "").toUpperCase();
}

// STM32MPx parts are microprocessors: Zephyr targets one specific core (an
// M-class companion core, or the application core itself for MP13), while
// other on-chip cores are outside Zephyr's scope.
function isMpuSeries(seriesName) {
  return /^stm32mp/i.test(seriesName);
}

const CORE_LABELS = {
  m0: "Cortex-M0",
  "m0+": "Cortex-M0+",
  m3: "Cortex-M3",
  m4: "Cortex-M4",
  m4f: "Cortex-M4F",
  m7: "Cortex-M7",
  m33: "Cortex-M33",
  m55: "Cortex-M55",
  a7: "Cortex-A7",
};

const CORE_ORDER = ["m0", "m0+", "m3", "m4", "m4f", "m7", "m33", "m55", "a7"];

function coreLabel(core) {
  return CORE_LABELS[core] || `Cortex-${core.toUpperCase()}`;
}

// Scans run at 06:00/14:00 Europe/Paris local time (DST-adjusted, see
// .github/workflows/update.yml); display timestamps the same way rather
// than in the browser's local timezone or raw UTC.
function formatTimestampParis(isoUtc) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(new Date(isoUtc));
  const get = (type) => parts.find((p) => p.type === type).value;
  // Some engines report midnight as hour "24" rather than "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

// Zephyr's published docs use "/latest/" for main and "/<X.Y.Z>/" (no "v"
// prefix) for tagged releases.
function docVersion(ref) {
  return ref === "main" ? "latest" : ref.replace(/^v/, "");
}

function bindingDocUrl(ref, bindingPath) {
  const relPath = bindingPath.startsWith(BINDINGS_PREFIX)
    ? bindingPath.slice(BINDINGS_PREFIX.length)
    : bindingPath;
  const htmlPath = relPath.replace(/\.ya?ml$/, ".html");
  return `${ZEPHYR_DOCS_BASE}${docVersion(ref)}/build/dts/api/bindings/${htmlPath}`;
}

// Kconfig-sourced capabilities (e.g. HAS_POWEROFF) are the hidden SoC-side
// half of a user-facing `select`ed/`depends on` pair (HAS_POWEROFF ->
// POWEROFF, HAS_PM -> PM); link to the user-facing CONFIG_* symbol's doc
// anchor since that's the one a reader would actually enable.
function kconfigDocUrl(ref, symbol) {
  const userSymbol = symbol.replace(/^HAS_/, "");
  return `${ZEPHYR_DOCS_BASE}${docVersion(ref)}/kconfig.html#CONFIG_${userSymbol}`;
}

function link(href, text, title) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  if (title) a.title = title;
  return a;
}

const CELL_CLASSES = {
  supported: "cell-supported",
  not_ported: "cell-not-ported",
  absent: "cell-absent",
};

const CELL_LABELS = {
  supported: "\u2713",
  not_ported: "\u25cf",
  absent: "",
};

function cellClass(status) {
  return CELL_CLASSES[status] || CELL_CLASSES.absent;
}

function cellLabel(status) {
  return CELL_LABELS[status] || CELL_LABELS.absent;
}

// Pick the most informative status across a category's compatibles for one
// series: a single "supported" compatible outweighs a sibling compatible
// that's merely on-chip-but-unported, which in turn outweighs one that's
// confirmed absent from the silicon entirely.
const STATUS_PRIORITY = ["supported", "not_ported", "not_available", "absent"];

function rawAggregateStatus(apis, seriesName) {
  const statuses = new Set(apis.map((api) => (api.series_support || {})[seriesName] || "absent"));
  return STATUS_PRIORITY.find((status) => statuses.has(status)) || "absent";
}

// The grid always shows the full comparison: "not_available" (confirmed
// absent from the silicon) renders the same as plain "absent" (unknown),
// since only supported vs. on-chip-but-not-ported is actionable here.
function aggregateStatus(apis, seriesName) {
  const raw = rawAggregateStatus(apis, seriesName);
  return raw === "not_available" ? "absent" : raw;
}

// Coverage % = supported / (supported + not_ported): of the series
// STM32Cube confirms the silicon has (already ported, or on-chip but not
// yet ported), what fraction is actually ported. null when that total is
// zero (nothing on-chip to port, or no hal_stm32 classification at all).
function coverageRatio(supported, notPorted) {
  const denom = supported + notPorted;
  return denom > 0 ? Math.round((100 * supported) / denom) : null;
}

function formatCoverage(pct) {
  return pct === null ? "\u2013" : `${pct}%`;
}

// Hardware categories only, full dataset (ignores the search filter).
function computeCoverageStats(report) {
  const seriesNames = report.series.map((s) => s.name);
  const bySeriesCounts = new Map(seriesNames.map((s) => [s, { supported: 0, notPorted: 0 }]));
  const byCategory = new Map();
  let globalSupported = 0;
  let globalNotPorted = 0;

  for (const category of report.categories) {
    if (category.baseline || (category.section || "hardware") !== "hardware") continue;
    let supported = 0;
    let notPorted = 0;
    for (const s of seriesNames) {
      const status = rawAggregateStatus(category.apis, s);
      if (status === "supported") {
        supported += 1;
        bySeriesCounts.get(s).supported += 1;
      } else if (status === "not_ported") {
        notPorted += 1;
        bySeriesCounts.get(s).notPorted += 1;
      }
    }
    byCategory.set(`${category.group}/${category.name}`, coverageRatio(supported, notPorted));
    globalSupported += supported;
    globalNotPorted += notPorted;
  }

  const bySeries = new Map();
  for (const [s, counts] of bySeriesCounts) {
    bySeries.set(s, coverageRatio(counts.supported, counts.notPorted));
  }

  return { byCategory, bySeries, global: coverageRatio(globalSupported, globalNotPorted) };
}

function buildCoverageBadge(stats) {
  if (!stats) return null;
  const badge = document.createElement("span");
  badge.className = "coverage-badge";
  badge.textContent = `${formatCoverage(stats.global)} ported`;
  badge.title = "Ported / (ported + on-chip, not ported) across all hardware categories and series";
  return badge;
}

function matchesFilter(category, api, needle) {
  if (!needle) return true;
  return (
    (api.compatible || api.kconfig || "").toLowerCase().includes(needle) ||
    (api.title || "").toLowerCase().includes(needle) ||
    category.name.toLowerCase().includes(needle) ||
    category.group.toLowerCase().includes(needle)
  );
}

// ---------------------------------------------------------------------
// Series (Core x Series pivot: rows are Cortex cores, columns are series,
// cells show the SoC count; click a cell to expand its SoC list). Rendered
// as the lead block of the combined table below, ahead of a divider row,
// so its series columns line up with the API coverage grid's.
// ---------------------------------------------------------------------

// Number of leading (non-series) columns in the combined table: Group,
// Category, API and, when stats are on, Ported %.
function metaColCount() {
  return 3 + (state.showStats ? 1 : 0);
}

function buildSeriesRows(report, series, cols) {
  const cores = CORE_ORDER.filter((core) => report.series.some((s) => s.cores.includes(core)));
  const rows = [];

  for (const core of cores) {
    const row = document.createElement("tr");
    row.className = "series-row";
    const rowHeader = document.createElement("th");
    rowHeader.scope = "row";
    rowHeader.className = "series-row-header";
    rowHeader.textContent = coreLabel(core);
    row.appendChild(rowHeader);
    // Blank filler cells so this row has the same cell count as the API
    // coverage rows below (Group/Category/API[/Ported %]), keeping series
    // columns' cellIndex - and therefore the column-hover highlight -
    // aligned across both blocks.
    for (let i = 1; i < cols; i++) {
      row.appendChild(document.createElement("td"));
    }

    const expandedHere = [];
    for (const s of series) {
      const td = document.createElement("td");
      const socsWithCore = s.socs.filter((soc) => soc.cores.includes(core));
      if (socsWithCore.length > 0) {
        const key = `${core}::${s.name}`;
        const expanded = state.expandedSeries.has(key);
        td.className = "series-cell" + (expanded ? " series-cell-expanded" : "");
        td.textContent = String(socsWithCore.length);
        td.title = `${s.name}: click to ${expanded ? "hide" : "show"} SoC list`;
        td.addEventListener("click", () => {
          if (state.expandedSeries.has(key)) {
            state.expandedSeries.delete(key);
          } else {
            state.expandedSeries.add(key);
          }
          renderTable(state.report, state.search);
        });
        if (expanded) expandedHere.push({ series: s, socs: socsWithCore });
      } else {
        td.className = "cell-absent";
        td.textContent = "\u2013";
      }
      row.appendChild(td);
    }
    rows.push(row);

    for (const { series: s, socs } of expandedHere) {
      const detailRow = document.createElement("tr");
      detailRow.className = "detail-row";
      const td = document.createElement("td");
      td.colSpan = cols + series.length;
      const label = document.createElement("strong");
      label.textContent = `${s.name}: `;
      td.appendChild(label);
      td.appendChild(document.createTextNode(socs.map((soc) => soc.name).join(", ")));
      detailRow.appendChild(td);
      rows.push(detailRow);
    }
  }

  return rows;
}

// Section title row: marks which of the two conceptual tables (Series /
// API coverage) the rows that follow belong to. An optional extra node
// (e.g. the global ported-% badge) can be appended after the label.
function buildSectionTitleRow(colCount, label, extraNode) {
  const tr = document.createElement("tr");
  tr.className = "section-title-row";
  const td = document.createElement("td");
  td.colSpan = colCount;
  td.appendChild(document.createTextNode(label));
  if (extraNode) td.appendChild(extraNode);
  tr.appendChild(td);
  return tr;
}

// Column-label sub-header for the API coverage block (Group/Category/API/
// [Ported %] + per-series ported %), shown once right below the "API
// coverage" section title and above the first category row. Kept out of
// the sticky top-level <thead> (which only ever shows "Series" + the
// series names) so that header stays uncluttered while scrolling.
function buildCoverageSubHeaderRow(seriesObjs, stats) {
  const tr = document.createElement("tr");
  tr.className = "coverage-subheader-row";
  for (const label of ["Group", "Category", "API"]) {
    const th = document.createElement("th");
    th.textContent = label;
    th.className = "col-header-text";
    tr.appendChild(th);
  }
  if (state.showStats) {
    const th = document.createElement("th");
    th.textContent = "Ported %";
    th.className = "col-header-text";
    th.title = "Ported / (ported + on-chip, not ported); hardware categories only";
    tr.appendChild(th);
  }
  for (const s of seriesObjs) {
    const th = document.createElement("th");
    if (stats) {
      th.textContent = formatCoverage(stats.bySeries.get(s.name));
      th.title = `${s.name}: ported / (ported + on-chip, not ported)`;
      th.className = "series-coverage-badge";
    }
    tr.appendChild(th);
  }
  return tr;
}


// ---------------------------------------------------------------------
// API coverage table (one row per category, expandable to per-compatible)
// ---------------------------------------------------------------------

function buildCategoryRow(ref, series, category, apis, expanded, coveragePct) {
  const tr = document.createElement("tr");
  tr.className = `category-row group-${category.group}`;
  tr.addEventListener("click", () => {
    const key = `${category.group}/${category.name}`;
    if (state.expandedCategories.has(key)) {
      state.expandedCategories.delete(key);
    } else {
      state.expandedCategories.add(key);
    }
    renderTable(state.report, state.search);
  });

  const groupCell = document.createElement("td");
  groupCell.className = "col-group";
  const groupBadge = document.createElement("span");
  groupBadge.className = `group-badge group-badge-${category.group}`;
  groupBadge.textContent = category.group;
  groupCell.appendChild(groupBadge);
  tr.appendChild(groupCell);

  const catCell = document.createElement("td");
  catCell.className = "col-category";
  catCell.textContent = `${expanded ? "\u25be" : "\u25b8"} ${category.name}`;
  tr.appendChild(catCell);

  const nameCell = document.createElement("td");
  nameCell.className = "api-name";
  nameCell.textContent = apiCountLabel(category, apis);
  tr.appendChild(nameCell);

  if (state.showStats) {
    const covCell = document.createElement("td");
    covCell.className = "col-coverage";
    covCell.textContent = formatCoverage(coveragePct);
    covCell.title = "Ported / (ported + on-chip, not ported)";
    tr.appendChild(covCell);
  }

  for (const s of series) {
    const status = aggregateStatus(apis, s);
    const td = document.createElement("td");
    td.className = cellClass(status);
    td.textContent = cellLabel(status);
    tr.appendChild(td);
  }
  return tr;
}

// Blank spacer row marking the boundary between the hardware peripheral
// categories (devicetree-backed; "absent" means not present on the
// silicon) and the software capability categories (Kconfig/PM; "absent"
// means not yet implemented in Zephyr for this series).
function buildSectionSeparatorRow(seriesCount) {
  const tr = document.createElement("tr");
  tr.className = "section-separator-row";
  const td = document.createElement("td");
  td.colSpan = seriesCount + metaColCount();
  tr.appendChild(td);
  return tr;
}

function apiCountLabel(category, apis) {
  if (category.source === "kconfig") {
    return `${apis.length} Kconfig option${apis.length === 1 ? "" : "s"}`;
  }
  return `${apis.length} compatible${apis.length === 1 ? "" : "s"}`;
}

function buildApiDetailRow(ref, series, category, api) {
  const tr = document.createElement("tr");
  tr.className = "detail-row api-detail-row";

  tr.appendChild(document.createElement("td")); // group (blank, indented)
  tr.appendChild(document.createElement("td")); // category (blank, indented)

  const nameCell = document.createElement("td");
  nameCell.className = "api-name api-name-indent";

  if (category.source === "kconfig") {
    const badge = document.createElement("span");
    badge.className = "source-badge source-badge-kconfig";
    badge.textContent = "Kconfig";
    badge.title =
      "Kconfig-gated capability: 'absent' means not yet implemented in Zephyr for this series, not a hardware limitation.";
    nameCell.appendChild(badge);
    nameCell.appendChild(link(kconfigDocUrl(ref, api.kconfig), api.title || api.kconfig, "Zephyr Kconfig reference"));
  } else {
    nameCell.appendChild(
      link(bindingDocUrl(ref, api.binding_path), api.title || api.compatible, "Zephyr devicetree binding doc")
    );
    if (api.compatible) {
      const compatLink = link(
        `${GITHUB_BLOB_BASE}${encodeURIComponent(ref)}/${api.binding_path}`,
        api.compatible,
        "Binding source on GitHub"
      );
      compatLink.className = "api-compat";
      nameCell.appendChild(compatLink);
    }
  }
  tr.appendChild(nameCell);

  if (state.showStats) {
    tr.appendChild(document.createElement("td")); // coverage % (blank, category-level only)
  }

  for (const s of series) {
    // The hal_stm32 IP catalog maps tokens per category, not per individual
    // compatible, so attributing not_ported to one specific compatible
    // would overstate precision the backend doesn't have. That detail is
    // only shown aggregated at the category-row level.
    const rawStatus = (api.series_support && api.series_support[s]) || "absent";
    const status = rawStatus === "supported" ? "supported" : "absent";
    const td = document.createElement("td");
    td.className = cellClass(status);
    td.textContent = cellLabel(status);
    if (status === "supported") {
      if (api.driver_paths && api.driver_paths.length) {
        td.title = api.driver_paths.join("\n");
      } else if (api.series_states && api.series_states[s]) {
        td.title = `Power states: ${api.series_states[s].join(", ")}`;
      }
    }
    tr.appendChild(td);
  }
  return tr;
}

function renderTable(report, filter) {
  const container = document.getElementById("table-container");
  container.replaceChildren();

  const seriesObjs = [...report.series].sort((a, b) => a.name.localeCompare(b.name));
  const series = seriesObjs.map((s) => s.name);
  const cols = metaColCount();
  const needle = filter.trim().toLowerCase();
  const stats = state.showStats && report.hal_stm32_commit ? computeCoverageStats(report) : null;

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const seriesLabel = document.createElement("th");
  seriesLabel.textContent = "Series";
  seriesLabel.className = "col-header-text";
  headRow.appendChild(seriesLabel);
  // Blank filler cells so this row keeps the same cell count as every row
  // below (see buildSeriesRows), keeping series columns' cellIndex aligned.
  for (let i = 1; i < cols; i++) {
    headRow.appendChild(document.createElement("th"));
  }
  for (const s of seriesObjs) {
    const th = document.createElement("th");
    th.title = s.name;
    const nameSpan = document.createElement("span");
    nameSpan.textContent = seriesShortName(s.name);
    th.appendChild(nameSpan);
    if (isMpuSeries(s.name)) {
      const badge = document.createElement("span");
      badge.className = "mpu-badge";
      badge.textContent = "MPU";
      badge.title =
        "Microprocessor: Zephyr targets this core; other on-chip cores (if any) are outside Zephyr's scope.";
      th.appendChild(badge);
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const fullWidth = cols + series.length;

  tbody.appendChild(buildSectionTitleRow(fullWidth, "SoC coverage"));
  for (const row of buildSeriesRows(report, seriesObjs, cols)) {
    tbody.appendChild(row);
  }

  tbody.appendChild(buildSectionTitleRow(fullWidth, "API Coverage", buildCoverageBadge(stats)));
  tbody.appendChild(buildCoverageSubHeaderRow(seriesObjs, stats));

  let categoryCount = 0;
  let lastSection = null;
  for (const category of report.categories) {
    if (category.baseline) continue; // metadata only, no coverage grid

    const apis = category.apis.filter((api) => matchesFilter(category, api, needle));
    if (apis.length === 0) continue;
    categoryCount += 1;

    const section = category.section || "hardware";
    if (lastSection !== null && section !== lastSection) {
      tbody.appendChild(buildSectionSeparatorRow(series.length));
    }
    lastSection = section;

    const key = `${category.group}/${category.name}`;
    const expanded = needle !== "" || state.expandedCategories.has(key);

    tbody.appendChild(
      buildCategoryRow(report.ref, series, category, apis, expanded, stats ? stats.byCategory.get(key) : undefined)
    );
    if (expanded) {
      for (const api of apis) {
        tbody.appendChild(buildApiDetailRow(report.ref, series, category, api));
      }
    }
  }

  if (categoryCount === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = fullWidth;
    td.textContent = "No matching APIs.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  enableColumnHover(table);
  container.appendChild(table);
}

// Mirrors the existing per-row hover highlight with a per-column one, so a
// series can be traced down the whole table. Delegated on the table itself
// (rebuilt fresh on every render) rather than per-cell listeners.
function enableColumnHover(table) {
  const toggle = (e, on) => {
    const cell = e.target.closest("td, th");
    if (!cell || !table.contains(cell) || cell.cellIndex < 0) return;
    for (const row of table.rows) {
      row.cells[cell.cellIndex]?.classList.toggle("col-hover", on);
    }
  };
  table.addEventListener("mouseover", (e) => toggle(e, true));
  table.addEventListener("mouseout", (e) => toggle(e, false));
}

async function loadRef(ref) {
  const entry = state.manifest.find((e) => e.ref === ref);
  if (!entry) return;
  state.report = await fetchJSON(`data/${entry.file}`);
  state.expandedCategories = new Set();
  state.expandedSeries = new Set();
  document.getElementById("commit-info").textContent =
    `${entry.ref} @ ${entry.zephyr_commit.slice(0, 12)} \u2014 generated ${formatTimestampParis(entry.generated_at)}`;

  // Older refs scanned before the hal_stm32-based classification existed
  // have no not_ported data at all, which would make the coverage % show a
  // misleading 100%/N/A everywhere; force stats off for those.
  if (!state.report.hal_stm32_commit) {
    setStatsVisible(false);
  }

  renderTable(state.report, state.search);
}

// Stats are opt-in and keyboard-only (press "s"): no checkbox. The grid
// itself always shows the plain supported/not_ported/absent comparison
// regardless (see aggregateStatus).
function setStatsVisible(visible) {
  state.showStats = visible;
}

async function init() {
  state.manifest = await fetchJSON("data/manifest.json");

  const select = document.getElementById("ref-select");
  for (const entry of state.manifest) {
    const opt = document.createElement("option");
    opt.value = entry.ref;
    opt.textContent = entry.ref;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    loadRef(select.value).catch(showError);
  });

  const search = document.getElementById("search-box");
  search.addEventListener("input", () => {
    state.search = search.value;
    if (state.report) renderTable(state.report, state.search);
  });

  // "s" toggles the Ported % stats, except while typing in a field (search
  // box, ref select), with a modifier held, or for a ref with no hal_stm32
  // classification data.
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "s" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (!state.report || !state.report.hal_stm32_commit) return;
    setStatsVisible(!state.showStats);
    renderTable(state.report, state.search);
  });

  if (state.manifest.length > 0) {
    select.value = state.manifest[0].ref;
    await loadRef(state.manifest[0].ref);
  }
}

function showError(err) {
  console.error(err);
  const container = document.getElementById("table-container");
  container.textContent = `Failed to load data: ${err.message}`;
}

init().catch(showError);
