/* global document, window, location, fetch, URLSearchParams, EventSource, FormData, navigator, setInterval */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const model = {
  loaded: new Set(),
  graphCursor: undefined,
  iterationCursor: undefined,
  evidenceCursor: undefined,
  findingCursor: undefined,
  csrfToken: undefined,
  eventSource: undefined,
  pendingApprovals: new Set(),
  liveByKey: new Map(),
  heartbeatByRun: new Map(),
  unknownRuns: new Set(),
  approvalById: new Map(),
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

async function apiWrite(path, body) {
  if (!model.csrfToken) {
    const session = await api("/api/v1/session");
    model.csrfToken = session.csrf_token;
  }
  const response = await fetch(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-harness-csrf": model.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload.detail || payload.title || `Request failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

function short(value, length = 18) {
  const text = String(value ?? "—");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function presentationFor(presentations, record, digest = record?.digest) {
  if (!presentations || !record?.id) return undefined;
  return presentations[`${record.id}@${digest || "live"}`];
}

function technicalPresentation(record, digest = record?.digest) {
  return {
    entity_id: record?.id || "unknown_entity",
    binding_digest: digest || null,
    title_zh: record?.id || "未知对象",
    description_zh: "业务描述暂未提供；以下保留原始技术记录。",
    type_label_zh: record?.type || "未知类型",
    status_label_zh: record?.status || "未知状态",
    technical_type: record?.type || "Unknown",
    technical_status: record?.status || "unknown",
    badges: [],
    fallback: true,
  };
}

function businessBadges(presentation) {
  const list = node("ul", "business-badges");
  for (const badge of presentation?.badges || []) {
    const item = node("li", "business-badge");
    item.dataset.tone = badge.tone || "neutral";
    item.append(node("span", "business-badge-label", badge.label_zh), node("b", "", badge.value));
    list.append(item);
  }
  return list;
}

function businessHeading(presentation, titleTag = "strong") {
  const wrapper = node("div", "business-heading");
  const meta = node("div", "business-meta");
  meta.append(
    node("span", "business-type", presentation.type_label_zh),
    node("span", "technical-type", presentation.technical_type),
    node("span", "business-status", presentation.status_label_zh),
    node("span", "technical-status", presentation.technical_status),
  );
  wrapper.append(
    meta,
    node(titleTag, "business-title", presentation.title_zh),
    node("p", "business-description", presentation.description_zh),
  );
  if (presentation.badges?.length) wrapper.append(businessBadges(presentation));
  return wrapper;
}

function copyFeedback(message) {
  const output = $("#copy-status");
  if (output) output.textContent = message;
}

async function copyDigest(button, digest, title) {
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      throw new Error("clipboard unavailable");
    }
    await navigator.clipboard.writeText(digest);
    copyFeedback(`已复制“${title}”的完整摘要。`);
    button.textContent = "已复制";
  } catch {
    const details = button.closest("details");
    if (details) details.open = true;
    copyFeedback(`无法自动复制“${title}”的摘要；完整值已显示，可手动选择。`);
  }
}

function auditDetails(presentation, fields = []) {
  const details = node("details", "audit-details");
  const digest = presentation.binding_digest;
  const summary = node(
    "summary",
    "audit-summary",
    digest ? `审计信息 · ${short(digest, 12)}` : "审计信息",
  );
  const table = node("dl", "audit-table");
  for (const [label, value] of fields) table.append(...pair(label, value));
  if (digest) {
    const term = node("dt", "", "DIGEST");
    const value = node("dd", "audit-digest");
    const code = node("code", "digest-full", digest);
    code.tabIndex = 0;
    const copy = node("button", "digest-copy", "复制完整摘要");
    copy.type = "button";
    copy.setAttribute("aria-label", `复制“${presentation.title_zh}”的完整摘要`);
    copy.addEventListener("click", () => void copyDigest(copy, digest, presentation.title_zh));
    value.append(code, copy);
    table.append(term, value);
  }
  details.append(summary, table);
  return details;
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
    model.pendingApprovals = new Set(project.pending_approvals || []);
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

function graphCard(record, presentations) {
  const button = node("button", "node-card");
  button.type = "button";
  const presentation = presentationFor(presentations, record) || technicalPresentation(record);
  button.append(businessHeading(presentation));
  button.addEventListener("click", () => inspectNode(record, presentation));
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
      for (const record of page.items) register.append(graphCard(record, page.presentations));
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

async function inspectNode(record, presentation) {
  const inspector = $("#graph-inspector");
  clear(inspector);
  inspector.append(
    node("span", "crosshair"),
    businessHeading(presentation, "h3"),
    auditDetails(presentation, [
      ["ID", record.id],
      ["REVISION", record.revision],
      ["SOURCE", record.source],
      ["ITERATION", record.provenance?.iteration_id],
      ["LOCATOR", record.locator],
    ]),
  );
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

async function loadSemanticProposals() {
  const output = $("#semantic-proposal-list");
  clear(output);
  try {
    const page = await api("/api/v1/semantic-proposals?limit=50");
    if (page.items.length === 0) {
      output.append(node("p", "", "No semantic proposals staged."));
      return;
    }
    for (const proposal of page.items) {
      const card = node("article", "evidence-card semantic-proposal");
      card.append(
        node("span", "kind", `SCORE ${(proposal.score / 1_000_000).toFixed(3)}`),
        node("strong", "", `${proposal.source_node_id} → ${proposal.candidate_node_id}`),
        node("p", "", proposal.reason),
        node("code", "approval-command", proposal.approve_command),
      );
      output.append(card);
    }
  } catch (error) {
    output.append(node("p", "", "Semantic proposal register unavailable."));
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

function liveKey(item) {
  return item.event.observation_key || item.event.payload?.observation_key || item.id;
}

function liveTime(timestamp) {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime())
    ? "--:--:--"
    : parsed.toLocaleTimeString([], { hour12: false });
}

function liveSummary(event) {
  const payload = event.payload || {};
  switch (event.event_type) {
    case "PhaseStarted":
      return `${payload.phase || "phase"} started`;
    case "PhaseCompleted":
      return `${payload.phase || "phase"} completed`;
    case "PhasePaused":
      return `${payload.phase || "phase"} paused · ${payload.status || "waiting"}`;
    case "GateStarted":
      return `${payload.gate_id || "gate"} started`;
    case "GateCompleted":
      return `${payload.gate_id || "gate"} · ${payload.passed ? "passed" : "failed"}`;
    case "RunStarted":
      return `${payload.run_id || "run"} started`;
    case "RunHeartbeat":
      return `${payload.run_id || "run"} ${payload.status === "unknown" ? "status unknown" : "heartbeat"}`;
    case "RunOutputSummary":
      return `${payload.run_id || "run"} · ${short(payload.summary, 72)}`;
    case "BudgetUpdated":
      return `budget · ${payload.total_tokens ?? payload.used_tokens ?? "unmetered"} tokens`;
    case "ApprovalRequired":
      return `${payload.request_id || "approval"} requires a decision`;
    default:
      return event.event_type;
  }
}

function updateSwimlane(event) {
  const phase = event.payload?.phase;
  if (typeof phase !== "string") return;
  const marker = $(`[data-live-phase="${phase}"]`);
  if (!marker) return;
  marker.classList.remove("is-active", "is-complete", "is-paused");
  if (event.event_type === "PhaseStarted") marker.classList.add("is-active");
  if (event.event_type === "PhaseCompleted") marker.classList.add("is-complete");
  if (event.event_type === "PhasePaused") marker.classList.add("is-paused");
}

function appendLiveItem(item) {
  const register = $("#live-register");
  const key = liveKey(item);
  const previous = model.liveByKey.get(key);
  const row = node("li", `live-event ${item.authoritative ? "is-authoritative" : "is-live"}`);
  row.append(
    node("time", "", liveTime(item.event.timestamp)),
    node("span", "live-source", item.authoritative ? "LEDGER" : "LIVE"),
    node("strong", "", item.event.event_type),
    node("span", "live-copy", liveSummary(item.event)),
  );
  if (previous) previous.replaceWith(row);
  else register.prepend(row);
  model.liveByKey.set(key, row);
  while (register.children.length > 100) register.lastElementChild?.remove();
  updateSwimlane(item.event);
}

async function approvalDetails(item) {
  const payload = item.event.payload || {};
  const requestId = payload.request_id;
  if (typeof requestId !== "string") return;
  if (!model.pendingApprovals.has(requestId)) {
    await loadOverview();
    if (!model.pendingApprovals.has(requestId)) return;
  }
  const previous = model.approvalById.get(requestId) || {};
  const merged = {
    ...previous,
    ...payload,
    workflow_operation_id: item.event.workflow_operation_id,
  };
  model.approvalById.set(requestId, merged);
  renderApproval(merged);
}

function approvalField(label, value) {
  const wrapper = node("div", "approval-field");
  wrapper.append(node("span", "", label), node("strong", "", value || "—"));
  return wrapper;
}

function renderApproval(approval) {
  const card = $("#approval-card");
  clear(card);
  card.append(
    node("p", "eyebrow", approval.risk ? `${approval.risk} risk` : "approval required"),
    node("h4", "", approval.object_type || "Governed object"),
    approvalField("REQUEST", approval.request_id),
    approvalField("OBJECT", approval.object_id),
    approvalField("DIGEST", approval.object_digest),
    approvalField("REQUEST ACTOR", approval.proposed_by || "unknown"),
    node("p", "approval-reason", approval.reason || "A governed decision is required."),
  );
  const form = node("form", "approval-form");
  const label = node("label", "");
  label.append(node("span", "", "DECISION ACTOR"));
  const input = node("input");
  input.name = "actor";
  input.required = true;
  input.autocomplete = "off";
  input.placeholder = "human:reviewer";
  label.append(input);
  const actions = node("div", "approval-actions");
  for (const decision of approval.allowed_decisions || ["approve", "reject", "defer"]) {
    const button = node("button", `decision decision-${decision}`, decision.toUpperCase());
    button.type = "submit";
    button.value = decision;
    button.name = "decision";
    actions.append(button);
  }
  form.append(label, actions);
  form.addEventListener("submit", (event) => void decideApproval(event, approval));
  card.append(form);
}

async function decideApproval(event, approval) {
  event.preventDefault();
  const submitter = event.submitter;
  const actor = new FormData(event.currentTarget).get("actor")?.toString().trim();
  if (!actor || !submitter?.value) return;
  status("live", `Recording ${submitter.value} for ${approval.request_id}…`);
  try {
    const result = await apiWrite(
      `/api/v1/approvals/${encodeURIComponent(approval.request_id)}/decision`,
      {
        decision: submitter.value,
        expected_digest: approval.object_digest,
        actor,
      },
    );
    model.pendingApprovals.delete(approval.request_id);
    const card = $("#approval-card");
    clear(card);
    card.append(node("p", "eyebrow", "DECISION RECORDED"), node("h4", "", result.decision));
    if (result.decision === "approve" && result.workflow_digest) {
      const resume = node("button", "command", "RESUME WORKFLOW");
      resume.type = "button";
      resume.addEventListener(
        "click",
        () => void resumeWorkflow(result.workflow_operation_id, result.workflow_digest, actor),
      );
      card.append(resume);
    } else {
      card.append(node("p", "", "Ledger readback accepted the actor and expected digest."));
    }
    status("live", `Decision ${result.decision} committed by ${actor}`);
    await loadOverview();
  } catch (error) {
    status(
      "live",
      error.status === 409
        ? "Target changed. Project state refreshed; review again."
        : error.message,
      "error",
    );
    if (error.status === 409) await loadOverview();
  }
}

async function resumeWorkflow(workflowId, workflowDigest, actor) {
  status("live", `Resuming ${workflowId} from its committed checkpoint…`);
  try {
    const result = await apiWrite(`/api/v1/workflows/${encodeURIComponent(workflowId)}/resume`, {
      expected_digest: workflowDigest,
      actor,
    });
    status("live", `Resume settled as ${result.status || "advanced"}`);
    await loadOverview();
  } catch (error) {
    status(
      "live",
      error.status === 409 ? "Workflow changed. Project state refreshed." : error.message,
      "error",
    );
    if (error.status === 409) await loadOverview();
  }
}

function receiveLive(message) {
  let item;
  try {
    item = JSON.parse(message.data);
  } catch {
    status("live", "The live stream returned an invalid event.", "error");
    return;
  }
  appendLiveItem(item);
  const payload = item.event.payload || {};
  if (item.event.event_type === "RunStarted" || item.event.event_type === "RunHeartbeat") {
    if (typeof payload.run_id === "string") {
      model.heartbeatByRun.set(payload.run_id, Date.now());
      model.unknownRuns.delete(payload.run_id);
    }
  }
  if (item.event.event_type === "ApprovalRequired") void approvalDetails(item);
  status("live", `${item.authoritative ? "Ledger" : "Live"} event · ${item.event.event_type}`);
}

function startLive() {
  if (model.eventSource) return;
  status("live", "Connecting to the unified event stream…");
  const source = new EventSource("/events");
  model.eventSource = source;
  for (const type of [
    "PhaseStarted",
    "PhaseCompleted",
    "PhasePaused",
    "GateStarted",
    "GateCompleted",
    "RunStarted",
    "RunHeartbeat",
    "RunOutputSummary",
    "BudgetUpdated",
    "ApprovalRequired",
  ])
    source.addEventListener(type, receiveLive);
  source.addEventListener("stream_reset", () => {
    source.close();
    model.eventSource = undefined;
    model.liveByKey.clear();
    clear($("#live-register"));
    status("live", "Live cursor rotated; authoritative snapshot refreshed.", "empty");
    void loadOverview().then(startLive);
  });
  source.addEventListener("stream_error", () => {
    status("live", "Event stream is temporarily unavailable.", "error");
  });
  source.onopen = () => {
    setText("#connection-label", "LIVE / LOCAL");
    status("live", "Unified event stream connected");
  };
  source.onerror = () => {
    setText("#connection-label", "RECONNECTING");
  };
}

function markUnknownRuns() {
  const now = Date.now();
  for (const [runId, heartbeat] of model.heartbeatByRun) {
    if (now - heartbeat <= 15_000 || model.unknownRuns.has(runId)) continue;
    model.unknownRuns.add(runId);
    const item = {
      id: `local:unknown:${runId}`,
      authoritative: false,
      event: {
        event_type: "RunHeartbeat",
        timestamp: new Date(now).toISOString(),
        observation_key: `local_unknown_${runId}`,
        payload: { run_id: runId, status: "unknown" },
      },
    };
    appendLiveItem(item);
    status("live", `${runId} has no heartbeat for 15s · status unknown`, "empty");
  }
}

const loaders = {
  overview: loadOverview,
  graph: loadGraph,
  impact: async () => {
    status("impact", "Enter two Harness node ids.");
    await loadSemanticProposals();
  },
  iterations: loadIterations,
  evidence: loadEvidence,
  findings: loadFindings,
  live: async () => startLive(),
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
setInterval(markUnknownRuns, 5_000);
void activate(location.hash.slice(1) || "overview");
