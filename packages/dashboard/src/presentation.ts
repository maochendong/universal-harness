export interface BusinessPresentationBadge {
  readonly label_zh: string;
  readonly value: string;
  readonly tone: "neutral" | "positive" | "warning" | "critical";
}

export interface BusinessPresentation {
  readonly presentation_version: "1";
  readonly entity_id: string;
  readonly binding_digest: string | null;
  readonly title_zh: string;
  readonly description_zh: string;
  readonly type_label_zh: string;
  readonly status_label_zh: string;
  readonly technical_type: string;
  readonly technical_status: string;
  readonly badges: readonly BusinessPresentationBadge[];
  readonly derived_from: readonly string[];
  readonly fallback: boolean;
}

export type PresentationMap = Readonly<Record<string, BusinessPresentation>>;

type PresentationSource = Readonly<Record<string, unknown>>;

const TYPE_LABELS: Readonly<Record<string, string>> = {
  Approval: "审批决定",
  ApprovalRequest: "审批请求",
  Checkpoint: "检查点",
  CodeArtifact: "代码产物",
  Component: "组件",
  Constraint: "约束",
  ContextBundle: "上下文包",
  Decision: "决策",
  EvaluationCase: "评估用例",
  Evidence: "证据",
  ExecutionPlan: "执行计划",
  Finding: "问题",
  Gate: "质量门禁",
  ImpactSet: "影响范围",
  ImprovementCandidate: "改进候选",
  Intent: "业务意图",
  Iteration: "迭代",
  Policy: "治理策略",
  Project: "项目",
  Requirement: "需求",
  Repository: "代码仓库",
  RootCauseAnalysis: "根因分析",
  Run: "执行运行",
  Task: "任务",
  Test: "测试",
  ToolDefinition: "工具定义",
};

const FALLBACK_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Evidence: "该证据记录门禁或评估对受治理对象的验证结果。",
  Requirement: "该需求描述需要实现或验证的业务结果。",
  Task: "该任务表示为实现当前迭代目标而安排的工作。",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  accepted: "已接受",
  proposed: "待确认",
  rejected: "已拒绝",
  superseded: "已取代",
  tombstoned: "已移除",
};

const RELATION_LABELS: Readonly<Record<string, string>> = {
  ADDRESSES: "处理",
  APPROVES: "批准",
  BLOCKS: "阻塞",
  CAPTURES: "记录",
  CONSTRAINED_BY: "受约束于",
  CONTAINS: "包含",
  DECOMPOSES_TO: "拆解为",
  DEPENDS_ON: "依赖",
  DERIVES_FROM: "派生自",
  DIAGNOSED_BY: "诊断自",
  EVALUATES: "评估",
  EXECUTES: "执行",
  GENERATED_BY: "生成自",
  GOVERNED_BY: "受治理于",
  IMPLEMENTS: "实现",
  INVOKES: "调用",
  MAY_IMPACT: "可能影响",
  PRODUCES: "产出",
  PROPOSES_CHANGE_TO: "建议变更",
  REALIZES: "实现目标",
  REFUTES: "反驳",
  REQUESTS_APPROVAL_FOR: "请求批准",
  RESOLVES: "解决",
  RESUMES: "恢复",
  SHAPES: "塑造",
  SUPERSEDES: "取代",
  SUPPORTS: "支持",
  TRIGGERS: "触发",
  USES_CONTEXT: "使用上下文",
  VERIFIES: "验证",
  VIOLATES: "违反",
};

const FINDING_RULE_LABELS: Readonly<Record<string, string>> = {
  api_contract_coverage: "API 契约覆盖不足",
  contradictory_constraint: "约束相互冲突",
  missing_design_artifact: "缺少设计产物",
  missing_verification: "缺少验证证据",
  orphan_node: "存在孤立图节点",
  stale_knowledge: "知识内容已过期",
  task_orphan: "任务缺少需求关联",
  task_stale: "任务状态已过期",
  traceability_gap: "追踪链路不完整",
  unhealthy_context_source: "上下文来源不健康",
};

const SEVERITY_LABELS: Readonly<
  Record<string, { readonly value: string; readonly tone: BusinessPresentationBadge["tone"] }>
> = {
  blocker: { value: "阻断", tone: "critical" },
  critical: { value: "严重", tone: "critical" },
  info: { value: "提示", tone: "neutral" },
  warning: { value: "警告", tone: "warning" },
};

const ACTIONABILITY_LABELS: Readonly<
  Record<string, { readonly value: string; readonly tone: BusinessPresentationBadge["tone"] }>
> = {
  auto_close: { value: "可自动关闭", tone: "positive" },
  human_review: { value: "人工复核", tone: "warning" },
  upstream_change: { value: "等待上游变更", tone: "warning" },
};

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  auth: "认证范围",
  design: "设计范围",
  evaluation: "评估范围",
  knowledge: "知识范围",
  verification: "验证范围",
};

const PHASE_LABELS: Readonly<Record<string, string>> = {
  capture: "需求录入",
  context: "上下文准备",
  evaluate: "质量评估",
  execute: "Agent 执行",
  impact: "影响分析",
  plan: "迭代计划",
  snapshot: "迭代快照",
  verify: "门禁验证",
};

const APPROVAL_OBJECT_LABELS: Readonly<Record<string, string>> = {
  AdoptionBaseline: "接管基线",
  AgentPlan: "Agent 执行计划",
  ExecutionAuthorizationSpec: "执行授权方案",
  ImpactSet: "影响范围",
  ImprovementCandidate: "改进候选",
  IterationPlan: "迭代计划",
  RequirementBaseline: "需求基线",
  ToolInvocation: "工具调用",
};

const RISK_LABELS: Readonly<
  Record<string, { readonly value: string; readonly tone: BusinessPresentationBadge["tone"] }>
> = {
  critical: { value: "严重风险", tone: "critical" },
  high: { value: "高风险", tone: "critical" },
  low: { value: "低风险", tone: "positive" },
  medium: { value: "中风险", tone: "warning" },
};

const DECISION_LABELS: Readonly<Record<string, string>> = {
  approve: "批准",
  defer: "稍后决定",
  reject: "拒绝",
};

const ITERATION_STATE_LABELS: Readonly<
  Record<string, { readonly value: string; readonly tone: BusinessPresentationBadge["tone"] }>
> = {
  aborted: { value: "已中止", tone: "critical" },
  blocked: { value: "已阻塞", tone: "critical" },
  completed: { value: "已完成", tone: "positive" },
  draft: { value: "草稿", tone: "neutral" },
  planned: { value: "已计划", tone: "neutral" },
  running: { value: "执行中", tone: "positive" },
  verifying: { value: "验证中", tone: "warning" },
};

const RUN_OUTCOME_LABELS: Readonly<
  Record<string, { readonly value: string; readonly tone: BusinessPresentationBadge["tone"] }>
> = {
  clarification_required: { value: "需要澄清", tone: "warning" },
  correct_block: { value: "正确阻断", tone: "positive" },
  failed: { value: "执行失败", tone: "critical" },
  handoff: { value: "已交接", tone: "warning" },
  partial: { value: "部分完成", tone: "warning" },
  success: { value: "执行成功", tone: "positive" },
};

const TASK_VERDICT_LABELS: Readonly<
  Record<string, { readonly value: string; readonly tone: BusinessPresentationBadge["tone"] }>
> = {
  blocked: { value: "已阻塞", tone: "critical" },
  failed: { value: "未通过", tone: "critical" },
  passed: { value: "已通过", tone: "positive" },
};

interface Candidate {
  readonly path: string;
  readonly value: string;
}

interface BadgeProjection {
  readonly badges: readonly BusinessPresentationBadge[];
  readonly paths: readonly string[];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nodeBadges(source: PresentationSource, technicalType: string): BadgeProjection {
  const extensions = recordValue(source.extensions);
  if (technicalType === "Iteration" && typeof source.iteration_state === "string") {
    const state = ITERATION_STATE_LABELS[source.iteration_state] ?? {
      value: `未知 / ${source.iteration_state}`,
      tone: "neutral" as const,
    };
    return {
      badges: [{ label_zh: "迭代状态", value: state.value, tone: state.tone }],
      paths: ["iteration_state"],
    };
  }
  if (technicalType === "Run") {
    const run = recordValue(extensions?.["harness.run"]);
    if (typeof run?.outcome === "string") {
      const outcome = RUN_OUTCOME_LABELS[run.outcome] ?? {
        value: `未知 / ${run.outcome}`,
        tone: "neutral" as const,
      };
      return {
        badges: [{ label_zh: "执行结果", value: truncate(outcome.value, 48), tone: outcome.tone }],
        paths: ["extensions.harness.run.outcome"],
      };
    }
  }
  if (technicalType === "Task") {
    const task = recordValue(extensions?.["harness.task"]);
    if (typeof task?.verdict === "string") {
      const verdict = TASK_VERDICT_LABELS[task.verdict] ?? {
        value: `未知 / ${task.verdict}`,
        tone: "neutral" as const,
      };
      return {
        badges: [{ label_zh: "任务判定", value: truncate(verdict.value, 48), tone: verdict.tone }],
        paths: ["extensions.harness.task.verdict"],
      };
    }
  }
  if (technicalType !== "Evidence") return { badges: [], paths: [] };
  const extensionKey =
    extensions?.["harness.evaluation"] === undefined ? "harness.gate" : "harness.evaluation";
  const extension = recordValue(extensions?.[extensionKey]);
  if (extension === undefined) return { badges: [], paths: [] };
  const badges: BusinessPresentationBadge[] = [];
  const paths: string[] = [];
  const path = (key: string): string => `extensions.${extensionKey}.${key}`;
  if (typeof extension.passed === "boolean") {
    badges.push({
      label_zh: "验证结果",
      value: extension.passed ? "已通过" : "未通过",
      tone: extension.passed ? "positive" : "critical",
    });
    paths.push(path("passed"));
  }
  if (typeof extension.freshness === "string") {
    const freshness =
      extension.freshness === "fresh"
        ? { value: "新鲜", tone: "positive" as const }
        : extension.freshness === "stale"
          ? { value: "已过期", tone: "warning" as const }
          : { value: `未知 / ${extension.freshness}`, tone: "neutral" as const };
    badges.push({ label_zh: "新鲜度", value: truncate(freshness.value, 48), tone: freshness.tone });
    paths.push(path("freshness"));
  }
  if (typeof extension.provisional === "boolean") {
    badges.push({
      label_zh: "临时证据",
      value: extension.provisional ? "是" : "否",
      tone: extension.provisional ? "warning" : "positive",
    });
    paths.push(path("provisional"));
  }
  return { badges, paths };
}

function isBusinessText(value: string): boolean {
  return (
    !/^[a-f0-9]{64}$/u.test(value) && !/^[A-Za-z][A-Za-z0-9_.:-]*_[A-Za-z0-9_.:-]+$/u.test(value)
  );
}

function truncate(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
}

function limitBadges(
  badges: readonly BusinessPresentationBadge[],
): readonly BusinessPresentationBadge[] {
  return badges.map((badge) => ({ ...badge, value: truncate(badge.value, 48) }));
}

function actionTitle(action: string, subject: string): string {
  return /^[A-Za-z]/u.test(subject) ? `${action} ${subject}` : `${action}${subject}`;
}

function candidates(source: PresentationSource, wanted: string): Candidate[] {
  const found: Candidate[] = [];
  const visit = (value: unknown, path: readonly string[], depth: number): void => {
    if (depth >= 4 || typeof value !== "object" || value === null || Array.isArray(value)) return;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      const childPath = [...path, key];
      const normalized = typeof child === "string" ? child.trim().replace(/\s+/gu, " ") : "";
      if (key === wanted && normalized !== "" && isBusinessText(normalized)) {
        found.push({ path: childPath.join("."), value: normalized });
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(source, [], 0);
  return found;
}

function first(
  source: PresentationSource,
  fields: readonly string[],
  excludedPath?: string,
): Candidate | undefined {
  for (const field of fields) {
    const match = candidates(source, field).find((candidate) => candidate.path !== excludedPath);
    if (match !== undefined) return match;
  }
  return undefined;
}

export function presentationKey(entityId: string, digest: string | null): string {
  return `${entityId}@${digest ?? "live"}`;
}

export function presentationMap(presentations: readonly BusinessPresentation[]): PresentationMap {
  return Object.fromEntries(
    [...presentations]
      .sort((left, right) =>
        presentationKey(left.entity_id, left.binding_digest).localeCompare(
          presentationKey(right.entity_id, right.binding_digest),
        ),
      )
      .map((presentation) => [
        presentationKey(presentation.entity_id, presentation.binding_digest),
        presentation,
      ]),
  );
}

export function presentNode(source: PresentationSource): BusinessPresentation {
  const entityId = typeof source.id === "string" ? source.id : "unknown_entity";
  const digest = typeof source.digest === "string" ? source.digest : null;
  const technicalType = typeof source.type === "string" ? source.type : "Unknown";
  const technicalStatus = typeof source.status === "string" ? source.status : "unknown";
  const typeLabel = TYPE_LABELS[technicalType] ?? `未知类型 / ${technicalType}`;
  const statusLabel = STATUS_LABELS[technicalStatus] ?? `未知状态 / ${technicalStatus}`;
  const title = first(source, ["display_name", "title", "name", "summary", "objective"]);
  const description = first(source, ["description", "summary", "objective", "reason"], title?.path);
  const badgeProjection = nodeBadges(source, technicalType);
  const derivedFrom = [title?.path, description?.path, ...badgeProjection.paths].filter(
    (value, index, values): value is string =>
      value !== undefined && values.indexOf(value) === index,
  );
  const fallback =
    title === undefined ||
    description === undefined ||
    TYPE_LABELS[technicalType] === undefined ||
    STATUS_LABELS[technicalStatus] === undefined;

  return {
    presentation_version: "1",
    entity_id: entityId,
    binding_digest: digest,
    title_zh: truncate(title?.value ?? `${typeLabel} · ${entityId}`, 80),
    description_zh: truncate(
      description?.value ?? FALLBACK_DESCRIPTIONS[technicalType] ?? `该记录表示一个${typeLabel}。`,
      240,
    ),
    type_label_zh: typeLabel,
    status_label_zh: statusLabel,
    technical_type: technicalType,
    technical_status: technicalStatus,
    badges: limitBadges(badgeProjection.badges),
    derived_from: derivedFrom,
    fallback,
  };
}

export function presentEdge(source: PresentationSource): BusinessPresentation {
  const entityId = typeof source.id === "string" ? source.id : "unknown_edge";
  const digest = typeof source.digest === "string" ? source.digest : null;
  const technicalType = typeof source.type === "string" ? source.type : "Unknown";
  const technicalStatus = typeof source.status === "string" ? source.status : "unknown";
  const typeLabel = RELATION_LABELS[technicalType] ?? `未知关系 / ${technicalType}`;
  const statusLabel = STATUS_LABELS[technicalStatus] ?? `未知状态 / ${technicalStatus}`;
  const description = first(source, ["description", "summary", "objective", "reason"]);
  const fallback = RELATION_LABELS[technicalType] === undefined || description === undefined;

  return {
    presentation_version: "1",
    entity_id: entityId,
    binding_digest: digest,
    title_zh: typeLabel,
    description_zh: truncate(
      description?.value ?? "该关系连接两个受治理对象，具体业务说明尚未记录。",
      240,
    ),
    type_label_zh: typeLabel,
    status_label_zh: statusLabel,
    technical_type: technicalType,
    technical_status: technicalStatus,
    badges: [],
    derived_from: description === undefined ? [] : [description.path],
    fallback,
  };
}

export function presentFindingGroup(source: object): BusinessPresentation {
  const record = source as Readonly<Record<string, unknown>>;
  const entityId = typeof record.group_id === "string" ? record.group_id : "unknown_finding_group";
  const digest = typeof record.membership_digest === "string" ? record.membership_digest : null;
  const rule = typeof record.rule === "string" ? record.rule : "unknown_rule";
  const scope = typeof record.scope_prefix === "string" ? record.scope_prefix : "unknown";
  const severity = typeof record.severity === "string" ? record.severity : "unknown";
  const actionability = typeof record.actionability === "string" ? record.actionability : "unknown";
  const openCount = typeof record.open_count === "number" ? record.open_count : 0;
  const memberCount = typeof record.member_count === "number" ? record.member_count : openCount;
  const ruleLabel = FINDING_RULE_LABELS[rule] ?? `未知规则 / ${rule}`;
  const severityLabel = SEVERITY_LABELS[severity] ?? { value: severity, tone: "neutral" as const };
  const actionabilityLabel = ACTIONABILITY_LABELS[actionability] ?? {
    value: actionability,
    tone: "neutral" as const,
  };
  const scopeSegment = scope.split("/").at(-1) ?? scope;
  const scopeLabel = SCOPE_LABELS[scopeSegment] ?? scope;

  return {
    presentation_version: "1",
    entity_id: entityId,
    binding_digest: digest,
    title_zh: truncate(ruleLabel, 80),
    description_zh: truncate(
      `${scopeLabel}存在${ruleLabel}的问题，共 ${String(openCount)} 项待处理。`,
      240,
    ),
    type_label_zh: "问题组",
    status_label_zh: openCount > 0 ? "待处理" : "已处理",
    technical_type: "FindingGroup",
    technical_status: openCount > 0 ? "open" : "closed",
    badges: limitBadges([
      { label_zh: "严重级别", value: severityLabel.value, tone: severityLabel.tone },
      { label_zh: "处置方式", value: actionabilityLabel.value, tone: actionabilityLabel.tone },
      {
        label_zh: "开放项",
        value: truncate(`${String(openCount)} / ${String(memberCount)}`, 48),
        tone: openCount > 0 ? "critical" : "positive",
      },
    ]),
    derived_from: ["rule", "scope_prefix", "severity", "actionability", "open_count"],
    fallback:
      FINDING_RULE_LABELS[rule] === undefined ||
      SEVERITY_LABELS[severity] === undefined ||
      ACTIONABILITY_LABELS[actionability] === undefined,
  };
}

export function presentSemanticProposal(source: PresentationSource): BusinessPresentation {
  const entityId = typeof source.edge_id === "string" ? source.edge_id : "unknown_proposal";
  const digest = typeof source.preview_digest === "string" ? source.preview_digest : null;
  const reason = first(source, ["reason"]);
  const score =
    typeof source.score === "number" && Number.isFinite(source.score) ? source.score : 0;

  return {
    presentation_version: "1",
    entity_id: entityId,
    binding_digest: digest,
    title_zh: "候选影响关系",
    description_zh: truncate(reason?.value ?? "该关系由确定性语义特征提出，尚未获得批准。", 240),
    type_label_zh: "语义候选",
    status_label_zh: "待批准",
    technical_type: "SemanticProposal",
    technical_status: "pending",
    badges: limitBadges([
      {
        label_zh: "相似度",
        value: truncate((score / 1_000_000).toFixed(3), 48),
        tone: "warning",
      },
    ]),
    derived_from: [...(reason === undefined ? [] : [reason.path]), "score"],
    fallback: reason === undefined || digest === null,
  };
}

export function presentEvent(source: object): BusinessPresentation {
  const record = source as Readonly<Record<string, unknown>>;
  const event =
    typeof record.event === "object" && record.event !== null && !Array.isArray(record.event)
      ? (record.event as Record<string, unknown>)
      : {};
  const payload =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const entityId = typeof record.id === "string" ? record.id : "unknown_event";
  const eventType = typeof event.event_type === "string" ? event.event_type : "UnknownEvent";
  const phase = typeof payload.phase === "string" ? payload.phase : "unknown";
  const phaseLabel = PHASE_LABELS[phase] ?? `未知阶段 / ${phase}`;
  const authoritative = record.authoritative === true;
  const sourceLabel = authoritative ? "权威账本" : "实时信号";
  const present = (
    title: string,
    description: string,
    status: string,
    badges: readonly BusinessPresentationBadge[],
    paths: readonly string[],
    fallback = false,
  ): BusinessPresentation => {
    return {
      presentation_version: "1",
      entity_id: entityId,
      binding_digest: null,
      title_zh: truncate(title, 80),
      description_zh: truncate(description, 240),
      type_label_zh: "实时事件",
      status_label_zh: status,
      technical_type: eventType,
      technical_status: authoritative ? "authoritative" : "live",
      badges: limitBadges([
        ...badges,
        {
          label_zh: "来源",
          value: sourceLabel,
          tone: authoritative ? "positive" : "warning",
        },
      ]),
      derived_from: [...paths, "source", "authoritative"],
      fallback,
    };
  };

  if (eventType === "PhaseStarted") {
    return present(
      actionTitle("开始", phaseLabel),
      `工作流已进入${phaseLabel}阶段。`,
      "进行中",
      [{ label_zh: "阶段", value: truncate(phaseLabel, 48), tone: "neutral" }],
      ["event.payload.phase"],
      PHASE_LABELS[phase] === undefined,
    );
  }
  if (eventType === "PhaseCompleted") {
    return present(
      actionTitle("完成", phaseLabel),
      `工作流已完成${phaseLabel}阶段。`,
      "已完成",
      [{ label_zh: "阶段", value: truncate(phaseLabel, 48), tone: "positive" }],
      ["event.payload.phase"],
      PHASE_LABELS[phase] === undefined,
    );
  }
  if (eventType === "PhasePaused") {
    return present(
      actionTitle("暂停", phaseLabel),
      `工作流在${phaseLabel}阶段暂停，等待继续条件。`,
      "等待中",
      [{ label_zh: "阶段", value: truncate(phaseLabel, 48), tone: "warning" }],
      ["event.payload.phase", "event.payload.status"],
      PHASE_LABELS[phase] === undefined,
    );
  }
  if (eventType === "GateStarted") {
    const gateId = typeof payload.gate_id === "string" ? payload.gate_id : "未知门禁";
    return present(
      "开始质量门禁",
      `质量门禁 ${gateId} 已开始执行。`,
      "验证中",
      [{ label_zh: "门禁", value: truncate(gateId, 48), tone: "neutral" }],
      ["event.payload.gate_id"],
      typeof payload.gate_id !== "string",
    );
  }
  if (eventType === "GateCompleted") {
    const passed = payload.passed === true;
    return present(
      passed ? "质量门禁已通过" : "质量门禁未通过",
      passed ? "质量门禁完成且验证通过。" : "质量门禁完成，但验证未通过。",
      passed ? "已通过" : "未通过",
      [
        {
          label_zh: "验证结果",
          value: passed ? "已通过" : "未通过",
          tone: passed ? "positive" : "critical",
        },
      ],
      ["event.payload.gate_id", "event.payload.passed"],
      typeof payload.passed !== "boolean",
    );
  }
  if (eventType === "RunStarted") {
    const runId = typeof payload.run_id === "string" ? payload.run_id : "未知运行";
    return present(
      "开始 Agent 执行",
      `Agent 运行 ${runId} 已开始。`,
      "运行中",
      [{ label_zh: "运行", value: truncate(runId, 48), tone: "positive" }],
      ["event.payload.run_id"],
      typeof payload.run_id !== "string",
    );
  }
  if (eventType === "RunHeartbeat") {
    const unknown = payload.status === "unknown";
    return present(
      unknown ? "执行状态未知" : "Agent 执行保持活跃",
      unknown ? "运行已超过心跳期限，当前状态未知。" : "Agent 运行已报告最新心跳。",
      unknown ? "状态未知" : "运行中",
      [
        {
          label_zh: "心跳",
          value: unknown ? "已超时" : "正常",
          tone: unknown ? "warning" : "positive",
        },
      ],
      ["event.payload.run_id", "event.payload.status"],
      typeof payload.run_id !== "string",
    );
  }
  if (eventType === "RunOutputSummary") {
    const summary =
      typeof payload.summary === "string" && payload.summary.trim() !== ""
        ? payload.summary.trim().replace(/\s+/gu, " ")
        : "Agent 已产生新的输出摘要。";
    const stream =
      payload.stream === "stderr"
        ? "错误输出"
        : payload.stream === "mixed"
          ? "标准输出 + 错误输出"
          : "标准输出";
    const bytes = typeof payload.bytes_observed === "number" ? payload.bytes_observed : undefined;
    return present(
      "执行输出摘要",
      summary,
      payload.final === true ? "已完成" : "已更新",
      [
        { label_zh: "输出来源", value: stream, tone: "neutral" },
        ...(bytes === undefined
          ? []
          : [{ label_zh: "已观察", value: `${String(bytes)} bytes`, tone: "neutral" as const }]),
        ...(payload.truncated === true
          ? [{ label_zh: "摘要", value: "已截断", tone: "warning" as const }]
          : []),
      ],
      [
        "event.payload.run_id",
        "event.payload.summary",
        "event.payload.stream",
        "event.payload.bytes_observed",
      ],
      typeof payload.summary !== "string",
    );
  }
  if (eventType === "BudgetUpdated") {
    const tokens =
      typeof payload.total_tokens === "number"
        ? payload.total_tokens
        : typeof payload.used_tokens === "number"
          ? payload.used_tokens
          : undefined;
    const observations = Array.isArray(payload.budget_observations)
      ? (payload.budget_observations as Array<Record<string, unknown>>)
      : [];
    const observation = (dimension: string): Record<string, unknown> | undefined =>
      observations.find((entry) => entry.dimension === dimension);
    const tokenObservation = observation("tokens");
    const stepObservation = observation("steps");
    const durationObservation = observation("duration_ms");
    const tokenValue =
      tokenObservation?.availability === "unavailable"
        ? "未计量"
        : typeof tokenObservation?.used === "number"
          ? String(tokenObservation.used)
          : tokens === undefined
            ? "未计量"
            : String(tokens);
    const stepValue =
      stepObservation?.availability === "unavailable"
        ? "未计量"
        : typeof stepObservation?.used === "number"
          ? String(stepObservation.used)
          : "未计量";
    const duration =
      typeof durationObservation?.used === "number"
        ? durationObservation.used
        : typeof payload.duration_ms === "number"
          ? payload.duration_ms
          : undefined;
    const provider = typeof payload.provider === "string" ? payload.provider : "当前 Agent 后端";
    const unavailable = tokenValue === "未计量" && stepValue === "未计量";
    const description = unavailable
      ? `${provider} 未提供可靠的 Token 与 Step 计量；${
          duration === undefined
            ? "Harness 仍会强制运行时长上限。"
            : `Harness 已测量运行时长 ${String(duration)} ms。`
        }`
      : tokens === undefined
        ? "执行预算发生变化。"
        : `当前累计使用 ${String(tokens)} tokens。`;
    return present(
      "执行预算已更新",
      description,
      "已更新",
      [
        {
          label_zh: "Token",
          value: tokenValue,
          tone: "neutral",
        },
        { label_zh: "Step", value: stepValue, tone: "neutral" },
        ...(duration === undefined
          ? []
          : [{ label_zh: "时长", value: `${String(duration)} ms`, tone: "positive" as const }]),
      ],
      ["event.payload.total_tokens", "event.payload.budget_observations"],
      observations.length === 0 && tokens === undefined,
    );
  }
  if (eventType === "ApprovalRequired") {
    const reason =
      typeof payload.reason === "string" && payload.reason.trim() !== ""
        ? payload.reason.trim().replace(/\s+/gu, " ")
        : "受治理对象需要人工确认后才能继续。";
    return present(
      "需要人工审批",
      reason,
      "等待决策",
      [{ label_zh: "控制", value: "人工确认", tone: "warning" }],
      ["event.payload.request_id", "event.payload.reason"],
      typeof payload.request_id !== "string",
    );
  }

  return present(
    `运行事件 · ${eventType}`,
    "该事件表示工作流运行状态发生变化。",
    authoritative ? "已写入账本" : "实时信号",
    [],
    [],
    true,
  );
}

export function presentApproval(source: PresentationSource): BusinessPresentation {
  const entityId = typeof source.request_id === "string" ? source.request_id : "unknown_approval";
  const digest = typeof source.object_digest === "string" ? source.object_digest : null;
  const objectType = typeof source.object_type === "string" ? source.object_type : "UnknownObject";
  const objectLabel = APPROVAL_OBJECT_LABELS[objectType] ?? `未知对象 / ${objectType}`;
  const reason = first(source, ["reason"]);
  const risk = typeof source.risk === "string" ? source.risk : "unknown";
  const riskLabel = RISK_LABELS[risk] ?? { value: risk, tone: "neutral" as const };
  const allowedDecisions = Array.isArray(source.allowed_decisions)
    ? source.allowed_decisions.filter((value): value is string => typeof value === "string")
    : [];
  const decisionValue = allowedDecisions
    .map((value) => DECISION_LABELS[value] ?? value)
    .join(" / ");

  return {
    presentation_version: "1",
    entity_id: entityId,
    binding_digest: digest,
    title_zh: truncate(`批准${objectLabel}`, 80),
    description_zh: truncate(reason?.value ?? "该受治理对象需要人工确认后才能继续。", 240),
    type_label_zh: "审批请求",
    status_label_zh: "等待决策",
    technical_type: objectType,
    technical_status: "pending",
    badges: limitBadges([
      { label_zh: "风险", value: riskLabel.value, tone: riskLabel.tone },
      {
        label_zh: "允许操作",
        value: truncate(decisionValue === "" ? "未声明" : decisionValue, 48),
        tone: "neutral",
      },
    ]),
    derived_from: [...(reason === undefined ? [] : [reason.path]), "risk", "allowed_decisions"],
    fallback:
      APPROVAL_OBJECT_LABELS[objectType] === undefined ||
      RISK_LABELS[risk] === undefined ||
      reason === undefined,
  };
}

/** PG-8: Chinese labels for the model ports and grounded purposes. */
const PORT_LABELS: Readonly<Record<string, string>> = {
  prd_proposal: "需求提案",
  prd_review: "需求评审",
  impact_advisory: "影响分析建议",
  design_proposal: "设计提案",
  design_review: "设计评审",
  plan_proposal: "计划提案",
  feedback_analysis: "反馈分析",
};

const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  project_discovery: "项目发现",
  context_enrichment: "上下文解读",
  approval_brief: "审批摘要",
  iteration_narrative: "迭代叙事",
};

const INVOCATION_STATE_LABELS: Readonly<Record<string, string>> = {
  planned: "已计划",
  started: "已启动",
  completed: "已完成",
  failed: "已失败",
  validated: "已校验",
  consumed: "已消费",
  invalidated: "已失效",
};

const FAILURE_EXPLANATIONS: Readonly<
  Record<string, { readonly value: string; readonly remedy: string }>
> = {
  provider_required: { value: "未配置 Provider", remedy: "配置 Provider 后重试" },
  provider_unavailable: { value: "Provider 不可用", remedy: "稍后重试或切换 Provider" },
  timeout: { value: "调用超时", remedy: "重试或提高预算后恢复" },
  budget_exhausted: { value: "预算耗尽", remedy: "提高预算后恢复" },
  invalid_output: { value: "输出未通过校验", remedy: "重新生成或调整输入后重试" },
  independence_violation: { value: "独立性校验未通过", remedy: "检查会话与绑定隔离后重试" },
  version_mismatch: { value: "契约版本不匹配", remedy: "对齐契约版本后重试" },
  policy_denied: { value: "策略拒绝", remedy: "调整授权或策略后重试" },
  uncertain: { value: "结果不确定", remedy: "人工复核后决定" },
};

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  impact_analysis: "影响分析",
  design_governance: "设计治理",
  independent_evaluation: "独立评估",
  advanced_audit: "高级审计",
  strict_tdd: "严格 TDD",
};

const GENERIC_STATUS_LABELS: Readonly<Record<string, string>> = {
  proven: "已证明",
  controlled_not_applicable: "受控不适用",
  not_enabled_by_profile: "未启用",
  historical_without_proof: "历史无证明",
  invalid_or_incomplete: "无效或不完整",
};

/**
 * PG-8 model invocation presentation (never renders raw prompts): Chinese
 * port/purpose label, contract version, output schema, usage, state and —
 * on failure — a Chinese explanation with a recovery action. Failure
 * summaries stay technical detail; the badge carries the mapped
 * explanation, not the provider's raw text.
 */
export function presentModelInvocation(source: PresentationSource): BusinessPresentation {
  const entityId =
    typeof source.invocation_id === "string" ? source.invocation_id : "unknown_invocation";
  const digest = typeof source.record_digest === "string" ? source.record_digest : null;
  const portId = typeof source.port_id === "string" ? source.port_id : "unknown_port";
  const purpose = typeof source.purpose === "string" ? source.purpose : undefined;
  const state = typeof source.state === "string" ? source.state : "unknown";
  const typeLabel =
    portId === "grounded_synthesis" && purpose !== undefined
      ? (PURPOSE_LABELS[purpose] ?? `未知用途 / ${purpose}`)
      : (PORT_LABELS[portId] ?? `未知端口 / ${portId}`);
  const statusLabel = INVOCATION_STATE_LABELS[state] ?? `未知状态 / ${state}`;
  const contractVersion =
    typeof source.prompt_contract_version === "string" ? source.prompt_contract_version : "unknown";
  const schemaId =
    typeof source.output_schema_id === "string" ? source.output_schema_id : "unknown";

  const badges: BusinessPresentationBadge[] = [
    { label_zh: "契约版本", value: truncate(contractVersion, 48), tone: "neutral" },
    { label_zh: "输出 Schema", value: truncate(schemaId, 48), tone: "neutral" },
  ];
  const usage = source.usage as
    { readonly tokens?: number; readonly duration_ms?: number } | undefined;
  badges.push({
    label_zh: "用量",
    value:
      usage?.tokens === undefined
        ? "不可用"
        : `${String(usage.tokens)} tokens${usage.duration_ms === undefined ? "" : ` · ${String(Math.round(usage.duration_ms / 100) / 10)}s`}`,
    tone: "neutral",
  });
  const failure = source.failure as
    { readonly code: string; readonly retryable: boolean } | undefined;
  if (failure !== undefined) {
    const explanation = FAILURE_EXPLANATIONS[failure.code] ?? {
      value: `未分类失败 / ${failure.code}`,
      remedy: "查看审计详情",
    };
    badges.push({ label_zh: "失败原因", value: truncate(explanation.value, 48), tone: "critical" });
    badges.push({ label_zh: "恢复动作", value: truncate(explanation.remedy, 48), tone: "warning" });
  }

  const knownPort =
    portId === "grounded_synthesis"
      ? purpose !== undefined && PURPOSE_LABELS[purpose] !== undefined
      : PORT_LABELS[portId] !== undefined;
  return {
    presentation_version: "1",
    entity_id: entityId,
    binding_digest: digest,
    title_zh: truncate(`${typeLabel} · ${statusLabel}`, 80),
    description_zh: truncate(
      `端口 ${portId}${purpose === undefined ? "" : `（${purpose}）`}，契约 ${String(source.prompt_contract_id ?? "unknown")} v${contractVersion}。`,
      240,
    ),
    type_label_zh: typeLabel,
    status_label_zh: statusLabel,
    technical_type: portId,
    technical_status: state,
    badges: limitBadges(badges),
    derived_from: ["port_id", "purpose", "state", "prompt_contract_version"],
    fallback: !knownPort || INVOCATION_STATE_LABELS[state] === undefined,
  };
}

/**
 * PG-8 capability card presentation: generic and domain status are shown
 * together; an inactive capability reads 未启用 without implying any proof.
 */
export function presentCapabilityStatus(source: PresentationSource): BusinessPresentation {
  const capabilityId =
    typeof source.capability_id === "string" ? source.capability_id : "unknown_capability";
  const typeLabel = CAPABILITY_LABELS[capabilityId] ?? `未知能力 / ${capabilityId}`;
  const genericStatus =
    typeof source.generic_status === "string" ? source.generic_status : undefined;
  const statusLabel =
    genericStatus === undefined
      ? "待证明"
      : (GENERIC_STATUS_LABELS[genericStatus] ?? `未知状态 / ${genericStatus}`);
  const badges: BusinessPresentationBadge[] = [];
  if (typeof source.domain_status === "string") {
    badges.push({
      label_zh: "领域状态",
      value: truncate(source.domain_status, 48),
      tone: "neutral",
    });
  }
  badges.push({
    label_zh: "解析",
    value: source.resolution === "active" ? "已激活" : "按 Profile 停用",
    tone: source.resolution === "active" ? "positive" : "neutral",
  });
  return {
    presentation_version: "1",
    entity_id: capabilityId,
    binding_digest: null,
    title_zh: truncate(typeLabel, 80),
    description_zh: truncate(`能力 ${capabilityId}：${statusLabel}。`, 240),
    type_label_zh: typeLabel,
    status_label_zh: statusLabel,
    technical_type: capabilityId,
    technical_status: genericStatus ?? "unproven",
    badges: limitBadges(badges),
    derived_from: ["capability_id", "generic_status", "domain_status", "resolution"],
    fallback: CAPABILITY_LABELS[capabilityId] === undefined,
  };
}
