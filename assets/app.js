"use strict";

const GITHUB_BLOB_BASE = "https://github.com/zephyrproject-rtos/zephyr/blob/";

const state = {
  manifest: [],
  report: null,
  search: "",
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

function blobLink(ref, path, text) {
  const a = document.createElement("a");
  a.href = `${GITHUB_BLOB_BASE}${encodeURIComponent(ref)}/${path}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  return a;
}

function cellClass(status) {
  return status === "supported" ? "cell-supported" : "cell-absent";
}

function cellLabel(status) {
  return status === "supported" ? "\u2713" : "";
}

function renderSeriesMeta(report) {
  const root = document.getElementById("series-meta");
  root.replaceChildren();
  for (const s of report.series) {
    const chip = document.createElement("span");
    chip.className = "series-chip";
    chip.title = s.socs.join(", ");
    chip.textContent = `${seriesShortName(s.name)} (${s.cores.length ? s.cores.join("/") : "?"}, ${s.socs.length} SoC)`;
    root.appendChild(chip);
  }
}

function buildApiRow(ref, series, category, api) {
  const tr = document.createElement("tr");

  const groupCell = document.createElement("td");
  groupCell.className = "col-group";
  groupCell.textContent = category.group;
  tr.appendChild(groupCell);

  const catCell = document.createElement("td");
  catCell.className = "col-category";
  catCell.textContent = category.name;
  tr.appendChild(catCell);

  const nameCell = document.createElement("td");
  nameCell.className = "api-name";
  nameCell.appendChild(blobLink(ref, api.binding_path, api.title || api.compatible));
  const compatSpan = document.createElement("span");
  compatSpan.className = "api-compat";
  compatSpan.textContent = api.compatible;
  nameCell.appendChild(compatSpan);
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

function matchesFilter(category, api, needle) {
  if (!needle) return true;
  return (
    api.compatible.toLowerCase().includes(needle) ||
    (api.title || "").toLowerCase().includes(needle) ||
    category.name.toLowerCase().includes(needle) ||
    category.group.toLowerCase().includes(needle)
  );
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
  let rowCount = 0;
  for (const category of report.categories) {
    if (category.baseline) continue; // metadata only, no coverage grid

    for (const api of category.apis) {
      if (!matchesFilter(category, api, needle)) continue;
      tbody.appendChild(buildApiRow(report.ref, series, category, api));
      rowCount += 1;
    }
  }
  table.appendChild(tbody);

  if (rowCount === 0) {
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
  document.getElementById("commit-info").textContent =
    `${entry.ref} @ ${entry.zephyr_commit.slice(0, 12)} \u2014 generated ${entry.generated_at}`;
  renderSeriesMeta(state.report);
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
