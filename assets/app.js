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
  m4f: "Cortex-M4",
  m7: "Cortex-M7",
  m33: "Cortex-M33",
  m55: "Cortex-M55",
  a7: "Cortex-A7",
};

const CORE_ORDER = ["m0", "m0+", "m3", "m4", "m4f", "m7", "m33", "m55", "a7"];

function coreLabel(core) {
  return CORE_LABELS[core] || `Cortex-${core.toUpperCase()}`;
}

function coreSortIndex(core) {
  const i = CORE_ORDER.indexOf(core);
  return i === -1 ? CORE_ORDER.length : i;
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

function link(href, text, title) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  if (title) a.title = title;
  return a;
}

function cellClass(status) {
  return status === "supported" ? "cell-supported" : "cell-absent";
}

function cellLabel(status) {
  return status === "supported" ? "\u2713" : "";
}

function aggregateStatus(apis, seriesName) {
  return apis.some((api) => (api.series_support || {})[seriesName] === "supported")
    ? "supported"
    : "absent";
}

function matchesFilter(category, api, needle) {
  if (!needle) return true;
  return (
    api.compatible.toLowerCase().includes(needle) ||
    (api.title || "").toLowerCase().includes(needle) ||
    category.name.toLowerCase().includes(needle) ||
    category.group.toLowerCase().includes(needle)
  );
}

// ---------------------------------------------------------------------
// Series (grouped by Cortex core, with an expandable SoC list per series)
// ---------------------------------------------------------------------

function renderSeriesGroups(report) {
  const container = document.getElementById("series-table-container");
  container.replaceChildren();

  const groups = new Map(); // core label -> [{ series, core }]
  for (const s of report.series) {
    const cores = s.cores.length ? s.cores : ["?"];
    for (const core of cores) {
      const label = coreLabel(core);
      if (!groups.has(label)) {
        groups.set(label, { order: coreSortIndex(core), entries: [] });
      }
      groups.get(label).entries.push({ series: s, core });
    }
  }

  const labels = [...groups.keys()].sort(
    (a, b) => groups.get(a).order - groups.get(b).order || a.localeCompare(b)
  );

  const grid = document.createElement("div");
  grid.className = "series-groups";

  for (const label of labels) {
    const { entries } = groups.get(label);
    entries.sort((a, b) => a.series.name.localeCompare(b.series.name));

    const card = document.createElement("div");
    card.className = "core-group";

    const heading = document.createElement("h3");
    heading.textContent = `${label} `;
    const count = document.createElement("span");
    count.className = "core-group-count";
    count.textContent = `(${entries.length})`;
    heading.appendChild(count);
    card.appendChild(heading);

    const chipRow = document.createElement("div");
    chipRow.className = "series-chip-row";

    for (const { series, core } of entries) {
      const chipKey = `${core}::${series.name}`;
      const expanded = state.expandedSeries.has(chipKey);

      const chip = document.createElement("span");
      chip.className = "series-chip";
      chip.title = series.name;
      chip.addEventListener("click", () => {
        if (state.expandedSeries.has(chipKey)) {
          state.expandedSeries.delete(chipKey);
        } else {
          state.expandedSeries.add(chipKey);
        }
        renderSeriesGroups(report);
      });

      const chipText = document.createElement("span");
      chipText.textContent = `${seriesShortName(series.name)} \u00b7 ${series.socs.length} ${expanded ? "\u25be" : "\u25b8"}`;
      chip.appendChild(chipText);

      if (isMpuSeries(series.name)) {
        const badge = document.createElement("span");
        badge.className = "mpu-badge";
        badge.textContent = "MPU";
        badge.title =
          "Microprocessor: Zephyr targets this core; other on-chip cores (if any) are outside Zephyr's scope.";
        chip.appendChild(badge);
      }
      if (series.cores.length > 1) {
        const otherCores = series.cores.filter((c) => c !== core).map(coreLabel).join(", ");
        const dual = document.createElement("span");
        dual.className = "dual-core-badge";
        dual.textContent = "multi-core";
        dual.title = `Also available with: ${otherCores}`;
        chip.appendChild(dual);
      }

      chipRow.appendChild(chip);

      if (expanded) {
        const detail = document.createElement("div");
        detail.className = "soc-detail";
        detail.textContent = series.socs.join(", ");
        chipRow.appendChild(detail);
      }
    }

    card.appendChild(chipRow);
    grid.appendChild(card);
  }

  container.appendChild(grid);
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
  nameCell.textContent = `${apis.length} compatible${apis.length === 1 ? "" : "s"}`;
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

function buildApiDetailRow(ref, series, api) {
  const tr = document.createElement("tr");
  tr.className = "detail-row api-detail-row";

  tr.appendChild(document.createElement("td")); // group (blank, indented)
  tr.appendChild(document.createElement("td")); // category (blank, indented)

  const nameCell = document.createElement("td");
  nameCell.className = "api-name api-name-indent";
  nameCell.appendChild(
    link(bindingDocUrl(ref, api.binding_path), api.title || api.compatible, "Zephyr devicetree binding doc")
  );
  const compatLink = link(
    `${GITHUB_BLOB_BASE}${encodeURIComponent(ref)}/${api.binding_path}`,
    api.compatible,
    "Binding source on GitHub"
  );
  compatLink.className = "api-compat";
  nameCell.appendChild(compatLink);
  if (api.origin_category) {
    const origin = document.createElement("span");
    origin.className = "origin-tag";
    origin.textContent = `from ${api.origin_category}`;
    nameCell.appendChild(origin);
  }
  tr.appendChild(nameCell);

  for (const s of series) {
    const status = (api.series_support && api.series_support[s]) || "absent";
    const td = document.createElement("td");
    td.className = cellClass(status);
    td.textContent = cellLabel(status);
    if (status === "supported" && api.driver_paths && api.driver_paths.length) {
      td.title = api.driver_paths.join("\n");
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
  for (const category of report.categories) {
    if (category.baseline) continue; // metadata only, no coverage grid

    const apis = category.apis.filter((api) => matchesFilter(category, api, needle));
    if (apis.length === 0) continue;
    categoryCount += 1;

    const key = `${category.group}/${category.name}`;
    const expanded = needle !== "" || state.expandedCategories.has(key);

    tbody.appendChild(buildCategoryRow(report.ref, series, category, apis, expanded));
    if (expanded) {
      for (const api of apis) {
        tbody.appendChild(buildApiDetailRow(report.ref, series, api));
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
  container.appendChild(table);
}

async function loadRef(ref) {
  const entry = state.manifest.find((e) => e.ref === ref);
  if (!entry) return;
  state.report = await fetchJSON(`data/${entry.file}`);
  state.expandedCategories = new Set();
  state.expandedSeries = new Set();
  document.getElementById("commit-info").textContent =
    `${entry.ref} @ ${entry.zephyr_commit.slice(0, 12)} \u2014 generated ${entry.generated_at}`;
  renderSeriesGroups(state.report);
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
