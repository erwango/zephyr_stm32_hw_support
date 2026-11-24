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
// cells show the SoC count; click a cell to expand its SoC list)
// ---------------------------------------------------------------------

function renderSeriesTable(report) {
  const container = document.getElementById("series-table-container");
  container.replaceChildren();

  const cores = CORE_ORDER.filter((core) => report.series.some((s) => s.cores.includes(core)));
  const series = [...report.series].sort((a, b) => a.name.localeCompare(b.name));

  const wrapper = document.createElement("div");
  wrapper.className = "series-pivot-wrapper";

  const table = document.createElement("table");
  table.className = "series-pivot";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const coreHeader = document.createElement("th");
  coreHeader.textContent = "Core";
  coreHeader.className = "series-pivot-corner";
  headRow.appendChild(coreHeader);
  for (const s of series) {
    const th = document.createElement("th");
    th.title = s.name;
    const name = document.createElement("span");
    name.textContent = seriesShortName(s.name);
    th.appendChild(name);
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
  for (const core of cores) {
    const row = document.createElement("tr");
    const rowHeader = document.createElement("th");
    rowHeader.scope = "row";
    rowHeader.textContent = coreLabel(core);
    row.appendChild(rowHeader);

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
          renderSeriesTable(report);
        });
        if (expanded) expandedHere.push({ series: s, socs: socsWithCore });
      } else {
        td.className = "cell-absent";
        td.textContent = "\u2013";
      }
      row.appendChild(td);
    }
    tbody.appendChild(row);

    for (const { series: s, socs } of expandedHere) {
      const detailRow = document.createElement("tr");
      detailRow.className = "detail-row";
      const td = document.createElement("td");
      td.colSpan = series.length + 1;
      const label = document.createElement("strong");
      label.textContent = `${s.name}: `;
      td.appendChild(label);
      td.appendChild(document.createTextNode(socs.map((soc) => soc.name).join(", ")));
      detailRow.appendChild(td);
      tbody.appendChild(detailRow);
    }
  }

  table.appendChild(tbody);

  wrapper.appendChild(table);
  container.appendChild(wrapper);
}


// ---------------------------------------------------------------------
// API coverage table (one row per category, expandable to per-compatible)
// ---------------------------------------------------------------------

function buildCategoryRow(ref, series, category, apis, expanded) {
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
  td.colSpan = seriesCount + 3;
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

  const series = report.series.map((s) => s.name);
  const needle = filter.trim().toLowerCase();

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Group", "Category", "API"]) {
    const th = document.createElement("th");
    th.textContent = label;
    th.className = "col-header-text";
    headRow.appendChild(th);
  }
  for (const s of series) {
    const th = document.createElement("th");
    th.textContent = seriesShortName(s);
    th.title = s;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
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

    tbody.appendChild(buildCategoryRow(report.ref, series, category, apis, expanded));
    if (expanded) {
      for (const api of apis) {
        tbody.appendChild(buildApiDetailRow(report.ref, series, category, api));
      }
    }
  }
  table.appendChild(tbody);

  if (categoryCount === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No matching APIs.";
    container.appendChild(empty);
    return;
  }
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
    `${entry.ref} @ ${entry.zephyr_commit.slice(0, 12)} \u2014 generated ${entry.generated_at}`;

  renderSeriesTable(state.report);
  renderTable(state.report, state.search);
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
