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
  if (status === "driver") return "cell-driver";
  if (status === "dt-only") return "cell-dtonly";
  return "cell-absent";
}

function cellLabel(status) {
  if (status === "driver") return "\u2713";
  if (status === "dt-only") return "DT";
  return "\u00b7";
}

function renderSeriesMeta(report) {
  const root = document.getElementById("series-meta");
  root.replaceChildren();
  for (const s of report.series) {
    const card = document.createElement("div");
    card.className = "series-card";
    card.title = s.socs.join(", ");

    const name = document.createElement("strong");
    name.textContent = seriesShortName(s.name);
    const cores = document.createElement("div");
    cores.className = "series-cores";
    cores.textContent = s.cores.length ? s.cores.join(", ") : "?";
    const socs = document.createElement("div");
    socs.className = "series-socs";
    socs.textContent = `${s.socs.length} SoC${s.socs.length === 1 ? "" : "s"}`;

    card.append(name, cores, socs);
    root.appendChild(card);
  }
}

function buildApiRow(ref, series, api) {
  const tr = document.createElement("tr");

  const nameCell = document.createElement("td");
  nameCell.className = "api-name";
  nameCell.appendChild(blobLink(ref, api.binding_path, api.title || api.compatible));
  nameCell.appendChild(document.createElement("br"));
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
    if (status === "driver" && api.driver_paths && api.driver_paths.length) {
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

  for (const category of report.categories) {
    if (category.baseline) continue; // metadata only, no coverage grid

    const apis = category.apis.filter((api) => matchesFilter(category, api, needle));
    if (apis.length === 0) continue;

    const section = document.createElement("section");
    section.className = "category-section";

    const heading = document.createElement("h3");
    heading.textContent = `${category.name} (${category.group})`;
    section.appendChild(heading);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const nameHeader = document.createElement("th");
    nameHeader.textContent = "API";
    headRow.appendChild(nameHeader);
    for (const s of series) {
      const th = document.createElement("th");
      th.textContent = seriesShortName(s);
      th.title = s;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const api of apis) {
      tbody.appendChild(buildApiRow(report.ref, series, api));
    }
    table.appendChild(tbody);

    section.appendChild(table);
    container.appendChild(section);
  }

  if (!container.hasChildNodes()) {
    const empty = document.createElement("p");
    empty.textContent = "No matching APIs.";
    container.appendChild(empty);
  }
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
