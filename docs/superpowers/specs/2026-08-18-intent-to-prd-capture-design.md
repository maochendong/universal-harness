# Universal Harness Intent → 高质量 PRD Capture 设计

日期：2026-08-18
状态：评审问题已修订，统一实施计划已重编，待实施授权
目标版本：Protocol 1.1.0
关联设计：

- [Universal Harness Slim Profiles 与 Capability Kernel 设计](./2026-08-18-harness-slim-profiles-design.md)
- [Universal Harness DesignSet 生命周期设计](./2026-08-18-designset-lifecycle-design.md)
- [Universal Harness 可证明 TDD 协议设计](./2026-08-18-provable-tdd-protocol-design.md)

## 1. 摘要

Universal Harness 当前的 Capture 能把结构化输入提交为 RequirementBaseline，也能让一次性 `IntentInterpreter` 返回澄清问题，但它不能保证自由文本 Intent 被持续澄清为高质量 PRD：澄清时不创建 Operation，问题和答案没有权威会话，CLI 与 Dashboard 无法共同续接；默认 `createGenericInterpreter()` 会把原始 Intent 包装成一条“mandatory gate suite passes”的需求；一次模型输出可以直接进入 RequirementBaseline，而没有完整语义硬门禁和独立质量评审。

本设计把 Capture 升级为 Evidence Kernel 内部的受管 PRD 状态机：

```text
Intent
  → controlled proposal-purpose ProjectContextBundle
  → structured PrdProposal
  → deterministic PRD quality gates
  → managed clarification rounds
  → controlled review-purpose ProjectContextBundle
  → independent PrdReview
  → profile/risk-adaptive approval
  → immutable accepted PRD
  → RequirementBaseline + Intent/Requirement/Constraint/Test graph
```

`PrdProposal` 是 PRD 内容唯一权威源。模型、Manual 表单和旧 `IntentInterpreter` 只能提出结构化 Proposal 或问题，不能写 Ledger、批准自身输出或直接生成 accepted RequirementBaseline。Harness 对 Proposal 做确定性的 Schema、引用、完整性、一致性和测试先行准备度校验；独立 `PrdReviewPort` 再做语义质量评审。最终 accepted PRD、RequirementBaseline、图记录、Review/Policy/Profile/Approval bindings 和 Capture checkpoint 在一次 Ledger transaction 中原子提交，批准版本不可原地修改。

Capture 是所有 Profile 共享的 Evidence Kernel，不增加公共 lifecycle phase。Lite、Standard、Governed 改变上下文深度、Adapter/Review budget、风险阈值和人工批准要求，但不能关闭受管会话、硬门禁、独立 Review 或不可变提交。

现有 `IntentInterpreter` 保留一个 major 的兼容期，通过 `LegacyIntentInterpreterAdapter` 接入 `PrdProposalPort`。旧输出仍必须通过新硬门禁和独立 Review；`createGenericInterpreter()` 不再是默认生产路径。

## 2. 背景与现状缺口

### 2.1 当前实现

当前链路为：

```text
intent string
  → IntentInterpreter(intent)
      ├── InterpretedIntent
      ├── ClarificationOffer
      └── undefined
  → captureRequirements
  → RequirementProposal
  → RequirementBaseline approval
  → atomic graph materialization
```

现有实现提供了有价值的基础：

- `captureRequirements` 以纯函数检查空需求、空验收标准和无 verification 的约束；
- RequirementBaseline digest 与 ApprovalRequest/提交内容绑定；
- accepted Intent、Requirement、Constraint、Test 和关系边原子提交；
- ClarificationOffer 支持带选项问题并由 Harness 添加 `other`；
- CLI 能返回 typed `input_required`。

### 2.2 实质缺口

1. 首轮澄清发生在 `startOperation` 之前，问题、答案、轮次和预算不可恢复。
2. `IntentInterpreter` 只接收一个字符串，无法安全消费项目上下文、已有答案、旧 Proposal 和评审反馈。
3. `createGenericInterpreter()` 默认把任意 Intent 变成一条低信息需求，形式完整但业务质量不足。
4. `captureRequirements` 只检查字段存在，不检查目标、非目标、业务场景、术语、依赖、风险、冲突和测试先行准备度。
5. 模型既提出需求又隐含完成质量判断，没有独立 reviewer。
6. CLI 返回问题后丢失会话；Dashboard 没有 Capture 读写接口。
7. PRD Markdown 由当前图重建，但没有 accepted PRD version 作为完整内容与评审绑定。
8. Test 节点只复制 acceptance 文本，没有稳定 acceptance criterion id，无法贯通澄清、DesignSet、TaskTddContract 和 Red/Green Evidence。

## 3. 已确认的产品决策

| 决策 | 结论 |
| --- | --- |
| 生命周期位置 | Capture 内部受管状态机，不新增公共 phase |
| 项目上下文 | 自动读取受控上下文，严格路径/预算/脱敏/digest |
| 内容权威 | structured PrdProposal 是 PRD 内容唯一权威源 |
| 质量判断 | 确定性硬门禁 + 独立 PrdReviewPort |
| Review 独立性 | 独立调用、上下文、prompt/version、conversation 和 Evidence；可同供应商/模型 |
| 人工批准 | Profile/风险自适应；Governed 强制人工 |
| 版本 | accepted PRD 不可变；修订创建新 version/SUPERSEDES |
| 用户入口 | CLI/Dashboard 共用同一 Capture Session |
| 无 Proposal 模型 | 默认 Manual 结构化录入，不使用 Generic Interpreter 包装 |
| Adapter 配置 | Proposal、Review、执行 Agent 三个独立配置槽和 identity |
| 旧接口 | IntentInterpreter 保留一个 major，通过兼容 Adapter 接入 |
| TDD 协同 | 澄清必须形成测试先行验收标准；DesignSet 再批准具体 Oracle/Gate/路径 |
| Profile 协同 | Capture 属于 Evidence Kernel；三档只改变深度、预算、风险与批准策略 |

## 4. 目标与非目标

### 4.1 目标

1. 任意 Intent 在第一次语义处理前就有可恢复 Capture Session。
2. 多轮问题、答案、Proposal、Validation、Review、Profile 和 Approval 全部可重放。
3. 项目上下文自动提供但严格受 Policy、路径、尺寸、脱敏和 baseline digest 控制。
4. Proposal/Review Adapter 无状态、只读、可替换，不能成为第二权威源。
5. accepted PRD 满足确定性完整性、语义质量和测试先行准备度。
6. CLI 与 Dashboard 可交替操作同一会话，不复制状态机。
7. 低风险项目保持 Lite 入口成本，高风险项目自动增强治理或建议升级。
8. Requirement/Acceptance/Test/DesignSet/TddContract/Evidence 形成稳定追踪链。
9. Protocol 1.0 历史保持可读，不补造不存在的 Proposal/Review 证据。

### 4.2 非目标

- 不让模型直接编辑 Markdown PRD 或 `.harness` Ledger。
- 不把 PRD Markdown 恢复为权威源。
- 不在 Capture 中决定技术架构、具体测试文件、测试框架或 Failure Oracle。
- 不要求所有项目使用不同供应商完成 Proposal 和 Review。
- 不允许 Profile、Override 或人工批准绕过公共硬门禁、critical Review Finding 或 Policy deny。
- 不在本设计中实施代码、修改现有实施计划或发布 Protocol 1.1。
- 不把 External Action Intent 与业务 Intent 混为同一种记录。

## 5. 总体架构

### 5.1 深模块

新增 `PrdCaptureCoordinator` 深模块。外部 Interface 只有一个推进方法：

```ts
export interface PrdCaptureCoordinator {
  advance(command: CaptureCommand): Promise<CaptureOutcome>;
}
```

`CaptureCommand` 只表达触发 Coordinator 的领域动作，不表达目标 state：

```ts
export type CaptureCommand =
  | StartCaptureCommand
  | SubmitClarificationAnswersCommand
  | SubmitManualReviewInputCommand
  | RequestPrdRevisionCommand
  | ApplyApprovalDecisionCommand
  | ResumeCaptureCommand
  | CancelCaptureCommand;
```

`ApplyApprovalDecisionCommand` 只携带已由统一 ApprovalService 提交的 request id、decision id 和 expected session digest；调用方不能在命令中伪造 decision 内容。`SubmitManualReviewInputCommand` 绑定 reviewer actor、review invocation id、rubric/profile digest 和 expected session digest，不能作为业务澄清答案回流 Proposal。

调用方不能传入目标 state、跳过 Validation/Review、直接标记 accepted，或提交 RequirementBaseline。Coordinator 内部拥有：

- 状态迁移和 checkpoint；
- canonicalization/digest；
- Context/Proposal/Review 调度；
- retry/round/budget；
- deterministic gates；
- Profile/Risk/Approval 路由；
- invalidation/supersede；
- accepted PRD 原子提交。

CLI、Dashboard、Orchestrator 和测试都跨同一个 Interface。删除该 Module 会使上述复杂性重新散落到多个调用方，因此它不是浅层透传。

### 5.2 真实 seam

仅保留三个外部变化点：

```ts
export interface ProjectContextPort {
  compile(input: ProjectContextRequest): Promise<ProjectContextResult>;
}

export interface PrdProposalPort {
  propose(input: PrdProposalInput): Promise<PrdProposalResult>;
}

export interface PrdReviewPort {
  review(input: PrdReviewInput): Promise<PrdReviewResult>;
}
```

Ledger repository、state transition、quality rules、approval routing 和 graph materialization 是 Coordinator 内部能力，不再为每一步暴露一个浅 Port。

### 5.3 权威所有权

- 人类拥有 Intent、澄清答案和人工 ApprovalDecision；版本化 Policy identity 拥有受规则约束的自动 ApprovalDecision。
- ProjectContextPort 只拥有受控读取实现，不拥有 Context 选择 Policy。
- Proposal Adapter 只拥有生成实现，不拥有 Proposal validity/state。
- Review Adapter 只拥有评审实现，不拥有最终 accept/reject。
- Coordinator 拥有状态机和确定性派生。
- Ledger 拥有已提交的 Session/Proposal/Lineage/Manual Review/Review/Risk/Approval/accepted PRD 历史。
- Graph 是 accepted PRD 的权威工程关系表达。
- Markdown PRD 是可重建 Projection。

## 6. 权威数据模型

Capture 会话与候选工件使用 append-only runtime records，不为每轮问题或模型调用增加 Graph Node。只有 accepted PRD 物化业务图。

### 6.1 CaptureSessionRecord

```ts
export interface CaptureSessionRecord {
  readonly record_kind: "capture_session";
  readonly protocol_version: "1.1.0";
  readonly session_id: string;
  readonly revision: number;
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly state: CaptureState;
  readonly blocked_reason?: CaptureBlockReason;
  readonly intent_text: string;
  readonly intent_digest: string;
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly project_baseline_digest: string;
  readonly proposal_context_bundle_digest?: string;
  readonly review_context_bundle_digest?: string;
  readonly current_proposal_digest?: string;
  readonly current_validation_digest?: string;
  readonly current_review_digest?: string;
  readonly current_risk_assessment_digest?: string;
  readonly current_approval_request_id?: string;
  readonly applied_approval_decision_id?: string;
  readonly pending_question_ids: readonly string[];
  readonly round: number;
  readonly budget_use: CaptureBudgetUse;
  readonly supersedes_digest?: string;
  readonly record_digest: string;
}
```

Session revision 只追加，不原地修改。时间、实时 tokens/steps 和 UI metadata 不进入语义 digest；它们保存在 provenance/observation 区域。

### 6.2 Clarification records

```ts
export interface ClarificationQuestionRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "clarification_question";
  readonly question_id: string;
  readonly session_id: string;
  readonly round: number;
  readonly source: "deterministic_gate" | "proposal" | "review" | "human";
  readonly target_kind:
    | "intent"
    | "prd_section"
    | "requirement"
    | "constraint"
    | "acceptance_criterion"
    | "risk"
    | "glossary";
  readonly target_id?: string;
  readonly missing_dimension: string;
  readonly question: string;
  readonly options?: readonly ClarificationOption[];
  readonly required: boolean;
  readonly status: "open" | "answered" | "superseded";
  readonly content_digest: string;
}

export interface ClarificationAnswerRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "clarification_answer";
  readonly answer_id: string;
  readonly session_id: string;
  readonly question_id: string;
  readonly answer_kind: "selected_option" | "free_text" | "structured";
  readonly value: unknown;
  readonly actor: string;
  readonly expected_session_digest: string;
  readonly content_digest: string;
}
```

Question 必须引用精确对象和 missing dimension。答案不能覆盖旧问题；重新回答会追加新 Answer 并使依赖旧答案的 Proposal/Review 失效。

### 6.3 ProjectContextBundleRecord

```ts
export interface ProjectContextSource {
  readonly locator: string;
  readonly source_kind: string;
  readonly source_digest: string;
  readonly selection_reason: string;
  readonly classification: "public_project" | "internal_project" | "restricted";
  readonly summary: string;
  readonly truncated: boolean;
}

export interface ProjectContextBundleRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "project_context_bundle";
  readonly bundle_id: string;
  readonly session_id: string;
  readonly purpose: "proposal" | "review";
  readonly project_baseline_digest: string;
  readonly profile_digest: string;
  readonly policy_digest: string;
  readonly budget: ProjectContextBudget;
  readonly sources: readonly ProjectContextSource[];
  readonly content_digest: string;
}
```

Bundle 保存模型实际看见的规范摘要与 source digest，不保存未授权原始文件或 secret。

### 6.4 PrdProposalRecord

```ts
export interface PrdProposalRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "prd_proposal";
  readonly proposal_id: string;
  readonly session_id: string;
  readonly revision: number;
  readonly status: "proposed" | "superseded" | "rejected" | "accepted";
  readonly input_binding: {
    readonly session_digest: string;
    readonly proposal_context_bundle_digest: string;
    readonly answers_digest: string;
    readonly adapter_profile_digest: string;
    readonly prompt_version_digest: string;
    readonly producer_identity: string;
    readonly invocation_id: string;
    readonly conversation_id: string;
    readonly evidence_locator: string;
  };
  readonly content: PrdProposal;
  readonly content_digest: string;
  readonly supersedes_digest?: string;
  readonly record_digest: string;
}
```

`PrdProposal` 的 Protocol 1.1 权威结构如下；实现时必须提供等价、`additionalProperties: false` 的版本化 JSON Schema，不允许各 Adapter 自行扩展内容形状：

```ts
export interface PrdSourceBinding {
  readonly source_kind:
    | "intent"
    | "clarification_answer"
    | "project_context"
    | "accepted_prd"
    | "validation_finding"
    | "review_finding";
  readonly source_id: string;
  readonly source_digest: string;
}

export interface PrdTraceableEntity {
  readonly id: string;
  readonly source_bindings: readonly PrdSourceBinding[];
}

export interface PrdStatement extends PrdTraceableEntity {
  readonly statement: string;
}

export interface PrdActor extends PrdTraceableEntity {
  readonly name: string;
  readonly description: string;
}

export interface PrdScenario extends PrdTraceableEntity {
  readonly actor_id: string;
  readonly precondition: string;
  readonly action: string;
  readonly observable_outcome: string;
  readonly scenario_kind:
    | "primary"
    | "failure"
    | "boundary"
    | "security"
    | "compatibility";
}

export interface PrdRequirement extends PrdTraceableEntity {
  readonly statement: string;
  readonly priority: "must" | "should" | "could";
  readonly change_kind: "must_change" | "preserve";
  readonly scenario_ids: readonly string[];
  readonly acceptance_criterion_ids: readonly string[];
}

export interface PrdConstraint extends PrdTraceableEntity {
  readonly statement: string;
  readonly category:
    | "business"
    | "technical"
    | "security"
    | "compliance"
    | "compatibility"
    | "operational";
  readonly verification_intent: string;
}

export interface PrdDependency extends PrdTraceableEntity {
  readonly dependency_kind: "internal" | "external";
  readonly description: string;
  readonly required_by_ids: readonly string[];
}

export type PrdRiskCategory =
  | "security"
  | "privacy"
  | "compliance"
  | "financial"
  | "data_integrity"
  | "availability"
  | "compatibility"
  | "migration"
  | "operational"
  | "delivery"
  | "other";

export interface PrdRisk extends PrdTraceableEntity {
  readonly category: PrdRiskCategory;
  readonly description: string;
  readonly likelihood: "low" | "medium" | "high" | "unknown";
  readonly impact: "low" | "medium" | "high" | "critical" | "unknown";
  readonly mitigation: string;
}

export interface PrdOpenQuestion extends PrdTraceableEntity {
  readonly question: string;
  readonly blocking: boolean;
  readonly owner: string;
}

export interface PrdGlossaryTerm extends PrdTraceableEntity {
  readonly term: string;
  readonly definition: string;
}

export interface PrdProposal {
  readonly schema_version: "1.1.0";
  readonly intent: {
    readonly text: string;
    readonly digest: string;
  };
  readonly problem_statement: string;
  readonly goals: readonly PrdStatement[];
  readonly non_goals: readonly PrdStatement[];
  readonly actors: readonly PrdActor[];
  readonly scenarios: readonly PrdScenario[];
  readonly requirements: readonly PrdRequirement[];
  readonly constraints: readonly PrdConstraint[];
  readonly acceptance_criteria: readonly PrdAcceptanceCriterion[];
  readonly assumptions: readonly PrdStatement[];
  readonly dependencies: readonly PrdDependency[];
  readonly risks: readonly PrdRisk[];
  readonly open_questions: readonly PrdOpenQuestion[];
  readonly glossary: readonly PrdGlossaryTerm[];
  readonly context_source_refs: readonly string[];
}
```

所有集合按 id 规范排序；引用集合去重后排序。每个 traceable entity 至少一个有效 SourceBinding；accepted Proposal 不允许存在 `blocking: true` 的 OpenQuestion。Adapter metadata、时间、token、conversation id、Review 结论和技术设计均不进入 `PrdProposal` 内容摘要。

Adapter 返回的不是权威 `PrdProposal`，而是 `PrdProposalDraft`。Draft 与上述语义字段同构，但每个 entity 使用本次调用内唯一的 `draft_key` 和以下 lineage 声明替代最终 id：

```ts
export type PrdDraftLineage =
  | { readonly kind: "new" }
  | { readonly kind: "continues"; readonly previous_entity_id: string };

export type PrdDraftEntity<T extends PrdTraceableEntity> = Omit<
  T,
  "id" | "source_bindings"
> & {
  readonly draft_key: string;
  readonly lineage: PrdDraftLineage;
  readonly proposed_source_bindings: readonly PrdSourceBinding[];
};

export type PrdDraftAcceptanceCriterion = Omit<
  PrdAcceptanceCriterion,
  "criterion_id" | "source_bindings"
> & {
  readonly draft_key: string;
  readonly lineage: PrdDraftLineage;
  readonly proposed_source_bindings: readonly PrdSourceBinding[];
};

export interface PrdProposalDraft {
  readonly schema_version: "1.1.0";
  readonly intent: PrdProposal["intent"];
  readonly problem_statement: string;
  readonly goals: readonly PrdDraftEntity<PrdStatement>[];
  readonly non_goals: readonly PrdDraftEntity<PrdStatement>[];
  readonly actors: readonly PrdDraftEntity<PrdActor>[];
  readonly scenarios: readonly PrdDraftEntity<PrdScenario>[];
  readonly requirements: readonly PrdDraftEntity<PrdRequirement>[];
  readonly constraints: readonly PrdDraftEntity<PrdConstraint>[];
  readonly acceptance_criteria: readonly PrdDraftAcceptanceCriterion[];
  readonly assumptions: readonly PrdDraftEntity<PrdStatement>[];
  readonly dependencies: readonly PrdDraftEntity<PrdDependency>[];
  readonly risks: readonly PrdDraftEntity<PrdRisk>[];
  readonly open_questions: readonly PrdDraftEntity<PrdOpenQuestion>[];
  readonly glossary: readonly PrdDraftEntity<PrdGlossaryTerm>[];
  readonly context_source_refs: readonly string[];
}
```

Coordinator 对 `new` 铸造 Harness id；对 `continues` 复用精确 previous id，并验证 kind 相同、旧 id 存在且本 revision 只被领取一次。continues 保持逻辑 id，图物化时递增对应 Node revision，旧字节留在 Ledger；LineageRecord 用 previous Proposal digest 记录连续性。真正替换业务身份时必须声明 new，并由 accepted PRD/Graph 的 supersede 记录连接版本。删除实体只通过新 Proposal 不再引用旧 id 表达。禁止 Adapter 自选最终 id，也禁止 Harness 以文本相似度猜测 lineage；无法确定时生成定向澄清问题。

Draft 内所有名为 `*_id` / `*_ids` 的实体引用，在同一 Draft 中使用 target `draft_key`，引用上一 accepted PRD 时使用 canonical id；Coordinator 必须在生成 Proposal 前解析为 canonical id，并拒绝 dangling、跨 kind 或歧义引用。

### 6.5 Acceptance Criterion

```ts
export interface PrdAcceptanceCriterion {
  readonly criterion_id: string;
  readonly requirement_id: string;
  readonly precondition: string;
  readonly action: string;
  readonly observable_outcome: string;
  readonly verification_intent: string;
  readonly test_first_example?: string;
  readonly scenario_kind: "primary" | "failure" | "boundary" | "security" | "compatibility";
  readonly source_bindings: readonly PrdSourceBinding[];
}
```

Criterion 是业务验收事实，不包含具体测试文件、framework、selector、Gate id 或 Failure Oracle；这些属于 DesignSet.test_strategy。若 Criterion 由澄清答案形成或改变，其 SourceBinding 必须引用对应 AnswerRecord 的 id/digest；AnswerRecord 已绑定 QuestionRecord，因此可机械复验 `Question → Answer → Criterion`。

Coordinator 为每个 Proposal revision 派生索引记录；它不复制内容权威，只加速来源追踪：

```ts
export interface PrdEntityLineageRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "prd_entity_lineage";
  readonly lineage_record_id: string;
  readonly session_id: string;
  readonly proposal_content_digest: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly lineage_kind: "new" | "continues";
  readonly source_bindings: readonly PrdSourceBinding[];
  readonly previous_proposal_content_digest?: string;
  readonly record_digest: string;
}
```

### 6.6 Validation 与 Review

```ts
export interface PrdValidationReportRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "prd_validation_report";
  readonly validation_report_id: string;
  readonly session_id: string;
  readonly proposal_digest: string;
  readonly rule_set_digest: string;
  readonly passed: boolean;
  readonly results: readonly PrdValidationRuleResult[];
  readonly blocking_question_ids: readonly string[];
  readonly report_digest: string;
}

export interface PrdReviewReportRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "prd_review_report";
  readonly review_report_id: string;
  readonly session_id: string;
  readonly proposal_digest: string;
  readonly review_context_bundle_digest: string;
  readonly validation_digest: string;
  readonly reviewer_adapter_profile_digest: string;
  readonly reviewer_identity: string;
  readonly prompt_version_digest: string;
  readonly invocation_id: string;
  readonly conversation_id: string;
  readonly evidence_locator: string;
  readonly verdict: "accept" | "revise" | "clarify" | "blocked";
  readonly dimensions: readonly PrdReviewDimension[];
  readonly findings: readonly PrdReviewFinding[];
  readonly suggested_questions: readonly ClarificationQuestionDraft[];
  readonly report_digest: string;
}
```

ReviewReport 是质量 Evidence，不是 ApprovalDecision。Harness 复验 finding severity、mandatory dimensions、independence binding 和 Profile policy 后才决定下一状态。

Manual Review 的人工 rubric 输入独立保存，不进入 ClarificationAnswer：

```ts
export interface ManualReviewInputRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "manual_review_input";
  readonly manual_review_input_id: string;
  readonly session_id: string;
  readonly review_invocation_id: string;
  readonly reviewer_actor: string;
  readonly rubric_digest: string;
  readonly dimension_inputs: readonly PrdReviewDimensionInput[];
  readonly expected_session_digest: string;
  readonly record_digest: string;
}
```

### 6.7 CaptureRiskAssessmentRecord

风险自适应批准必须基于可重放的确定性记录，而不是 Reviewer 或 Coordinator 中的隐式判断：

```ts
export type CaptureRiskLevel = "low" | "medium" | "high" | "critical";
export type CaptureMateriality = "non_material" | "material";
export type CaptureRiskConfidence = "high" | "medium" | "low";

export interface CaptureRiskTrigger {
  readonly trigger_id: string;
  readonly source_kind:
    | "proposal"
    | "validation"
    | "review"
    | "context_classification"
    | "policy";
  readonly source_id: string;
  readonly source_digest: string;
  readonly severity: CaptureRiskLevel;
  readonly reason: string;
}

export interface CaptureRiskAssessmentRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "capture_risk_assessment";
  readonly risk_assessment_id: string;
  readonly session_id: string;
  readonly proposal_content_digest: string;
  readonly validation_report_digest: string;
  readonly review_report_digest: string;
  readonly proposal_context_bundle_digest: string;
  readonly review_context_bundle_digest: string;
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly policy_digest: string;
  readonly rule_set_digest: string;
  readonly level: CaptureRiskLevel;
  readonly materiality: CaptureMateriality;
  readonly confidence: CaptureRiskConfidence;
  readonly triggers: readonly CaptureRiskTrigger[];
  readonly assessment_digest: string;
}
```

Risk Engine 只消费以上已绑定事实并按版本化 rule set 确定性归约：级别取命中触发器最高值；任何未知/冲突分类把 confidence 降为 low；Requirement、Constraint、API/data/security/compliance/compatibility 范围变化按 Policy 计算 materiality。Review 只提供带来源的 risk signal，不能直接决定 level、materiality 或批准。只有 `low + non_material + high confidence` 才可能进入 Policy 自动批准；Policy 可进一步收紧，不能放宽公共规则。

### 6.8 AcceptedPrdRecord

Accepted record 不复制第二份 PRD 内容，只封装唯一 Proposal content digest：

```ts
export interface AcceptedPrdRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "accepted_prd";
  readonly prd_id: string;
  readonly revision: number;
  readonly session_id: string;
  readonly workflow_operation_id: string;
  readonly proposal_id: string;
  readonly proposal_content_digest: string;
  readonly proposal_context_bundle_digest: string;
  readonly review_context_bundle_digest: string;
  readonly validation_report_digest: string;
  readonly review_report_digest: string;
  readonly risk_assessment_digest: string;
  readonly project_profile_digest: string;
  readonly profile_decision_digest: string;
  readonly capture_policy_digest: string;
  readonly policy_digest: string;
  readonly approval_digest: string;
  readonly requirement_baseline_digest: string;
  readonly supersedes_digest?: string;
  readonly record_digest: string;
}
```

同一 `prd_id` 的 revision 单调递增；superseding revision 通过 `supersedes_digest` 指向前一 AcceptedPrdRecord。accepted PRD、RequirementBaseline 和 graph records 的内容必须能反向复验到同一个 Proposal content digest。

## 7. Capture 内部状态机

### 7.1 状态

```ts
export type CaptureState =
  | "intent_received"
  | "context_compiling"
  | "proposing"
  | "validating"
  | "clarification_required"
  | "reviewing"
  | "review_input_required"
  | "risk_assessing"
  | "revision_required"
  | "profile_decision_required"
  | "approval_required"
  | "approval_deferred"
  | "accepted"
  | "blocked"
  | "cancelled";

export type CaptureBlockReason =
  | "review_provider_required"
  | "capture_budget_exhausted"
  | "review_blocked"
  | "risk_policy_denied";
```

`review_provider_required` 不是生命周期状态，而是 `blocked` 的 typed reason。`blocked_reason` 当且仅当 `state === "blocked"` 时必须存在；其他状态出现该字段一律拒绝。这样可以在不扩张状态机 Interface 的前提下精确表达恢复入口。恢复动作只能清除导致阻塞的条件并追加新 Session revision，不能原地改写旧记录。

### 7.2 主路径

```text
intent_received
  → context_compiling(proposal)
  → proposing
  → validating
      ├── fail → clarification_required / revision_required
      └── pass → context_compiling(review) → reviewing
                    ├── manual input → review_input_required → reviewing
                    ├── clarify → clarification_required
                    ├── revise → revision_required → context_compiling(proposal) → proposing
                    ├── blocked → blocked(reason=review_blocked)
                    └── accept → risk_assessing
                                  ├── critical/deny → blocked(reason=risk_policy_denied)
                                  ├── risk upgrade → profile_decision_required → purpose-scoped context invalidation
                                  │                                      ├── proposal drift → context_compiling(proposal)
                                  │                                      └── review-only drift → context_compiling(review)
                                  └── stable → approval_required / policy auto-decision
                                      ├── approve → accepted
                                      ├── reject → revision_required → context_compiling(proposal) → proposing
                                      └── defer → approval_deferred → approval_required
```

Session 在 `intent_received` 前置事务中创建。`context_compiling` 由已提交 invocation purpose 区分 Proposal/Review，不为同一技术动作复制两个状态。任何 Port 调用发生前，Operation、Session、Profile/Policy/baseline binding 和调用意图已经提交，解决当前“澄清不创建 Operation”的缺口。

### 7.3 澄清轮次

1. Coordinator 合并 deterministic/proposal/review 问题草稿。
2. 规范化、去重、稳定排序并生成 QuestionRecord。
3. 一次返回当前全部 blocking questions；UI 可分组展示，但不能隐藏 mandatory 问题。
4. SubmitAnswers 必须带 expected session digest。
5. 所有 mandatory 问题回答后创建新 Session revision。
6. 重新编译 Proposal；旧 Proposal/Validation/Review 保留并 supersede/invalidate。
7. 轮次和总 budget 由 CapturePolicy 控制；耗尽后进入可恢复 blocker。

### 7.4 Proposal 与 Review 顺序

硬门禁总是在 Review 之前。Schema/引用/确定性完整性失败不会调用语义 reviewer。Proposal 与 Review 分别编译 purpose-bound ContextBundle：二者绑定同一 project baseline，但拥有独立 purpose、budget、selection record、bundle id 和 content digest。源文件允许重叠，Bundle identity/digest 不允许复用。Review 只能读取：

- accepted answers；
- current Proposal；
- current review-purpose ContextBundle；
- passed ValidationReport；
- Profile/Policy rubric；
- 历史 accepted PRD 的受控 diff（若为 iterate）。

Review 不读取 Proposal conversation/transcript 或模型思维过程，防止共享会话形成自评。

### 7.5 批准与接受

Approval Preview 从 Proposal、Validation、Review、CaptureRiskAssessment、Profile 和 Policy 的同一 canonical view 生成，审批对象固定为当前 `PrdProposalRecord.proposal_id + content_digest`。统一 ApprovalService 只负责提交 ApprovalDecision，不得改变 Capture state 或写 accepted PRD；CLI/Dashboard 随后调用 `advance(ApplyApprovalDecisionCommand)`，Coordinator 读取并复验权威 Decision。Decision consumption key 固定为 `session_id + session_revision + request_id + decision_id + object_digest`，成功后写入 `applied_approval_decision_id`。Approval 已提交但 advance 中断时，resume 会发现未消费 Decision 并幂等继续。

决策语义固定：approve 进入 accepted transaction；reject 必须带理由并使当前 Proposal 追加 rejected revision，然后进入 revision_required，用户显式 cancel 才结束会话；defer 进入 approval_deferred，不生成 accepted 工件，resume 时在 bindings 未漂移的前提下重签 ApprovalRequest。Policy 自动批准由 Coordinator 在 accepted transaction 内生成 actor 为版本化 Policy identity 的 ApprovalDecision，不经过外部捷径。

批准后提交前重新复验所有 digest。accepted transaction 同时写入：

1. accepted PrdProposal status revision；
2. AcceptedPrdRecord；
3. RequirementBaseline document；
4. Intent/Requirement/Constraint/Test NodeRecords；
5. DECOMPOSES_TO、CONSTRAINED_BY、VERIFIES 等 EdgeRecords；
6. Context/Validation/Review/Risk/Profile/Policy/Approval bindings；
7. PrdEntityLineage/supersede/derivation records；
8. Capture accepted checkpoint/events。

事务失败不留下部分 accepted 状态。resume 使用相同 proposal/content digest 幂等重试；baseline 或 binding 漂移使 Approval 失效。

### 7.6 权威事件

Capture 的权威状态由 record/checkpoint 重建，事件只陈述已提交事实。Protocol 1.1.0 至少定义：

- `CaptureSessionStarted`；
- `ContextCompilationStarted` / `ContextCompilationCompleted`，均绑定 purpose；
- `PrdProposalRequested` / `PrdProposalReceived`；
- `PrdValidationCompleted`；
- `ClarificationRequested` / `ClarificationAnswered`；
- `PrdReviewRequested` / `PrdReviewCompleted`；
- `CaptureRiskAssessed`；
- `CaptureProfileRecommendationCreated`；
- `PrdApprovalRequired`；
- `PrdApprovalDecisionApplied` / `PrdApprovalDeferred`；
- `PrdAccepted` / `PrdRevisionRequested`；
- `CaptureBlocked`（必须携带 `CaptureBlockReason`）/ `CaptureCancelled`。

Live heartbeat、token/step 计量和 stdout tail 是可删除观察事件，不能替代以上权威事件、Port Evidence 或 accepted checkpoint。

## 8. ProjectContextPort

### 8.1 契约

```ts
export interface ProjectContextRequest {
  readonly session_id: string;
  readonly purpose: "proposal" | "review";
  readonly intent_text: string;
  readonly project_root_kind: "new" | "adopted" | "managed";
  readonly project_baseline_digest: string;
  readonly project_profile_digest: string;
  readonly capture_policy_digest: string;
  readonly allowed_source_kinds: readonly string[];
  readonly path_policy: Readonly<Record<string, unknown>>;
  readonly budget: ProjectContextBudget;
}

export type ProjectContextResult =
  | { readonly status: "compiled"; readonly bundle: ProjectContextBundleRecord }
  | { readonly status: "blocked"; readonly failure: ProjectContextFailure };
```

Port 不能返回原始任意文件访问能力。Harness 校验 locator、path、source digest、classification、budget 和 baseline 后才接受 Bundle。

### 8.2 默认候选与排除

默认候选：

- README、manifest、Pack/template metadata；
- accepted PRD、Architecture、Specification、ADR/Decision；
- public API、Schema、数据契约；
- Gate/测试框架摘要；
- 相关 Graph 邻域和近期 Snapshot/Finding；
- 项目 Policy 允许的目录摘要。

默认排除：

- `.git`、secret、环境变量、证书、密钥和 credential files；
- `.harness` 原始权威记录作为模型可执行指令；必要事实由受信任 reader 摘要；
- 二进制、超大文件、越界 symlink、未跟踪敏感文件；
- 与 Intent 无关且超过 budget 的源码正文。

### 8.3 Adapter

- `LocalGitProjectContextAdapter`：adopt/iterate；
- `NewProjectContextAdapter`：new，仅模板/Pack/显式 seed；
- `InMemoryProjectContextAdapter`：测试。

## 9. PrdProposalPort

### 9.1 输入

```ts
export interface PrdProposalInput {
  readonly session: CaptureSessionProjection;
  readonly proposal_context_bundle: ProjectContextBundleRecord;
  readonly accepted_answers: readonly ClarificationAnswerRecord[];
  readonly previous_proposal?: PrdProposalRecord;
  readonly deterministic_feedback?: PrdValidationReportRecord;
  readonly review_feedback?: PrdReviewReportRecord;
  readonly profile: CaptureProposalProfile;
  readonly invocation: CaptureInvocationBinding;
}
```

### 9.2 输出

```ts
export type PrdProposalResult =
  | { readonly status: "proposed"; readonly draft: PrdProposalDraft }
  | { readonly status: "clarification_required"; readonly questions: readonly ClarificationQuestionDraft[] }
  | { readonly status: "failed"; readonly failure: PrdPortFailure };
```

Port 无 Session/Ledger 写权限，不能返回 canonical id、accepted、approval、next_state 或 graph records。Coordinator 先验证 Draft JSON Schema/lineage/source refs，再分配或复用稳定 id 并生成 canonical `PrdProposalRecord`；Adapter 自报“valid”没有权威性。

### 9.3 Adapter

- `DshPrdProposalAdapter`：只读、严格 JSON stdout；
- `ManualPrdProposalAdapter`：默认，CLI/Dashboard 结构化录入；
- `LegacyIntentInterpreterAdapter`：一个 major 兼容；
- `InMemoryPrdProposalAdapter`：测试。

## 10. PrdReviewPort

### 10.1 输入与输出

```ts
export interface PrdReviewInput {
  readonly proposal: PrdProposalRecord;
  readonly review_context_bundle: ProjectContextBundleRecord;
  readonly validation_report: PrdValidationReportRecord;
  readonly manual_input?: ManualReviewInputRecord;
  readonly rubric: PrdReviewRubric;
  readonly profile: CaptureReviewProfile;
  readonly invocation: CaptureInvocationBinding;
}

export type PrdReviewResult =
  | { readonly status: "completed"; readonly report: PrdReviewReportDraft }
  | { readonly status: "input_required"; readonly questions: readonly ManualReviewQuestion[] }
  | { readonly status: "failed"; readonly failure: PrdPortFailure };
```

### 10.2 独立性

Proposal 与 Review 必须具有不同：

- adapter role/id；
- invocation id；
- conversation id；
- prompt template/version digest；
- purpose-bound ContextBundle id/digest；
- Evidence/transcript；
- budget accounting。

可以使用同一 vendor/model/executable，但不能复用 Proposal session、隐藏 history 或 self-review output。Review Adapter 不能修改 Proposal；建议修订通过 Finding/Question 回到 Coordinator。

### 10.3 Adapter

- `DshPrdReviewAdapter`；
- `ManualPrdReviewAdapter`，职责分离按 Policy；
- `InMemoryPrdReviewAdapter`。

Review Adapter 缺失时进入 `blocked`，并记录 `blocked_reason: "review_provider_required"`。用户可以显式选择 Manual Review 或配置 Provider 后恢复；不能自动跳过 Review。

## 11. Adapter 运行边界与配置

### 11.1 独立配置槽

```json
{
  "capture": {
    "context": { "provider": "local-git", "budget": {} },
    "proposal": { "provider": "dsh", "model": "...", "budget": {} },
    "review": { "provider": "dsh", "model": "...", "budget": {} }
  },
  "agent": { "provider": "dsh" }
}
```

Capture Proposal、PRD Review 和执行 Agent 是三个 Adapter identity。即使共用 dsh executable/model，也分别拥有 env allowlist、timeout、token/output ceiling、prompt digest、conversation、Harness-owned evidence sink 和 usage accounting；Evidence sink 不挂载给 provider 进程。

### 11.2 权限

Proposal/Review Adapter：

- 对项目目录、`.harness`、Ledger、宿主 cwd 和任意文件路径零直接访问，只能读取 Harness 序列化到 stdin 的 Port input；
- 在无项目挂载的隔离临时目录运行，ProjectContextPort 是读取项目事实的唯一 Adapter seam；
- 无 shell/tool invocation 字段；
- 不继承 Agent write scope；
- 无 secret/环境变量读取，除明确 provider credential allowlist；
- 输出尺寸、嵌套深度、数组数量和字符串长度受限；
- stdout 只接受一个结构化 envelope；stderr/transcript 只作不可信 Evidence。

### 11.3 idempotency

输出 digest 不能参与产生它的调用键。三类 Port 分别使用以下预调用键：

```text
Context:
  session_id + session_revision + purpose
  + project_baseline_digest + project_profile_digest + capture_policy_digest
  + allowed_sources/path_policy/budget digest + context_adapter_profile_digest

Proposal:
  session_id + session_revision + proposal_context_bundle_digest
  + answers_digest + previous_proposal_digest
  + deterministic_feedback_digest + review_feedback_digest
  + proposal_adapter_profile_digest + prompt_version_digest

Review:
  session_id + session_revision + proposal_content_digest
  + review_context_bundle_digest + validation_report_digest
  + manual_review_input_digest
  + rubric/profile digest
  + review_adapter_profile_digest + prompt_version_digest
```

不存在的可选输入使用固定 null marker，所有组合字段 canonical 后再摘要。resume 先读取已有 invocation/Evidence。completed 调用复用结果；uncertain 调用先按 Provider 能力对账，不能盲目重复产生两个候选事实。

### 11.4 统一失败契约

```ts
export interface PrdPortFailure {
  readonly code:
    | "invalid_output"
    | "provider_unavailable"
    | "timeout"
    | "budget_exhausted"
    | "version_mismatch"
    | "uncertain"
    | "policy_denied";
  readonly retryable: boolean;
  readonly summary: string;
  readonly evidence_locator?: string;
  readonly raw_output_digest?: string;
}
```

`summary` 是可公开展示的受净化说明；原始 provider output 只能进入受控 Evidence。Coordinator 根据 `code + retryable + CapturePolicy` 唯一决定 retry、reconcile、manual fallback 或 blocked，不允许 Adapter 指定目标状态。

## 12. 确定性 PRD 硬门禁

### 12.1 公共不可关闭规则

1. Schema、id、引用、枚举、长度和 canonical ordering 合法。
2. 至少一个目标与 Requirement；非目标、假设、依赖、风险和开放问题字段语义明确。
3. 每个 Requirement 有稳定 id 和至少一个 Acceptance Criterion；每个 `must_change` Requirement 至少一个 Criterion 含非空 test-first example。
4. 每个 Constraint 有 verification intent。
5. Requirement/Constraint/Scenario/Criterion 引用对象存在。
6. requirement/non-goal、assumption/fact、open/decided 之间无结构化冲突。
7. 业务术语无一词多义冲突或缺失关键定义。
8. Context/answers/proposal/profile/policy bindings 完整。
9. entity id 只由 Coordinator 铸造/复用，Draft lineage、SourceBinding 和所有引用完整无歧义。
10. accepted Proposal 没有 blocking OpenQuestion。
11. `test_first_readiness` 通过。
12. critical deterministic Finding 为零。

### 12.2 test_first_readiness

以下情况必须澄清：

- “更快、更友好、支持、优化”等没有可观察结果；
- 只描述实现步骤，不描述业务行为；
- verification 只有“测试通过”而没有对象与结果；
- must-change 代码需求没有可执行行为标准；
- 高风险需求缺少失败路径、边界、拒绝、安全或兼容场景；
- Acceptance Criteria 重复、矛盾或无法区分；
- 不能说明在实现前哪种业务行为应失败或缺失。

硬门禁产生精确 question target，不让模型用自由文本 warning 代替阻塞规则。

## 13. TDD 测试先行追踪

### 13.1 追踪链

```text
ClarificationQuestion / Answer
  → PrdAcceptanceCriterion
  → accepted Test node
  → DesignSet.test_strategy
  → canonical criterion_assertion
  → TaskTddContract AssertionCluster
  → Baseline / Red / Green Evidence
  → TaskVerdict
```

accepted PRD 物化每个 Criterion 对应的 Test seed。Test id 由 Coordinator 从 canonical criterion id 确定性派生；Criterion continues 时复用 Test id 并递增 Node revision。Test extension 必须含 `acceptance_criterion_id`、Criterion source binding digest，VERIFIES 指向 Requirement。

Criterion 是 Assertion 编译的唯一业务权威源：每个 accepted 原子 Criterion 在任何 Protocol 1.1 Plan 中必须确定性编译为且仅编译为一个 `criterion_assertion`。Assertion id 从 accepted PRD digest、criterion id 和 assertion schema version 稳定派生，并显式绑定 `acceptance_criterion_id` 与对应 Test seed；相同输入重编必须得到相同 id。启用 design_governance 时再绑定 primary test_strategy；未启用时不生成 strategy binding，由 Plan 单独绑定 CapabilityPlan 证明该能力未启用。若一个 Criterion 包含多个可独立裁决的结果，Capture 硬门禁必须先要求拆分 Criterion，Planner 不得在下游用 1:N Assertion 掩盖上游非原子语义。

### 13.2 职责分界

PRD Capture 决定：

- actor/precondition；
- action/scenario；
- observable outcome；
- verification intent；
- test-first example/反例；
- 风险要求的场景种类。

DesignSet.test_strategy 决定：

- TDD required/not_applicable；
- target Gate/selector；
- Failure Oracle；
- test/test-config/production path；
- framework/refactor policy。

Planner 决定更窄 Assertion Cluster 和 Task Contract。PRD 不产生 RedEvidence；只有在 baseline 后真实执行且匹配 approved Oracle 的失败才是 Red。

Planner 可以把多个 canonical criterion assertions 分配给同一 owning Task/AssertionCluster，但不能合并其身份、Evidence 要求或 Verdict；同一 Plan revision 中，每个 criterion assertion 必须恰好归属一个 owning Task。Planner 还可以增加 `task_internal_assertion` 表达构建产物或工程约束，但这种 Assertion 必须声明独立来源，不能替代 criterion assertion、满足 Criterion 覆盖或弱化业务结果。

### 13.3 不可降级

- design_governance 启用时，DesignSet 必须覆盖 accepted Criterion/Test seeds；未启用时零 DesignSet/strategy binding；
- DesignSet 可技术细化，但不能删减或弱化 observable outcome；
- controlled_not_applicable 只能由 DesignSet 批准；
- 设计阶段无法形成有效 Oracle 时创建 Finding 回到 Capture，生成新 PRD revision；
- Planner/Agent 不能私自补写或改写验收标准。

## 14. Profile 分层

Capture 属于 Evidence Kernel。Profile 只调整策略：

| 能力 | Lite | Standard | Governed |
| --- | --- | --- | --- |
| Context | manifest/README/Gate/相关 Graph 最小摘要 | 增加 ADR、现有 PRD、API、Schema、Test、Impact 邻域 | 增加 Policy、合规、审计、历史 Decision |
| Proposal | Manual 默认；模型可选 | 模型推荐；Manual 可用 | Policy 认可的 Adapter/profile |
| Review | 必须，较小 budget | 必须，标准 rubric | 必须，强化 rubric/retention/identity |
| Risk Assessment | 公共确定性规则；低风险阈值最宽但不可低于公共下限 | 增加 materiality/敏感域规则 | 强化合规触发器，禁止自动批准 |
| 测试先行 | 每 must-change Requirement 至少一个可执行 Criterion | 主路径 + 关键失败/边界 | 安全/权限/兼容/迁移/审计/不可逆场景 |
| 低风险人工批准 | Policy 可自动决定 | Policy 可自动决定，物质性变化通常人工 | 不免，必须人工 |
| 中高风险 | 人工或建议升级 | 人工 | 人工，可职责分离/双人 |

公共硬门禁、独立 Review 和 critical Finding 不可由低档 Profile 关闭。

### 14.1 CapturePolicyBinding

为避免与后续 CapabilityPlan 循环：

- new/adopt 在 Capture 前选择 ProjectProfile；
- iterate 使用项目 Profile revision；
- CapturePolicyBinding 从 ProjectProfile、Policy 和当前 ProfileDecision 确定性派生；
- current reviewed Proposal 生成 CaptureRiskAssessment；approved/accepted PRD 再提供完整风险输入编译后续 CapabilityPlan；
- accepted PRD 绑定最终 CapturePolicy/ProfileDecision/RiskAssessment digest。

### 14.2 Capture 内升级

```text
Proposal/Review risk changed
  → ProfileRecommendation
  → pause Capture
  → upgrade / rescope / override / cancel
  → new CapturePolicyBinding
  → expand Context when required
  → proposal-purpose drift: invalidate Proposal/Review/Risk/Approval → propose again
  → review-purpose only drift: invalidate Review/Risk/Approval → review again
```

未漂移的 Intent 和 answers 可以复用。Profile/Policy/Context budget 或 source selection 漂移时，相关 purpose-bound Bundle 只追加 invalidation；proposal-purpose Bundle 漂移必须使其绑定的 Proposal 及全部下游失效，只有 review-purpose Bundle 漂移才允许复用 Proposal。Override 服从 Slim Profile 的范围、理由、digest 和 Policy deny 规则。

## 15. 风险自适应批准

Review 通过不等于批准。Coordinator 先生成并提交绑定当前 Proposal/Validation/Review/Context/Profile/Policy 的 `CaptureRiskAssessmentRecord`，再根据 CapturePolicy、`level + materiality + confidence` 和 override 决定：

- `policy_auto_decision`：仅 Lite/Standard 明确允许的 `low + non_material + high confidence` Proposal；
- `human_approval_required`：中高风险、物质性变化、低 confidence、敏感领域、Profile upgrade/override；
- Governed：始终 human approval，可要求 reviewer/approver segregation。

自动接受仍生成 ApprovalDecision，actor 为版本化 Policy identity，并绑定同样的 object/content/baseline/validation/review/risk/policy/profile digest。它不是“没有批准”。

以下永远不能自动或人工绕过：

- deterministic hard gate failure；
- unresolved critical Review Finding；
- Policy deny/法规强制项；
- Context/Proposal/Review/Risk/Profile/Policy digest 漂移；
- required Review Provider/independence binding 缺失。

## 16. CLI 与 Dashboard 共用会话

### 16.1 CLI

不新增顶层主命令。六个 Slim 入口保持：new/adopt/iterate/resume/status/serve。

```bash
harness resume <operation-id> --answer <question-id>=<value>
harness resume <operation-id> --answers answers.json
```

`input_required` 至少返回：

- workflow_operation_id；
- capture_session_id；
- session_revision；
- expected_digest；
- questions；
- resume_command。

### 16.2 Dashboard

Read API 提供当前 Session、问题/答案、Context 摘要、Proposal diff、Validation、Review、Risk Assessment、Profile Recommendation 和 Approval preview。Write API 提供 submit answers、submit manual review input、request revision、resume；PRD approval 复用统一 Approval API 提交 Decision，然后必须调用 Coordinator `advance(ApplyApprovalDecisionCommand)` 才能改变 Capture 状态。

所有写入要求 session authentication、exact Origin、CSRF、actor、expected digest、body size 和字段 allowlist。CLI 与 Dashboard 交替操作后都从最新 Ledger checkpoint 继续。

### 16.3 UI 语义

默认显示中文业务说明：

- “正在理解项目背景”；
- “需要补充业务信息”；
- “需求质量检查未通过”；
- “独立评审建议修订”；
- “风险变化，需要确认治理档位”；
- “需求文档等待批准/已批准”。

digest、Port、Adapter、record kind 在审计展开项显示，不作为普通用户完成任务的前置知识。

## 17. IntentInterpreter 兼容迁移

### 17.1 兼容 Adapter

```text
IntentInterpreter
  → LegacyIntentInterpreterAdapter
  → PrdProposalPort
  → Validation
  → PrdReviewPort
  → Approval
```

一个 major 内保留并 deprecated：

- `IntentInterpreter`；
- `InterpretedIntent`；
- `ClarificationOffer`；
- `createGenericInterpreter()`；
- `OrchestratedServiceOptions.interpret`；
- `OrchestratorDependencies.interpret`。

新 `capture.proposal` 与旧 `interpret` 同时配置为 configuration error，不设隐式优先级。

### 17.2 映射

- requirements/constraints/acceptance 原样确定性映射；
- 新 PRD 必填字段不猜测，硬门禁生成问题；
- ClarificationOffer 规范化为权威 QuestionRecord；
- 多轮调用使用固定模板拼接 original Intent、accepted answers、受控 Context 摘要和上一轮 deterministic feedback；
- 模板输入 digest 进入 invocation Evidence；
- undefined 产生 `legacy_no_proposal`，可显式切换 Manual Adapter，不生成 Generic Requirement。

### 17.3 CLI 兼容

兼容期内，项目只有一个停在 Capture clarification 的开放 Operation 时，再次执行旧式 `harness iterate "<更明确意图>"` 被解释为 `submit_legacy_clarification_text` 并输出 deprecation warning。多个候选、digest 漂移或非 Capture 状态时拒绝推断，要求显式 session/operation id。

### 17.4 历史与开放 Operation

- completed Protocol 1.0 RequirementBaseline 不改写，显示 `historical_without_prd_review`；
- 尚未批准的开放 Capture 创建 Session revision 1，保留原 Intent/问题；
- 旧 pending RequirementBaseline ApprovalRequest 被 supersede，新 Proposal 通过 Gate/Review 后重新签发；
- 已进入 Impact 后的开放旧 Operation 不就地补造 Review：选择 `reopen_managed_capture` 时失效旧 Impact/Plan/Context/Run，回到 Capture 生成真实 accepted PRD 后才可进入 Protocol 1.1 Design/TDD；选择 `continue_protocol_1_0` 时沿历史兼容路径完成，不能生成 1.1 DesignSet/TddContract 或宣称新 proof；
- 兼容期结束删除写入口和类型导出，但历史 reader 永久保留。

## 18. 失效、错误与恢复

| 条件 | 行为 |
| --- | --- |
| Context source/baseline 漂移 | 失效 Bundle、Proposal、Review、RiskAssessment、Approval，重新编译 |
| Proposal Schema/JSON 非法 | `proposal_invalid`，预算内重试，不调用 Review |
| deterministic gate fail | typed questions/findings，回到 clarify/revise |
| Proposal timeout/crash | 保存 invocation Evidence，Session 可恢复 |
| Review Provider 缺失 | `state: blocked`、`blocked_reason: review_provider_required`，选择 Manual/配置 Provider 后追加 Session revision 恢复 |
| Review revise/clarify | 保留旧 Proposal/Report，追加新 revision/questions |
| Manual Review input 缺失/冲突 | 保持 `review_input_required`，拒绝混入 ClarificationAnswer |
| answer/session digest 冲突 | typed conflict/HTTP 409，刷新后重交 |
| Profile/Policy risk upgrade | pause，失效相关 Context/Review/RiskAssessment/Approval，按新 CapturePolicy 继续 |
| Approval reject/defer | reject 进入 revision_required；defer 进入 approval_deferred，均不生成 accepted 工件 |
| Approval binding drift | supersede request，重新 Preview/批准 |
| Ledger transaction failure | 零部分 accepted PRD，幂等恢复 |
| round/budget exhausted | `state: blocked`、`blocked_reason: capture_budget_exhausted`，调整 Policy/budget 后显式恢复 |
| invalid transition | fail closed，不修改 Session |
| Adapter uncertain | 对账后复用/重试，不盲目双调用 |

业务拒绝、澄清和 budget failure 通过 typed result 返回。throw 只表示进程崩溃/编程错误，Operation 保持可恢复 interrupted 状态。

## 19. 安全与治理

1. 项目文件、旧 PRD、README、源码注释、用户回答和模型输出全部是不可信文本。
2. ProjectContextPort 不提供 shell/tool capability，不把文档内容提升为指令。
3. 路径规范化后复验 realpath，阻止 traversal/symlink escape。
4. secret patterns、credential paths、环境变量、证书和私钥 fail closed。
5. Proposal/Review Adapter 的 provider credential 只进入进程环境，不进入 prompt/Evidence。
6. Proposal/Review provider 进程不挂载项目、Ledger 或宿主 cwd；只有 ProjectContextPort 可按 Policy 读取项目事实。
7. Prompt、Schema、Adapter profile、model 和 Policy 全部有版本/digest。
8. Proposal 与 Review independence 由 Harness 根据 invocation/conversation/profile/purpose-bound Context bindings 机械验证。
9. Manual answers/review/approval 绑定 actor、expected digest 和 session revision。
10. Profile Override 不能覆盖 hard gate、critical Finding 或 Policy deny。
11. accepted PRD/RequirementBaseline/Graph 原子提交防止批准到提交的 TOCTOU。

## 20. 测试策略

### 20.1 Coordinator Interface

- Intent → 多轮 clarify → Proposal → Validation → Review → Approval → accepted；
- revise/reject/defer/cancel/resume；
- persisted ApprovalDecision → ApplyApprovalDecisionCommand → accepted/revision/deferred，崩溃后 resume 幂等消费；
- Manual Review input 与业务 ClarificationAnswer 隔离；
- CLI/Dashboard 交替回答；
- immutable accepted PRD + superseding revision；
- invalid transition 和 expected digest conflict。

### 20.2 Port Conformance

Proposal/Review Adapter 统一验证：

- exact input/output Schema；
- typed failure；
- timeout/output/token/env ceilings；
- zero project/Ledger writes；
- invocation/conversation/prompt/profile digest；
- Proposal/Review session 不复用；
- proposal-purpose/review-purpose Bundle identity 与 digest 不复用；
- Proposal/Review 无项目、Ledger、cwd 或任意文件直接读取。

### 20.3 Schema/Property

- 任意集合输入排序得到相同 Proposal/Bundle/Report digest；
- dangling/duplicate id 永远失败；
- Question/Answer target 可重放；
- Draft lineage 确定性生成/复用 entity id，跨 revision 不靠文本猜测；
- Criterion SourceBinding 可复验到 Intent/Answer/Context/旧 PRD；
- accepted Criterion 恰好物化一个当前 Test seed；
- 任意 hard gate failure 都不能进入 accepted transaction；
- Context/Profile/Policy 漂移必然失效依赖 Review/RiskAssessment/Approval；
- RiskAssessment 同输入/规则产生同 digest；low confidence 永不自动批准。

### 20.4 Fault/Recovery

- 每个状态/checkpoint 前后 fault injection；
- Context/Proposal/Review uncertain invocation reconciliation；
- accepted transaction 任意 artifact 写入失败零部分提交；
- resume 不重复答案、Manual Review、Review、Risk、ApprovalDecision consumption、Lineage、Node/Edge/Event；
- round/token/time budget 恢复。

### 20.5 Security

- prompt injection fixture；
- secret/path/symlink/binary/oversize fixture；
- malformed/deep/huge Adapter output；
- Dashboard Origin/CSRF/session/body/digest；
- Proposal self-review/reused conversation 拒绝。

### 20.6 Profile Matrix

- Lite Manual + minimal Context + independent Review + low/non-material/high-confidence PolicyDecision；
- Lite risk upgrade Standard 后 expanded Context/re-review；
- Standard model Proposal + independent Review + material human approval；
- Governed strong Review + human approval + segregation Policy；
- Override cannot bypass hard/critical/deny。

### 20.7 TDD Integration

- clarification question → criterion id → Test VERIFIES Requirement；
- DesignSet 覆盖全部 accepted Criterion/Test seeds；
- DesignSet 弱化 observable outcome 被拒绝；
- 无有效 Oracle → Finding → Capture new PRD revision；
- TaskTddContract 同时绑定 Requirement/Criterion/Test/strategy/Gate/Oracle；
- RedEvidence 不能由 PRD test-first example 伪造。

### 20.8 Legacy/Migration/E2E

- InterpretedIntent/ClarificationOffer/undefined 映射；
- new/old config conflict；
- old repeated iterate compatibility；
- completed historical read；
- open Capture migration；
- new/adopt/iterate/resume/serve 完整纵向场景；
- 真实 Lite/Standard/Governed dogfood。
- Lite 单 Requirement 从 Intent 到 accepted PRD 的墙钟时间、用户输入轮次、手填字段数、上下文预填命中率、Review 修订率和人工批准等待时间。

## 21. 完成定义

1. Capture Session 在首次 Port 调用前持久化并可恢复。
2. `PrdCaptureCoordinator.advance()` 是 CLI/Dashboard/Orchestrator 唯一推进 Interface。
3. structured PrdProposal 是 PRD 内容唯一权威源。
4. Proposal/Review 的 purpose-bound ProjectContextBundle 分别受路径、baseline、Policy、budget、脱敏和 digest 控制，允许源重叠但禁止 Bundle 复用；Proposal/Review Adapter 对项目与 Ledger 零直接访问。
5. deterministic hard gates 与 independent Review 均不能被 Adapter/Profile/Approval 绕过。
6. Proposal、Review、执行 Agent 的 Adapter identity、权限、会话、budget 和 Evidence 分离。
7. 无 Proposal 模型时默认 Manual；Generic Interpreter 不再默认自动包装。
8. Profile 分层、Capture 内升级、Override 和 Approval 与 Slim Profile 规则一致。
9. 每个 canonical entity id 由 Coordinator 铸造/复用并有 SourceBinding/lineage；accepted Criterion 可追溯到澄清事实并贯通 Test seed/DesignSet/TddContract/Evidence。
10. CaptureRiskAssessment 是版本化、确定性、可重放事实，自动批准仅允许 low/non-material/high-confidence。
11. accepted PRD、RequirementBaseline、Graph、bindings 和 checkpoint 原子提交。
12. accepted PRD 不可修改，修订只通过新 version/SUPERSEDES。
13. CLI/Dashboard 可交替完成同一澄清、Manual Review 和审批会话，所有状态变化经过 Coordinator.advance。
14. IntentInterpreter 一个 major 兼容且不能绕过新质量链；历史不改写。
15. Unit、Conformance、Property、Fault、Security、Migration、Dashboard、TDD Integration 和 E2E 全通过。
16. 真实项目完成 Lite、Standard、Governed Intent→PRD dogfood并比较轮次、批准、上下文规模、成本和质量 Finding；Lite 必须单独报告单 Requirement 录入墙钟时间、用户输入轮次、手填字段数、上下文预填命中率、Review 修订率和人工批准等待时间，证明“轻”来自交互深度降低而不是绕过质量链。

## 22. 被否决的替代方案

### 22.1 在 Orchestrator 暴露每个 PRD 步骤 Port

会让 CLI、Dashboard 和测试理解 Context/Proposal/Validation/Review/Approval 顺序，形成大量浅接口和重复恢复逻辑，因此否决。

### 22.2 让 PRD Agent 持有会话

模型会成为第二权威源，CLI/Dashboard 无法共用 checkpoint，crash 后也不能从 Ledger 重建，因此否决。

### 22.3 保留 Generic Interpreter 为默认

虽然兼容简单，但继续允许任意 Intent 被包装为低质量单需求，违背升级目标，因此只保留显式 deprecated 兼容入口。

### 22.4 只做确定性规则、不做独立 Review

确定性规则无法充分判断目标价值、业务完整性、术语一致性和场景遗漏，因此保留独立 Review，同时不让 Review 取代硬门禁。

### 22.5 强制 Proposal/Review 使用不同供应商

隔离最强但显著提高配置成本。独立 invocation/context/prompt/conversation/Evidence 已能阻止同会话自评；项目 Policy 可进一步要求不同模型/供应商。

### 22.6 在 Capture 中直接批准 Failure Oracle

会把需求澄清与测试技术设计混合。PRD 只负责可测试业务行为，DesignSet 负责具体 Oracle/Gate/path，边界更稳定。

## 23. 实施边界建议

统一实施计划已重编为 [Universal Harness Protocol 1.1 统一实施计划](../plans/2026-08-18-designset-lifecycle-implementation-plan.md)。本设计不授权代码实施；以下序列仅保留为 Capture 子模块的局部依赖说明：

1. Capture runtime records、完整 PrdProposal/Draft JSON Schema、canonical digest 和 migration reader；
2. PrdCaptureCoordinator/state/checkpoint/ApprovalDecision consumption；
3. ProjectContextPort/Compiler、安全预算与 Proposal/Review 零文件访问隔离；
4. PrdProposalPort、Coordinator-issued id/lineage、Manual Adapter、deterministic gates；
5. PrdReviewPort、Manual Review input 与 independence validator；
6. CaptureRiskAssessment、Profile Recommendation 与风险批准；
7. accepted PRD/RequirementBaseline/Graph 原子提交；
8. Criterion/Test seed 与 DesignSet/TDD bindings；
9. LegacyIntentInterpreterAdapter 与 deprecation；
10. CLI/Dashboard 共用 Session；
11. Profile matrix、fault、migration、E2E 和 dogfood。

统一计划已经把高质量 Capture 放在 Impact/Design/Plan 之前；实施时禁止先让低质量 RequirementBaseline 进入后续治理，再事后补 PRD Review。
