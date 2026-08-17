import { describe, expect, it } from "vitest";

import {
  presentEdge,
  presentEvent,
  presentFindingGroup,
  presentNode,
  presentApproval,
  presentSemanticProposal,
  presentationMap,
  presentationKey,
} from "../src/index.js";

describe("Dashboard business presentation", () => {
  it("presents authoritative task text without changing its digest binding", () => {
    const digest = "a".repeat(64);
    const record = {
      id: "task_01",
      digest,
      type: "Task",
      status: "accepted",
      extensions: {
        "harness.task": {
          title: "实现 Atlas 登录闭环",
          objective: "让用户能够安全登录并进入工作台。",
        },
      },
    };
    const before = structuredClone(record);

    expect(presentNode(record)).toEqual({
      presentation_version: "1",
      entity_id: "task_01",
      binding_digest: digest,
      title_zh: "实现 Atlas 登录闭环",
      description_zh: "让用户能够安全登录并进入工作台。",
      type_label_zh: "任务",
      status_label_zh: "已接受",
      technical_type: "Task",
      technical_status: "accepted",
      badges: [],
      derived_from: ["extensions.harness.task.title", "extensions.harness.task.objective"],
      fallback: false,
    });
    expect(presentationKey("task_01", digest)).toBe(`task_01@${digest}`);
    expect(record).toEqual(before);
  });

  it("falls back deterministically instead of presenting identifiers as business text", () => {
    expect(
      presentNode({
        id: "requirement_abcdef",
        digest: "b".repeat(64),
        type: "Requirement",
        status: "unexpected",
        name: "task_abcdef",
        objective: "支持企业用户通过单点登录进入 Atlas。",
      }),
    ).toMatchObject({
      title_zh: "支持企业用户通过单点登录进入 Atlas。",
      description_zh: "该需求描述需要实现或验证的业务结果。",
      type_label_zh: "需求",
      status_label_zh: "未知状态 / unexpected",
      technical_type: "Requirement",
      technical_status: "unexpected",
      derived_from: ["objective"],
      fallback: true,
    });
  });

  it("normalizes and truncates Unicode business text at the specified character limits", () => {
    const presentation = presentNode({
      id: "component_01",
      digest: "c".repeat(64),
      type: "Component",
      status: "proposed",
      display_name: `  ${"界".repeat(81)}  `,
      description: `第一行\n${"😀".repeat(241)}`,
    });

    expect([...presentation.title_zh]).toHaveLength(80);
    expect(presentation.title_zh).toBe(`${"界".repeat(79)}…`);
    expect([...presentation.description_zh]).toHaveLength(240);
    expect(presentation.description_zh).toBe(`第一行 ${"😀".repeat(235)}…`);
    expect(presentation).toMatchObject({
      type_label_zh: "组件",
      status_label_zh: "待确认",
      fallback: false,
    });
  });

  it("uses stable lexical traversal and ignores arrays or fields deeper than four levels", () => {
    const presentation = presentNode({
      id: "decision_01",
      digest: "d".repeat(64),
      type: "Decision",
      status: "accepted",
      a: { name: "采用统一身份认证" },
      z: { name: "不应优先采用的名称" },
      array: [{ display_name: "数组中的名称" }],
      one: { two: { three: { four: { display_name: "过深的名称" } } } },
      reason: "减少各业务模块重复维护账号体系。",
    });

    expect(presentation).toMatchObject({
      title_zh: "采用统一身份认证",
      description_zh: "减少各业务模块重复维护账号体系。",
      type_label_zh: "决策",
      derived_from: ["a.name", "reason"],
      fallback: false,
    });
  });

  it("presents a governed graph relation without replacing its technical identity", () => {
    const digest = "e".repeat(64);

    expect(
      presentEdge({
        id: "edge_requirement_task",
        digest,
        type: "MAY_IMPACT",
        status: "proposed",
        source_id: "requirement_login",
        target_id: "task_auth",
        reason: "登录需求变化可能要求重新验证认证任务。",
      }),
    ).toEqual({
      presentation_version: "1",
      entity_id: "edge_requirement_task",
      binding_digest: digest,
      title_zh: "可能影响",
      description_zh: "登录需求变化可能要求重新验证认证任务。",
      type_label_zh: "可能影响",
      status_label_zh: "待确认",
      technical_type: "MAY_IMPACT",
      technical_status: "proposed",
      badges: [],
      derived_from: ["reason"],
      fallback: false,
    });
  });

  it("summarizes a finding group with textual severity and actionability badges", () => {
    const digest = "f".repeat(64);

    expect(
      presentFindingGroup({
        group_id: "finding-group_01",
        membership_digest: digest,
        rule: "missing_verification",
        scope_prefix: "project/repository_atlas/auth",
        severity: "blocker",
        actionability: "human_review",
        open_count: 3,
        member_count: 4,
      }),
    ).toEqual({
      presentation_version: "1",
      entity_id: "finding-group_01",
      binding_digest: digest,
      title_zh: "缺少验证证据",
      description_zh: "认证范围存在缺少验证证据的问题，共 3 项待处理。",
      type_label_zh: "问题组",
      status_label_zh: "待处理",
      technical_type: "FindingGroup",
      technical_status: "open",
      badges: [
        { label_zh: "严重级别", value: "阻断", tone: "critical" },
        { label_zh: "处置方式", value: "人工复核", tone: "warning" },
        { label_zh: "开放项", value: "3 / 4", tone: "critical" },
      ],
      derived_from: ["rule", "scope_prefix", "severity", "actionability", "open_count"],
      fallback: false,
    });
  });

  it("keeps a semantic impact suggestion visibly non-authoritative", () => {
    const digest = "1".repeat(64);

    expect(
      presentSemanticProposal({
        edge_id: "proposal_edge_01",
        preview_digest: digest,
        source_node_id: "requirement_login",
        candidate_node_id: "component_auth",
        score: 875_000,
        reason: "需求与认证组件共享登录契约特征。",
      }),
    ).toEqual({
      presentation_version: "1",
      entity_id: "proposal_edge_01",
      binding_digest: digest,
      title_zh: "候选影响关系",
      description_zh: "需求与认证组件共享登录契约特征。",
      type_label_zh: "语义候选",
      status_label_zh: "待批准",
      technical_type: "SemanticProposal",
      technical_status: "pending",
      badges: [{ label_zh: "相似度", value: "0.875", tone: "warning" }],
      derived_from: ["reason", "score"],
      fallback: false,
    });
  });

  it("describes a live workflow phase while retaining event provenance", () => {
    expect(
      presentEvent({
        id: "live:stream_01:7",
        source: "live",
        authoritative: false,
        event: {
          event_type: "PhaseStarted",
          payload: { phase: "impact" },
        },
      }),
    ).toEqual({
      presentation_version: "1",
      entity_id: "live:stream_01:7",
      binding_digest: null,
      title_zh: "开始影响分析",
      description_zh: "工作流已进入影响分析阶段。",
      type_label_zh: "实时事件",
      status_label_zh: "进行中",
      technical_type: "PhaseStarted",
      technical_status: "live",
      badges: [
        { label_zh: "阶段", value: "影响分析", tone: "neutral" },
        { label_zh: "来源", value: "实时信号", tone: "warning" },
      ],
      derived_from: ["event.payload.phase", "source", "authoritative"],
      fallback: false,
    });
  });

  it("explains an approval while keeping the original object digest as its binding", () => {
    const digest = "2".repeat(64);

    expect(
      presentApproval({
        request_id: "approval_request_01",
        object_id: "impact_set_01",
        object_type: "ImpactSet",
        object_digest: digest,
        reason: "确认登录需求涉及的组件和验证范围。",
        risk: "high",
        allowed_decisions: ["approve", "reject", "defer"],
      }),
    ).toEqual({
      presentation_version: "1",
      entity_id: "approval_request_01",
      binding_digest: digest,
      title_zh: "批准影响范围",
      description_zh: "确认登录需求涉及的组件和验证范围。",
      type_label_zh: "审批请求",
      status_label_zh: "等待决策",
      technical_type: "ImpactSet",
      technical_status: "pending",
      badges: [
        { label_zh: "风险", value: "高风险", tone: "critical" },
        { label_zh: "允许操作", value: "批准 / 拒绝 / 稍后决定", tone: "neutral" },
      ],
      derived_from: ["reason", "risk", "allowed_decisions"],
      fallback: false,
    });
  });

  it("covers every current node, relation, and persisted status with a stable Chinese label", () => {
    const nodeLabels = {
      Project: "项目",
      Repository: "代码仓库",
      Iteration: "迭代",
      Intent: "业务意图",
      Requirement: "需求",
      Constraint: "约束",
      Decision: "决策",
      Component: "组件",
      ExecutionPlan: "执行计划",
      Task: "任务",
      CodeArtifact: "代码产物",
      Policy: "治理策略",
      ToolDefinition: "工具定义",
      Test: "测试",
      EvaluationCase: "评估用例",
      Gate: "质量门禁",
      ContextBundle: "上下文包",
      Run: "执行运行",
      Checkpoint: "检查点",
      Evidence: "证据",
      ApprovalRequest: "审批请求",
      Approval: "审批决定",
      Finding: "问题",
      RootCauseAnalysis: "根因分析",
      ImprovementCandidate: "改进候选",
      ImpactSet: "影响范围",
    } as const;
    const relationLabels = {
      DERIVES_FROM: "派生自",
      SUPERSEDES: "取代",
      GENERATED_BY: "生成自",
      RESUMES: "恢复",
      DECOMPOSES_TO: "拆解为",
      ADDRESSES: "处理",
      CONSTRAINED_BY: "受约束于",
      GOVERNED_BY: "受治理于",
      SHAPES: "塑造",
      REALIZES: "实现目标",
      IMPLEMENTS: "实现",
      VERIFIES: "验证",
      EVALUATES: "评估",
      EXECUTES: "执行",
      INVOKES: "调用",
      PRODUCES: "产出",
      SUPPORTS: "支持",
      REFUTES: "反驳",
      VIOLATES: "违反",
      CONTAINS: "包含",
      DEPENDS_ON: "依赖",
      USES_CONTEXT: "使用上下文",
      CAPTURES: "记录",
      BLOCKS: "阻塞",
      REQUESTS_APPROVAL_FOR: "请求批准",
      RESOLVES: "解决",
      APPROVES: "批准",
      DIAGNOSED_BY: "诊断自",
      PROPOSES_CHANGE_TO: "建议变更",
      TRIGGERS: "触发",
      MAY_IMPACT: "可能影响",
    } as const;

    for (const [type, expected] of Object.entries(nodeLabels)) {
      expect(
        presentNode({
          id: "node_01",
          digest: "3".repeat(64),
          type,
          status: "accepted",
          title: "业务名称",
          description: "业务说明。",
        }).type_label_zh,
      ).toBe(expected);
    }
    for (const [type, expected] of Object.entries(relationLabels)) {
      expect(
        presentEdge({
          id: "edge_01",
          digest: "4".repeat(64),
          type,
          status: "accepted",
          reason: "业务关联说明。",
        }).type_label_zh,
      ).toBe(expected);
    }
    for (const [status, expected] of Object.entries({
      proposed: "待确认",
      accepted: "已接受",
      rejected: "已拒绝",
      superseded: "已取代",
      tombstoned: "已移除",
    })) {
      expect(
        presentNode({
          id: "node_01",
          digest: "5".repeat(64),
          type: "Task",
          status,
          title: "业务名称",
          description: "业务说明。",
        }).status_label_zh,
      ).toBe(expected);
    }
  });

  it("renders Evidence verdict and freshness as textual governance badges", () => {
    expect(
      presentNode({
        id: "evidence_gate_01",
        digest: "6".repeat(64),
        type: "Evidence",
        status: "accepted",
        source: "gate",
        extensions: {
          "harness.gate": {
            gate_id: "gate_test",
            passed: false,
            freshness: "stale",
            provisional: true,
          },
        },
      }),
    ).toMatchObject({
      title_zh: "证据 · evidence_gate_01",
      description_zh: "该证据记录门禁或评估对受治理对象的验证结果。",
      badges: [
        { label_zh: "验证结果", value: "未通过", tone: "critical" },
        { label_zh: "新鲜度", value: "已过期", tone: "warning" },
        { label_zh: "临时证据", value: "是", tone: "warning" },
      ],
      derived_from: [
        "extensions.harness.gate.passed",
        "extensions.harness.gate.freshness",
        "extensions.harness.gate.provisional",
      ],
      fallback: true,
    });
  });

  it("translates iteration state, run outcome, and task verdict into readable badges", () => {
    expect(
      presentNode({
        id: "iteration_01",
        digest: "7".repeat(64),
        type: "Iteration",
        status: "accepted",
        iteration_state: "running",
        objective: "交付登录闭环。",
        description: "从需求到验证完成登录能力。",
      }).badges,
    ).toEqual([{ label_zh: "迭代状态", value: "执行中", tone: "positive" }]);
    expect(
      presentNode({
        id: "run_01",
        digest: "8".repeat(64),
        type: "Run",
        status: "accepted",
        title: "执行认证任务",
        description: "Agent 完成实现并交还控制权。",
        extensions: { "harness.run": { outcome: "handoff" } },
      }).badges,
    ).toEqual([{ label_zh: "执行结果", value: "已交接", tone: "warning" }]);
    expect(
      presentNode({
        id: "task_01",
        digest: "9".repeat(64),
        type: "Task",
        status: "accepted",
        title: "验证登录接口",
        description: "执行接口与集成测试。",
        extensions: { "harness.task": { verdict: "passed" } },
      }).badges,
    ).toEqual([{ label_zh: "任务判定", value: "已通过", tone: "positive" }]);
  });

  it("covers every Dashboard live event with deterministic Chinese action text", () => {
    const events = [
      {
        type: "PhaseCompleted",
        payload: { phase: "verify" },
        title: "完成门禁验证",
        status: "已完成",
      },
      {
        type: "PhasePaused",
        payload: { phase: "execute", status: "waiting" },
        title: "暂停 Agent 执行",
        status: "等待中",
      },
      {
        type: "GateStarted",
        payload: { gate_id: "gate_test" },
        title: "开始质量门禁",
        status: "验证中",
      },
      {
        type: "GateCompleted",
        payload: { gate_id: "gate_test", passed: false },
        title: "质量门禁未通过",
        status: "未通过",
      },
      {
        type: "RunStarted",
        payload: { run_id: "run_01" },
        title: "开始 Agent 执行",
        status: "运行中",
      },
      {
        type: "RunHeartbeat",
        payload: { run_id: "run_01", status: "unknown" },
        title: "执行状态未知",
        status: "状态未知",
      },
      {
        type: "RunOutputSummary",
        payload: { run_id: "run_01", summary: "已完成登录接口实现。" },
        title: "执行输出摘要",
        status: "已更新",
      },
      {
        type: "BudgetUpdated",
        payload: { total_tokens: 1200 },
        title: "执行预算已更新",
        status: "已更新",
      },
      {
        type: "ApprovalRequired",
        payload: { request_id: "approval_request_01", reason: "确认影响范围。" },
        title: "需要人工审批",
        status: "等待决策",
      },
    ] as const;

    for (const [index, fixture] of events.entries()) {
      expect(
        presentEvent({
          id: `live:stream_01:${String(index + 10)}`,
          source: "ledger",
          authoritative: true,
          event: { event_type: fixture.type, payload: fixture.payload },
        }),
      ).toMatchObject({
        title_zh: fixture.title,
        status_label_zh: fixture.status,
        technical_type: fixture.type,
        technical_status: "authoritative",
        fallback: false,
      });
    }
  });

  it("marks unknown protocol values as fallback even when business text is available", () => {
    expect(
      presentNode({
        id: "node_unknown",
        digest: "0".repeat(64),
        type: "FutureNode",
        status: "future_status",
        title: "未来业务对象",
        description: "来自未来协议版本的对象。",
      }),
    ).toMatchObject({
      title_zh: "未来业务对象",
      type_label_zh: "未知类型 / FutureNode",
      status_label_zh: "未知状态 / future_status",
      fallback: true,
    });
  });

  it("builds a stable sidecar keyed only by entity id and binding digest", () => {
    const nodePresentation = presentNode({
      id: "task_02",
      digest: "b".repeat(64),
      type: "Task",
      status: "accepted",
      title: "后置任务",
      description: "验证稳定排序。",
    });
    const edgePresentation = presentEdge({
      id: "edge_01",
      digest: "a".repeat(64),
      type: "IMPLEMENTS",
      status: "accepted",
      reason: "任务实现需求。",
    });

    const forward = presentationMap([nodePresentation, edgePresentation]);
    const reverse = presentationMap([edgePresentation, nodePresentation]);

    expect(Object.keys(forward)).toEqual([
      `edge_01@${"a".repeat(64)}`,
      `task_02@${"b".repeat(64)}`,
    ]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  it("limits every badge value even when an unknown protocol value is unusually long", () => {
    const longValue = "未".repeat(60);
    const approval = presentApproval({
      request_id: "approval_request_long",
      object_type: "ImpactSet",
      object_digest: "c".repeat(64),
      reason: "确认影响范围。",
      risk: longValue,
      allowed_decisions: [longValue],
    });
    const finding = presentFindingGroup({
      group_id: "finding-group_long",
      membership_digest: "d".repeat(64),
      rule: "missing_verification",
      scope_prefix: "verification",
      severity: longValue,
      actionability: longValue,
      open_count: 1,
      member_count: 1,
    });

    for (const item of [...approval.badges, ...finding.badges]) {
      expect([...item.value].length).toBeLessThanOrEqual(48);
    }
  });
});
