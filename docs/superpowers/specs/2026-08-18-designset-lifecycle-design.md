# Universal Harness DesignSet 生命周期设计

日期：2026-08-18  
状态：已确认，待协同实施计划修订
目标版本：Protocol 1.1.0

配套设计：

- [Universal Harness Slim Profiles 与 Capability Kernel 设计](./2026-08-18-harness-slim-profiles-design.md)
- [Universal Harness 可证明 TDD 协议设计](./2026-08-18-provable-tdd-protocol-design.md)

## 1. 摘要

当 CapabilityPlan 启用 `design_governance` 时，Universal Harness 必须把设计作为该迭代不可省略的权威工程资产，而不是由执行 Agent 临时推断、由 Markdown 文档事后补写，或仅在审计阶段以 warning 提醒缺失。

本设计定义 `design_governance` Capability Module。它启用时在 `impact` 与 `plan` 之间贡献一级 `design` DAG 节点：

```text
capture → impact → design → plan → context → execute → verify → evaluate → snapshot
```

`design` 相位通过可插拔的 `DesignProposalPort` 调用设计 Agent/LLM。模型只能读取受控输入并返回结构化 `DesignSetProposalRecord`，不能批准自身提案、直接写入权威图或修改项目文件。Harness 对提案执行确定性的 Schema、引用、关系、覆盖、冲突、风险和摘要校验；人工批准整个 DesignSet 的规范摘要后，Harness 才在一次 Ledger 事务中原子提交 accepted `DesignSet`、`Decision`、`Component`、`DesignArtifact` revisions 及关系边。

Standard、Governed，以及 Lite 中由风险、用户或 Policy 激活 `design_governance` 的迭代必须经过 `design`。在这些迭代中，即使设计不需要改变，也必须生成 `mode: reuse` 的 DesignSet，引用既有 accepted 设计资产的精确 revision/digest，并为 API、数据、UI 等不适用领域提供结构化理由。Capability 已启用但没有 accepted DesignSet 时不得进入 `plan`。Lite 未启用该 Capability 时不运行 DesignProposalPort，也不生成空壳/reuse DesignSet；Plan 通过 CapabilityPlan digest 证明设计治理未启用而不是遗漏。

启用 design_governance 的 ExecutionPlan 必须同时绑定 RequirementBaseline、ImpactSet、DesignSet、CapabilityPlan 和 Policy 摘要；未启用时绑定 RequirementBaseline、CapabilityPlan、Plan 和 Policy，不伪造 DesignSet。任一实际启用的上游摘要漂移都会使审批或下游执行授权失效。测试、评审、审计或运行时 Finding 继续作为 Change Seed；当 CapabilityPlan 包含 Impact/Design 时，通过图谱传播触发新的 ImpactSet 和 DesignSet revision，再级联重建 Plan、Context 和 Run。

当 CapabilityPlan 启用 `strict_tdd` 时，DesignSet 的 `test_strategy` 是可证明 TDD 的唯一设计来源：它按 Requirement 声明 TDD required 或受控 not_applicable，并在 required 时批准 Baseline Guard、target Gate、Failure Oracle、路径策略和测试框架摘要。Plan 只能把这些约束编译为更窄的 TaskTddContract，不能降级或扩大。未启用 strict_tdd 时不生成 Contract/Cycle，并显示 `not_enabled_by_profile`。Slim Profile、DesignSet 和 TDD 一起进入首次 Protocol 1.1.0。

## 2. 背景与问题

当前实现已经具备以下基础：

- `capture` 将 Intent、Requirement、Constraint、Test 固化为经批准的 RequirementBaseline；
- `impact` 根据 Change Seed 和关系传播规则生成、批准并冻结 ImpactSet；
- `plan` 从冻结 ImpactSet 编译声明式 Task Specification；
- 图谱 Schema 已包含 Decision、Component，以及 `ADDRESSES`、`SHAPES`、`REALIZES` 等关系；
- Context Compiler 可以把既有 Decision、Component 和 CodeArtifact 邻域提供给执行 Agent；
- Auditor 会报告 `missing_design_artifact`。

但当前主链没有 `design` 相位，也没有运行时生产 Decision 的正式端口。普通 CLI 默认把整段用户意图转换为单一 Requirement，默认 Planner 再按 Requirement 生成 Task。已有 Decision/Component 只有在接管扫描、人工文档或既有图谱中存在且关系完整时，才可能进入 ImpactSet 和 ContextBundle。

因此存在四个实质性缺口：

1. 新需求可以在没有已批准架构决策、契约和测试策略的情况下进入 Plan。
2. 执行 Agent 可能在任务上下文中临时完成设计，但这种设计没有独立摘要、审批、revision 和关系边。
3. Architecture/Specification 投影缺少一个明确的、可重建的设计权威来源。
4. Finding 无法精确判断应修订 Requirement、Design 还是 Plan，只能依赖已有图谱质量或事后审计。

本设计将设计资产提升为 RequirementBaseline 和 ExecutionPlan 之间的正式治理边界。

## 3. 已确认的产品决策

| 决策 | 结论 |
| --- | --- |
| DesignSet 生成权 | Agent/模型提出，Harness 校验，人工批准 |
| 生命周期适用范围 | Standard/Governed 强制；Lite 按 CapabilityPlan 激活；激活后无设计变化也必须 reuse |
| 设计资产模型 | 新增通用 DesignArtifact；Decision、Component 保持独立节点 |
| DesignArtifact 分类 | `api_contract`、`data_contract`、`test_strategy`、`ui_design` |
| 审批粒度 | 整个 DesignSet 作为一个原子审批对象 |
| 权威提交时机 | 批准前不进入工程图；批准后一次 Ledger 事务原子提交 |
| 完整性门槛 | 覆盖不足不得进入 Plan |
| Finding 回流 | 重新生成 ImpactSet 和 DesignSet，并失效下游授权 |
| 模型接入 | 独立可插拔 DesignProposalPort，允许未来替换更强 LLM |
| 历史兼容 | 已完成旧迭代不改写；开放旧迭代安全进入或回退 design |
| TDD 协同 | test_strategy 决定适用性与 Oracle；Plan/Execute 不得降级或自行改写 |
| 版本交付 | DesignSet 与可证明 TDD 一起进入首次 Protocol 1.1.0 |
| Profile 协同 | design_governance 未启用时零 Design 工件；启用后本 Spec 全部规则强制 |

## 4. 目标与非目标

### 4.1 目标

1. 每个启用 design_governance 的 1.1 迭代都产生一个可审批、可重建、可查询的 accepted DesignSet。
2. DesignSet 至少留存架构决策、组件变化、接口契约、数据契约、测试策略及对应关系边。
3. 无设计变化也必须留下复用资产和不变判断的客观绑定。
4. 设计模型可以替换，但 Harness 的校验、审批、Ledger 和执行授权不依赖模型供应商。
5. 启用 design_governance 的 Plan 只能从已批准 RequirementBaseline、冻结 ImpactSet 和 accepted DesignSet 编译。
6. Finding 可以通过图谱和摘要使设计及下游授权准确失效，而不覆盖历史事实。
7. Dashboard 和 Markdown Projection 可以从同一权威设计图重建人类可读视图。
8. test_strategy 为每个 Requirement 提供可编译、可批准、可验证的 TDD 策略，使 Plan 能生成不可降级 TaskTddContract。

### 4.2 非目标

- 不允许 Design Agent 直接修改源码、设计文档或 `.harness` Ledger。
- 不把模型自述、思维过程或供应商特有 trace 作为设计事实。
- 不为每一种设计文档新增独立 Node 类型。
- 不追溯生成或伪造旧 Protocol 1.0 已完成迭代的 DesignSet。
- 不在本次设计中引入多人并行设计、租约或分布式审批。
- 不把 Markdown Architecture/Specification 恢复为独立权威来源。
- 不由 Design Agent 运行 Red/Green、签发执行 Grant 或生成 TDD Evidence。
- 不把 TDD 状态机扩展为新的公共生命周期 phase；它属于 Task 的 execute 内部协议。
- 不要求 Lite 在 design_governance 未启用时生成 no-op/reuse DesignSet。

## 5. Design Capability DAG 与节点语义

### 5.1 启用后的 DAG 顺序

```text
capture
  RequirementBaseline approval + authoritative commit
    ↓
impact
  ImpactSet proposal + approval + freeze
    ↓
design
  Design proposal + deterministic validation + approval + atomic commit
    ↓
plan
  Task decomposition + plan validation + authoritative commit
    ↓
context → execute → verify → evaluate → snapshot
```

`design_governance` Module 依赖 `impact_analysis`，并向 Capability Compiler 贡献 `impact → design → plan` 节点和 invalidation rules。`design` checkpoint boundary 使用 `authoritative_commit`。Workflow Engine 不直接按 Profile 判断是否运行 design；它只执行 CapabilityPlan 中实际存在的 DAG 节点。design 在等待或处理审批时沿用 `awaiting_approval`，设计提交完成后由 plan 生成 ExecutionPlan。

### 5.2 Design 相位完成条件

以下条件必须全部成立：

1. DesignInputBundle 绑定当前 RequirementBaseline、冻结 ImpactSet、Policy 和项目基线。
2. DesignProposalPort 返回符合端口契约的结构化提案。
3. 提案通过全部确定性校验。
4. ApprovalRequest 绑定的 object/content/baseline/policy/impact digest 仍然有效。
5. 人工作出显式 approve。
6. accepted DesignSet、资产 revisions 和关系边在一次 Ledger Operation 中全部提交成功。
7. 重新物化图后，DesignSet 内容摘要和引用资产摘要仍与批准对象一致。

任一条件不成立，启用了 design_governance 的 Operation 停留在 design，不得创建可执行 Plan。未启用该 Capability 的 Operation 不进入本完成条件。

## 6. 模块边界

Design 相位拆分为六个职责单一的深模块。

### 6.1 DesignInputCompiler

输入：

- RequirementBaseline digest 和本次 Requirement/Constraint/Test 节点；
- accepted/frozen ImpactSet 及全部解释路径；
- 受影响 Requirement、Decision、Component、DesignArtifact、CodeArtifact、Test 的受控邻域；
- accepted Policy、Gate 和项目能力；
- 接管扫描得到的组件、文件分类、API entries 和文档信号；
- 上一次 proposal 的 ValidationReport 或人工拒绝理由（仅重提案时）；
- 独立 token/step/attempt 预算。

输出 `DesignInputBundle`。Bundle 是只读、摘要绑定、预算受限的上下文，不把整个仓库或整个 Ledger 无界发送给模型。仓库文本和文档一律标记为不可信数据，不作为可执行指令。

### 6.2 DesignProposalPort

```ts
export interface DesignProposalPort {
  readonly name: string;
  propose(input: DesignProposalInput): Promise<DesignProposalResult>;
}

export type DesignProposalResult =
  | { readonly status: "proposed"; readonly proposal: RawDesignProposal }
  | {
      readonly status: "clarification_required";
      readonly questions: readonly DesignClarificationQuestion[];
    }
  | { readonly status: "failed"; readonly failure: DesignProposalFailure };
```

端口是 Harness 与设计模型之间的唯一语义插槽。当前可由 dsh adapter 承载；后续更强 LLM 只需实现同一端口，不得更改审批、Schema、关系规则或 Ledger 写入。

端口权限：

- 不授予项目写能力；
- 不授予 Ledger 写能力；
- 不允许返回 shell command、tool invocation 或隐式执行指令；
- 只允许返回结构化设计提案、澄清问题或类型化失败；
- 模型名称、版本、run id、token/step/duration 作为 provenance 和 Evidence 留存，不进入语义 content digest。

### 6.3 DesignProposalValidator

把不可信 `RawDesignProposal` 转换为规范 `DesignSetProposalRecord`。验证器是确定性纯模块，不调用模型，不产生副作用。

### 6.4 DesignApprovalCoordinator

负责创建 `object_type: DesignSet` 的 ApprovalRequest，生成同源中文/JSON Preview，处理 approve/reject/defer、摘要失效和重新签发。

### 6.5 DesignCommitter

从批准的 DesignSetProposalRecord 确定性构造最终 NodeRecord、EdgeRecord 和 accepted DesignSet，在一次 Ledger Operation 中提交。它拒绝任何 base revision、baseline、policy 或 ImpactSet 漂移。

### 6.6 DesignFeedbackRouter

接收 Finding/ImprovementCandidate 产生的新 Change Seed，根据新 ImpactSet 和摘要绑定，使当前开放迭代的 DesignSet、Plan、Context、Run 授权失效，并从 `impact → design → plan` 重新进入。历史记录只追加 revision/SUPERSEDES，不删除或覆盖。

## 7. 权威数据模型

### 7.1 Protocol 版本

默认 `PROTOCOL_VERSION` 从 `1.0.0` 提升到 `1.1.0`。运行时继续接受同一 major 的 `1.x` 记录，因此旧 Ledger 可直接读取。新 DesignSet 相关记录一律写入 `1.1.0`。

### 7.2 新 Node 类型

新增两个 Node 类型并加入 versionable node registry：

- `DesignSet`：一次迭代的设计聚合根和批准边界；
- `DesignArtifact`：通用、可版本化的设计资产。

`Decision` 和 `Component` 继续使用现有独立类型。它们的业务语义和传播规则不塞入 DesignArtifact。

### 7.3 DesignArtifact

```ts
export type DesignArtifactKind =
  | "api_contract"
  | "data_contract"
  | "test_strategy"
  | "ui_design";

export interface DesignArtifactContent {
  readonly artifact_kind: DesignArtifactKind;
  readonly title: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly acceptance_implications: readonly string[];
  readonly body_format: "structured" | "markdown" | "openapi" | "json_schema";
  readonly body: unknown;
}
```

各 kind 使用独立 profile 校验 body：

- `api_contract` 至少描述协议、入口/操作、输入输出、错误和兼容策略；
- `data_contract` 至少描述实体/Schema、约束、不变量、迁移和兼容策略；
- `test_strategy` 至少描述场景、测试层级、所需 Gate 和 Evidence，并按 Requirement 提供配套 TDD 设计要求；
- `ui_design` 至少描述用户流、关键状态、异常状态和可访问性要求。

body 是被批准语义的一部分，不能只保存外部 locator。可以同时带 locator，但 Ledger 必须留存足以重建审批预览和 Markdown 投影的规范内容。

`test_strategy` 的 TDD profile 由配套设计定义，至少包含：

- `required` 或受控 `not_applicable`；
- required 时的 Baseline Guard Gates、target Gate、test selectors 和 Failure Oracle；
- test/test-config/production/immutable 路径策略；
- framework profile digest 和 refactor policy；
- not_applicable 时的受控 category 和非空业务理由。

这里的 `not_applicable` 仅表示严格 TDD 执行不适用于该 Requirement，不表示 test_strategy 资产可以缺失。代码、配置、Schema、迁移、安全和缺陷修复默认 required；Planner 不得把 required 降级。

### 7.4 DesignSet Proposal

批准前的提案使用独立运行时记录，不是 NodeRecord：

```ts
export interface DesignSetProposalRecord {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly record_kind: "design_set_proposal";
  readonly proposal_id: string;
  readonly workflow_operation_id: string;
  readonly iteration_id: string;
  readonly created_at: string;
  readonly generator: DesignGeneratorProvenance;
  readonly content: DesignSetContent;
  readonly content_digest: string;
}
```

记录路径固定为：

```text
artifacts/design-set-proposals/<proposal-id>.json
```

ProposalRecord 在 Ledger 中用于暂停、恢复、重试和审批审计，但不进入物化工程图，不参与影响传播，也不被当作 accepted 设计事实。

### 7.5 DesignSet Content

```ts
export interface DesignSetContent {
  readonly requirement_baseline_digest: string;
  readonly impact_set_id: string;
  readonly impact_set_digest: string;
  readonly policy_digest: string;
  readonly repository_baseline: string;
  readonly mode: "change" | "reuse";
  readonly node_changes: readonly DesignNodeChange[];
  readonly reused_assets: readonly ReusedDesignAsset[];
  readonly edge_changes: readonly DesignEdgeChange[];
  readonly coverage: readonly RequirementDesignCoverage[];
  readonly risk_summary: DesignRiskSummary;
  readonly rationale: string;
}

export type DesignAssetNodeType = "Decision" | "Component" | "DesignArtifact";

export interface DesignNodeChange {
  readonly action: "create" | "revise";
  readonly node_id: string;
  readonly node_type: DesignAssetNodeType;
  readonly target_revision: number;
  readonly base?: { readonly revision: number; readonly digest: string };
  readonly locator?: string;
  readonly proposed_extensions: Readonly<Record<string, unknown>>;
}

export interface ReusedDesignAsset {
  readonly node_id: string;
  readonly node_type: DesignAssetNodeType;
  readonly revision: number;
  readonly digest: string;
}

export type DesignSemanticRelation = "ADDRESSES" | "SHAPES" | "SPECIFIES";

export interface DesignEdgeChange {
  readonly action: "create" | "supersede";
  readonly edge_id: string;
  readonly relation: DesignSemanticRelation;
  readonly source_id: string;
  readonly target_id: string;
  readonly base_digest?: string;
  readonly reason?: string;
}

export interface DesignRiskSummary {
  readonly level: "low" | "medium" | "high" | "critical";
  readonly reasons: readonly string[];
}
```

规范摘要对上述语义内容执行 canonical JSON digest。以下规则确保摘要稳定：

- node changes 按 node id、revision 排序；
- reused assets 按 node id、revision 排序；
- edge changes 按 edge id 排序；
- coverage 按 requirement id 排序；
- 所有集合在验证后去重；
- generator、时间、token、run id 不进入 content digest；
- base revision digest、目标 revision 和目标语义内容必须进入 digest。

`node_changes.action` 仅允许 `create` 或 `revise`。`revise` 必须声明当前 accepted base revision/digest 和目标 revision，拒绝跳号或 revision 分叉。复用使用独立 `reused_assets`，必须绑定 node id、revision 和 digest。

`edge_changes.action` 允许 `create` 或 `supersede`。supersede 必须绑定当前 edge digest，并提供替代关系或明确删除原因。批准前不得修改现有 accepted edge。

DesignProposalPort 只提出 ADDRESSES、SHAPES 和 SPECIFIES 语义边。DesignSet 的 DERIVES_FROM、CONTAINS 结构边由 DesignCommitter 根据已批准内容确定性生成；Task IMPLEMENTS DesignArtifact 由 Planner 在下一相位生成。模型不能伪造这些结构或执行事实。

### 7.6 Accepted DesignSet

批准后创建 `type: DesignSet`、`status: accepted` 的 NodeRecord。其 `harness.design_set` extension 包含：

- 与 proposal 相同的 DesignSetContent；
- `content_digest`；
- `approval_digest`；
- 物化后的 node/edge id、revision 和 digest 绑定。

记录路径固定为：

```text
artifacts/design-sets/<design-set-id>/<revision>.json
artifacts/design-artifacts/<design-artifact-id>/<revision>.json
artifacts/decisions/<decision-id>/<revision>.json
artifacts/components/<component-id>/<revision>.json
```

DesignCommitter 在批准前已经能确定性推导目标记录及其摘要；实际提交时必须复算并与 proposal 预测绑定一致。任何差异都作为 binding drift 拒绝提交。

### 7.7 DesignSet 标识与 revision

每个 iteration 使用一个稳定的 DesignSet id，由 project id 和 iteration id 确定性派生。同一开放迭代因 reject、Finding 或摘要失效重新设计时，accepted DesignSet 使用同一 id 的连续 revision；未获批准的 ProposalRecord 不占用 Node revision。新迭代产生新的 DesignSet id，并以 `SUPERSEDES` 指向上一迭代的项目级有效 DesignSet。这样既能区分迭代边界，也能沿 revision 和 SUPERSEDES 重建项目设计演化史。

DesignSet 的 `CONTAINS` 表示“本次设计集合引用或产出的成员关系”，不是资产所有权。一个被复用的 Decision、Component 或 DesignArtifact 可以被多个历史 DesignSet CONTAINS，但其 Node revision/digest 始终只有一个权威身份。

## 8. 关系模型

### 8.1 新增与扩展关系

| 关系 | Source | Target | 语义 |
| --- | --- | --- | --- |
| `DERIVES_FROM` | DesignSet | ImpactSet | DesignSet 从哪一个冻结影响范围产生 |
| `CONTAINS` | DesignSet | Decision / Component / DesignArtifact | DesignSet 聚合的设计资产 |
| `SPECIFIES` | DesignArtifact | Requirement / Decision / Component / Test | 契约或策略具体规定哪个对象 |
| `IMPLEMENTS`（扩展） | Task | Requirement / Decision / DesignArtifact | Task 实施需求、决策或设计契约 |

继续沿用：

```text
Decision ADDRESSES Requirement
Decision SHAPES Component
CodeArtifact REALIZES Component
Test VERIFIES Requirement / Constraint
```

`CONTAINS` 是结构关系，不进入影响传播。`SPECIFIES` 加入 Impact Engine：方向 `both`，默认风险 `high`，不允许直接沿 proposed/inferred edge 传播。这样 Requirement、Decision、Component 或 Test 改变时会找到其契约/策略，契约改变时也会反向影响被规范对象。

`DERIVES_FROM DesignSet → ImpactSet` 沿既有 inverse 规则，使 ImpactSet 变化可定位依赖它的 DesignSet。所有 proposed semantic edge 仍需随 DesignSet 一起批准后才成为传播事实。

### 8.2 知识层

`DesignSet` 和 `DesignArtifact` 默认属于 L2 architecture。Context Compiler 仍按任务预期输出、批准 Impact Path 和图谱邻域选择内容；新增 DesignSet digest 为 ContextBundle 强绑定。test_strategy 虽然带测试语义，仍留在 L2，以保证执行 Agent 首先把它理解为已批准设计约束，而不是临时 Gate 结果。

## 9. 设计覆盖与适用性

### 9.1 RequirementDesignCoverage

每个 `must-change` Requirement 必须有一个 coverage entry：

```ts
export interface RequirementDesignCoverage {
  readonly requirement_id: string;
  readonly decision_ids: readonly string[];
  readonly component_scope:
    | { readonly status: "covered" | "reused"; readonly component_ids: readonly string[] }
    | { readonly status: "not_applicable"; readonly reason: string };
  readonly test_strategy_ids: readonly string[];
  readonly applicability: {
    readonly api: DesignApplicability;
    readonly data: DesignApplicability;
    readonly ui: DesignApplicability;
  };
}

export type DesignApplicability =
  | { readonly status: "covered" | "reused"; readonly asset_ids: readonly string[] }
  | { readonly status: "not_applicable"; readonly reason: string };
```

### 9.2 强制规则

1. 每个 must-change Requirement 至少由一个 accepted/new Decision 通过 ADDRESSES 回应。
2. 每个 Decision 至少 SHAPES 一个 Component；仅当 `component_scope.status` 为 `not_applicable` 且 reason 非空时，才允许没有 Component。
3. 每个 must-change Requirement 至少关联一个 test_strategy DesignArtifact；test_strategy 资产本身不允许缺失。其内部 TDD 适用性必须是 required 或配套设计定义的受控 not_applicable。
4. API、数据、UI 分别必须是 covered、reused 或带非空理由的 not_applicable。
5. covered/reused 的 asset id 必须存在于本 DesignSet 的 node changes/reused assets 中，并由合法 SPECIFIES edge 连接到相应 Requirement、Decision、Component 或 Test。
6. `mode: reuse` 不降低任何覆盖要求，只是禁止无必要的 node revision。
7. `inspect` 节点可以进入人工预览和设计上下文，但未经确认的 inferred edge 不能满足 must-change 覆盖。

覆盖失败是 design blocker，不再只是 snapshot 前的 `missing_design_artifact` warning。

## 10. 确定性校验流水线

验证顺序固定，任一步失败都不创建 ApprovalRequest：

1. **Shape**：严格 Schema、允许的 enum、长度和内容上限。
2. **Imperative content**：递归拒绝 command、shell、tool invocation 等执行字段。
3. **Reference**：Requirement、Impact entry、base asset 和 edge endpoint 存在。
4. **Revision**：base digest 最新、revision 连续、无分叉、reuse digest 未漂移。
5. **Relation**：所有 edge 符合关系兼容矩阵和 source/target 方向。
6. **Coverage**：逐 Requirement 执行第 9 节规则。
7. **Conflict**：不引入互斥 accepted Decision、重复资产或同一目标的矛盾契约。
8. **Risk**：综合 Impact Path 风险、DesignArtifact kind 和变更动作，取上界。
9. **Canonicalization**：稳定排序、去重、计算 content digest。
10. **Round-trip**：序列化再读取后必须得到相同语义对象和 digest。

ValidationReport 包含稳定 error code、JSON path、关联 Requirement/asset、中文可读说明和可修复建议。报告可以在相位预算内作为下一次 DesignProposalPort 输入，但 Harness 不替模型静默补全内容。

## 11. 审批与拒绝语义

### 11.1 原子审批

ApprovalRequest 的 object 是整个 DesignSet proposal。Preview 至少展示：

- 需求基线、ImpactSet、Policy 和 repository baseline；
- change/reuse 模式；
- 新增、修订、复用的 Decision、Component、DesignArtifact；
- 新增/替代关系边；
- 每个 Requirement 的覆盖状态和不适用理由；
- 风险摘要、预计下游影响；
- proposal content digest。

任一资产内容、关系、覆盖、基线或引用 digest 变化，旧批准自动失效并重新签发请求。

### 11.2 approve

重新校验全部绑定后调用 DesignCommitter。提交成功才记录 design phase checkpoint 并进入 plan。

### 11.3 defer

保持 operation 暂停和原 proposal/ApprovalRequest pending；resume 不重新调用模型，除非绑定已漂移。

### 11.4 reject

DesignSet 的 reject 不终止整个迭代。它关闭当前 proposal，要求非空评审理由，并把理由作为下一轮 DesignInputBundle 的受控反馈。新 proposal 使用新的 proposal id/content digest 和新的 ApprovalRequest。旧 Proposal 和 ApprovalDecision 永久保留为审计证据。

模型重提案次数受 design phase budget 和 Policy 限制；预算耗尽后 operation 以可恢复 blocker 停在 design，需要人工补充输入或调整授权预算。

## 12. 原子提交与并发

DesignCommitter 使用单一 Ledger Operation 提交：

1. accepted DesignSet NodeRecord；
2. create/revise 的 Decision、Component、DesignArtifact NodeRecord；
3. create/supersede 的 EdgeRecord；
4. DesignSet DERIVES_FROM 和 CONTAINS 结构边；
5. Approval/phase lifecycle events；
6. design checkpoint。

提交前读取 expected baseline，并复验所有 base revision digest。Ledger transaction 失败时不允许留下部分节点、部分边或已推进 checkpoint。恢复使用同一 proposal/content digest 幂等重试；如果 baseline 已变化，则使批准失效并重新进入 proposal/approval。

## 13. Plan、Context 与 Execute 绑定

### 13.1 ExecutionPlan

启用 design_governance 时，`ExecutionPlanContent.shared_context` 新增：

```ts
readonly design_set_id: string;
readonly design_set_digest: string;
```

对应 Plan guard 必须验证：

- DesignSet status 为 accepted；
- approval digest 存在且有效；
- RequirementBaseline/ImpactSet/Policy digest 与 DesignSet 一致；
- DesignSet materialized asset bindings 与当前图一致；
- 所有 must-change Requirement 的设计覆盖 complete；
- Plan 的 Task expected outputs/impact paths 覆盖已批准设计资产。

启用 design_governance 时，`PlanTasksPort` 输入增加 accepted DesignSet 摘要、设计资产引用、覆盖结果和关系路径。默认 Planner 仍可一 Requirement 一 Task，但 Task 必须声明它实施的 Requirement、Decision 和适用 DesignArtifact。未启用时 Planner 不接收伪 DesignSet，只绑定 CapabilityPlan 的 `inactive_by_profile` 事实。

CapabilityPlan 同时启用 strict_tdd 时，对于 test_strategy 声明为 required 的 Assertion，Planner 还必须按配套设计编译 `TaskTddContract` 和唯一 `AssertionCluster` 覆盖。Planner 可以缩小 selector、路径和预算，但不能降低适用性、扩大 Failure Oracle 或绕过 TestInfrastructureTask 依赖。Plan digest 同时覆盖 TaskTddContract。

### 13.2 ContextBundle

启用 design_governance 时，Context binding 新增 `design_set_digest`。候选源增加当前 accepted DesignSet、它 CONTAINS 的设计资产以及与任务 IMPLEMENTS/impact path 相连的设计邻域。未启用时没有该 binding/候选源。Bundle budget 和 freshness 规则保持不变。

### 13.3 执行前复验

ExecutionPreflight 在 Run 启动前验证 CapabilityPlan 以及实际启用 Capability 的摘要。design_governance 启用时验证 RequirementBaseline、ImpactSet、DesignSet、Plan、Policy、ContextBundle；strict_tdd 启用时再验证 TaskTddContract、framework profile、隔离 workspace 能力和当前 TDD checkpoint。任一已启用绑定漂移阻止 RunStarted，不允许以 Agent 自述或旧 ApprovalDecision 绕过。

## 14. Finding 与反馈级联

测试、Gate、评审、Evaluation、Audit 或运行时失败继续创建 Finding。以下完整链适用于 CapabilityPlan 启用了 impact_analysis/design_governance 的 Operation：

```text
Finding
  → Change Seed
  → new ImpactSet proposal / approval / freeze
  → new DesignSet proposal / approval / revision
  → new ExecutionPlan
  → new ContextBundle
  → repair Run
  → Verify / Evaluate / Snapshot
```

规则：

- 历史 accepted DesignSet、Plan、Run 和 Snapshot 不变；
- 当前开放迭代对旧 digest 的授权被标记失效，而不是删除旧工件；
- 受影响的 TaskTddContract、CapabilityGrant、TDD Cycle 和未完成 Evidence 同步失效，只追加 invalidation 记录；
- 新设计通过 revision 和 SUPERSEDES 形成演化链；
- design_governance 已启用时，即使 Finding 最终判断“设计无需改变”，也必须产生新的 `mode: reuse` DesignSet，绑定新 ImpactSet 并留下判断依据；
- Requirement/Constraint 改变时，RequirementBaseline 和其下游摘要全部失效；
- Decision/Component/DesignArtifact 改变时，从 impact/design 重新进入；
- design_governance 已启用时，仅 Task/Code/Test 变化也不能跳过 design，而是使用 change 或 reuse DesignSet 明确设计判断；未启用时 Finding 先触发风险/Profile 重算，再由新 CapabilityPlan 决定是否激活 Design。

## 15. 失败处理

| 失败 | 行为 |
| --- | --- |
| LLM timeout/unavailable | 记录受管 Run/Evidence，按 phase budget 重试；耗尽后可恢复阻塞 |
| clarification_required | operation 返回 input_required，输入后重新编译 DesignInputBundle |
| 非法 RawDesignProposal | 产生 ValidationReport，不创建图节点或 ApprovalRequest |
| 覆盖不足 | 阻塞在 design，报告具体 Requirement 和缺失资产 |
| 人工 defer | 保持 pending，等待 resume |
| 人工 reject | 保留证据，携带理由重新提案 |
| 审批绑定漂移 | 旧请求失效，重新编译、校验和签发 |
| Ledger transaction 失败 | 不推进 checkpoint，不留下部分设计事实，允许幂等恢复 |
| 已启用 design_governance 但 Plan 缺少 DesignSet | typed binding error，禁止生成或执行 |
| Context/Run 前摘要漂移 | 阻止 RunStarted，回退到最早受影响相位 |
| TDD strategy/Contract 漂移 | 撤销 Phase Grant、失效当前 Cycle，按配套设计重建 Plan 或回退 design |

## 16. 协议迁移

### 16.1 已完成 Protocol 1.0 迭代

- 保持原 Ledger、Snapshot 和摘要不变；
- Dashboard/Projection 标记“Protocol 1.0 历史记录，无 DesignSet/TDD 证明”；
- Auditor 对历史缺失设计保持 warning 语义；
- 不自动生成 `mode: reuse` 来伪造当时不存在的设计审批。

### 16.2 尚未进入 Plan 的开放迭代

项目先按 Slim Profile Spec 显式选择 Profile 并编译 CapabilityPlan。design_governance 启用且存在有效 frozen ImpactSet 时，resume 将 next DAG node 路由到 design；ImpactSet 不存在或摘要无效时先回到 impact。未启用时不补造 DesignSet。

### 16.3 已进入 Plan/Context/Execute 的开放迭代

旧 Plan 和后续工件保留，但其执行授权失效。迁移器先要求 Profile/CapabilityPlan；design_governance 启用时追加 typed migration blocker 和失效事件，路由回 `impact → design → plan`。在 accepted DesignSet、新 Plan 和适用的 TaskTddContract 提交前，不允许继续旧 Run。未启用时只重建 Kernel 所需下游。

### 16.4 不可安全判断的旧状态

不自动补 DesignSet，也不猜测 checkpoint。Operation 阻塞并输出明确恢复命令和缺失绑定；修复后从 impact 重新生成。

## 17. Dashboard 与投影

### 17.1 Dashboard

Capability 激活时启用 `Design` 视图，展示：

- 当前/历史 DesignSet revisions；
- accepted/proposal/rejected 状态及 content digest；
- Requirement 设计覆盖矩阵；
- Decision、Component、DesignArtifact 的 create/revise/reuse；
- API/data/UI 适用性和不适用理由；
- 风险摘要、关系边和演化链；
- DesignProposalPort 名称和运行计量，但与语义摘要分区显示。
- 每个 Requirement 的 TDD 适用性、Failure Oracle、Gate、路径策略和 framework profile。

Standard/Governed 或临时激活 Design 的视图同步扩展：

- Overview 的 Operation DAG 增加 design 节点；
- Graph 显示 DesignSet、DesignArtifact、SPECIFIES；
- Impact 显示设计层传播与覆盖；
- Iterations 显示 DesignSet id/digest；
- Iterations/Task 显示 Baseline → Red → Green → Refactor 时间线和 Phase Grant；
- Evidence 显示设计 Agent Run、ValidationReport、批准证据以及配对的 TDD Evidence；
- Findings 显示回退到 design 的原因；
- Live 显示 design phase、提案重试和输出摘要；
- Approvals 使用权威 Ledger 队列展示 DesignSet 中文预览并收集 reject 理由。

### 17.2 Markdown Projection

扩展现有 Markdown providers：

- Architecture 从 accepted Decision、Component、DesignArtifact 和关系边生成；
- Specification 从 Requirement、Constraint、Test、API/data contract、test strategy 生成；
- Plan 显示绑定的 DesignSet id/digest 和每个 Task 实施的设计资产；
- PRD 继续以 RequirementBaseline 为主，但显示对应 Decision/DesignSet 链接；
- Snapshot 显示 DesignSet、设计批准证据和 TDD 证明/受控不适用/历史无证明状态。

Projection 不拥有独立状态。检测漂移后只能从权威图重建，不能反向覆盖 Ledger。Lite 未启用 Design 时返回 `inactive_by_profile`，不渲染空 Architecture/DesignSet 证明。

## 18. 安全与治理

1. DesignProposalPort 输入中的仓库文本、Markdown 和注释按不可信数据处理，防止 prompt injection 获取工具或写权限。
2. Port 使用只读能力集，不接受命令或 tool invocation 字段。
3. Proposal body 设置尺寸、嵌套深度、数组数量和总 token 上限，防止资源耗尽。
4. Approval Preview 与 JSON API 必须从同一规范 ProposalRecord 生成。
5. 模型不可读取未授权 secret、环境变量或工作区外文件。
6. 人工批准不能把 Policy `deny` 改成 allow；DesignSet 只治理设计事实，不扩大执行能力。
7. Reject 理由和 ValidationReport 作为不可信反馈数据传给模型，不获得指令优先级。
8. 原子提交和 expected baseline 防止批准到提交之间的 TOCTOU。

## 19. 测试策略

### 19.1 Unit

- Protocol 1.1 Schema 的有效/无效夹具；
- DesignArtifact 各 kind profile；
- DesignSet canonical ordering 和 digest；
- create/revise/reuse 与 revision drift；
- Relation compatibility 和 SPECIFIES 传播；
- RequirementDesignCoverage 全部分支；
- 风险聚合和 Approval Preview；
- DesignProposalPort result parsing；
- reject reason、clarification 和 typed failure。

### 19.2 Property

- 任意输入排序产生相同 DesignSet digest；
- 非法引用、关系或 revision 永远不能通过校验；
- approved content 与物化节点/边可以双向复验；
- 任意 Ledger transaction 中断不产生部分 DesignSet；
- 幂等 resume 不重复提交节点、边或 ApprovalDecision；
- finding cascade 不修改历史 accepted digest。
- test_strategy required 永远不能被 Planner 降级，DesignSet digest 漂移必然使 TaskTddContract 和当前 Cycle 失效。

### 19.3 Integration

- `impact → design` checkpoint 和 resume；
- valid proposal → approval → atomic commit → plan；
- invalid proposal → ValidationReport → bounded reproposal；
- reject → reason → new proposal/new digest；
- defer → stable pending → resume；
- baseline/policy/impact/reused revision drift → approval invalidation；
- design_governance 已启用但缺少 DesignSet → plan guard failure；未启用时验证零 Design 工件和 CapabilityPlan binding；
- CapabilityPlan/DesignSet 的 Plan、Context、Preflight 条件绑定及 TaskTddContract 编译；
- Finding → new ImpactSet → new DesignSet revision → replanning。

### 19.4 Migration

- 读取和物化 1.0 completed Ledger；
- 1.0 capture/impact checkpoint 先要求 Profile/CapabilityPlan；design_governance 启用时进入 design，未启用时进入 Kernel 下游；
- 1.0 plan/context/execute checkpoint 按 CapabilityPlan 失效并回退到最早必要 DAG 节点；
- 缺失/漂移 ImpactSet 的旧 operation 安全阻塞；
- 历史 Projection 和 Dashboard 显示协议提示。

### 19.5 E2E

`harness new`、`harness adopt`、`harness iterate` 各至少覆盖一个启用 Design 的场景；整个 E2E 矩阵覆盖：

1. change DesignSet 完整闭环；
2. reuse DesignSet 完整闭环；
3. 人工批准/拒绝/暂缓；
4. 配置 dsh DesignProposalPort；
5. 使用测试 adapter 替代 LLM，证明端口可插拔；
6. strict_tdd 与 independent_evaluation 同时启用时，Requirement → Impact → Design → Plan → Baseline → Red → Green → Gates → Evaluation → Snapshot；
7. Dashboard Design/Approvals/Live 可观测；
8. Markdown Architecture/Specification/Plan 可重建且无漂移；
9. Lite 未启用 design_governance 时零 Design Port/Node/Record/Event/Approval，Read API 返回 inactive_by_profile。

## 20. 完成定义

实现只有在以下条件全部满足时才完成：

1. Protocol 1.1 Schema、关系矩阵和 JSON Schema 导出完成。
2. design_governance Module 向 CapabilityPlan DAG 贡献 design 节点，checkpoint/resume/recovery 正确；未启用时零 Design 工件。
3. DesignProposalPort 是可替换接口，默认运行路径可以通过项目配置接入 dsh。
4. Design Agent 没有项目或 Ledger 写权限。
5. 所有 proposal 在批准前不进入物化工程图。
6. DesignSet 原子批准、原子提交、摘要失效和 reject 重提案均有账本证据。
7. 每个启用 design_governance 的 1.1 Plan 都绑定 accepted DesignSet；缺失或漂移时机械阻止执行。
8. Standard/Governed 以及临时激活 Design 的迭代均经过 design；未启用的 Lite 迭代显示 not_enabled_by_profile 且零空壳工件。
9. Finding 能生成新 ImpactSet/DesignSet 并失效下游授权。
10. 已完成 1.0 历史不改写，开放 operation 按规则迁移。
11. Dashboard 与 Markdown Projection 完整展示设计资产、覆盖、审批和历史演化。
12. Unit、Property、Integration、Migration、E2E 和 Dashboard 测试全部通过。
13. strict_tdd 同时启用时，每个 required Assertion 都有唯一、当前有效的 Baseline/Red/Green 配对证明；受控不适用、Profile 未启用和历史无证明被明确区分。

## 21. 被否决的替代方案

### 21.1 把 DesignSet 作为 Plan 内部子步骤

优点是 phase/checkpoint 迁移较少，但会混合设计与任务计划所有权，导致 reject、Finding 回退和 Dashboard 观测语义不清，无法实现一级设计资产治理，因此否决。

### 21.2 外部设计服务生成文档后由 Harness 导入

优点是容易替换模型，但权威状态和审批摘要跨系统，容易产生内容漂移，也不能保证反馈闭环完整。模型可插拔应通过 DesignProposalPort 实现，而不是把权威边界移出 Harness，因此否决。

### 21.3 每个设计资产单独审批

控制粒度最细，但会制造大量批准请求，并允许部分资产批准、部分资产悬空。DesignSet 本身已经精确绑定每个资产和关系的内容摘要，整体原子审批更符合本次迭代的设计一致性边界，因此否决。

### 21.4 把契约继续保存为 CodeArtifact/Markdown

改动最小，但无法可靠区分实现文件与设计契约，也无法实施按 kind 的覆盖和校验。DesignArtifact 提供受控扩展点，避免为每种设计文档无限增加 Node 类型，因此否决。

## 22. 实施边界建议

后续实施计划必须服从 Slim Profile/Capability Kernel 的依赖顺序，本设计不直接授权代码修改：

1. Protocol 1.1 Profile/Capability runtime records 与 Capability Compiler；
2. Workflow Engine/Operation DAG 与固定 phase 解耦；
3. Lite Kernel-only vertical slice 和零 Design 工件测试；
4. DesignSet Schema、canonical model、validator、coverage 和 property tests；
5. DesignInputCompiler、DesignProposalPort、ApprovalCoordinator、DesignCommitter；
6. design_governance Module、checkpoint、resume 和 migration；
7. Plan/Context/Preflight 的 CapabilityPlan/DesignSet 条件绑定；
8. Finding/Profile upgrade cascade 与 Audit 语义；
9. CLI/config/dsh、Projection、Dashboard 渐进披露；
10. Standard/Governed/临时激活 Design 的 E2E、dogfood 和验收报告。
