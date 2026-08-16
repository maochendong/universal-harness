/* global document, window, location, fetch, URLSearchParams, setInterval */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const model = {
  loaded: new Set(),
  graphCursor: undefined,
  iterationCursor: undefined,
  evidenceCursor: undefined,
  findingCursor: undefined,
};

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function clear(element) {
  element.replaceChildren();
}

function status(view, message, tone = "ready") {
  const line = $(`[data-state="${view}"]`);
  if (!line) return;
  line.textContent = message;
  line.dataset.tone = tone;
}

async function api(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || payload.title || `Request failed (${response.status})`);
  }
  return payload.data;
}

function short(value, length = 18) {
  const text = String(value ?? "—");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = String(value ?? "—");
}

async function loadOverview() {
  status("overview", "Loading project summary…");
  try {
    const project = await api("/api/v1/project");
    setText("#project-name", project.name);
    setText("#repository-label", `REPOSITORY ${project.repository_id}`);
    setText("#project-next-action", project.next_action);
    setText("#metric-operations", project.committed_operations);
    setText(
      "#metric-tasks",
      project.task_progress
        ? `${project.task_progress.completed} / ${project.task_progress.total}`
        : "0 / 0",
    );
    const coverage = project.evaluation_coverage || { evaluated: 0, total: 0 };
    setText("#metric-evaluation", `${coverage.evaluated} / ${coverage.total}`);
    const openGroups = (project.finding_groups || []).filter((group) => group.open_count > 0);
    setText("#metric-findings", openGroups.length);
    setText("#iteration-state", project.iteration?.state || "NONE");
    setText(
      "#iteration-identity",
      project.iteration
        ? `${project.iteration.id} · ${project.next_action}`
        : "No active iteration.",
    );
    setText("#cache-state", String(project.graph_cache).toUpperCase());
    setText(
      "#cache-copy",
      project.graph_cache === "ok"
        ? "Projection digest and SQLite integrity checks agree."
        : `Projection reports ${project.graph_cache}.`,
    );
    setText("#control-level", String(project.control_level).toUpperCase());
    const signals = $("#project-signals");
    clear(signals);
    for (const entry of [
      `${project.blockers?.length || 0} blockers`,
      `${project.pending_approvals?.length || 0} pending approvals`,
      `${project.stale_evidence?.length || 0} stale evidence`,
    ])
      signals.append(node("li", "", entry));
    status("overview", `Authoritative status loaded · ${project.last_ledger_operation}`);
  } catch (error) {
    status("overview", error.message, "error");
  }
}

function graphQuery(cursor) {
  const query = new URLSearchParams({ limit: "24" });
  const view = $("#graph-view").value;
  const type = $("#graph-type").value;
  const state = $("#graph-status").value;
  if (view) query.set("view", view);
  if (type) query.set("type", type);
  if (state) query.set("status", state);
  if (cursor) query.set("cursor", cursor);
  return query;
}

function graphCard(record) {
  const button = node("button", "node-card");
  button.type = "button";
  button.append(
    node("span", "kind", record.type),
    node("strong", "", record.id),
    node("span", "status", record.status),
  );
  button.addEventListener("click", () => inspectNode(record));
  return button;
}

async function loadGraph({ append = false } = {}) {
  status("graph", append ? "Loading next graph page…" : "Scanning graph page…");
  const register = $("#graph-list");
  if (!append) clear(register);
  try {
    const page = await api(
      `/api/v1/graph/nodes?${graphQuery(append ? model.graphCursor : undefined)}`,
    );
    if (!page.items.length && !append)
      status("graph", "No nodes match the selected filters.", "empty");
    else {
      for (const record of page.items) register.append(graphCard(record));
      status("graph", `${page.items.length} nodes loaded · expand one for its immediate field`);
    }
    model.graphCursor = page.next_cursor;
    $("#graph-more").hidden = !model.graphCursor;
  } catch (error) {
    status("graph", error.message, "error");
  }
}

function pair(label, value) {
  return [node("dt", "", label), node("dd", "", value ?? "—")];
}

async function inspectNode(record) {
  const inspector = $("#graph-inspector");
  clear(inspector);
  inspector.append(
    node("span", "crosshair"),
    node("p", "eyebrow", `${record.type} / REV ${record.revision}`),
    node("h3", "inspector-title", record.id),
  );
  const table = node("dl", "data-table");
  for (const [label, value] of [
    ["STATUS", record.status],
    ["SOURCE", record.source],
    ["ITERATION", record.provenance?.iteration_id],
    ["DIGEST", record.digest],
    ["LOCATOR", record.locator],
  ])
    table.append(...pair(label, value));
  inspector.append(table);
  status("graph", `Expanding one-hop neighborhood for ${record.id}…`);
  try {
    const field = await api(`/api/v1/graph/neighborhood/${encodeURIComponent(record.id)}?depth=1`);
    const neighbors = node("div", "neighbor-list");
    for (const neighbor of field.nodes.filter((item) => item.id !== record.id)) {
      neighbors.append(node("span", "", `${neighbor.type} · ${neighbor.id}`));
    }
    inspector.append(
      node("p", "plot-label", `${field.edges.length} EDGES / ${field.nodes.length} NODES`),
      neighbors,
    );
    status("graph", `Neighborhood loaded for ${record.id}`);
  } catch (error) {
    inspector.append(node("p", "state-line", error.message));
    status("graph", error.message, "error");
  }
}

async function traceImpact(event) {
  event.preventDefault();
  const from = $("#impact-from").value.trim();
  const to = $("#impact-to").value.trim();
  const output = $("#impact-output");
  clear(output);
  status("impact", `Tracing ${from} → ${to}…`);
  try {
    const path = await api(
      `/api/v1/graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&depth=10`,
    );
    const line = node("div", "trace-path");
    path.nodes.forEach((item, index) => {
      line.append(node("span", "trace-node", `${item.type} / ${item.id}`));
      const edge = path.edges[index];
      if (edge) line.append(node("span", "trace-edge", `— ${edge.type} →`));
    });
    output.append(line);
    status("impact", `${path.edges.length} governed relationships explain this path`);
  } catch (error) {
    output.append(node("p", "", "No explanation path could be rendered."));
    status("impact", error.message, "error");
  }
}

function iterationButton(record) {
  const button = node("button", "record-button");
  button.type = "button";
  button.append(
    node("span", "kind", `REV ${record.revision}`),
    node("strong", "", record.id),
    node("span", "status", record.iteration_state || record.status),
  );
  button.addEventListener("click", () => openIteration(record.id));
  return button;
}

async function loadIterations({ append = false } = {}) {
  const query = new URLSearchParams({ type: "Iteration", limit: "20" });
  if (append && model.iterationCursor) query.set("cursor", model.iterationCursor);
  const list = $("#iteration-list");
  if (!append) clear(list);
  status("iterations", "Loading iteration register…");
  try {
    const page = await api(`/api/v1/graph/nodes?${query}`);
    for (const record of page.items) list.append(iterationButton(record));
    model.iterationCursor = page.next_cursor;
    $("#iteration-more").hidden = !model.iterationCursor;
    status(
      "iterations",
      !page.items.length && !append
        ? "No iterations are recorded."
        : `${page.items.length} iteration records loaded`,
      !page.items.length && !append ? "empty" : "ready",
    );
  } catch (error) {
    status("iterations", error.message, "error");
  }
}

async function openIteration(id) {
  const detail = $("#iteration-detail");
  clear(detail);
  status("iterations", `Reading ${id}…`);
  try {
    const record = await api(`/api/v1/iterations/${encodeURIComponent(id)}`);
    detail.append(node("p", "eyebrow", "ITERATION DOSSIER"), node("h3", "", record.iteration.id));
    const grid = node("div", "dossier-grid");
    for (const [label, value] of [
      ["STATE", record.iteration.iteration_state],
      ["GRAPH NODES", record.graph.nodes.length],
      ["EVALUATIONS", record.evaluations.length],
    ]) {
      const cell = node("div");
      cell.append(node("span", "", label), node("strong", "", value));
      grid.append(cell);
    }
    const table = node("dl", "data-table");
    for (const [label, value] of [
      ["REVISION", record.iteration.revision],
      ["SOURCE", record.iteration.source],
      ["DIGEST", record.iteration.digest],
      ["TIMESTAMP", record.iteration.provenance?.timestamp],
    ])
      table.append(...pair(label, value));
    detail.append(grid, table);
    status("iterations", `${id} loaded with ${record.graph.edges.length} related edges`);
  } catch (error) {
    detail.append(node("p", "", "Iteration could not be loaded."));
    status("iterations", error.message, "error");
  }
}

function evidenceQuery(cursor) {
  const query = new URLSearchParams({ limit: "20" });
  const state = $("#evidence-status").value;
  const iteration = $("#evidence-iteration").value.trim();
  if (state) query.set("status", state);
  if (iteration) query.set("iteration", iteration);
  if (cursor) query.set("cursor", cursor);
  return query;
}

function evidenceRow(record, index) {
  const row = node("article", "evidence-row");
  const extension =
    record.extensions?.["harness.evaluation"] || record.extensions?.["harness.gate"] || {};
  row.append(
    node("span", "ordinal", String(index + 1).padStart(2, "0")),
    node("strong", "", record.id),
    node("span", "", `${record.status} / ${record.source}`),
    node(
      "span",
      "",
      extension.passed === undefined ? "VERDICT —" : extension.passed ? "PASSED" : "FAILED",
    ),
    node("span", "digest", short(record.digest, 24)),
  );
  return row;
}

async function loadEvidence({ append = false } = {}) {
  const list = $("#evidence-list");
  if (!append) clear(list);
  status("evidence", "Reading evidence bindings…");
  try {
    const page = await api(
      `/api/v1/evidence?${evidenceQuery(append ? model.evidenceCursor : undefined)}`,
    );
    const offset = list.children.length;
    page.items.forEach((record, index) => list.append(evidenceRow(record, offset + index)));
    model.evidenceCursor = page.next_cursor;
    $("#evidence-more").hidden = !model.evidenceCursor;
    status(
      "evidence",
      !page.items.length && !append
        ? "No Evidence nodes match this filter."
        : `${page.items.length} Evidence nodes loaded`,
      !page.items.length && !append ? "empty" : "ready",
    );
  } catch (error) {
    status("evidence", error.message, "error");
  }
}

function findingCard(group) {
  const card = node("article", "finding-card");
  card.classList.add(`severity-${group.severity}`);
  const header = node("header");
  header.append(node("span", "", group.severity), node("span", "", group.actionability));
  card.append(
    header,
    node("h3", "", group.rule),
    node("p", "", group.scope_prefix),
    node("p", "digest", `DIGEST ${short(group.membership_digest, 30)}`),
    node("strong", "finding-count", group.open_count),
  );
  card.title = (group.samples || []).join("\n");
  return card;
}

async function loadFindings({ append = false } = {}) {
  const query = new URLSearchParams({ limit: "20" });
  if (append && model.findingCursor) query.set("cursor", model.findingCursor);
  const list = $("#finding-list");
  if (!append) clear(list);
  status("findings", "Projecting Finding groups…");
  try {
    const page = await api(`/api/v1/finding-groups?${query}`);
    for (const group of page.items) list.append(findingCard(group));
    model.findingCursor = page.next_cursor;
    $("#finding-more").hidden = !model.findingCursor;
    status(
      "findings",
      !page.items.length && !append
        ? "No Finding groups are open."
        : `${page.items.length} governance groups loaded`,
      !page.items.length && !append ? "empty" : "ready",
    );
  } catch (error) {
    status("findings", error.message, "error");
  }
}

const loaders = {
  overview: loadOverview,
  graph: loadGraph,
  impact: async () => status("impact", "Enter two Harness node ids."),
  iterations: loadIterations,
  evidence: loadEvidence,
  findings: loadFindings,
};

async function activate(view) {
  const chosen = loaders[view] ? view : "overview";
  for (const link of $$(".nav-link")) {
    if (link.dataset.view === chosen) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const panel of $$("[data-panel]")) {
    const active = panel.dataset.panel === chosen;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  if (!model.loaded.has(chosen)) {
    model.loaded.add(chosen);
    await loaders[chosen]();
  }
}

$("#graph-controls").addEventListener("submit", (event) => {
  event.preventDefault();
  model.graphCursor = undefined;
  void loadGraph();
});
$("#graph-more").addEventListener("click", () => void loadGraph({ append: true }));
$("#impact-form").addEventListener("submit", (event) => void traceImpact(event));
$("#iteration-more").addEventListener("click", () => void loadIterations({ append: true }));
$("#evidence-controls").addEventListener("submit", (event) => {
  event.preventDefault();
  model.evidenceCursor = undefined;
  void loadEvidence();
});
$("#evidence-more").addEventListener("click", () => void loadEvidence({ append: true }));
$("#finding-more").addEventListener("click", () => void loadFindings({ append: true }));
window.addEventListener("hashchange", () => void activate(location.hash.slice(1) || "overview"));

function tick() {
  setText("#clock-label", new Date().toLocaleTimeString([], { hour12: false }));
}
tick();
setInterval(tick, 1000);
void activate(location.hash.slice(1) || "overview");
