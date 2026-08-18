# Universal Harness Slim Profiles 与 Capability Kernel 设计

日期：2026-08-18
状态：评审问题已修订，待最终确认与实施授权
目标版本：Protocol 1.1.0
关联设计：

- [Universal Harness Intent → 高质量 PRD Capture 设计](./2026-08-18-intent-to-prd-capture-design.md)
- [Universal Harness DesignSet 生命周期设计](./2026-08-18-designset-lifecycle-design.md)
- [Universal Harness 可证明 TDD 协议设计](./2026-08-18-provable-tdd-protocol-design.md)

## 1. 摘要

Universal Harness 的核心价值是让需求、执行、验证和反馈形成可重放、可审计的证据闭环，而不是要求所有项目默认承担完整治理平台的成本。

当前实现已经包含 8 个固定 orchestration phases、26 类 Node、31 类 Edge、15 类权威事件、11 类实时观测事件和 25 个 CLI 命令；Runtime 约 2.65 万行，单一 orchestrator 已超过 5,600 行。已确认但尚未实施的 DesignSet 和严格 TDD 又会增加 design phase、设计审批、隔离工作区、Red/Green 状态机、typed Evidence 和更多 Dashboard 视图。如果这些能力全部进入默认路径，Universal Harness 将从“可以接管不同项目的通用 Harness”变成“要求所有项目采用完整治理模型的平台”。

本设计把固定重流水线重构为：

```text
Evidence Kernel
  + data-driven Project Profile
  + deterministic Capability Plan
  + optional Capability Modules
  + append-only Profile Decision / Upgrade / Override evidence
```

安装或接管项目时，Harness 展示三档并由用户显式选择、确认：

- `Lite`：Evidence Kernel 强制，Impact、Design、Evaluation、Strict TDD 按风险或用户选择启用；
- `Standard`：Impact、DesignSet、Independent Evaluation 强制，Strict TDD 由 approved test_strategy 按 Task 决定；
- `Governed`：完整治理，所有适用代码 Task 强制 Strict TDD，并启用强审批与高级审计。

非交互模式必须显式传入 `--profile lite|standard|governed`；缺失返回 `input_required`，不静默选择。项目保存一个基础 Profile；单次迭代可以确认临时升级。风险建议可以由用户填写理由后 Override，但底层 Policy deny 永远不可覆盖。

固定 `ORCHESTRATION_PHASES` 不再是协议核心。Capability Compiler 根据 ProjectProfile、Requirement、Risk、Policy、用户决定和 Provider 能力生成确定性的 Operation DAG。未启用的 Module 不运行 Port、不生成空壳 Node/Event/Evidence、不制造批准请求，也不占据 Dashboard 核心导航。

Profile Slim、高质量 PRD Capture、DesignSet 和可证明 TDD 一起进入首次 Protocol 1.1.0。后三项尚未实施，因此不先发布一个低质量 Capture 或默认重流水线再返工。

## 2. 背景与问题

### 2.1 当前重量信号

截至本设计确认时，仓库具有：

- 14 个 workspace packages/adapters；
- 443 个 TypeScript/JavaScript 源文件；
- Runtime source 约 26,478 行；
- `orchestrator.ts` 约 5,646 行；
- 25 个 CLI command files；
- 26 类 Node、31 类 Edge；
- 15 类 authoritative lifecycle events、11 类 observation events；
- 224 个 test/spec files。

这些数字本身不是错误。内部复杂度可以服务稳定性；问题在于大量内部模型已经直接进入默认用户路径、命令面、审批面和 Dashboard 信息架构。

### 2.2 默认路径的实质问题

1. 普通低风险改动也可能要求用户理解 Requirement、ImpactSet、Plan、Context、Grant、Gate、Evaluation、Snapshot 和多种 digest。
2. `new/adopt/iterate` 默认驱动相同固定 phase pipeline，无法真正省略不需要的治理工件。
3. 当前 CLI 把业务主入口、内部阶段命令、运维恢复和 Graph 诊断平铺在同一级帮助中。
4. Dashboard 为完整治理模型设计；Lite 如果只隐藏数据而仍生成全部工件，运行成本和协议复杂度不会下降。
5. DesignSet 与严格 TDD 如果直接作为所有 Protocol 1.1 迭代的固定阶段，会显著提高存量项目的接管门槛。
6. 在单一 orchestrator 中继续增加 Profile 条件分支，会把“产品瘦身”转化为“代码分支膨胀”。

### 2.3 设计方向

本设计不删除 Graph、DesignSet、TDD、Evaluation 或 Audit。它把这些能力从“所有项目默认必经”改为“Profile/风险决定是否物化”，同时保留同一个 Ledger、ID/digest、Policy、Dashboard 和恢复模型。

## 3. 已确认的产品决策

| 决策 | 结论 |
| --- | --- |
| 初始选择 | `new/adopt` 展示 Lite/Standard/Governed，由用户选择后确认 |
| 非交互 | 必须显式 `--profile`；缺失返回 `input_required` |
| 项目基线 | 保存一个 ProjectProfile；迭代可临时升级 |
| 项目降级 | 显式批准，只影响未来迭代，不改写历史 |
| Lite 内核 | managed PRD Capture、Requirement、Plan、Context、Agent Grant、Gate/Evidence、Snapshot/Finding |
| Lite 审批 | 保留必要人工审批与 Dashboard 卡片，但不设固定次数 |
| Standard | 强制 Impact、DesignSet、Independent Evaluation；TDD 由 test_strategy 决定 |
| Governed | 所有适用代码 Task 强制 Strict TDD，强制完整治理与审计 |
| 风险升级 | Harness 给出最低建议 Profile，用户确认升级、缩小范围、Override 或取消 |
| Override | 允许覆盖 Profile 建议；必须带理由并绑定当前迭代/风险/digest |
| 不可覆盖 | Policy deny、工作区逃逸、Ledger/Evidence 篡改、关键安全 Gate、法规强制项 |
| CLI | 默认只展示 new/adopt/iterate/resume/status/serve 六个主入口 |
| Dashboard | 一套 Dashboard 渐进披露，URL 和 Read API 稳定 |
| 阶段模型 | 按需物化 Capability，不运行完整 no-op pipeline |
| 中途升级 | 原 Operation 暂停，补建能力、失效下游并从最早节点恢复 |
| Override 生命周期 | 仅当前迭代和风险对象；摘要漂移即失效 |
| 旧项目 | 下一次 iterate/resume 前显式选择；不自动映射 |
| 复杂度预算 | 进入自动验收，但不固定人工批准次数 |
| Protocol | Slim Profiles、managed PRD Capture、DesignSet、Provable TDD 一起进入 1.1.0 |

## 4. 目标与非目标

### 4.1 目标

1. 低风险项目可以只承担 Evidence Kernel 的工件、执行和认知成本。
2. 同一仓库、Ledger、CLI 和 Dashboard 支持三档，不复制三套平台。
3. Profile 选择、升级、Override、降级和 Capability Plan 都有权威摘要与审计证据。
4. 风险变化可以在开放迭代中安全升级，不丢失历史或复用旧授权。
5. Lite 未启用能力时真正做到零 Port 调用、零空壳工件、零 phase approval。
6. Standard/Governed 继续满足 DesignSet 和严格 TDD 已确认的不变量。
7. 默认 CLI 和 Dashboard 使用业务语言，不要求用户理解内部 Graph/Protocol 术语。
8. Profile 逻辑通过 Capability Compiler/Module contract 实现，不继续扩大 orchestrator 的条件分支。

### 4.2 非目标

- 不删除 Graph、Impact、DesignSet、TDD、Evaluation、Audit 或现有高级命令能力。
- 不提供“无 Gate、无 Evidence、无限制 Agent”的关闭治理模式。
- 不允许 Profile 或人工 Override 绕过底层 Policy deny。
- 不维护三套独立 Orchestrator、Dashboard、Ledger 或 Protocol。
- 不为 Profile/Capability 新增 Graph Node 类型。
- 不把 `not_enabled_by_profile` 伪装为 `controlled_not_applicable` 或 proof。
- 不自动猜测旧项目最适合的 Profile。
- 不在本设计中启动 DesignSet/TDD 的代码实施。

## 5. Evidence Kernel

所有 Profile 强制共享以下内核：

```text
Intent
  → managed PRD Capture
  → RequirementBaseline
  → ExecutionPlan
  → ContextBundle
  → Agent CapabilityGrant / Run
  → required Project Gates / Evidence
  → Snapshot
  → Finding feedback
```

### 5.1 RequirementBaseline

用户通过受管 Capture Session 把 Intent 澄清为 structured PrdProposal。所有 Profile 都必须经过确定性 PRD 硬门禁、独立 PrdReview 和 Profile/风险批准策略；accepted PRD、RequirementBaseline 与业务图原子提交。Profile 不允许跳过需求基线、让 Agent 自行定义完成条件，或把 `createGenericInterpreter()` 生成的单条泛化需求作为默认生产路径。详细契约见 Intent → 高质量 PRD Capture 设计。

### 5.2 ExecutionPlan

Plan 必须原子、可摘要、包含 Task DAG、验收 Assertion、预期输出、写入路径和 required Gates。Lite 的 Plan 可以不绑定 ImpactSet/DesignSet/TddContract，但必须绑定 CapabilityPlan digest，证明这些能力是未启用而不是遗漏。

### 5.3 ContextBundle

Context Compilation 仍是内核技术能力，但不作为 Lite 的独立用户治理阶段。它只选择 Plan 所需的最小上下文并绑定 freshness/digest。高级 Module 可以向 Context contributor registry 提供 Impact/Design/TDD 内容。

### 5.4 Agent Grant

任何 Agent 项目写入都必须有受限 CapabilityGrant、路径边界、预算和执行授权。Profile 只能收紧或增加前置证据，不能放宽 Policy deny。

### 5.5 Gate/Evidence

项目配置的 required Gates 在所有 Profile 中机械运行并形成 Evidence。Lite 不能把 Agent 自述或 Live output 当作验收。

### 5.6 Snapshot/Finding

完成迭代必须生成 Snapshot。Gate、执行、审计或人工反馈形成 Finding。Finding 可以触发风险重算和 Capability/Profile 升级建议。

### 5.7 最小追踪图

Lite 只要求 Requirement、Plan、Task、Run、Gate、Evidence、Snapshot/Finding 的必要追踪关系。未启用高级 Module 时不生成 ImpactSet、DesignSet、DesignArtifact 或 TddCycleRecord。Graph 引擎仍能读取和查询 Kernel 图，但完整传播和高级审计不是 Lite 必经运行步骤。

## 6. Capability Modules

### 6.1 内置 Module

Protocol 1.1 内置：

- `impact_analysis`
- `design_governance`
- `independent_evaluation`
- `strict_tdd`
- `advanced_audit`

这些 Module 不拥有独立 Ledger，也不绕过 Kernel。它们通过稳定 contract 向 Operation DAG、Context、Approval、Evidence、Finding 和 Dashboard 提供贡献。

### 6.2 Module Contract

```ts
export interface CapabilityModuleDefinition {
  readonly capability_id: CapabilityId;
  readonly version: string;
  readonly depends_on: readonly CapabilityId[];
  readonly required_providers: readonly ProviderCapability[];
  readonly input_bindings: readonly BindingKind[];
  readonly output_bindings: readonly BindingKind[];
  readonly checkpoint_boundary: CheckpointBoundary;
  readonly invalidated_by: readonly BindingKind[];
  readonly approval_objects: readonly ApprovalObjectKind[];
  readonly definition_digest: string;
}
```

Module 实现必须回答：

1. 它消费哪些权威输入；
2. 产生哪些权威输出；
3. 依赖哪些 Capability/Provider；
4. 在什么 checkpoint 后完成；
5. 哪些输入漂移会使其及下游失效；
6. 它产生哪些真实审批对象；
7. 未启用时如何证明没有被误执行。

### 6.3 依赖闭包

内置依赖：

```text
Evidence Kernel
  ├── impact_analysis
  ├── independent_evaluation
  └── advanced_audit

impact_analysis
  └── design_governance

design_governance + structured_gate_provider + isolated_workspace_provider
  └── strict_tdd
```

CapabilityPlan 只能包含满足依赖闭包的集合。用户不能单独开启 Strict TDD 而没有 Design/test_strategy、结构化 Gate 和隔离工作区能力。

### 6.4 未启用语义

未启用 Module：

- 不调用其 Proposal/Runner/Evaluator Port；
- 不创建对应 Node、runtime record、Run、Event 或 ApprovalRequest；
- 不生成 reuse/no-op 占位对象；
- Read API 返回 `inactive_by_profile` 及如何启用，不返回伪空历史；
- Verdict/Projection 显示 `not_enabled_by_profile`，不能显示 proof 或 `controlled_not_applicable`。

## 7. 三档 Profile

### 7.1 ProfileDefinition

```ts
export type CapabilityMode = "required" | "conditional" | "disabled";

export interface ProfileDefinition {
  readonly profile_id: "lite" | "standard" | "governed";
  readonly protocol_version: "1.1.0";
  readonly capabilities: Readonly<Record<CapabilityId, CapabilityMode>>;
  readonly approval_policy_id: string;
  readonly dashboard_presentation_id: string;
  readonly cli_presentation_id: string;
  readonly definition_digest: string;
}
```

ProfileDefinition 来自 Protocol registry，项目 Policy 可以收紧 conditional/required 和审批规则，不能把 required 改为 disabled 或放宽 deny。

### 7.2 Lite

| 能力 | 模式 |
| --- | --- |
| Evidence Kernel | required |
| Impact Analysis | conditional |
| Design Governance | conditional |
| Independent Evaluation | conditional |
| Strict TDD | conditional |
| Advanced Audit | conditional，仅基础 integrity 始终运行 |

conditional 由用户显式选择、风险推荐确认或项目 Policy 触发。用户可以 Override Profile 建议，但不能覆盖 Policy required/deny。

### 7.3 Standard

| 能力 | 模式 |
| --- | --- |
| Evidence Kernel | required |
| Impact Analysis | required |
| Design Governance | required |
| Independent Evaluation | required |
| Strict TDD | conditional，由 accepted test_strategy 按 Task 决定 |
| Advanced Audit | conditional；基础 Ledger integrity 始终由 Kernel 执行 |

Standard 的每个 Design iteration 必须遵守 DesignSet 原子批准/提交。表中的 Strict TDD `conditional` 指 Task 级适用性：DesignSet 获批后 final CapabilityPlan 激活策略解析，required Task 必须遵守 Provable TDD 协议，受控 not_applicable Task 留下批准依据但不生成 TDD Cycle。

### 7.4 Governed

所有 Capability required。Strict TDD 对所有适用代码、配置、Schema、迁移、安全和缺陷修复 Task 强制；受控不适用仍必须由 approved test_strategy 给出 category/reason。Governed 还允许项目 Policy 增加法规、隔离、审批职责分离和 Evidence 留存要求。

### 7.5 状态区分

任何 UI、API、Projection 和 Verdict 都必须区分：

- `proven`
- `controlled_not_applicable`
- `not_enabled_by_profile`
- `historical_without_proof`
- `invalid_or_incomplete`

这些状态不能折叠为一个 `passed` 标签。

领域 Module 可以定义更细状态，但必须由统一投影层映射到上述五态，Read API 和 Dashboard 不得各自复制映射逻辑：

```ts
export interface CapabilityStatusProjection {
  readonly capability_id: CapabilityId;
  readonly generic_status:
    | "proven"
    | "controlled_not_applicable"
    | "not_enabled_by_profile"
    | "historical_without_proof"
    | "invalid_or_incomplete";
  readonly domain_status: string;
  readonly reason?: string;
  readonly binding_ids: readonly string[];
}
```

Protocol 1.1 的 TDD 映射固定为：`tdd_proven → proven`、`framework_proven → proven`、`controlled_not_applicable → controlled_not_applicable`、`not_enabled_by_profile → not_enabled_by_profile`、`historical_without_tdd_proof → historical_without_proof`、`tdd_incomplete_or_invalid → invalid_or_incomplete`。UI 必须同时保留领域状态；特别是 `framework_proven` 只证明测试基础设施，不得显示为生产 Requirement 已完成 TDD。

## 8. Profile 与 Capability 权威记录

为避免 Graph 本体继续膨胀，Profile 使用严格 runtime records，而不是新 Node 类型。

### 8.1 ProjectProfileRecord

```ts
export interface ProjectProfileRecord {
  readonly record_kind: "project_profile";
  readonly project_id: string;
  readonly revision: number;
  readonly profile_id: ProfileId;
  readonly profile_definition_digest: string;
  readonly policy_digest: string;
  readonly approval_request_id: string;
  readonly approval_digest: string;
  readonly effective_from: string;
  readonly supersedes_digest?: string;
  readonly record_digest: string;
}
```

项目 Profile revision 只影响未来 Operation 的初始基线。降级或升级项目基线都创建新 revision，不改写历史 Operation 的决定。

### 8.2 ProfileRecommendationRecord

记录风险引擎建议：当前 Profile、建议最低 Profile、触发器、权威 CaptureRiskAssessment/后续 Impact risk 对象、范围/Policy/Requirement digest、中文理由和可选的范围缩减建议。Recommendation 是建议事实，不直接扩大权限；Capture 阶段不得从 Reviewer 自述或未版本化启发式直接派生 Recommendation。

### 8.3 ProfileDecisionRecord

```ts
export type ProfileDecisionKind =
  | "keep"
  | "temporary_upgrade"
  | "project_profile_change"
  | "override_recommendation";
```

Decision 绑定 actor、reason、推荐对象、当前/实际 Profile、Requirement/Risk/Policy/Scope digest 和 ApprovalDecision。Override reason 必填，且仅当前 iteration/risk object 有效。

### 8.4 CapabilityPlanRecord

记录本迭代 Capability 闭包、Module versions/digests、required providers、approval policy、Operation DAG 和上游 ProfileDecision digest。Record 还必须包含：

- `compilation_stage: provisional | final`；
- 每项 Capability 的 `resolution: active | inactive_by_profile | deferred`；
- resolution source 与所绑定的 Profile/Policy/Risk/DesignSet digest；
- `supersedes_digest`，用于 provisional → final 或风险升级 revision。

`deferred` 只允许出现在协议明确声明的后置决策点。Protocol 1.1 内置规则只允许 Standard 的 `strict_tdd` 在 design 前 deferred；它不能授权 Plan、Context 或 Execute。DesignSet 获批后、权威提交时，Capability Compiler 必须以其 canonical test_strategy/digest 为新输入生成 final revision。strict_tdd 在 final revision 中为 active，并由 test_strategy 决定 Task 级 required/not_applicable：存在 required Requirement 时生成对应 TDD Contract/Cycle；全部为受控 not_applicable 时不生成 Cycle，但保留 accepted DesignSet/test_strategy 作为 `controlled_not_applicable` 依据，不能标成 `not_enabled_by_profile`。

建议路径：

```text
artifacts/project-profiles/<project-id>/<revision>.json
artifacts/profile-recommendations/<recommendation-id>.json
artifacts/profile-decisions/<decision-id>.json
artifacts/capability-plans/<operation-id>/<revision>.json
```

所有集合规范排序；时间、Live telemetry 和模型 metadata 不进入语义 digest。

## 9. Capability Compiler 与 Operation DAG

### 9.1 输入

- ProjectProfileRecord；
- RequirementBaseline 或 capture proposal；
- current CaptureRiskAssessmentRecord 或后续 Impact risk signals；
- accepted Policy；
- 用户 ProfileDecision；
- 已注册 Module/Provider capabilities；
- 当前 repository/operation baseline。

final 编译还输入 accepted DesignSet/test_strategy digest；除 Standard strict_tdd 的既定 deferred 边界外，Compiler 不得依赖尚未产生的未来工件。

### 9.2 输出

Capability Compiler 确定性生成：

- resolved CapabilitySet；
- dependency closure；
- Provider bindings；
- approval object policy；
- Operation DAG；
- invalidation graph；
- capability plan digest。

同一规范输入必须产生相同 DAG/digest。DAG 循环、输出冲突、缺失 required Provider、未知 Module、非法 deferred Capability 或进入 Plan 时仍非 final 都是 compile blocker，不允许回退 Lite。

### 9.3 Standard Strict TDD 的两阶段解析

```text
provisional CapabilityPlan
  ├── impact_analysis: active
  ├── design_governance: active
  └── strict_tdd: deferred
        ↓ approved canonical DesignSet.test_strategy
final CapabilityPlan revision
  └── strict_tdd: active（Task 级 required / not_applicable）
        ↓
      Plan / TaskTddContract
```

provisional 与 final revision 使用同一 ProfileDecision，不新增 Profile 或人工批准。DesignSet Approval 已经批准 test_strategy，因此 final 编译是确定性派生事务，不再创建重复审批。accepted DesignSet、final CapabilityPlan、binding 和 design checkpoint 必须在同一 Ledger transaction 原子提交；事务中断时以相同 proposal/content digest 幂等重试。DesignSet/test_strategy 漂移会使 final revision 及全部下游失效。

### 9.4 DAG 节点语义

Kernel nodes 稳定存在；Module 通过 contributor 注册节点：

```text
capture
  → capability_decision
  → [impact?]
  → [design?]
  → plan
  → context
  → execute [strict_tdd subgraph?]
  → verify
  → [evaluate?]
  → snapshot
```

方括号表示只有 CapabilityPlan 启用才存在。`strict_tdd` 仍是 Task execute 内部 subgraph，不变成全局 phase。

new/adopt 的 ProjectProfile 在进入 managed Capture 前由用户选择；iterate 使用当前项目 Profile revision。图中的 `capability_decision` 不是初始档位选择，而是 accepted PRD 提供完整风险输入后的 CapabilityPlan 编译点：Lite/Governed 在没有合法 deferred capability 时可直接生成 final；Standard 的 strict_tdd 在 DesignSet 前必须生成 provisional，只有 accepted test_strategy 才能在 design checkpoint 原子 finalization，因此不会形成 Profile/Capture 循环。

### 9.5 Engine 边界

Workflow Engine 只理解 DAG node contract、checkpoint、typed result 和 invalidation；不直接判断 Profile 名称。禁止在 Engine 中复制 Lite/Standard/Governed 三条大分支。Profile 差异只存在于 registry、Capability Compiler 和 Module contributor。

## 10. Profile 选择与批准

### 10.1 new/adopt

交互模式：

1. 展示 Lite/Standard/Governed 的能力、审批、运行成本和适用场景；
2. 用户选择；
3. 展示选择后的完整 Capability/Policy 摘要；
4. 用户确认；
5. 写入 ProjectProfileRecord 和 ApprovalDecision。

`adopt` 的 staging preview 与 Profile 选择可以在同一向导中展示，但它们仍是两个独立 digest-bound approval objects，不能用一次点击模糊授权两类事实。

### 10.2 非交互

必须显式传：

```bash
harness new ... --profile lite
harness adopt ... --profile standard
```

缺失返回：

```json
{
  "status": "input_required",
  "reason": "profile_required",
  "options": ["lite", "standard", "governed"]
}
```

不写默认 Profile，不根据项目扫描自动决定。

### 10.3 iterate

引用项目基础 Profile 的精确 revision/digest。风险推荐发生后，用户可确认临时升级、缩小需求、Override 或取消。临时升级默认不修改项目基线。

### 10.4 项目 Profile 变更

永久升级或降级创建新 ProjectProfileRecord revision 和独立 ApprovalRequest。降级只影响未来 operation；历史 Snapshot/Evidence/CapabilityPlan 保持原语义。当前开放 operation 不随项目基线变化自动降级。

## 11. 风险推荐与 Override

### 11.1 推荐触发器

内置 Policy 可以建议 Lite → Standard：

- 跨多个 Component/Repository；
- public API、数据 Schema、迁移或兼容性变化；
- 安全、权限、secret、依赖供应链；
- medium/high 影响不确定性；
- 需要独立 Evaluation 或 Design contract；
- 项目 Gate/测试基础不足以支撑直接执行。

建议 Standard → Governed：

- critical risk；
- 受法规/审计要求约束；
- 不可逆外部副作用；
- 生产权限、资金、身份或敏感数据；
- 项目 Policy 明确要求强 TDD/职责分离。

触发器是可版本化 Policy 输入，不直接写死在 UI。

### 11.2 用户选择

Recommendation 后允许：

1. `temporary_upgrade`；
2. 缩小 Requirement/Scope 后重新计算；
3. `override_recommendation`，填写理由；
4. cancel。

### 11.3 Override 有效期

Override 绑定：

- iteration/operation；
- risk object；
- RequirementBaseline/Scope/Policy/Risk digest；
- 当前与建议/实际 Profile；
- actor/reason/approval digest。

任一绑定漂移立即失效并重新建议/批准。Override 不成为项目永久豁免。

### 11.4 永不可覆盖

- Policy deny；
- workspace/project boundary escape；
- Ledger、Approval、Evidence 或 Gate provider 篡改；
- mandatory security Gate fail；
- 法规强制 Policy；
- 被 Policy 明确禁止的不可逆外部操作；
- required Provider/Capability 缺失。

## 12. 中途升级与失效

风险、范围、Finding 或 Gate 变化可以在 Operation 中途建议更高 Profile。

### 12.1 流程

```text
Risk changed
  → pause Operation
  → revoke unused/current Grants
  → ProfileRecommendation
  → user upgrade / override / rescope / cancel
  → new ProfileDecision
  → new CapabilityPlan revision
  → materialize newly required Modules
  → invalidate downstream Plan/Context/Grant/unfinished Run authorization
  → resume from earliest affected DAG node
```

### 12.2 原子边界

ProfileDecision、CapabilityPlan revision、invalidation set 和 checkpoint 必须在同一 Ledger operation 原子提交。提交前失败时保持旧 checkpoint，但 Operation 继续暂停且旧 Grant 已撤销；不能在决策不完整时继续低档执行。

Standard 在 DesignSet 批准后进行 provisional → final 解析时，final CapabilityPlan revision、DesignSet binding 和 design checkpoint 同样遵守该原子边界；不能让 provisional Plan 进入执行。

### 12.3 历史

旧 Plan、Context、Run、Evidence 和 CapabilityPlan 不删除。它们追加 invalidation/supersede 记录。完成的历史 Snapshot 不因未来 Profile 变化重新解释。

### 12.4 中断恢复

resume 复验 ProjectProfile/Decision/CapabilityPlan/Requirement/Policy/Risk/repository baseline digest：

- 新 Plan 已提交：从最早未完成 DAG node 继续；
- 只有 Recommendation 未决：返回 approval/input required；
- Decision 已批准但 CapabilityPlan 未原子提交：Decision 视为未生效并重新完成事务；
- 摘要漂移：旧 Approval 失效并重新计算。

## 13. 审批模型

### 13.1 不固定次数

复杂度预算不限制人工批准次数。次数受需求修订、风险、Profile、Provider、执行副作用、Finding 和恢复影响。固定上限会迫使不同业务对象合并，降低摘要绑定和审计质量。

### 13.2 必要性规则

每个 ApprovalRequest 必须：

- 对应真实、独立的业务或授权对象；
- 有明确“为什么此时需要批准”；
- 显示批准后的能力、写入、风险和失效影响；
- 绑定 object/content/baseline/policy digest；
- 避免仅为 phase 对称或 no-op 工件创建。

### 13.3 各档批准对象

所有档位：

- ProjectProfile new/adopt/change；
- PRD/RequirementBaseline 按 CapturePolicy 形成 PolicyDecision 或人工 ApprovalDecision；Governed 始终人工，Lite/Standard 仅可在权威 CaptureRiskAssessment 为 `low + non_material + high confidence` 且硬门禁/独立 Review 全通过时自动决定；
- Profile Override；
- Policy 要求的 Agent 写入或外部副作用授权。

Standard：

- ImpactSet；
- DesignSet；
- Policy 指定的执行授权；
- Evaluation 结果按既有独立性规则形成事实，不由 Agent 自批。

Governed：

- Standard 的全部对象；
- Project Policy 实际命中的 TDD、高风险、职责分离、合规或不可逆操作授权对象。

## 14. CLI 信息架构

### 14.1 六个主入口

默认 `harness --help`、README、Getting Started 和常规错误恢复只围绕：

```text
harness new
harness adopt
harness iterate
harness resume
harness status
harness serve
```

一次 `new/adopt/iterate/resume` 驱动到完成或明确的 input/approval/blocker，不要求用户手工串联内部 phase 命令。

### 14.2 高级与运维命令

```text
harness ops approve|finding|verify|eval|snapshot|audit|doctor|abort
harness graph sync|check|query|edge|reconcile|project-tasks|backfill-evaluations
```

现有顶层命令保留一个 major version 的兼容 alias，执行相同行为并输出迁移提示。alias 不出现在默认帮助的主路径，但出现在 `--help-all` 和运维文档。

### 14.3 输出语言

Lite 默认输出使用需求、任务、批准、验证、问题、快照等业务词。Node、Edge、digest、Cycle、CapabilityPlan 等只在 `--verbose`、`--json`、高级视图或故障诊断中出现。

## 15. Dashboard 渐进披露

### 15.1 稳定基础

所有 Profile 共用同一个 Server、session、安全策略、URL、Read API 和 Ledger reader。Profile 不创建独立 Dashboard。

### 15.2 一级导航

Lite：

- Overview
- Iterations
- Approvals
- Evidence
- Findings

Standard 增加：

- Impact
- Design
- Graph

Governed 增加：

- TDD
- Audit
- Policy

Live、原始 Ledger 和诊断始终可从高级菜单进入；是否提升为一级导航由 presentation profile 决定。

### 15.3 未启用视图

稳定 URL/Read API 不能返回含糊空数组。返回：

```json
{
  "capability_state": "inactive_by_profile",
  "profile": "lite",
  "capability": "design_governance",
  "activation_options": ["temporary_upgrade", "project_profile_change"]
}
```

### 15.4 审批与 Override

Dashboard 卡片展示对象中文摘要、风险、Profile 建议/实际档位、能力变化、写入范围、Gate、actor、reason 和 digest 展开项。Override 必须显式输入理由，不能使用泛化 wildcard/batch approval。

## 16. Lite 硬复杂度预算

以下进入自动验收：

### 16.1 入口预算

- 一次 `new/adopt/iterate` 驱动至完成或明确暂停；
- Lite happy path 不要求手工调用 impact/plan/run/verify/eval/snapshot；
- 恢复使用 `resume`，不要求用户理解 checkpoint internals。
- Lite 单 Requirement Intent→accepted PRD dogfood 必须记录墙钟时间、用户输入轮次和人工批准等待时间；基线/阈值由首次 dogfood 报告冻结，后续回归不得无解释恶化。

### 16.2 认知预算

- 默认 CLI/Dashboard happy path 不要求理解 Node、Edge、digest、Cycle；
- 每次批准使用业务对象和影响说明；
- 高级术语可展开，但不作为完成任务的先决知识。

### 16.3 配置预算

除 Profile、Agent 和项目 Gates 外，普通 Lite 项目没有其他强制配置。Graph/Design/TDD/Evaluation Provider 只有对应 Capability 启用时才要求。

### 16.3.1 Capture 交互预算

- ManualPrdProposalAdapter 必须优先展示上下文预填值、差异和缺失项，不要求用户重复录入可从受控项目上下文确定的事实；
- dogfood 必须记录手填字段数、上下文预填命中率和 Review 修订率；
- Capture 硬门禁、独立 Review、RiskAssessment 和必要批准不可通过 UX 优化删除；“轻”只允许来自更少的输入、轮次和等待时间。

### 16.4 工件预算

未启用 Module 必须：

- 零 Module Port 调用；
- 零对应 Node/runtime record；
- 零 Module Run/Event/Evidence；
- 零 no-op/reuse approval；
- 零核心 Dashboard 空壳卡片。

### 16.5 Dashboard 预算

Lite 默认五个核心视图。高级能力可发现、可解释如何启用，但不能抢占默认导航和首屏信息层级。

### 16.6 审批预算

不固定次数。每次批准必须有真实业务对象、必要原因和摘要漂移规则。仅为固定 phase 或空壳工件创建批准即为回归。

### 16.7 架构预算

- Workflow Engine 不出现复制三套 Profile 流程的大分支；
- 每个 Capability 是独立 Module，有稳定 contract 和窄测试；
- 新 optional Capability 不得把新 Node/Event 强制加入 Kernel；
- Profile presentation 不复制三套 Dashboard page/component；
- 当前 5,600+ 行 orchestrator 必须按 Kernel/Compiler/Module boundary 拆分，而不是继续增长。

## 17. Protocol 版本与迁移

### 17.1 Protocol 1.1 协同交付

Slim Profile、managed PRD Capture、DesignSet 和 Provable TDD 均尚未实施，因此共同进入首次 1.1.0：

1. 先建立 Profile/Capability Kernel 和动态 DAG；
2. 升级 Evidence Kernel Capture：受管 PRD Session、Context、Proposal、Coordinator-issued lineage、Review、CaptureRiskAssessment、风险批准和 Criterion/Test seed；
3. 再把 DesignSet 作为 `design_governance` Module；
4. 再把严格 TDD 作为 `strict_tdd` Module；
5. 最后扩展 Projection/Dashboard/E2E。

禁止先实现固定 `capture → impact → design → ...` 全量流水线，再用 UI 隐藏。

### 17.2 已有项目

没有 ProjectProfileRecord 的项目，在下一次 `iterate` 或 `resume` 前返回 `profile_required`：

- 交互模式选择并确认；
- 非交互传 `--profile`；
- completed Ledger/Snapshot/digest 不改写；
- 不猜测历史属于哪个 Profile；
- 尚未进入 Impact 的开放 operation 可迁入 managed Capture；已进入 Impact 的 operation 必须显式选择 `reopen_managed_capture` 或 `continue_protocol_1_0`。前者失效旧下游并在 accepted PRD 后重编译 CapabilityPlan，后者不得补造 DesignSet/TDD proof。

### 17.3 已完成历史

历史显示 `historical_without_profile`。它不等于 Lite/Standard/Governed，也不补造 ProfileDecision、DesignSet 或 TDD proof。

### 17.4 兼容命令

旧顶层高级命令保留一个 major，输出 stable deprecation warning 和新命令路径。JSON 机器接口的结果 Schema 保持兼容或提供明确 versioned replacement。

## 18. 失败处理

| 失败 | 行为 |
| --- | --- |
| 未选择 Profile | `input_required/profile_required`，不创建默认记录 |
| 未知 Profile/definition digest | 阻塞，不回退 Lite |
| required Module/Provider 缺失 | typed blocker + doctor 恢复建议 |
| Capability DAG 循环/冲突 | compile failure，不创建 Plan/Grant |
| Standard strict_tdd 在 Plan 前仍 deferred | typed compile blocker；从 approved canonical DesignSet 幂等提交 accepted DesignSet + final CapabilityPlan |
| Recommendation 未决 | Operation 暂停，不继续旧授权 |
| Override reason 缺失 | ApprovalRequest 无效 |
| Override binding drift | 旧 Override 失效并重新建议 |
| Profile/CapabilityPlan drift | 撤销 Grant，回到最早受影响 DAG node |
| 升级事务中断 | 原子恢复；不留下部分能力工件 |
| Dashboard 不可用 | CLI 读取同一 Ledger 状态，不改变权威事实 |
| Policy deny | fail closed，Profile/Override/Approval 均不能绕过 |

## 19. 安全与治理

1. Profile 选择和 Override 是授权输入，必须绑定 actor、object、policy、scope 和 digest。
2. Profile 不能扩大 Policy；Capability Compiler 先取 Profile/Project Policy 的严格交集。
3. Module/Provider definitions 必须有版本和 digest，防止同名能力漂移。
4. CapabilityPlan 提交前复验 Provider capability，防止 TOCTOU。
5. Dashboard/CLI Preview 从同一 canonical record 生成。
6. 项目文档、扫描内容和模型建议不能直接改变 Profile 或 CapabilityPlan。
7. Override reason 是不可信文本，不获得指令优先级。
8. 降级不删除历史 Evidence，也不降低开放 Operation 已签发授权的复验要求。
9. Profile selection/upgrade/downgrade 不允许 wildcard 或无人审计的 batch approval。

## 20. 测试策略

### 20.1 Schema/Canonical

- ProfileDefinition、ProjectProfile、Recommendation、Decision、CapabilityPlan valid/invalid fixtures；
- unknown fields、invalid enum、空 reason、非法 revision/digest；
- 任意输入排序产生同一 CapabilityPlan/DAG digest；
- runtime records 不进入 Graph Node registry。

### 20.2 Capability Compiler Property

- resolved set 总是满足依赖闭包；
- 同一输入产生同一 DAG；
- 循环、输出冲突、缺失 required provider 永远失败；
- Standard provisional → final 对同一 DesignSet digest 确定且幂等，deferred 状态不能越过 Plan guard；
- Lite 未启用 Module 永远无 DAG node/Port call/output record；
- Project Policy 只能收紧 Profile；
- Policy deny 永远不能被 Override。

### 20.3 Profile Matrix

- 三档均运行 managed PRD Capture、硬门禁、独立 Review 和确定性 CaptureRiskAssessment；
- Lite/Standard 仅 low/non-material/high-confidence PolicyDecision 与 Governed mandatory human approval；
- Capture 内风险升级按 purpose 扩充 Context；proposal-purpose 漂移失效 Proposal 及下游，review-purpose 漂移失效 Review/Risk/Approval；
- Lite Kernel-only golden；
- Lite 风险触发单个/多个 Module；
- Standard mandatory Impact/Design/Evaluation；
- Standard per-Task TDD strategy；
- Governed applicable Task 全部 strict TDD；
- 五类 proof/applicability/profile state 不混淆。

### 20.4 Selection/Approval

- new/adopt interactive selection + confirmation；
- non-interactive missing profile → input_required；
- Requirement/Profile/Override/Execution approval digest drift；
- Profile Override reason/expiry；
- project upgrade/downgrade revision；
- 不固定次数但拒绝 no-op approval。

### 20.5 Upgrade/Recovery/Fault

- 在每个 DAG checkpoint 触发升级；
- Grant revoke、new CapabilityPlan、downstream invalidation；
- upgrade transaction fault injection 零部分提交；
- resume 幂等；
- open legacy operation profile migration；
- Dashboard/Live 中断不影响恢复。

### 20.6 CLI/Dashboard

- default help 只有六个主入口；
- old alias 行为相同并有 deprecation；
- Profile-specific primary nav；
- inactive capability 返回明确 state；
- Lite happy path 无内部术语；
- URL/Read API 跨 Profile 稳定。

### 20.7 E2E

`new/adopt/iterate/resume` 至少覆盖：

1. Lite Kernel-only 完整闭环；
2. Lite 中途升级 Standard；
3. Lite Override 后低档继续；
4. Override 因 scope drift 失效；
5. Standard DesignSet + selective TDD；
6. Governed full TDD；
7. missing Provider fail closed；
8. old project explicit profile migration；
9. Profile downgrade only future iteration；
10. Dashboard progressive disclosure；
11. Lite zero optional artifacts assertion；
12. Policy deny cannot be overridden。

## 21. 完成定义

1. `new/adopt` 交互选择并确认三档；非交互缺少 `--profile` 返回 input_required。
2. ProjectProfile、Recommendation、Decision 和 CapabilityPlan 是 canonical、append-only runtime records。
3. Evidence Kernel Capture 从 Intent 生成经过稳定 lineage、硬门禁、独立 Review、确定性 RiskAssessment 和风险批准的 immutable accepted PRD；三档共享状态机且按 Profile 调整上下文、预算和人工批准。
4. Capability Compiler 生成确定性依赖闭包、DAG 和 invalidation graph。
5. Standard strict_tdd 通过 provisional → final CapabilityPlan 解析 test_strategy，不形成循环依赖、重复审批或 provisional 执行授权。
6. Workflow Engine 不直接包含三套 Profile 大分支。
7. Lite 只运行 Evidence Kernel；未启用 Module 零 Port 调用、零工件、零批准、零 Run。
8. Standard 强制 Impact/Design/Evaluation，TDD 由 approved test_strategy 决定。
9. Governed 对所有适用代码 Task 强制 strict TDD 和完整审计。
10. Profile Recommendation 可人工 Override，但 Policy deny 永远不可覆盖。
11. Override 绑定当前 iteration/risk/digest，漂移即失效。
12. 中途升级原子提交新 CapabilityPlan，失效下游并确定性恢复。
13. 项目降级只影响未来 Operation，不改写历史。
14. 已有项目下一次运行前显式选择，不静默映射。
15. CLI 默认只有六个主入口，旧高级命令兼容一个 major。
16. Dashboard 一套实现渐进披露，稳定 URL/API，正确区分五类状态。
17. Lite 硬复杂度预算全部进入自动验收。
18. Slim/PRD Capture/DesignSet/TDD 作为同一 Protocol 1.1 依赖序列交付。
19. Unit、Property、Integration、Fault、Migration、CLI、Dashboard、E2E 全部通过。
20. 至少一个真实项目分别完成 Lite、Standard 和 Governed dogfood，并比较工件数、批准原因和运行成本；Lite 还必须报告单 Requirement 录入墙钟时间、用户输入轮次、手填字段数、上下文预填命中率、Review 修订率和人工批准等待时间。

## 22. 被否决的替代方案

### 22.1 完整流水线 + no-op/reuse 工件

迁移简单，但 Lite 仍运行全部 phase、生成全部协议工件，只是 UI 隐藏，不能达到真实瘦身，因此否决。

### 22.2 三套独立 Orchestrator

每档内部直观，但会复制 Ledger、恢复、Finding、Dashboard 和测试，Profile 升级需要跨引擎迁移，长期成本最高，因此否决。

### 22.3 只减少审批

自动审批可以减少停顿，但 Impact/Design/TDD/Graph 工件和 Provider 依赖仍然存在，也无法降低接管门槛，因此否决。

### 22.4 只隐藏高级 Dashboard/CLI

改善视觉，不减少运行时、协议和配置成本，Lite 会成为皮肤而非产品能力，因此否决。

### 22.5 Profile 建议不可 Override

最安全但缺乏项目自治；用户已确认允许在充分留痕后覆盖建议。底层 Policy deny 已提供不可突破的安全边界，因此否决全阻塞方案。

### 22.6 静默默认 Standard

减少一次选择，但违背显式治理边界，会让新项目在不知道成本的情况下进入完整流程，因此否决。

## 23. 与 DesignSet/TDD 的协同边界

本 Spec 的 Profile/Capability 决策同时约束 Capture 与两份下游 Spec：

- managed PRD Capture、硬门禁与 independent Review 属于所有 Profile 的 Evidence Kernel；
- Profile 只改变 Context、Adapter/rubric budget、风险阈值和人工批准，不关闭 PRD 质量链；
- accepted PRD/RequirementBaseline 的 Criterion/Test seeds 是 DesignSet/TDD 的上游权威输入；

- `design_governance` 未启用时，不运行 design、不生成 DesignSet；
- 一旦启用，DesignSet Spec 的原子提案、批准、提交、覆盖和 Finding 规则全部强制；
- `strict_tdd` 未启用时，不生成 TaskTddContract/TddCycleRecord，并显示 `not_enabled_by_profile`；
- 一旦启用，Provable TDD Spec 的 Baseline、Oracle、隔离工作区、Phase Grant、Red/Green pairing 和 TaskVerdict 规则全部强制；
- Governed 的所有适用代码 Task 自动启用 strict_tdd；Standard 由 accepted test_strategy 决定；Lite 由风险/用户/Policy 激活。

两份配套 Spec 必须同步删去“所有 Protocol 1.1 迭代固定经过 Design/Strict TDD”的绝对表述，并引用本 Spec 的 Capability activation 语义。

## 24. 实施边界建议

统一实施计划已经按本节主干重编为 [Universal Harness Protocol 1.1 统一实施计划](../plans/2026-08-18-protocol-1.1-unified-implementation-plan.md)，没有追加 Task 20。本设计仍不授权代码实施；以下顺序保留为 Kernel→Module 的全局约束：

1. Protocol 1.1 Profile/Capability records；
2. Capability registry/compiler/DAG；
3. managed PRD Capture/Context/Proposal/Review/Criterion-Test seed；
4. Workflow Engine 与固定 phase 解耦、orchestrator 拆分；
5. Lite Kernel-only vertical slice 与复杂度验收；
6. Standard 的 Impact/Design/Evaluation Modules；
7. Governed/conditional Strict TDD Module；
8. Profile selection/approval/override/migration；
9. CLI 信息架构、Capture Session 与 compatibility aliases；
10. Dashboard progressive disclosure；
11. 三档 E2E、fault、dogfood 与成本对比报告。

统一计划保留 19 个任务并已按上述依赖重新编排和裁剪；实施时禁止回退为“先完成固定重流水线、再补 Profile”的顺序。
