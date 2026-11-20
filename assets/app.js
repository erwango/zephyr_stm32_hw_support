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
  seriesSort: { key: "name", dir: 1 },
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
// Series table (sortable, with expandable SoC list)
// ---------------------------------------------------------------------

function sortSeriesRows(seriesList, sort) {
  const rows = [...seriesList];
  rows.sort((a, b) => {
    let av;
    let bv;
    if (sort.key === "cores") {
      av = [...a.cores].sort().join(",");
      bv = [...b.cores].sort().join(",");
    } else if (sort.key === "socs") {
      av = a.socs.length;
      bv = b.socs.length;
    } else {
      av = a.name;
      bv = b.name;
    }
    if (av < bv) return -1 * sort.dir;
    if (av > bv) return 1 * sort.dir;
    return a.name.localeCompare(b.name) * sort.dir;
  });
  return rows;
}

function renderSeriesTable(report) {
  const container = document.getElementById("series-table-container");
  container.replaceChildren();

  const table = document.createElement("table");
  table.className = "series-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const columns = [
    { key: "name", label: "Series" },
    { key: "cores", label: "Cortex core(s)" },
    { key: "socs", label: "SoCs" },
  ];
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.label;
    th.className = "sortable col-header-text";
    if (state.seriesSort.key === col.key) {
      th.textContent += state.seriesSort.dir === 1 ? " \u25b2" : " \u25bc";
    }
    th.addEventListener("click", () => {
      if (state.seriesSort.key === col.key) {
        state.seriesSort.dir *= -1;
      } else {
        state.seriesSort = { key: col.key, dir: 1 };
      }
      renderSeriesTable(report);
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const rows = sortSeriesRows(report.series, state.seriesSort);
  for (const s of rows) {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.className = "col-header-text";
    nameCell.textContent = seriesShortName(s.name);
    nameCell.title = s.name;
    tr.appendChild(nameCell);

    const coresCell = document.createElement("td");
    coresCell.className = "col-header-text";
    coresCell.textContent = s.cores.length ? s.cores.join(", ") : "?";
    tr.appendChild(coresCell);

    const socsCell = document.createElement("td");
    socsCell.className = "col-header-text soc-toggle";
    const expanded = state.expandedSeries.has(s.name);
    socsCell.textContent = `${s.socs.length} ${expanded ? "\u25be" : "\u25b8"}`;
    socsCell.addEventListener("click", () => {
      if (state.expandedSeries.has(s.name)) {
        state.expandedSeries.delete(s.name);
      } else {
        state.expandedSeries.add(s.name);
      }
      renderSeriesTable(report);
    });
    tr.appendChild(socsCell);

    tbody.appendChild(tr);

    if (expanded) {
      const detailTr = document.createElement("tr");
      detailTr.className = "detail-row";
      const detailTd = document.createElement("td");
      detailTd.colSpan = columns.length;
      detailTd.className = "soc-list";
      detailTd.textContent = s.socs.join(", ");
      detailTr.appendChild(detailTd);
      tbody.appendChild(detailTr);
    }
  }
  table.appendChild(tbody);
  container.appendChild(table);
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
