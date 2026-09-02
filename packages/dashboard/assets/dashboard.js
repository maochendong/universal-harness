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
  schedulerOperationId: undefined,
  schedulerView: undefined,
  // undefined = not loaded yet; null = unavailable. Active only when the
  // project Ledger carries an active connection (design §19.3).
  collaborationView: undefined,
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

function collaborationActive() {
  return model.collaborationView?.status === "active";
}

async function ensureConnection() {
  if (model.collaborationView === undefined) {
    try {
      model.collaborationView = await api("/api/v1/collaboration/connection");
    } catch {
      model.collaborationView = null;
    }
  }
  return model.collaborationView;
}

function renderConnectionCard(view) {
  const observed = $("#connection-observed");
  if (!view || view.status === "not_connected") {
    setText("#connection-state", "LOCAL");
    setText("#connection-copy", "No remote coordinator is connected; this project is local-only.");
    observed.hidden = true;
    return;
  }
  if (view.status !== "active") {
    setText("#connection-state", "DISCONNECTED");
    setText(
      "#connection-copy",
      `Ledger records ${view.connection?.connection_id ?? "a connection"} as disconnected; remote history stays on the Control Ref.`,
    );
    observed.hidden = true;
    return;
  }
  setText("#connection-state", "REMOTE");
  setText(
    "#connection-copy",
    `Connected to ${view.connection?.coordinator_origin ?? "coordinator"} · target ${view.connection?.target_ref ?? "—"}`,
  );
  observed.hidden = false;
  const remote = view.remote;
  observed.textContent =
    !remote || remote.status === "unreachable"
      ? "协调器暂不可达；以上为项目 Ledger 权威事实。"
      : `远程协调事实 · ${remote.status}${remote.stale ? " · 投影滞后于 Ledger" : ""} · 本地投影（observed_at ${remote.projection_observed_at}）`;
}

async function loadOverview() {
  status("overview", "Loading project summary…");
  try {
    const project = await api("/api/v1/project");
    renderConnectionCard(await ensureConnection());
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
      const neighborPresentation =
        presentationFor(field.presentations, neighbor) || technicalPresentation(neighbor);
      const item = node("article", "neighbor-card");
      item.append(businessHeading(neighborPresentation));
      neighbors.append(item);
    }
    const relations = node("div", "neighbor-relations");
    for (const edge of field.edges) {
      const edgePresentation =
        presentationFor(field.presentations, edge) || technicalPresentation(edge);
      const relation = node("div", "relation-chip");
      relation.append(
        node("strong", "", edgePresentation.type_label_zh),
        node("span", "", edgePresentation.technical_type),
      );
      relations.append(relation);
    }
    inspector.append(
      node("p", "plot-label", `${field.edges.length} EDGES / ${field.nodes.length} NODES`),
      relations,
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
      const itemPresentation =
        presentationFor(path.presentations, item) || technicalPresentation(item);
      const pathNode = node("article", "trace-node");
      pathNode.append(businessHeading(itemPresentation));
      line.append(pathNode);
      const edge = path.edges[index];
      if (edge) {
        const edgePresentation =
          presentationFor(path.presentations, edge) || technicalPresentation(edge);
        const pathEdge = node("span", "trace-edge");
        pathEdge.append(
          node("strong", "", edgePresentation.type_label_zh),
          node("small", "", edgePresentation.technical_type),
        );
        line.append(pathEdge);
      }
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
      const presentation =
        presentationFor(page.presentations, { id: proposal.edge_id }, proposal.preview_digest) ||
        technicalPresentation(
          { id: proposal.edge_id, type: "SemanticProposal", status: "pending" },
          proposal.preview_digest,
        );
      card.append(
        businessHeading(presentation, "h3"),
        auditDetails(presentation, [
          ["SOURCE", proposal.source_node_id],
          ["TARGET", proposal.candidate_node_id],
          ["SCORE", (proposal.score / 1_000_000).toFixed(3)],
          ["APPROVE", proposal.approve_command],
        ]),
      );
      output.append(card);
    }
  } catch (error) {
    output.append(node("p", "", "Semantic proposal register unavailable."));
    status("impact", error.message, "error");
  }
}

function iterationButton(record, presentations) {
  const button = node("button", "record-button");
  button.type = "button";
  const presentation = presentationFor(presentations, record) || technicalPresentation(record);
  button.append(businessHeading(presentation));
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
    for (const record of page.items) list.append(iterationButton(record, page.presentations));
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
    const presentation =
      presentationFor(record.presentations, record.iteration) ||
      technicalPresentation(record.iteration);
    detail.append(node("p", "eyebrow", "ITERATION DOSSIER"), businessHeading(presentation, "h3"));
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
    detail.append(
      grid,
      auditDetails(presentation, [
        ["ID", record.iteration.id],
        ["REVISION", record.iteration.revision],
        ["SOURCE", record.iteration.source],
        ["TIMESTAMP", record.iteration.provenance?.timestamp],
      ]),
    );
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

function evidenceRow(record, index, presentations) {
  const row = node("article", "evidence-row");
  const presentation = presentationFor(presentations, record) || technicalPresentation(record);
  row.append(
    node("span", "ordinal", String(index + 1).padStart(2, "0")),
    businessHeading(presentation),
    auditDetails(presentation, [
      ["ID", record.id],
      ["REVISION", record.revision],
      ["SOURCE", record.source],
      ["ITERATION", record.provenance?.iteration_id],
    ]),
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
    page.items.forEach((record, index) =>
      list.append(evidenceRow(record, offset + index, page.presentations)),
    );
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

function findingCard(group, presentations) {
  const card = node("article", "finding-card");
  card.classList.add(`severity-${group.severity}`);
  const presentation =
    presentationFor(presentations, { id: group.group_id }, group.membership_digest) ||
    technicalPresentation(
      { id: group.group_id, type: "FindingGroup", status: group.actionability },
      group.membership_digest,
    );
  card.append(
    businessHeading(presentation, "h3"),
    auditDetails(presentation, [
      ["GROUP ID", group.group_id],
      ["RULE", group.rule],
      ["SCOPE", group.scope_prefix],
      ["MEMBERS", group.member_count],
    ]),
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
    for (const group of page.items) list.append(findingCard(group, page.presentations));
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

const schedulerReasonLabels = {
  no_wave_assignment: "未绑定已批准波次",
  exclusive_resources: "声明了独占资源，按 Plan 串行",
};

const schedulerRecoveryLabels = {
  open_approval: "打开审批卡",
  submit_budget_policy_proposal: "提交预算 Policy Proposal，或缩小 Plan",
  inspect_retry: "检查自动恢复配额与失败证据",
  inspect_candidate_conflict: "检查候选分支与冲突路径",
  revise_plan_resources: "返回 Plan 修订资源声明",
  return_to_impact_and_plan: "返回 Impact / Plan 重新确认",
  open_gate_evidence_and_replan: "打开 Gate Evidence 并生成修复 Task",
  change_adapter_or_supervise: "更换 Adapter 或降级为监督单槽位",
};

function schedulerReason(reason) {
  if (schedulerReasonLabels[reason]) return schedulerReasonLabels[reason];
  const [kind, peer] = String(reason).split(":", 2);
  if (kind === "depends_on_wave_peer") return `依赖同波次 Task ${peer}`;
  if (kind === "write_path_overlap") return `与 ${peer} 的写路径重叠`;
  if (kind === "exclusive_resource_conflict") return `与 ${peer} 争用独占资源`;
  return reason;
}

function schedulerSource(authority) {
  const badge = node("span", `source-key source-${authority}`);
  badge.textContent =
    authority === "authoritative"
      ? "权威 / Ledger"
      : authority === "live"
        ? "实时 / Live"
        : "候选 / Provisional";
  return badge;
}

function schedulerAudit(task) {
  const details = node("details", "audit-details scheduler-audit");
  details.append(node("summary", "audit-summary", "技术详情"));
  const table = node("dl", "audit-table");
  table.append(...pair("TASK ID", task.task_id));
  if (task.current_run_id) table.append(...pair("RUN", task.current_run_id));
  if (task.technical_details?.lease_digest)
    table.append(...pair("LEASE DIGEST", task.technical_details.lease_digest));
  details.append(table);
  return details;
}

function schedulerPhaseState(task, phase) {
  const order = ["lease", "context", "execute", "verify", "integrate", "release"];
  const activeByStatus = {
    waiting_dependency: -1,
    ready: 0,
    awaiting_approval: 0,
    running: 2,
    verifying: 3,
    integration_queued: 4,
    candidate_validated: 4,
    retry_pending: 2,
    blocked: 2,
    cancelled: 5,
    integrated: 6,
  };
  const phaseIndex = order.indexOf(phase);
  const activeIndex = activeByStatus[task.status] ?? -1;
  if (task.status === "integrated" || task.status === "cancelled") return "complete";
  if (phaseIndex < activeIndex) return "complete";
  if (phaseIndex === activeIndex) return "active";
  return "pending";
}

function renderSchedulerTaskDetail(task) {
  const detail = $("#scheduler-task-detail");
  clear(detail);
  detail.append(node("span", "crosshair"), node("p", "eyebrow", "TASK DOSSIER"));
  const heading = node("h3", "", task.title);
  heading.id = "scheduler-detail-title";
  detail.append(heading, schedulerSource(task.authority));

  const timeline = node("ol", "scheduler-task-timeline");
  const phaseLabels = {
    lease: "Lease",
    context: "Context",
    execute: "Execute",
    verify: "Verify",
    integrate: "Integrate",
    release: "Release",
  };
  for (const [phase, label] of Object.entries(phaseLabels)) {
    const item = node("li", "", label);
    item.dataset.state = schedulerPhaseState(task, phase);
    timeline.append(item);
  }
  const dependencyCopy = task.dependency_ids.length ? task.dependency_ids.join("、") : "无前置依赖";
  const reasons = node("ul", "scheduler-reason-list");
  const reasonValues = task.non_parallel_reasons.length
    ? task.non_parallel_reasons.map(schedulerReason)
    : ["本 Task 在已批准波次内没有额外串行约束"];
  for (const reason of reasonValues) reasons.append(node("li", "", reason));
  const evidence = node("div", "scheduler-evidence-note");
  evidence.append(
    node("strong", "", "Assertions / Gates / Evidence"),
    node(
      "p",
      "",
      "状态只按 Ledger 证据投影；当前 Scheduler Read Model 未暴露逐项列表时，不以 Agent 自述补齐。",
    ),
    node(
      "p",
      "",
      "active_operation / read_branch：Provider 未提供；无法判定 mismatch、missing 或 stale 时，不把分支状态推断为安全。",
    ),
  );
  detail.append(
    node("p", "scheduler-task-status", `${task.status_label} · Wave ${task.wave_index + 1}`),
    timeline,
    node("p", "plot-label", `DEPENDENCIES · ${dependencyCopy}`),
    reasons,
    evidence,
    schedulerAudit(task),
  );
}

function schedulerTaskCard(task) {
  const button = node("button", `scheduler-task-card authority-${task.authority}`);
  button.type = "button";
  button.dataset.status = task.status;
  button.setAttribute("aria-label", `查看 Task：${task.title}`);
  const heading = node("span", "scheduler-task-heading");
  heading.append(node("strong", "", task.title), node("small", "", task.status_label));
  const dependencies = task.dependency_ids.length
    ? `依赖 ${task.dependency_ids.join("、")}`
    : "可独立启动";
  button.append(
    schedulerSource(task.authority),
    heading,
    node("span", "scheduler-task-deps", dependencies),
  );
  if (task.non_parallel_reasons.length)
    button.append(
      node("span", "scheduler-task-reason", schedulerReason(task.non_parallel_reasons[0])),
    );
  button.addEventListener("click", () => renderSchedulerTaskDetail(task));
  return button;
}

function renderSchedulerWaves(view) {
  const register = $("#scheduler-waves");
  clear(register);
  if (!view.waves.length) {
    register.append(node("p", "scheduler-empty", "当前 Profile 未激活并行 Task 波次。"));
    return;
  }
  for (const wave of view.waves) {
    const article = node("article", "scheduler-wave");
    if (wave.wave_index === view.summary.current_wave) article.classList.add("is-current");
    const header = node("header", "scheduler-wave-header");
    header.append(
      node("span", "scheduler-wave-index", String(wave.wave_index + 1).padStart(2, "0")),
      node("strong", "", `Wave ${wave.wave_index + 1}`),
      node("small", "", `${wave.tasks.length} Task`),
    );
    const tasks = node("div", "scheduler-wave-tasks");
    for (const task of wave.tasks) tasks.append(schedulerTaskCard(task));
    article.append(header, tasks);
    register.append(article);
  }
}

function renderSchedulerPool(view) {
  const pool = $("#scheduler-agent-pool");
  clear(pool);
  if (view.operation.live_state === "rebuilding") {
    const rebuilding = node("article", "scheduler-rebuilding");
    rebuilding.append(
      node("strong", "", "正在从 Ledger 重建"),
      node("p", "", "实时投影丢失；权威 Task 进度保持不变，当前不推断 Slot 成败。"),
    );
    pool.append(rebuilding);
    return;
  }
  if (!view.slots.length) {
    pool.append(node("p", "scheduler-empty", "没有活动 Agent Slot。"));
    return;
  }
  for (const slot of view.slots) {
    const task = view.tasks.find((candidate) => candidate.task_id === slot.task_id);
    const zombie =
      slot.state === "running" && task && !["running", "verifying"].includes(task.status);
    const card = node("article", `agent-slot slot-${slot.state}${zombie ? " is-zombie" : ""}`);
    const header = node("header", "");
    header.append(node("strong", "", slot.slot_id), schedulerSource("live"));
    card.append(
      header,
      node("p", "agent-slot-task", task?.title || slot.task_id || "等待 Task"),
      node("p", "agent-slot-run", slot.run_id ? `Run ${slot.run_id}` : "无活动 Run"),
      node(
        "p",
        "agent-slot-lease",
        task?.technical_details?.lease_digest
          ? "Lease 已绑定（digest 见 Task 技术详情）"
          : "Lease：Provider 未提供",
      ),
      node(
        "p",
        "agent-slot-observation",
        zombie
          ? "疑似僵尸进程 · 等待 Ledger 对账"
          : slot.observed_at || "heartbeat / observed_at：Provider 未提供",
      ),
      node("p", "agent-slot-usage", "steps / tokens / duration：Provider 未提供"),
      node("p", "agent-slot-worktree", "worktree：仅展示脱敏标识（当前未提供）"),
    );
    pool.append(card);
  }
}

async function schedulerApprovalDecision(approval, decision, card) {
  const actorInput = $("input", card);
  const actorValue = actorInput?.value.trim();
  if (!actorValue) {
    status("scheduler", "请输入可审计的审批人身份。", "error");
    actorInput?.focus();
    return;
  }
  status("scheduler", `正在提交 ${decision}：${approval.request_id}…`);
  try {
    const result = await apiWrite(
      `/api/v1/approvals/${encodeURIComponent(approval.request_id)}/decision`,
      {
        decision,
        expected_digest: approval.bindings.object_digest,
        actor: actorValue,
      },
    );
    card.dataset.decision = decision;
    const outcome = node("p", "scheduler-decision-recorded", "审批决议已写入 Ledger");
    card.append(outcome);
    if (decision === "approve") {
      if (result.workflow_operation_id && result.workflow_digest) {
        const resume = node("button", "command", "恢复 Operation");
        resume.type = "button";
        resume.addEventListener("click", async () => {
          resume.disabled = true;
          try {
            await apiWrite(
              `/api/v1/workflows/${encodeURIComponent(result.workflow_operation_id)}/resume`,
              { expected_digest: result.workflow_digest, actor: actorValue },
            );
            await loadScheduler();
            status("scheduler", "Operation 已恢复；正在刷新调度状态。", "ready");
          } catch (error) {
            status("scheduler", error.message, "error");
          } finally {
            resume.disabled = false;
          }
        });
        card.append(resume);
      } else {
        card.append(node("code", "scheduler-resume-command", approval.resume_command));
      }
    } else {
      await loadScheduler();
    }
  } catch (error) {
    status("scheduler", error.message, "error");
  }
}

function renderSchedulerApprovals(view) {
  const list = $("#scheduler-approvals");
  clear(list);
  if (!view.approvals.length) {
    list.append(node("p", "scheduler-empty", "当前没有待处理 Scheduler 审批。"));
    return;
  }
  for (const approval of view.approvals) {
    const card = node("article", "scheduler-approval-card");
    const heading = node("header", "");
    heading.append(
      node("strong", "", approval.objective),
      node("span", "risk-chip", approval.risk_label),
    );
    const form = node("form", "scheduler-approval-form");
    const label = node("label", "", "审批人身份");
    const input = node("input");
    input.name = "actor";
    input.required = true;
    input.placeholder = "human:operator";
    input.setAttribute("aria-label", `审批人身份：${approval.objective}`);
    label.append(input);
    const actions = node("div", "scheduler-approval-actions");
    for (const decision of approval.allowed_decisions) {
      const button = node(
        "button",
        `scheduler-decision decision-${decision}`,
        decision.toUpperCase(),
      );
      button.type = "button";
      button.addEventListener(
        "click",
        () => void schedulerApprovalDecision(approval, decision, card),
      );
      actions.append(button);
    }
    form.append(label, actions);
    const bindings = node("details", "audit-details");
    bindings.append(node("summary", "audit-summary", "审批绑定与恢复命令"));
    const table = node("dl", "audit-table");
    table.append(
      ...pair("ACTION", approval.action),
      ...pair("REASON", approval.reason),
      ...pair("OBJECT DIGEST", approval.bindings.object_digest),
      ...pair("BASELINE", approval.bindings.baseline_digest),
      ...pair("POLICY", approval.bindings.policy_digest),
      ...pair("RESUME", approval.resume_command),
    );
    bindings.append(table);
    card.append(heading, node("p", "", approval.reason), form, bindings);
    card.append(
      node(
        "p",
        "scheduler-provider-note",
        "write paths / 独占资源 / Adapter / 预算 / grounded brief：仅在权威 Read Model 提供时展示；当前未提供。",
      ),
    );
    list.append(card);
  }
}

function renderSchedulerFindings(view) {
  const list = $("#scheduler-findings");
  clear(list);
  if (!view.findings.length) {
    list.append(node("p", "scheduler-empty", "没有阻塞当前波次的 Finding。"));
    return;
  }
  for (const finding of view.findings) {
    const card = node("article", "scheduler-finding-card");
    card.append(
      node("strong", "", finding.summary),
      node("span", "scheduler-finding-rule", finding.rule || "未分类 Finding"),
      node(
        "p",
        "scheduler-recovery-action",
        schedulerRecoveryLabels[finding.recovery_action] || "打开 Finding 证据后处理",
      ),
    );
    list.append(card);
  }
}

function renderSchedulerSummary(view) {
  const currentWave = view.summary.current_wave;
  setText(
    "#scheduler-wave-metric",
    currentWave === null
      ? `完成 / ${view.summary.total_waves}`
      : `${currentWave + 1} / ${view.summary.total_waves}`,
  );
  setText("#scheduler-slot-metric", `${view.summary.running_slots} / ${view.summary.total_slots}`);
  setText(
    "#scheduler-task-metric",
    `${view.summary.task_progress.completed} / ${view.summary.task_progress.total}`,
  );
  setText(
    "#scheduler-control-metric",
    `${view.summary.blocking_findings} / ${view.summary.pending_approvals}`,
  );
  const budget = view.budget;
  const tokenLimit = Math.max(1, budget.limit.tokens);
  const usedPercent = Math.min(100, (budget.consumed_tokens / tokenLimit) * 100);
  const reservedPercent = Math.min(100 - usedPercent, (budget.reserved_tokens / tokenLimit) * 100);
  $("#scheduler-budget-used").style.width = `${usedPercent}%`;
  $("#scheduler-budget-reserved").style.width = `${reservedPercent}%`;
  $("#scheduler-budget-reserved").style.left = `${usedPercent}%`;
  setText(
    "#scheduler-budget-metric",
    `${budget.consumed_tokens + budget.reserved_tokens} / ${budget.limit.tokens} tokens`,
  );
  setText(
    "#scheduler-budget-copy",
    `已用 ${budget.consumed_steps} steps · 预留 ${budget.reserved_steps} steps · deadline ${budget.limit.duration_ms}ms`,
  );
  setText("#scheduler-live-state", view.operation.live_state_label);
}

async function loadScheduler() {
  status("scheduler", "正在读取 Ledger、Plan 与可丢弃实时投影…");
  try {
    if (!model.schedulerOperationId) {
      const project = await api("/api/v1/project");
      model.schedulerOperationId = project.scheduler_operation_id;
    }
    if (!model.schedulerOperationId) {
      throw new Error("当前项目还没有可读取的 Operation。");
    }
    const view = await api(
      `/api/v1/scheduler?operation_id=${encodeURIComponent(model.schedulerOperationId)}`,
    );
    model.schedulerView = view;
    renderSchedulerSummary(view);
    renderSchedulerWaves(view);
    renderSchedulerPool(view);
    renderSchedulerApprovals(view);
    renderSchedulerFindings(view);
    const selected =
      view.tasks.find((task) => task.wave_index === view.summary.current_wave) || view.tasks[0];
    if (selected) renderSchedulerTaskDetail(selected);
    status(
      "scheduler",
      view.operation.live_state === "rebuilding"
        ? "实时投影缺失；权威进度已从 Ledger 恢复。"
        : `Operation ${view.operation.operation_id} · ${view.tasks.length} Task`,
      view.operation.live_state === "rebuilding" ? "empty" : "ready",
    );
  } catch (error) {
    for (const target of [
      "#scheduler-waves",
      "#scheduler-agent-pool",
      "#scheduler-approvals",
      "#scheduler-findings",
    ])
      clear($(target));
    $("#scheduler-waves").append(node("p", "scheduler-empty", error.message));
    status("scheduler", error.message, "error");
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
  const presentation = presentationFor(item.presentations, item, null) || {
    ...technicalPresentation(
      {
        id: item.id,
        type: item.event.event_type,
        status: item.authoritative ? "authoritative" : "live",
      },
      null,
    ),
    title_zh: item.event.event_type,
    description_zh: liveSummary(item.event),
  };
  const heading = businessHeading(presentation);
  row.append(
    node("time", "", liveTime(item.event.timestamp)),
    node("span", "live-source", item.authoritative ? "LEDGER" : "LIVE"),
    heading,
  );
  if (item.event.event_type === "RunOutputSummary") {
    const payload = item.event.payload || {};
    const output = node("pre", "live-output-tail", payload.summary || "No output summary.");
    output.setAttribute("aria-label", "Agent output tail");
    const stream = payload.stream || "stdout";
    const observed = Number.isFinite(payload.bytes_observed)
      ? `${payload.bytes_observed} bytes`
      : "bytes unknown";
    const flags = [stream, observed];
    if (payload.truncated) flags.push("tail truncated");
    if (payload.final) flags.push("final flush");
    const meta = node("p", "live-output-meta", flags.join(" · "));
    row.append(output, meta);
  }
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
  const presentation =
    presentationFor(item.presentations, { id: requestId }, payload.object_digest) ||
    technicalPresentation(
      {
        id: requestId,
        type: payload.object_type || "ApprovalRequest",
        status: "pending",
      },
      payload.object_digest,
    );
  renderApproval(merged, presentation, { card: $("#approval-card"), view: "live" });
}

function renderApproval(approval, presentation, options) {
  const card = options.card;
  const view = options.view;
  clear(card);
  const authoritativeAuditPresentation = {
    ...presentation,
    binding_digest: approval.object_digest || null,
  };
  card.append(
    businessHeading(presentation, "h4"),
    auditDetails(authoritativeAuditPresentation, [
      ["REQUEST", approval.request_id],
      ["OBJECT", approval.object_id],
      ["OBJECT TYPE", approval.object_type],
      ["REQUEST ACTOR", approval.proposed_by || "unknown"],
      ["WORKFLOW", approval.workflow_operation_id],
    ]),
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
  form.addEventListener("submit", (event) => void decideApproval(event, approval, { card, view }));
  card.append(form);
}

async function decideApproval(event, approval, options) {
  event.preventDefault();
  const submitter = event.submitter;
  const actor = new FormData(event.currentTarget).get("actor")?.toString().trim();
  if (!actor || !submitter?.value) return;
  // M3: with an active Ledger connection the decision is submitted to the
  // Coordinator (design §18.1); otherwise the local digest-bound path is kept.
  const remote = collaborationActive();
  status(options.view, `Recording ${submitter.value} for ${approval.request_id}…`);
  try {
    const result = await apiWrite(
      remote
        ? `/api/v1/collaboration/approvals/${encodeURIComponent(approval.request_id)}/decision`
        : `/api/v1/approvals/${encodeURIComponent(approval.request_id)}/decision`,
      remote
        ? { decision: submitter.value }
        : { decision: submitter.value, expected_digest: approval.object_digest, actor },
    );
    const recorded = remote ? result.decision?.decision : result.decision;
    if (recorded !== "defer") model.pendingApprovals.delete(approval.request_id);
    const card = options.card;
    clear(card);
    card.append(
      node("p", "eyebrow", remote ? "远程协调事实" : "DECISION RECORDED"),
      node("h4", "", recorded),
    );
    if (remote) {
      card.append(
        node(
          "p",
          "",
          `已通过协调器提交 · 本地投影（observed_at ${result.projection_observed_at}）；物化进项目 Ledger 需等待 sync。`,
        ),
      );
    } else if (result.decision === "approve" && result.workflow_digest) {
      const resume = node("button", "command", "RESUME WORKFLOW");
      resume.type = "button";
      resume.addEventListener(
        "click",
        () =>
          void resumeWorkflow(result.workflow_operation_id, result.workflow_digest, actor, {
            view: options.view,
            card,
          }),
      );
      card.append(resume);
    } else {
      card.append(node("p", "", "Ledger readback accepted the actor and expected digest."));
    }
    status(options.view, `Decision ${recorded} committed by ${actor}`);
    await loadOverview();
    if (recorded === "defer" && options.view === "approvals") await loadApprovals();
  } catch (error) {
    status(
      options.view,
      error.status === 409
        ? "Target changed. Project state refreshed; review again."
        : error.message,
      "error",
    );
    if (error.status === 409) {
      await loadOverview();
      if (options.view === "approvals") await loadApprovals();
    }
  }
}

async function resumeWorkflow(workflowId, workflowDigest, actor, options = { view: "live" }) {
  status(options.view, `Resuming ${workflowId} from its committed checkpoint…`);
  try {
    const result = await apiWrite(`/api/v1/workflows/${encodeURIComponent(workflowId)}/resume`, {
      expected_digest: workflowDigest,
      actor,
    });
    status(options.view, `Resume settled as ${result.status || "advanced"}`);
    await loadOverview();
    if (options.view === "approvals") await loadApprovals();
  } catch (error) {
    status(
      options.view,
      error.status === 409 ? "Workflow changed. Project state refreshed." : error.message,
      "error",
    );
    if (error.status === 409) await loadOverview();
  }
}

async function loadApprovals() {
  const queue = $("#approval-queue");
  status("approvals", "Reading committed ApprovalRequest and ApprovalDecision records…");
  try {
    const page = await api("/api/v1/approvals?limit=500");
    clear(queue);
    model.pendingApprovals = new Set(page.items.map((approval) => approval.request_id));
    setText("#approval-count", `${page.items.length} pending`);
    if (page.items.length === 0) {
      const empty = node("article", "approval-empty");
      empty.append(
        node("p", "eyebrow", "QUEUE CLEAR"),
        node("h3", "", "当前没有待审批请求"),
        node(
          "p",
          "",
          "当工作流在需求基线、影响范围或执行授权边界暂停时，权威审批请求会出现在这里。",
        ),
      );
      queue.append(empty);
      status("approvals", "No committed approval request is pending.", "empty");
      return;
    }
    for (const approval of page.items) {
      const card = node("article", "approval-card approval-queue-card");
      const presentation =
        presentationFor(page.presentations, { id: approval.request_id }, approval.object_digest) ||
        technicalPresentation(
          {
            id: approval.request_id,
            type: approval.object_type || "ApprovalRequest",
            status: "pending",
          },
          approval.object_digest,
        );
      model.approvalById.set(approval.request_id, approval);
      renderApproval(approval, presentation, { card, view: "approvals" });
      queue.append(card);
    }
    status("approvals", `${page.items.length} authoritative approval request(s) loaded.`);
  } catch (error) {
    clear(queue);
    queue.append(node("p", "approval-load-error", error.message));
    status("approvals", error.message, "error");
  }
}

function remoteDecisionCard(decision) {
  const card = node("article", "approval-card approval-queue-card remote-fact-card");
  card.append(
    node("p", "eyebrow", "远程协调事实"),
    node("h4", "", `${decision.decision ?? "—"} · ${decision.request_id ?? "unknown request"}`),
    auditDetails(
      {
        ...technicalPresentation(
          {
            id: decision.remote_decision_id || decision.request_id || "remote_decision",
            type: "RemoteApprovalDecision",
            status: decision.decision || "recorded",
          },
          decision.object_digest,
        ),
        binding_digest: decision.object_digest || null,
      },
      [
        ["REQUEST", decision.request_id],
        ["OPERATION", decision.operation_id],
        ["OBJECT", decision.object_id],
        ["DECIDED AT", decision.decided_at],
        ["REQUIRED PERMISSION", decision.required_permission],
      ],
    ),
  );
  return card;
}

async function loadRemoteInbox() {
  const heading = $("#remote-inbox-heading");
  const inbox = $("#remote-inbox");
  clear(inbox);
  if (!collaborationActive()) {
    heading.hidden = true;
    return;
  }
  heading.hidden = false;
  setText("#remote-inbox-observed", "正在读取协调器投影…");
  try {
    const view = await api("/api/v1/collaboration/approvals");
    setText("#remote-inbox-observed", `本地投影（observed_at ${view.projection_observed_at}）`);
    if (!view.decisions.length) {
      inbox.append(node("p", "projection-note", "协调器收件箱中没有远程审批决议。"));
      return;
    }
    for (const decision of view.decisions) inbox.append(remoteDecisionCard(decision));
  } catch (error) {
    setText("#remote-inbox-observed", `协调器收件箱不可用：${error.message}`);
  }
}

async function retryIntegration(integrationId, button) {
  button.disabled = true;
  status("approvals", `Retrying integration ${integrationId} after human resolution…`);
  try {
    const result = await apiWrite(
      `/api/v1/collaboration/integrations/${encodeURIComponent(integrationId)}/retry`,
      {},
    );
    status(
      "approvals",
      `Integration ${integrationId} accepted · target now at ${short(result.target_commit, 12)}`,
    );
    await loadConflicts();
  } catch (error) {
    button.disabled = false;
    status("approvals", error.message, "error");
  }
}

function conflictCard(conflict) {
  const card = node("article", "approval-card approval-queue-card remote-fact-card");
  card.append(
    node("p", "eyebrow", "远程协调事实"),
    node("h4", "", conflict.integration_id),
    auditDetails(
      technicalPresentation(
        {
          id: conflict.integration_id || "integration_unknown",
          type: "IntegrationRecord",
          status: "conflict",
        },
        null,
      ),
      [
        ["OPERATION", conflict.operation_id],
        ["EXPECTED TARGET", conflict.expected_target_commit],
        ["OPERATION COMMIT", conflict.operation_commit],
      ],
    ),
  );
  const retry = node("button", "command", "RESOLVE MANUALLY THEN RETRY");
  retry.type = "button";
  retry.addEventListener("click", () => void retryIntegration(conflict.integration_id, retry));
  card.append(retry);
  return card;
}

async function loadConflicts() {
  const heading = $("#conflict-heading");
  const list = $("#conflict-list");
  clear(list);
  if (!collaborationActive()) {
    heading.hidden = true;
    return;
  }
  heading.hidden = false;
  setText("#conflict-observed", "正在读取协调器投影…");
  try {
    const view = await api("/api/v1/collaboration/conflicts");
    setText("#conflict-observed", `本地投影（observed_at ${view.projection_observed_at}）`);
    if (!view.conflicts.length) {
      list.append(node("p", "projection-note", "没有待人工解决的 Integration 冲突。"));
      return;
    }
    for (const conflict of view.conflicts) list.append(conflictCard(conflict));
  } catch (error) {
    setText("#conflict-observed", `协调器冲突投影不可用：${error.message}`);
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
  scheduler: loadScheduler,
  live: async () => startLive(),
  approvals: async () => {
    await ensureConnection();
    await Promise.all([loadApprovals(), loadRemoteInbox(), loadConflicts()]);
  },
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
$("#scheduler-refresh").addEventListener("click", () => void loadScheduler());
$("#approval-refresh").addEventListener("click", () => {
  void Promise.all([loadApprovals(), loadRemoteInbox(), loadConflicts()]);
});
window.addEventListener("hashchange", () => void activate(location.hash.slice(1) || "overview"));

function tick() {
  setText("#clock-label", new Date().toLocaleTimeString([], { hour12: false }));
}
tick();
setInterval(tick, 1000);
setInterval(markUnknownRuns, 5_000);
void activate(location.hash.slice(1) || "overview");
