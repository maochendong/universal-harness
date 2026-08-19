# Universal Harness 模型建议 Adapter 与 Grounded Synthesis 设计

日期：2026-08-19
状态：已批准实施
目标版本：Protocol 1.1.0
关联设计：

- [Universal Harness Slim Profiles 与 Capability Kernel 设计](./2026-08-18-harness-slim-profiles-design.md)
- [Universal Harness Intent → 高质量 PRD Capture 设计](./2026-08-18-intent-to-prd-capture-design.md)
- [Universal Harness DesignSet 生命周期设计](./2026-08-18-designset-lifecycle-design.md)
- [Universal Harness 可证明 TDD 协议设计](./2026-08-18-provable-tdd-protocol-design.md)
- [Universal Harness Protocol 1.1 统一实施计划](../plans/2026-08-18-protocol-1.1-unified-implementation-plan.md)

## 1. 摘要

Universal Harness 已经在 Capture、Design、Plan、Execute 和 Evaluation 中使用或预留模型 Adapter，但 Impact 遗漏发现、设计独立评审、高质量计划分解、Finding 语义诊断以及跨阶段中文提炼仍没有统一的深模块边界。如果让模型直接替代图传播、风险归约、审批、Gate、Ledger 或状态机，会把「证据驱动」退化为「模型自述驱动」。

本设计在已批准的 Protocol 1.1 中新增四个领域 Port，并用一个跨阶段的 `GroundedSynthesisPort` 复用四类摘要性任务：

1. `ImpactAdvisoryPort`；
2. `DesignReviewPort`；
3. `PlanProposalPort`，取代并迁移现有 `PlanTasksPort`；
4. `FeedbackAnalysisPort`；
5. `GroundedSynthesisPort`，固定支持 `project_discovery`、`context_enrichment`、`approval_brief`和 `iteration_narrative`。

模型只能返回结构化 Proposal、Review 或 Synthesis。Harness 继续拥有确定性校验、风险上界、审批、状态迁移、原子提交、Evidence 接受和失效级联。Standard/Governed 对本设计适用的模型槽位强制配置 Provider；Lite 只在 CapabilityPlan 或 Policy 激活后调用，未启用时零 Invocation、零 Result、零空壳 Evidence。

## 2. 已确认的产品决策

| 决策 | 结论 |
| --- | --- |
| 模型职责 | 只提供候选、评审和带引用的提炼，不拥有权威状态 |
| Impact | 模型只能增补，不能删除确定性结果、降低风险或激活推理边 |
| Design Review | 输出 `accept_recommended | revision_required | blocked`；Critical Finding 阻止 DesignSet 审批请求 |
| Plan | 模型提出 Task/Assertion Cluster/DAG；Harness 编译 Assertion、ID、Gate、TDD Contract 和路径授权 |
| Feedback | 确定性 RCA 规则优先；模型只处理未分类、多信号冲突和语义解释 |
| 跨阶段摘要 | 四种固定 purpose、四套严格 Schema，所有业务 claim 必须引用输入来源 |
| 会话隔离 | 每个 Port/purpose 独立 prompt、Schema、budget、conversation、run identity 和 Evidence |
| Provider 复用 | 可共用 vendor、model 或 executable，禁止共享隐藏历史 |
| Profile | Standard/Governed 强制配置适用 Provider；Lite 默认不启用 |
| 失败 | Standard/Governed 必需调用耗尽重试后 blocked；`iteration_narrative` 仅产生 Projection Finding |
| 审批 | 不因 Port 数量增加固定审批；继续审批真实业务对象 |
| 任务计划 | 嵌入既有 19 个 Task，不追加 Task 20 |

## 3. 目标与非目标

### 3.1 目标

1. 让模型参与非结构化理解、归纳、提取、生成和解释，不替代确定性管理。
2. 使 Impact、Design、Plan 和 Feedback 中的模型输出都有严格 Schema、来源引用、预算和可恢复 Evidence。
3. 用一个深的 `GroundedSynthesisPort` 覆盖四类相似任务，避免四个浅层 Prompt 转发接口。
4. 保持 Profile/Capability 分层，Lite 不为未启用能力承担运行、认知或工件成本。
5. 使 Dashboard 能展示中文业务摘要、来源、风险、用量、阻塞原因和恢复入口。

### 3.2 非目标

- 不用模型代替 Capability Compiler、Graph 传播、Schema/canonical digest、Policy、Grant、Gate、TddController、TaskVerdict 或 Snapshot anchor。
- 不允许模型直接审批、写 Ledger/Graph、修改项目文件或选择 privileged feedback route。
- 不把所有模型用途收敛成一个动态 Prompt/JSON Schema Port。
- 不为每个模型调用新增公共 phase、Capability Node 或固定审批点。
- 不追溯补造 Protocol 1.0 模型 Evidence。

## 4. 总体架构与权威边界

```text
adopt scan → Grounded(project_discovery) → managed Capture
  → deterministic impact propagation → ImpactAdvisory → validate/approve
  → DesignProposal → deterministic validator → DesignReview → human approve
  → PlanProposal → deterministic Plan Compiler
  → deterministic Context selection → Grounded(context_enrichment)
  → Agent → Gate/Evaluation → FeedbackAnalysis → Change Seed
  → authoritative Snapshot → Grounded(iteration_narrative)

every real approval object
  → Grounded(approval_brief) → existing ApprovalDecision
```

模型 Port 必须遵循统一所有权：

- Adapter 拥有生成或评审实现，不拥有 validity、state 或 acceptance。
- 领域 Coordinator/Compiler 拥有确定性归一、校验、路由和失效。
- 人类或版本化 Policy identity 拥有真实 ApprovalDecision。
- Ledger 拥有 Invocation、Result、Validation、Decision 和 accepted 历史。
- Graph 只物化已接受的工程事实。
- Markdown/Dashboard 是可重建 Projection。

## 5. 共用受管模型调用

### 5.1 内部深模块

Runtime 实现一个内部 `ManagedModelInvocationRunner`，统一处理预算、进程隔离、输出上限、重试、对账、Evidence 和恢复。它不是向领域调用方暴露的通用 Model Port；Impact、Design、Plan、Feedback 和 Synthesis 仍使用自己的领域 Interface/Schema。

### 5.2 调用状态

```text
ModelInvocationPlanned
  → ModelInvocationStarted
  → ModelInvocationCompleted | ModelInvocationFailed | ModelInvocationIndeterminate
  → ModelResultValidated | ModelResultRejected
  → ModelResultConsumed | ModelResultInvalidated
```

任何 Provider 调用前，Operation/checkpoint、slot/purpose、input/prompt/Schema/model/config/budget digest 和 invocation id 已提交。输入、Policy、baseline 或批准对象漂移会追加 invalidation，不覆盖旧记录。

### 5.3 共用记录

`ModelInvocationRecord` 至少包含：

- port、purpose、adapter、vendor、model 和 version；
- input bundle、prompt、Schema、Policy、Profile/CapabilityPlan 和 baseline digest；
- token/step/duration/output ceiling 与实际用量；
- conversation/run/attempt identity；
- raw output artifact digest、normalized result digest 和 validation digest；
- retry/reconciliation 及 typed failure。

运行 provenance 不进入领域结果的语义 content digest。领域结果分别使用 `ImpactAdvisoryRecord`、`DesignReviewRecord`、`PlanProposalRecord`、`FeedbackAnalysisRecord` 和 `GroundedSynthesisRecord`。

### 5.4 会话独立性

五个新 Port（四个领域 Port 与 `GroundedSynthesisPort`）的每次调用都拥有独立 prompt、Schema、budget、conversation、run identity 和 Evidence；`GroundedSynthesisPort` 的四种 purpose 也必须彼此隔离。允许共用 vendor/model/executable，但 cache key 必须包含 slot、purpose 和全部输入摘要，不得共享隐藏 history。`DesignReviewPort` 与 `DesignProposalPort` 的 ContextBundle、prompt、conversation 和 transcript 必须不同。

## 6. ImpactAdvisoryPort

```ts
export interface ImpactAdvisoryPort {
  readonly name: string;
  advise(input: ImpactAdvisoryInput): Promise<ImpactAdvisoryResult>;
}

export type ImpactAdvisoryResult =
  | {
      readonly status: "proposed";
      readonly additions: readonly ImpactCandidate[];
      readonly edge_candidates: readonly ImpactEdgeCandidate[];
      readonly risk_signals: readonly ImpactRiskSignal[];
      readonly missing_facts: readonly ImpactMissingFact[];
      readonly questions: readonly ImpactClarificationQuestion[];
    }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ImpactClarificationQuestion[];
    }
  | { readonly status: "failed"; readonly failure: ModelPortFailure };
```

输入绑定 Change Seed、accepted PRD/RequirementBaseline、确定性传播结果与解释路径、受控图邻域、`SemanticSeedProvider` 候选、版本化关系规则注册表（registry version + digest）、Policy、CapabilityPlan 和 Git baseline。

校验器必须拒绝：

- 删除或降级确定性 Impact entry；
- 降低关系默认风险或风险路径上界；
- 改写传播方向或允许规则禁止的 inferred edge；
- 无有效 Graph/PRD/source 引用的 candidate；
- 越过现有 ImpactSet 校验和批准的提交。

模型结果不单独审批；通过校验的增补候选与确定性结果合并后，随完整 ImpactSet 批准。

## 7. DesignReviewPort

```ts
export interface DesignReviewPort {
  readonly name: string;
  review(input: DesignReviewInput): Promise<DesignReviewResult>;
}

export type DesignReviewResult =
  | {
      readonly status: "accept_recommended" | "revision_required" | "blocked";
      readonly findings: readonly DesignReviewFinding[];
      readonly coverage_assessment: readonly DesignCoverageAssessment[];
      readonly residual_risks: readonly DesignResidualRisk[];
      readonly summary: string;
    }
  | { readonly status: "failed"; readonly failure: ModelPortFailure };
```

Design 顺序固定为：

```text
DesignProposal
  → deterministic DesignProposalValidator
  → independent DesignReviewPort
  → ReviewResultValidator
  → DesignSet ApprovalRequest
```

每个 Finding 必须有 severity/category、affected asset/criterion、source references、observed problem、recommended revision 和 suggested verification。未解决 Critical Finding 时不得创建 DesignSet ApprovalRequest。`accept_recommended` 只是语义评审结果，最终仍必须由人工批准 DesignSet，任何 Profile 都不允许 Reviewer 自动接受自身或 Proposal 模型的输出。

## 8. PlanProposalPort

`PlanProposalPort` 取代 `PlanTasksPort` 作为 Protocol 1.1 的计划模型 seam：

```ts
export interface PlanProposalPort {
  readonly name: string;
  propose(input: PlanProposalInput): Promise<PlanProposalResult>;
}
```

输入包含 accepted PRD、Harness 预编译的 canonical Assertion descriptors、frozen ImpactSet、accepted DesignSet 或 capability-not-enabled binding、final CapabilityPlan、Gate registry、TDD strategy、受控路径和 Task/Context 预算。

模型只返回：

- 临时 Task key、目标和原子性理由；
- canonical Assertion 到 Assertion Cluster/owning Task 的分配；
- Requirement/Decision/DesignArtifact bindings；
- Task DAG、并行理由和建议 Context budget；
- 批准路径/Gate 的子集建议和澄清问题。

Plan Compiler 独占 Assertion identity、Task id/digest、覆盖唯一性、路径交集、Gate、TDD Contract 和 DAG 合法性。模型不能创建/合并 canonical Assertion、扩大路径、弱化 Gate/TDD 或遗漏 Design/Impact 覆盖。

`PlanTasksPort` 保留一个 major，由 `LegacyPlanTasksAdapter` 映射成 Raw PlanProposal，输出弃用告警并经过同一校验链。新旧 Planner 同时配置是 configuration error，不设隐式优先级。

## 9. FeedbackAnalysisPort

```ts
export interface FeedbackAnalysisPort {
  readonly name: string;
  analyze(input: FeedbackAnalysisInput): Promise<FeedbackAnalysisResult>;
}
```

只在 RCA 为 `unclassified`、多个确定性信号冲突，或 Policy 要求带引用的语义解释时调用。输入是 Finding、确定性 RCA、Gate/Evaluation Evidence、受控执行摘要和关联 PRD/Impact/Design/Plan/TDD bindings。输出仅包含 Diagnosis candidates、Change Seed candidates、verification suggestions、confidence 和 source references。

确定性 RCA 命中结果不得被覆盖。模型不能决定 target layer、Capability/Profile 升级、失效范围或 privileged route。低置信度或高风险候选必须人工复核；Feedback Router 只消费已校验/已复核的结构化字段。

## 10. GroundedSynthesisPort

```ts
export type GroundedSynthesisPurpose =
  | "project_discovery"
  | "context_enrichment"
  | "approval_brief"
  | "iteration_narrative";

export interface GroundedSynthesisPort {
  readonly name: string;
  synthesize<P extends GroundedSynthesisPurpose>(
    input: GroundedSynthesisInput<P>,
  ): Promise<GroundedSynthesisResult<P>>;
}
```

这不是动态 Prompt/Schema Port。调用方只能选择四种固定 purpose，每个 purpose 有自己的版本化输入/输出 Schema：

| Purpose | 结构化输出 | 禁止事项 |
| --- | --- | --- |
| `project_discovery` | 项目事实、候选 Capability/Gate、confidence、source refs | 直接写 Graph/Profile/CapabilityPlan |
| `context_enrichment` | 术语、分段摘要、相关性解释、source refs | 移除 mandatory context、扩大文件读取范围 |
| `approval_brief` | 变化、风险、权衡、待决问题、source refs | 修改审批对象/digest、建议自动通过 |
| `iteration_narrative` | 结果、Evidence、遗留风险、后续建议、source refs | 修改 Snapshot/Verdict 或补造 Evidence |

每个业务 claim 至少引用一个当前 Bundle 中的 source id/digest。确定性 Citation Validator 只证明「引用存在且摘要一致」，不宣称语义解释必然正确；后者仍由领域校验、Review 和人工批准处理。

`approval_brief` 在审批对象/Invocation 已提交后调用，摘要不进入对象语义 digest。`iteration_narrative` 在权威 Snapshot 提交后调用；失败时 Snapshot 保持完成，只追加可恢复 Projection Finding。

## 11. Profile、Provider 与 DAG 子状态

### 11.1 ModelProviderBinding

CapabilityPlan 增加：

```ts
export interface ModelProviderBinding {
  readonly slot_id: ModelSlotId;
  readonly purpose?: GroundedSynthesisPurpose;
  readonly required: boolean;
  readonly provider_identity: string;
  readonly config_digest: string;
  readonly prompt_version: string;
  readonly schema_version: string;
  readonly budget_profile: string;
  readonly failure_mode: "block" | "projection_finding";
}
```

Binding 按生命周期分两个互不重叠的作用域持有：

- **Capture-scope**：`project_discovery` 与 Capture 阶段 `approval_brief` 在 CapabilityPlan 编译（accepted PRD 之后的 `capability_decision`）之前运行，其 binding 由 ProfileDecision 级 Capture-scope binding record 持有，在 Capture 启动前提交，绑定 ProfileDecision、Policy、配置、baseline 和版本摘要。
- **Operation-scope**：accepted PRD 之后的全部领域 Port 与 Grounded purpose binding 由 CapabilityPlan 持有。

两类 binding 使用同一 Schema；同一 slot/purpose 不得同时存在于两类 binding，Capability Compiler 确定性验证作用域不重叠。

Provider closure 在 preflight 确定性复验。Standard/Governed 对当前 Operation 适用的新槽位强制配置 Provider，配置缺失不得降级 Lite/Manual/确定性假结果。Lite 未启用时不编译 binding，也不调用 Port。

### 11.2 Profile 矩阵

| 槽位 | Lite | Standard | Governed |
| --- | --- | --- | --- |
| Impact Advisory | Capability/Policy 激活后 | `impact_analysis` 内强制 | 强制 |
| Design Review | `design_governance` 激活后强制 | 强制 | 强制，Policy 可要求不同模型 |
| Plan Proposal | 可选，默认确定性 Planner | 强制 | 强制 |
| Feedback Analysis | 启用且命中调用条件 | 命中调用条件时强制 | 命中调用条件时强制 |
| Project Discovery | adopt 时可选 | adopt 时强制 | adopt 时强制 |
| Context Enrichment | 可选 | 每个执行 Context 强制 | 强制 |
| Approval Brief | 存在人工审批且已启用 | 存在审批时强制 | 存在审批时强制 |
| Iteration Narrative | 可选 | 强制尝试，失败不阻塞 Snapshot | 强制尝试，失败不阻塞 Snapshot |

### 11.3 内部子状态

不新增公共 phase：

```text
impact: propagate → advise → validate → approve
design: propose → validate → review → approve
plan: propose → compile → validate
context: select → enrich → compile
feedback: deterministic RCA → semantic analysis → route
snapshot: commit → narrative projection
```

Workflow Engine 只执行 CapabilityPlan 中的 node/Provider binding 和 typed result，不直接按 Profile 名称分支。

## 12. 审批、Finding、失效与恢复

### 12.1 审批不固定增长

- ImpactAdvisory 结果随完整 ImpactSet 批准。
- DesignReview 是 DesignSet 审批前质量门，不生成第二个 Design 审批。
- PlanProposal 沿用现有 Policy/风险驱动的 Plan 接受规则。
- FeedbackAnalysis 仅产生候选，低置信度/高风险按既有复核规则处理。
- GroundedSynthesis 不产生新审批对象。

### 12.2 路由与失效

| 条件 | 行为 |
| --- | --- |
| Impact 候选试图降风险/删 entry | 拒绝 Result，预算内重提 |
| Design Review Critical Finding | 留在 design，携带 Finding 重新 Proposal |
| Review 证明需求不可设计 | 产生 Change Seed，回到 managed Capture |
| Plan Proposal 覆盖/DAG/路径非法 | 留在 plan 重提；预算耗尽 blocked |
| Plan 暴露 Design/Impact 缺陷 | Finding 回到对应上游 node |
| FeedbackAnalysis 低置信度 | 人工复核后才能消费 Change Seed |
| Synthesis 缺 citation | Result 无效；前三种 purpose 阻塞 |
| Iteration Narrative 失败 | Snapshot 保持完成，Projection Finding 可重试 |
| input/Policy/baseline/object drift | 失效旧 Result，以新 binding 重开 |

恢复只从 Ledger 中的 Invocation、Result、Validation 和 checkpoint 重建，不根据 transcript 猜测完成度。

## 13. 失败契约

```ts
export interface ModelPortFailure {
  readonly code:
    | "provider_required"
    | "provider_unavailable"
    | "timeout"
    | "budget_exhausted"
    | "invalid_output"
    | "citation_missing"
    | "binding_drift"
    | "independence_violation"
    | "version_mismatch"
    | "uncertain"
    | "policy_denied";
  readonly retryable: boolean;
  readonly summary: string;
  readonly raw_output_digest?: string;
  readonly evidence_locator?: string;
}
```

Standard/Governed 中，适用 Provider 缺失在 preflight 阻塞；必需调用的运行失败在阶段预算耗尽后进入 typed `blocked`，不静默切换 Manual/另一模型。外部结果不明时保留 attempt 为 `indeterminate`；若 Provider 无法按 invocation id 对账，新建 attempt 并保留旧证据，不伪造 exactly-once。

## 14. 安全与治理

1. 仓库文本、Markdown、日志、用户输入和模型输出全部视为不可信数据。
2. Provider 进程不挂载项目工作区、Ledger、Evidence sink 或宿主 cwd；只读 Harness 编译的 purpose-bound Bundle。
3. 不提供 shell、tool invocation、Git、文件写、审批或 Ledger capability。
4. 输出递归拒绝 command/tool/unknown field，并限制尺寸、嵌套、数组和字符串。
5. Secret、credential path、证书、私钥、环境变量和未授权 realpath 不得进入 Bundle。
6. Endpoint、redirect、network origin、provider credential allowlist 和数据保留策略受项目 Policy 控制。
7. Approval Brief 和 Dashboard 不显示原始敏感 output；大输出只保存 artifact digest/locator/tail。
8. 模型不能扩大 Profile/Capability/Policy、越过人工批准或把自评作为 Evidence。

## 15. Dashboard 与 Projection

Read API 统一展示：

- 业务标题、中文摘要、来源引用和 confidence；
- 当前 slot/purpose、状态、阻塞原因和恢复入口；
- model/provider、token/step/duration/cost 和 retry；
- Result validation、关联 Finding、审批对象和失效原因；
- digest、prompt/Schema/version 作为展开审计字段。

Approval 卡片默认显示 `approval_brief`，但必须同时保留 Harness 从 canonical object 确定性生成的风险、范围和 digest，不允许模型摘要隐藏原始批准事实。

## 16. 测试策略

### 16.1 Conformance

五个 Port（其中 `GroundedSynthesisPort` 固定四种 purpose）的所有 Adapter 统一验证：

- exact input/output Schema、unknown fields、size/depth/enum 边界；
- input/prompt/Schema/model/config/budget digest；
- token/step/duration/output 预算；
- timeout/cancel/crash/retry/reconciliation/resume；
- conversation/run/purpose 独立性；
- citation 存在性和 bundle ownership；
- prompt injection、secret、path traversal、恶意日志；
- typed failure 与零 Ledger/Graph/approval 写能力。

### 16.2 领域不变量

- Impact 模型永远无法删 entry、降风险、改方向或激活禁止 inferred edge。
- Design Critical Finding 必须阻止 ApprovalRequest，Review 不能自批。
- Plan Assertion 全覆盖/唯一、DAG 无环、路径/Gate/TDD 不扩权。
- Feedback 不能覆盖确定性 RCA 或直接选 privileged route。
- Grounded 每个 claim 都有当前 Bundle 引用，不串用 Schema/会话。

### 16.3 Fault 与 E2E

每个 Invocation/Result/checkpoint 前后做 fault injection。T19 至少覆盖：

1. Lite 新槽位全部未启用，零调用/零工件；
2. Standard 真实模型纵向闭环；
3. Governed 真实模型、独立会话与人工批准；
4. Provider 缺失 preflight blocker 和运行失败恢复；
5. Critical Design Review 重提案；
6. Impact 降风险尝试被拒绝；
7. 非法 Plan Proposal 无法执行；
8. Feedback 低置信度人工复核；
9. Narrative 失败不影响 Snapshot，重试后补齐 Projection；
10. input/Policy/baseline/object drift 精确失效。

Dogfood 记录每个 Port 的调用数、tokens、steps、时长、成本、修订率、citation coverage、Provider failure/retry/block、Impact 增补接受/误报率、Plan 重编率和 Approval Brief 决策时间。所有结构化业务 claim 的 citation coverage 必须为 100%。

## 17. 协议迁移

- Protocol 1.0 Ledger、Snapshot 和 completed 状态保持不变，不补造模型 Evidence。
- Protocol 1.1 尚未实施，不存在需要回填的新记录。
- `SemanticSeedProvider` 保留，作为 ImpactAdvisory 候选检索来源，不与新 Port 构成两套权威图。
- `PlanTasksPort` 保留一个 major，历史 reader 永久保留；新旧配置冲突时 fail closed。
- Standard/Governed 旧项目升级时必须显式提交 Provider bindings，不自动降级或选择模型。
- 已打开的 Protocol 1.0 Operation 沿 Slim/TDD 迁移规则继续或重开 managed Capture，不中途插入调用伪造历史。

## 18. 完成定义

1. 四个领域 Port 和 `GroundedSynthesisPort` 四种 purpose 都有版本化 Interface、Schema、conformance 和测试 Adapter。
2. Standard/Governed Provider closure 在 preflight 精确验证适用 slot/purpose。
3. 所有模型输出只能通过确定性 Validator 和既有审批/提交模块进入后续流程。
4. Critical Design Review、Impact 风险下限、Plan Assertion/TDD 和确定性 RCA 均不可绕过。
5. 所有调用都能从 Ledger/Evidence 恢复、失效和审计，不依赖 transcript 猜测。
6. Lite 未启用槽位零 Port 调用、零工件、零审批。
7. `iteration_narrative` 失败不改变 Snapshot/Verdict 的权威完成事实。
8. Dashboard 以中文业务内容展示来源、风险、阻塞、用量和恢复，digest 作为展开审计字段。
9. Lite、Standard、Governed 真实 E2E 与安全、故障、Dashboard、打包 smoke 全部通过。
10. 至少一个 Standard 和一个 Governed 真实项目使用真实模型完成全链调用并从账本复验。

## 19. 被否决的替代方案

### 19.1 每个摘要位置一个独立 Port

会重复预算、引用、失败、安全和恢复 Interface，形成四个浅模块，因此收敛为固定 purpose 的 `GroundedSynthesisPort`。

### 19.2 动态 Prompt + JSON Schema 通用 Port

扩展性高，但领域不变量、失败语义和测试责任会泄漏给每个调用方，实质是 Prompt 转发器，因此否决。

### 19.3 模型直接生成 ImpactSet/DesignSet/ExecutionPlan/Finding route

会让模型输出成为第二权威源，且无法证明关系传播、风险下限、Assertion 覆盖和 privileged route 未被绕过，因此否决。

### 19.4 全部 Finding 用模型重新分类

会覆盖高置信度确定性 RCA 并增加不必要成本。只对未分类、冲突或需要语义解释的 Finding 调用。

### 19.5 Narrative 失败阻止 Snapshot

Narrative 是可重建 Projection，如果反向决定权威 Snapshot 是否完成，就会违反 Ledger/Projection 分离，因此改为 Projection Finding 与后续重试。

## 20. 实施边界

本设计已纳入 [Universal Harness Protocol 1.1 统一实施计划](../plans/2026-08-18-protocol-1.1-unified-implementation-plan.md)。五个 Port（四个领域 Port 与一个固定四 purpose 的 `GroundedSynthesisPort`）、Provider binding、统一调用、Dashboard 和 E2E 嵌入现有 T2–T19，保持 19 个原子 Task，不新增 Task 20。
