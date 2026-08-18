# Universal Harness 可证明 TDD 协议设计

日期：2026-08-18
状态：已确认，待协同实施计划修订
目标版本：Protocol 1.1.0
前置设计：

- [Universal Harness Slim Profiles 与 Capability Kernel 设计](./2026-08-18-harness-slim-profiles-design.md)
- [Universal Harness DesignSet 生命周期设计](./2026-08-18-designset-lifecycle-design.md)

## 1. 摘要

Universal Harness 当前能够证明“任务最终通过了 Gate、Evaluation 和 Evidence 验收”，但不能证明任务遵守了测试驱动开发中的“先红、再绿”。Agent 可以先完成实现，再补测试；也可能把编译错误、依赖缺失或任意非零退出码描述为 Red。最终测试通过不能反向证明生产代码是在有效失败测试之后才被允许修改。

当 CapabilityPlan 启用 `strict_tdd` 时，本设计把 TDD 从提示词中的开发建议提升为 `execute` 内部的受管协议：

```text
approved DesignSet.test_strategy
  → Plan 编译 TaskTddContract
  → Baseline Guard
  → Test Authoring（仅测试路径可写）
  → Red Verify（失败必须匹配预声明 Oracle）
  → Implementation（Red accepted 后才签发生产路径 Grant）
  → Green Verify（同一测试补丁、Gate 和执行环境）
  → Refactor（显式、可选、测试路径只读）
  → Verify → Evaluate → TaskVerdict → Snapshot
```

TDD 仍是 execute 内部 subgraph，不新增全局 phase。外部 Operation DAG 由 Slim CapabilityPlan 决定，例如 Standard/Governed 的完整路径可以是：

```text
capture → impact → design → plan → context → execute → verify → evaluate → snapshot
```

Lite 未启用 Impact/Design/Evaluation 时外部 DAG 可以更短；一旦 strict_tdd 激活，它依赖 design_governance、structured Gate 和 isolated workspace，并在每个相关 Task、每个 required Assertion Cluster 的 `execute` 内运行，因此可以服从 Task DAG 并行执行，不把整个迭代强制串行化。

Slim Profiles、DesignSet 与本协议共同进入首次 Protocol 1.1.0。strict_tdd 激活时，DesignSet 负责批准 TDD 适用性、失败 Oracle、目标 Gate 和路径策略；Plan 负责把它编译为不可降级的执行 Contract；TddController、CapabilityGrant、Gate、Evidence 和 Ledger 负责机械证明执行顺序。未激活时零 TDD Contract/Cycle/Run，并显示 `not_enabled_by_profile`。Agent 自述、transcript、文件时间戳和模糊退出码都不是 TDD 证明。

## 2. 背景与问题

现有验收链已经具备良好基础：

```text
Requirement Acceptance Criteria
  → Test VERIFIES Requirement
  → Task Acceptance Assertion
  → Agent Run
  → Project Gates
  → independent Evaluation
  → TaskVerdict
  → Iteration Snapshot
```

Plan 会把验收标准编译成绑定 Test、Required Gate 和 Evidence 类型的原子 Assertion。Verify 会运行项目 Gate 并产生不可变 Evidence；Evaluate 会独立评估 Task/Run；TaskVerdict 只有在 Assertion 所需 Gate、Evaluation 和 Evidence 都存在且通过时才通过。因此 Agent 的完成声明不是验收事实。

但现有执行协议仍有四个缺口：

1. 没有实现前的 Red 验证步骤，无法证明测试先于实现产生。
2. 没有预声明 Failure Oracle，无法区分“行为尚未实现”与语法、环境或测试框架错误。
3. 单个 Run 同时拥有测试和生产路径写权限，无法证明 Red accepted 前没有生产实现参与。
4. TaskVerdict 只检查最终证据，不要求 Baseline、Red、Green 的顺序、同源性和配对关系。

当前可能出现的：

```text
Agent 先实现 → verify 失败 → 修复 → verify 通过
```

属于门禁失败后的修复闭环，不是严格 TDD。本设计在不削弱现有 Verify/Evaluate 的前提下补齐“可证明顺序”。

## 3. 已确认的产品决策

| 决策 | 结论 |
| --- | --- |
| TDD 适用性来源 | 由 accepted DesignSet 的 `test_strategy` 按 Requirement 声明；Plan 不得降级 |
| 适用范围 | 代码、配置、Schema、迁移、安全和缺陷修复默认 `required` |
| 受控不适用 | 仅允许批准的 `documentation_only`、`research_only`、`non_executable_projection` 等分类 |
| Red 定义 | 目标测试按预声明 Failure Oracle 产生结构化、匹配的行为失败 |
| 基线证明 | 先证明既有目标测试或受影响组件在 repository baseline 上健康 |
| 写权限 | Test Authoring 只能写测试；Red accepted 后重新签发生产路径 Grant |
| 测试冻结 | Red accepted 后冻结规范化 test patch；后续修改使本轮证据失效 |
| Green 定义 | 同一 test patch、target Gate、framework profile 和执行环境在实现 revision 上通过 |
| Refactor | 显式但可选的第三个受管 Run；测试路径继续只读 |
| 生命周期位置 | 作为每个启用 strict_tdd Task 的 `execute` 内部状态机，不新增公共 red/green phase |
| 证据模型 | 复用统一 Evidence 节点，通过 `evidence_type` 区分；另有不可变 `TddCycleRecord` 配对 |
| 覆盖粒度 | Planner 定义 Assertion Cluster；每个 required Assertion 恰好属于一个当前有效 Cycle |
| 无测试框架 | 先执行受治理的 `TestInfrastructureTask`，生产 Task 在 FrameworkEvidence accepted 前阻塞 |
| Protocol 版本 | 与 DesignSet 一起进入首次 1.1.0，不另建 1.2 过渡版本 |
| Profile 激活 | Governed 对适用代码 Task 强制；Standard 由 test_strategy 决定；Lite 由风险/用户/Policy 激活 |
| 未启用语义 | 零 TDD 工件，状态为 `not_enabled_by_profile`，不伪装 not_applicable/proven |

## 4. 目标与非目标

### 4.1 目标

1. 对所有已激活 strict_tdd 且 `tdd: required` 的 Assertion，Ledger 能重放并证明 Baseline、Red、Green 的顺序和绑定。
2. Red accepted 前没有任何生产实现参与被验证的 Red 工作树。
3. Red 只能由预声明的行为失败产生，不能由任意非零退出码伪造。
4. Red 和 Green 使用同一个规范化测试补丁、目标 Gate、测试框架和执行环境。
5. TaskVerdict 机械拒绝缺失、重复、失效或绑定漂移的 TDD Cycle。
6. 进程中断、预算耗尽、测试变化和 Finding 回流后可以确定性恢复或失效，不覆盖历史证据。
7. Dashboard 和 Projection 用业务语义展示 TDD 状态，同时保留 digest 审计入口。

### 4.2 非目标

- 不声称状态机可以独立证明实现代码是理论上的“最小实现”。
- 不用 TDD 证据替代完整项目 Gate、CapabilityPlan 启用的独立 Evaluation、代码评审或安全评估。
- 不允许 Agent、模型或 transcript 自己签发 RedEvidence、GreenEvidence 或生产写权限。
- 不用 Git 文件时间戳、提交顺序或自然语言日志推断 TDD 顺序。
- 不要求文档、研究和纯投影任务伪造不可执行测试。
- 不追溯生成 Protocol 1.0 历史迭代当时不存在的 Red/Green 证据。
- 不在本设计中引入新的公共生命周期 phase。
- 不要求 strict_tdd 未启用的 Lite Task 生成 no-op Contract、Cycle 或 Evidence。

## 5. 总体架构

### 5.1 权威链

```text
Requirement / Assertion
  ↓
accepted DesignSet.test_strategy
  applicability + baseline guards + target Gate + Oracle + path policy
  ↓
ExecutionPlan.TaskTddContract
  assertion clusters + immutable design binding + phase budgets
  ↓
TddController
  phase state + isolated workspaces + CapabilityGrants + checkpoints
  ↓
Gate Providers
  normalized target-test results + failure classification
  ↓
typed Evidence + TddCycleRecord
  ↓
TaskVerdict
  ↓
Verify / Evaluate / Snapshot
```

权威所有权不可互换：

- CapabilityPlan 决定本迭代/Task 是否启用 strict_tdd；未启用时不得进入本权威链。
- DesignSet 决定为什么需要 TDD、预期什么失败、允许测试和实现触及哪些范围。
- Planner 只负责拆分 Assertion Cluster、选择更窄 selector/path/budget 并形成执行 Contract。
- TddController 只执行已批准策略，不能修改 Oracle 或自行声明不适用。
- Gate Provider 只报告结构化运行事实，不能批准证据。
- Evidence Validator 复验绑定并决定 Evidence 是否 accepted。
- TaskVerdict 只消费 accepted Ledger 事实，不消费 Agent 自评。

### 5.2 DesignProposalPort 边界

DesignProposalPort 可以提出 test_strategy，包括 TDD 适用性、Failure Oracle、Gate 和路径策略，但：

- 使用只读输入和能力集；
- 不能运行测试或修改项目文件；
- 不能签发 CapabilityGrant；
- 不能批准自身提案；
- 不能生成执行 Evidence 或 TddCycleRecord；
- 输出必须经过确定性 Schema、引用、覆盖和风险校验，再由人工批准整个 DesignSet。

### 5.3 与最终验收的关系

Task 内的 Green 只证明指定行为由红转绿。它不等于项目级完成：

```text
TddCycle completed
  → execute 完成
  → verify 运行完整 build/test/regression/security Gates
  → [evaluate] 独立检查 Assertion 与 Evidence
  → TaskVerdict 联合裁决
```

方括号表示 `independent_evaluation` 启用时存在。即使全部 TDD Cycle completed，只要完整 Gate 或已启用的 Evaluation 失败，TaskVerdict 仍失败并进入统一 Finding 反馈闭环。

### 5.4 Capability 激活边界

- Governed：所有适用代码、配置、Schema、迁移、安全和缺陷修复 Task 激活 strict_tdd；
- Standard：DesignSet.test_strategy 对 Task 声明 required 时激活；
- Lite：风险推荐、用户选择或 Project Policy 激活后，Capability Compiler 先补齐 design_governance、structured Gate 和 isolated workspace 依赖；
- 未激活：不调用 TddController，不创建 TaskTddContract、TDD Run/Event/Evidence/TddCycleRecord，也不创建空壳批准；
- 激活决定和 CapabilityPlan digest 必须进入 Plan/TaskVerdict，使“未启用”与“遗漏证据”可机械区分。

## 6. DesignSet.test_strategy 契约

### 6.1 每个 Requirement 的策略

当 CapabilityPlan 激活 design_governance/strict_tdd 时，每个相关 `must-change` Requirement 必须关联至少一个 accepted `test_strategy` DesignArtifact。test_strategy 资产本身不可缺失；其内部可以对“严格 TDD 执行是否适用”做受控判断：

```ts
export type TddApplicability =
  | {
      readonly status: "required";
      readonly baseline_guard_gate_ids: readonly string[];
      readonly target_gate_id: string;
      readonly target_test_selectors: readonly string[];
      readonly failure_oracle: FailureOracle;
      readonly path_policy: TddPathPolicy;
      readonly framework_profile_digest: string;
      readonly refactor_policy: "planned" | "not_planned";
    }
  | {
      readonly status: "not_applicable";
      readonly category: TddNotApplicableCategory;
      readonly reason: string;
    };

export type TddNotApplicableCategory =
  | "documentation_only"
  | "research_only"
  | "non_executable_projection";

export interface RequirementTddPolicy {
  readonly requirement_id: string;
  readonly applicability: TddApplicability;
}
```

受控 category 由 Protocol registry 定义，项目 Policy 可以进一步收紧，不能通过自由字符串扩展。代码、配置、Schema、迁移、安全和缺陷修复如果被声明为 not_applicable，DesignSet 校验必须失败。

### 6.2 路径策略

```ts
export interface TddPathPolicy {
  readonly test_write_paths: readonly string[];
  readonly test_config_write_paths: readonly string[];
  readonly production_write_paths: readonly string[];
  readonly immutable_paths: readonly string[];
}
```

路径必须为仓库内的规范相对路径或受控 glob，经过与 Policy、ImpactSet 和 Component scope 的交集校验。Planner 可以缩小路径，不得扩大；测试与生产范围重叠时必须在 design 阶段消歧，不能留给 Agent 自行判断。

测试框架配置默认属于 test-config；应用运行配置、数据库迁移、依赖锁文件是否属于 production，必须由项目 profile 和 DesignSet 明确分类。分类结果进入 strategy digest。

对于把测试与生产代码放在同一物理文件中的语言或框架，普通路径级 Grant 不足以证明 test-only。项目必须提供受信任、语法感知的 patch classifier，证明修改仅发生在测试区域；否则 DesignSet 必须选择独立测试文件或黑盒测试，strict TDD preflight fail closed，不能因为共置测试而自动降级为 not_applicable。

### 6.3 Baseline Guard 语义

Baseline 不是“Red 前随便运行一次测试”，而是证明失败不是既有缺陷：

- 修改既有测试时，目标 Gate/selector 必须在 repository baseline 上通过。
- 新增测试时，baseline 上不存在该 test patch，因此先运行 DesignSet 批准的受影响组件回归 Gate，并记录目标测试在 baseline 不存在；不能把“找不到新测试”当作 Red。
- Gate 必须在未应用 test patch 和 production patch 的 baseline workspace 上运行。
- Baseline 不健康时创建 `pre_existing_failure` Finding 并阻塞 Cycle；不得继续制造 RedEvidence。

### 6.4 Failure Oracle

```ts
export interface FailureOracle {
  readonly selector_ids: readonly string[];
  readonly allowed_failure_kinds: readonly TddFailureKind[];
  readonly assertion_ids: readonly string[];
  readonly expected_error_codes?: readonly string[];
  readonly expected_symbols?: readonly string[];
  readonly normalized_message_patterns?: readonly string[];
}

export type TddFailureKind =
  | "assertion_failure"
  | "contract_mismatch"
  | "expected_exception_not_thrown"
  | "missing_symbol";
```

默认允许前三种行为失败。`missing_symbol` 只有在 DesignSet 预先声明精确 symbol 或稳定 error code 时才允许。message pattern 必须使用受限、可审计的匹配语法，禁止不受控正则表达式。

以下结果永远不能形成有效 RedEvidence：

- 通用 syntax/parse/compile error；唯一例外是 DesignSet 预声明的精确 `missing_symbol`，或被正式建模为稳定 `contract_mismatch` 的 contract compiler Gate，且 Provider 能把错误绑定到目标 selector/assertion；
- test discovery failure 或没有目标测试结果；
- 依赖、权限、网络、环境或 secret 错误；
- timeout、进程崩溃、OOM 或 Harness 中断；
- 与 selector、assertion 或 Oracle 无关的其他测试失败；
- 只有退出码和 stdout、没有结构化测试结果。

## 7. Plan 与 TaskTddContract

### 7.1 编译规则

strict_tdd 激活后，Planner 从 accepted DesignSet 的 test_strategy 编译每个相关 Task 的 `TaskTddContract`。Plan 必须绑定 RequirementBaseline、ImpactSet、DesignSet、CapabilityPlan、Policy 和 Contract digest。未激活的 Task 不生成 Contract，并在 Plan/Verdict 中绑定 `not_enabled_by_profile`。

Planner 允许：

- 将 Requirement Assertion 拆分为更小的 Assertion Cluster；
- 缩小 target selector、路径和预算；
- 为共享同一个 test patch 和 target Gate 的 Assertion 建立一个 Cluster；
- 插入 `TestInfrastructureTask` 依赖。

Planner 禁止：

- 把 `required` 改为 `not_applicable`；
- 扩大 Failure Oracle、路径或 Gate 能力；
- 让一个 required Assertion 同时由多个当前 Cycle 覆盖；
- 让不同 test patch 或不同 target Gate 的 Assertion 共享 Cycle；
- 生成没有 DesignSet strategy binding 的可执行 Task。

### 7.2 Contract 模型

```ts
export type TddContractMode =
  | "required"
  | "not_applicable"
  | "framework_bootstrap";

export interface TddPhaseBudget {
  readonly max_runs: number;
  readonly max_duration_ms: number;
  readonly max_steps?: number;
  readonly max_tokens?: number;
}

export interface TddPhaseBudgets {
  readonly test_authoring: TddPhaseBudget;
  readonly implementation: TddPhaseBudget;
  readonly refactor?: TddPhaseBudget;
}

export interface FrameworkBootstrapProfile {
  readonly framework_profile_id: string;
  readonly discovery_gate_id: string;
  readonly pass_fixture_id: string;
  readonly fail_fixture_id: string;
  readonly expected_failure_kind: TddFailureKind;
  readonly test_write_paths: readonly string[];
  readonly test_config_write_paths: readonly string[];
}

export interface TaskTddContract {
  readonly contract_id: string;
  readonly task_id: string;
  readonly contract_mode: TddContractMode;
  readonly requirement_baseline_digest: string;
  readonly impact_set_digest: string;
  readonly design_set_digest: string;
  readonly capability_plan_digest: string;
  readonly test_strategy_asset_id: string;
  readonly test_strategy_digest: string;
  readonly plan_digest: string;
  readonly assertion_clusters: readonly AssertionCluster[];
  readonly not_applicable_binding?: {
    readonly category: TddNotApplicableCategory;
    readonly reason: string;
  };
  readonly framework_bootstrap_profile?: FrameworkBootstrapProfile;
  readonly phase_budgets: TddPhaseBudgets;
  readonly contract_digest: string;
}

export interface AssertionCluster {
  readonly cluster_id: string;
  readonly logical_cycle_id: string;
  readonly assertion_ids: readonly string[];
  readonly test_node_ids: readonly string[];
  readonly target_gate_id: string;
  readonly target_test_selectors: readonly string[];
  readonly baseline_guard_gate_ids: readonly string[];
  readonly failure_oracle: FailureOracle;
  readonly path_policy: TddPathPolicy;
  readonly framework_profile_digest: string;
  readonly refactor_policy: "planned" | "not_planned";
}
```

`logical_cycle_id` 对一个 Plan revision 中的 Cluster 稳定。每次失效重试使用新的 `attempt_ordinal` 和 attempt record，但仍归属同一 logical cycle。这样既能保留失败历史，又能要求每个 Assertion 最终只有一个当前有效 completed attempt。

Protocol 1.1 的可执行 Task 只允许一种 `contract_mode`。`required` Task 必须且只能包含一个 Assertion Cluster，这个 Cluster 可以覆盖共享同一 test patch 和 target Gate 的多个 Assertion；需要不同 patch/Gate 的 Assertion 必须拆为不同 Task，并通过 Task DAG 表达依赖。`not_applicable` 和 `framework_bootstrap` Task 的 clusters 为空，分别要求对应的 binding/profile。这样避免同一工作树内多个 Cycle 相互污染，同时保留 Task 级并行能力。

### 7.3 覆盖不变量

Plan validator 必须证明：

1. 每个 `tdd: required` Assertion 恰好属于一个 Assertion Cluster。
2. Cluster 中的 Assertion 共享同一 test patch、target Gate、framework profile 和路径策略。
3. not_applicable Assertion 绑定 approved category、reason 和 DesignSet digest。
4. framework_bootstrap Task 不包含生产 Requirement 实现，不获得 production path。
5. 所有 Task 依赖形成无环 DAG；生产 Task 依赖所需 FrameworkEvidence。
6. 一个 Task 不混合 required、not_applicable 和 framework_bootstrap；需要不同模式时必须拆分。

## 8. TDD 状态机

### 8.1 状态顺序

```text
contract_ready
  → baseline_guard
  → test_authoring
  → red_verification
  → implementation
  → green_verification
  → refactor?
  → cycle_completed
```

终止或旁路状态：

```text
blocked | invalidated | budget_exhausted | cancelled
```

状态迁移只由 TddController 根据 accepted Ledger 事实执行。Agent 不能自行跳转，也不能通过 prompt 输出请求放宽权限。

### 8.2 隔离工作区

“Test Authoring 只能写测试”不能只依赖最终 `git diff`。严格模式使用隔离工作区和规范补丁：

1. Baseline workspace 从绑定的 repository baseline 创建，保持只读语义。
2. Test Authoring workspace 从相同 baseline 创建，只授予 test/test-config 范围。
3. Harness 提取并验证规范化 test patch；出现 production 或 immutable path diff 时拒绝该 Run。
4. Red verification 在新的 clean workspace 中，只向 baseline 应用已验证 test patch。
5. Implementation workspace 再从 baseline + frozen test patch 创建，不继承 Test Authoring workspace 的其他瞬态变化。
6. Green verification 使用 Implementation revision 与同一 frozen test patch。

因此即使某个外部 executor 不能证明所有瞬态文件操作，RedEvidence 仍只来自可重建的 `baseline + accepted test patch`。不能提供隔离 workspace、规范 patch 和写集合复验的 Adapter，不得宣称支持 `strict_tdd`，相关 Task 必须在 preflight 阻塞。

### 8.3 Phase Grant

每个阶段使用独立、可撤销、带 digest 的 CapabilityGrant；不在原 Grant 上直接扩大能力：

| 状态 | 写入范围 | Gate/工具范围 | 解锁条件 |
| --- | --- | --- | --- |
| baseline_guard | 无 | baseline guard/target Gate | baseline Evidence accepted |
| test_authoring | test + test-config | 测试编辑、静态检查 | test patch 通过路径和内容校验 |
| red_verification | 无 | target Gate | Oracle 匹配且 RedEvidence accepted |
| implementation | production；test 只读 | 编译、target Gate、受控实现工具 | GreenEvidence accepted |
| refactor | 更窄 production；test 只读 | target Gate + 指定回归 Gate | RefactorEvidence accepted |

Implementation Grant 只在 `TddRedAccepted` 提交后重新签发。Agent 自述、transcript、Live event 或未验证退出码均不能解锁。

### 8.4 实现修复循环

Green 未通过但测试补丁、Gate、环境和 Contract 未漂移时，Task 保持在 implementation，在阶段预算内继续修复。该失败不是新的 Red，不生成第二份 RedEvidence。

如果实现发现 DesignSet 的 Oracle、接口契约或影响范围错误，则创建 Finding，撤销 Grant，并通过 `impact → design → plan` 级联修订；不得由执行 Agent 就地修改 Contract。

### 8.5 Refactor

Refactor 是显式但可选的第三个 Run：

- 是否计划执行由 DesignSet/Plan 声明；
- 测试路径和 test patch 保持只读；
- Refactor Grant 的生产路径和预算不得宽于 Implementation；
- 必须重新运行 target Gate 和 Contract 指定的回归 Gate；
- 失败补丁应在隔离 workspace 中丢弃，保留已验证 Green checkpoint；无法安全隔离时创建 Finding 并阻塞，不做隐式破坏性 Git 回退。

协议只能证明重构前后行为仍绿，不能独立证明重构质量最佳。质量仍由 Evaluation 和评审判断。

## 9. Evidence 与 TddCycleRecord

### 9.1 统一 Evidence 类型

不新增多个 Graph Node 类型。继续使用统一 Evidence 节点，在权威 extension 中增加：

| `evidence_type` | 证明内容 |
| --- | --- |
| `framework_result` | 测试发现、受控通过、受控失败样例均可机械运行 |
| `baseline_test_result` | 既有目标测试或受影响组件在 baseline 健康 |
| `red_test_result` | baseline + frozen test patch 按 Oracle 失败 |
| `green_test_result` | 同一 test patch 在 production revision 上通过 |
| `refactor_test_result` | 可选重构后目标与回归 Gate 仍通过 |

公共绑定至少包括：

- workflow operation、iteration、Task、Run、Contract、logical cycle 和 attempt；
- repository baseline、workspace/patch/revision digest；
- Gate id/version/config digest；
- framework profile、toolchain 和 executor environment digest；
- selector、结构化 test result、failure classification；
- CapabilityGrant digest、observed write set digest；
- started/finished time、duration、exit status 和 output artifact locator/digest。

`executor_environment_digest` 表示 OS/runtime/toolchain/runner 等外部执行环境，不包含生产源码内容。依赖锁文件或项目配置如果由实现合法修改，属于 production revision，由其 digest 单独绑定，不能伪装为外部环境变化。

### 9.2 RedEvidence 接受条件

RedEvidence 只有在以下条件全部成立时 accepted：

1. BaselineEvidence accepted 且未漂移。
2. Red workspace 可由 baseline + frozen test patch 确定性重建。
3. observed diff 仅包含批准的 test/test-config 路径。
4. target Gate、selector、framework profile 和 executor environment 与 Contract 一致。
5. 结构化失败至少命中一个目标 Assertion，并完整匹配 Failure Oracle。
6. 不存在更早的 Harness/环境/发现错误遮蔽目标结果。
7. Evidence digest 和 checkpoint 已写入 Ledger。

### 9.3 GreenEvidence 接受条件

GreenEvidence 只有在以下条件全部成立时 accepted：

1. 引用同一 logical cycle 的当前 accepted RedEvidence。
2. test patch、target Gate、selector、framework profile 和 executor environment 与 Red 完全一致。
3. test/test-config 路径自 Red 后没有变化。
4. production revision 的 observed diff 在 Implementation Grant 范围内。
5. 所有目标 selector 通过且没有目标结果缺失。
6. Evidence 和 implementation checkpoint 已提交。

### 9.4 TddCycleRecord

活动状态由 append-only domain events 和 checkpoint 重建。每个 attempt 结束时写入不可变记录：

```ts
export interface TddCycleRecord {
  readonly protocol_version: "1.1.0";
  readonly record_kind: "tdd_cycle";
  readonly logical_cycle_id: string;
  readonly attempt_ordinal: number;
  readonly task_id: string;
  readonly assertion_ids: readonly string[];
  readonly contract_digest: string;
  readonly repository_baseline: string;
  readonly baseline_evidence_digest?: string;
  readonly test_patch_digest?: string;
  readonly target_gate_binding_digest?: string;
  readonly executor_environment_digest?: string;
  readonly red_evidence_digest?: string;
  readonly green_evidence_digest?: string;
  readonly refactor_evidence_digest?: string;
  readonly implementation_revision?: string;
  readonly status: "completed" | "invalidated" | "blocked";
  readonly reason?: string;
  readonly record_digest: string;
}
```

建议路径：

```text
artifacts/tdd-cycles/<logical-cycle-id>/<attempt-ordinal>.json
```

旧 Record 永不改写。后续发现摘要漂移时追加 `TddCycleInvalidated`，并创建新 attempt；当前有效视图由事件重放选择。一个 required Assertion 找不到唯一当前有效 completed Record 时，TaskVerdict 必须失败。

字段完整性由 `status` 和终止阶段决定：`completed` 必须包含 Baseline、test patch、Gate/environment、Red、Green 和 implementation revision；`invalidated`/`blocked` 只允许保留终止前已经 accepted 的绑定，并必须有结构化 reason。这样 Baseline 失败等早期终止也能形成不可变审计记录，而不会伪造尚未产生的 Red/Green。

## 10. Domain Events 与检查点

新增或扩展以下权威事件：

- `TddCycleStarted`
- `TddBaselineAccepted`
- `TddTestPatchFrozen`
- `TddRedAccepted`
- `TddImplementationUnlocked`
- `TddGreenAccepted`
- `TddRefactorAccepted`
- `TddCycleCompleted`
- `TddCycleInvalidated`

事件 payload 只保存规范 ID、摘要、状态和原因；大体积 stdout、测试报告和 patch 作为 artifact 保存并由 digest 引用。

每个关键边界沿用 Git-native Ledger 的 `CheckpointCommitted`。恢复时必须复验：

- RequirementBaseline、ImpactSet、DesignSet、Plan、Policy 和 Context digest；
- Contract、logical cycle 和 attempt；
- repository baseline、工作树和 frozen test patch；
- Gate、framework profile 和 executor environment；
- 当前 CapabilityGrant 和预算消耗。

全部一致才从最近状态继续。任何不一致都进入 deterministic invalidation、人工复核或重新开始，不根据 transcript 猜测完成度。

Live Spool 可以额外发送相同业务语义的可删除事件，例如 heartbeat、step、output tail 和当前 TDD state，但 Live event 不参与证据接受、授权解锁或恢复事实判断。

## 11. 失效与失败处理

| 条件 | 行为 |
| --- | --- |
| Baseline Gate 失败 | 创建 `pre_existing_failure` Finding，阻塞 Cycle |
| Test Authoring 写入 production/immutable path | 拒绝 patch、撤销 Grant、终止 Run、创建 policy Finding |
| Red 与 Oracle 不匹配 | 不产生 accepted RedEvidence；在 test-only 范围修复或回到 DesignSet revision |
| Red 后测试或 test-config 被修改 | 当前 Red 及全部下游 Evidence 失效，新 attempt 从 test_authoring 开始 |
| baseline/Gate/framework/environment 漂移 | 整个 attempt 失效，从 baseline_guard 重开 |
| Green 失败 | 在 Implementation Grant 和预算内修复，不伪造新 Red |
| Implementation 预算耗尽 | 创建 implementation Finding，保留 Evidence/output tail，暂停 Task |
| Refactor 失败 | 丢弃隔离 refactor patch，保留 Green checkpoint；无法隔离则阻塞 |
| 完整 Verify 失败 | 创建 Finding 并进入统一反馈路由；经新 ImpactSet/DesignSet（可为 reuse）/Plan 后执行修复 |
| Evaluation 拒绝 | Finding 绑定 Assertion、Cycle 和证据缺口并进入统一反馈路由；Green 不覆盖评审 |
| upstream digest 漂移 | 撤销 Run/Grant，追加 invalidation，回到最早受影响 phase |

Green 验证阶段的局部实现失败在当前 Contract 和预算内修复，不创建 Finding。进入 Verify/Evaluate 后产生的 Finding 一律作为 Change Seed 经过 ImpactSet 和 DesignSet；即使设计无需改变，也生成绑定新 ImpactSet 的 `mode: reuse` DesignSet，再编译新 Plan。任何 Requirement、Impact、Decision、Contract、Oracle、路径或 Gate 变化都会使旧 Cycle 授权失效。

## 12. TestInfrastructureTask

### 12.1 触发条件

如果目标组件没有满足 strict TDD 的结构化 Gate Provider、测试发现能力或 framework profile，Planner 不能直接生成生产功能 Task。它必须先插入 `contract_mode: framework_bootstrap` 的 TestInfrastructureTask。

### 12.2 权限与完成条件

Bootstrap Task：

- 只允许修改测试框架、测试配置和受控示例测试路径；
- 不允许修改生产实现路径；
- 不要求普通 Red/Green Cycle，避免递归依赖尚不存在的测试框架；
- 必须生成 accepted `framework_result`，机械证明：
  1. runner 能发现指定测试；
  2. 受控 pass 样例通过；
  3. 隔离 fixture 中的受控 fail 样例被解析为指定 failure kind，且失败样例不会留在项目默认测试套件中；
  4. 结构化输出含 selector、assertion 和结果；
  5. framework profile、toolchain 和配置 digest 可重建。

所有依赖该 profile 的 production Task 在 FrameworkEvidence accepted 前阻塞。Bootstrap 不是 `not_applicable`，TaskVerdict 必须显示独立的 framework proof 状态。

## 13. TaskVerdict

strict_tdd 激活时，TaskVerdict 在现有 Assertion/Gate/Evaluation/Evidence 条件上增加 TDD 条件：

### 13.1 required

每个 required Assertion 必须：

1. 唯一映射到一个 Assertion Cluster；
2. 找到一个当前有效、`status: completed` 的 TddCycleRecord；
3. Record 的 Contract/DesignSet/Plan/Assertion binding 未漂移；
4. Baseline、Red、Green Evidence 均 accepted 且绑定一致；
5. refactor_policy 为 planned 时存在 accepted RefactorEvidence；
6. 完整 required Gates 通过；CapabilityPlan 启用 `independent_evaluation` 时，对应 Evaluation 也必须通过。

### 13.2 not_applicable

不要求 TddCycleRecord，但必须绑定 accepted DesignSet 的受控 category/reason，且 Task 类型与 Policy 允许。Verdict 显示“受控不适用”，不能伪装为“具备 TDD 证明”。

### 13.3 framework_bootstrap

必须存在 accepted FrameworkEvidence，且所有 discovery/pass/fail assertions 通过。Verdict 显示“测试基础设施证明”。

### 13.4 Profile 未启用

CapabilityPlan 未启用 strict_tdd 时，不要求 TddCycleRecord，但必须存在 accepted CapabilityPlan binding。Verdict 显示 `not_enabled_by_profile`，不能显示“受控不适用”“具备 TDD 证明”或“缺失证据”。

### 13.5 历史记录

Protocol 1.0 completed Task 保持原 Verdict，不补造 TDD 条件。Dashboard/Projection 显示“历史记录，无 TDD 证明”。

## 14. Dashboard 与 Projection

### 14.1 Design 与 Approval

strict_tdd Capability 激活时，DesignSet Preview 增加每个 Requirement 的：

- TDD required/not_applicable；
- 中文业务理由；
- baseline guard Gate 和 target Gate；
- test selector 和 Failure Oracle；
- test/test-config/production 路径范围；
- framework profile 和 refactor policy。

这些字段随整个 DesignSet 原子批准，不新增执行期批准入口。

### 14.2 Iterations 与 Task

strict_tdd 激活时，Task 详情使用时间线展示：

```text
Baseline → Test Authoring → Red → Implementation → Green → Refactor → Complete
```

每一段显示当前/完成/失效/阻塞状态、Run、Grant 范围、预算、Gate、中文原因、恢复入口和关联 Finding。digest 作为可展开审计字段，不作为主要业务标签。

未激活时 Dashboard TDD 稳定 URL/Read API 返回 `inactive_by_profile` 和激活选项，不渲染空时间线。

### 14.3 Evidence 与 Verdict

Evidence 视图显示：

- Requirement、Assertion 和测试业务名称；
- baseline 健康结论；
- Red 失败种类、Oracle 匹配项和目标 selector；
- Green/Refactor 结果；
- test patch、production revision、Gate 和环境绑定；
- Record 配对结论和失效原因。

Verdict 明确区分：

- `tdd_proven`
- `controlled_not_applicable`
- `framework_proven`
- `not_enabled_by_profile`
- `historical_without_tdd_proof`
- `tdd_incomplete_or_invalid`

### 14.4 Live

Live 可以显示 dsh 心跳、tokens/steps、phase、stdout tail 和当前 TDD state，便于观察和故障定位；它仍是可删除观测层。Dashboard 刷新或 Live 丢失后，所有权威状态必须能从 Ledger、Evidence 和 TddCycleRecord 重建。

### 14.5 Markdown Projection

- Specification 显示 test_strategy 的 TDD 适用性和 Oracle。
- Plan 显示每个 Task 的 Assertion Cluster、Contract mode 和 required Evidence。
- Snapshot 显示 TDD 证明摘要、受控不适用理由和历史兼容标签。
- Architecture 继续由 DesignSet/Decision/Component/DesignArtifact 生成，不复制执行期 Evidence。

## 15. Protocol 版本与迁移

### 15.1 Protocol 1.1 协同交付

Slim Profiles、DesignSet 和 TDD 尚未实施，因此 Profile/Capability records、DesignSet Schema、test_strategy profile、TaskTddContract、typed Evidence、TddCycleRecord 和事件在首次 Protocol 1.1.0 中按依赖一起交付。先建立动态 CapabilityPlan/DAG，再把 TDD 作为 strict_tdd Module 接入，避免先发布固定重流水线再返工。

### 15.2 已完成 Protocol 1.0

- 原 Ledger、Snapshot、Verdict 和 digest 保持不变；
- 不补造 Red/Green、DesignSet 或 Approval；
- Dashboard/Projection 标记“Protocol 1.0 历史记录，无 DesignSet/TDD 证明”；
- Auditor 保持兼容 warning，不追溯阻塞历史完成状态。

### 15.3 开放 Protocol 1.0

先沿用 Slim Profile 迁移规则要求显式 ProjectProfile，再根据新 CapabilityPlan 回到最早安全 DAG node：

- strict_tdd 未激活：不补造 TDD Contract/Cycle，显示 not_enabled_by_profile；
- strict_tdd 激活且尚未 Plan：补齐 Impact/Design 后编译 Contract；
- 已有 Plan/Context/Run：旧授权失效，按 CapabilityPlan 回到最早依赖节点；
- 新 Plan 中 TDD required Task 必须编译 TaskTddContract；
- 无法判断 baseline 或 checkpoint 时阻塞并给出明确恢复命令，不猜测 Red/Green 状态。

### 15.4 追加而非改写

Evidence、Cycle、Grant 和审批发生漂移时，只追加 invalidation/supersede/event 记录；不修改旧 Artifact 字节。Materialized view 通过事件重放选择当前有效记录。

## 16. 安全与治理

1. 测试源码、失败消息、stdout 和报告均是不可信输入，不能获得提示词或工具指令优先级。
2. Failure Oracle 使用受限枚举、稳定 code/symbol 和受限 pattern，避免任意正则和消息注入。
3. Gate Provider 必须限制报告尺寸、嵌套深度和附件数量；大输出只保存 digest/locator/tail。
4. Red/Green Evidence 必须由 Harness 根据 Gate 原始结果和绑定计算，Agent 不能直接提交 accepted 状态。
5. Phase Grant 不能覆盖项目 Policy deny；人工审批 DesignSet 也不能扩大 Policy 能力。
6. strict TDD 需要隔离 workspace、规范 patch 和写集合复验；能力不足的 Adapter 必须 fail closed。
7. secret、环境变量和工作区外路径不进入 test patch 或 Evidence content。
8. Grant、baseline、Gate、environment 和 patch 的摘要绑定防止审批/验证之间的 TOCTOU。
9. 恶意测试不得通过修改 Harness Ledger、Evidence 或 Gate Provider 伪造结果；这些路径必须 immutable。

## 17. 测试策略

### 17.1 Unit

- test_strategy TDD profile 的有效/无效 Schema；
- required/not_applicable/framework_bootstrap/not_enabled_by_profile 分类；
- Failure Oracle 分类和受限 pattern；
- Assertion Cluster 覆盖与唯一性；
- TaskTddContract canonical digest；
- Evidence binding 和 TddCycleRecord validator；
- TaskVerdict 的所有模式和失败原因。

### 17.2 Property

- 输入排序不影响 Contract、patch manifest 和 Cycle digest；
- required 永远不能被 Planner 降级；
- required Assertion 恰好一个当前有效 Cycle；
- 不匹配 Oracle 的任意失败都不能 accepted；
- test patch 改变必然使旧 Red/Green 配对失效；
- 任何 unauthorized path diff 都不能进入 accepted patch；
- resume/replay 不重复签发事件、Grant 或 Record。

### 17.3 Policy 与隔离

- Test Authoring 不能提交 production/immutable path；
- Red workspace 只能由 baseline + test patch 重建；
- Red accepted 前无法获得 Implementation Grant；
- Implementation/Refactor 无法改变 test patch；
- Adapter 不支持 isolation 时 preflight fail closed；
- Grant 撤销、预算耗尽和中断恢复正确。

### 17.4 Controller Integration

- existing test baseline pass → valid Red → Green；
- new test component baseline pass → valid Red → Green；
- baseline pre-existing failure → Finding/block；
- invalid red → no unlock → test-only retry；
- test change after Red → invalidation/new attempt；
- Green repair loop 不产生第二个 Red；
- optional Refactor success/failure isolation；
- crash at every checkpoint → deterministic resume。

### 17.5 DesignSet/Plan Integration

- DesignSet required strategy → Plan Contract；
- Plan 降级/扩大 Oracle/path 被拒绝；
- DesignSet revision 使 Plan/Context/Grant/Cycle 失效；
- TestInfrastructureTask DAG 依赖；
- Finding → ImpactSet → DesignSet revision → new Contract。
- Lite 未激活 strict_tdd → zero Contract/Run/Event/Evidence/Cycle。

### 17.6 Adapter 与 E2E

至少覆盖：

1. 测试 adapter 的严格 TDD 完整闭环；
2. dsh 的两个受管 Run（test-authoring、implementation）和可选 refactor Run；
3. framework bootstrap 后生产 Task 解锁；
4. controlled not_applicable Task；
5. Lite not_enabled_by_profile Task 且零 TDD 工件；
6. 越权路径、错误 Oracle、环境漂移和预算耗尽；
7. 完整 Gate 或已启用 Evaluation 失败后的反馈级联；
8. Dashboard 刷新后从 Ledger 重建时间线；
9. Markdown Plan/Snapshot 与权威 Contract/Evidence 无漂移；
10. Protocol 1.0 历史兼容和开放迭代迁移；
11. `harness new`、`adopt`、`iterate` 各至少一个纵向场景。

## 18. 完成定义

实现只有在以下条件全部满足时才完成：

1. Protocol 1.1 同时包含 Slim Profile/Capability、DesignSet 和可证明 TDD 的 Schema、JSON Schema 与兼容读取。
2. strict_tdd 激活时，accepted test_strategy 对每个相关 Requirement 给出 required 或受控 not_applicable；未激活时零 TDD 工件。
3. Plan 对 strict_tdd 激活的 Task 生成不可降级 TaskTddContract，Assertion 覆盖唯一且完整。
4. strict TDD 使用隔离 workspace 和规范 test patch；Red workspace 可确定性重建。
5. Red 只有在 Baseline 健康且匹配 Failure Oracle 时 accepted。
6. Red accepted 前不能签发 Implementation Grant。
7. Red/Green 使用相同 test patch、Gate、framework profile 和 executor environment。
8. Red 后测试变化、环境漂移和越权写入会机械失效或阻塞。
9. TestInfrastructureTask 能生成 FrameworkEvidence 并正确阻塞/解锁依赖 Task。
10. TaskVerdict 区分 tdd_proven、受控不适用、framework proof、not_enabled_by_profile、历史无证明和无效/不完整。
11. Verify 以及 CapabilityPlan 启用的 Evaluation 继续独立于 TDD Cycle，并能否决最终完成。
12. Ledger 可重放所有 TDD state、Grant、Evidence、Record 和 invalidation。
13. Dashboard/Projection 提供中文业务语义和可展开 digest 审计。
14. Unit、Property、Policy、Integration、Migration、Adapter、Dashboard 和 E2E 测试全部通过。
15. 至少一个真实 Standard/Governed 项目通过真实 Agent 完成 DesignSet → Red → Green → Gate → Evaluation → Snapshot 纵向闭环；同时一个 Lite Kernel-only 项目证明零 TDD Contract/Run/Event/Evidence/Cycle，二者均可从账本复验。

## 19. 被否决的替代方案

### 19.1 只修改 Agent Prompt

成本最低，但无法阻止先实现后补测试，也无法让 TaskVerdict 客观验证顺序，因此否决。

### 19.2 拆成普通 TestTask、ImplementationTask、RefactorTask

可以利用 Task DAG，但跨 Task 的 test patch、Gate、Grant 和 Evidence 配对容易产生双重真相，Planner 也可能绕过依赖。保留 Task 内受管状态机更适合作为原子验收协议，因此否决。

### 19.3 增加公共 red/green/refactor phase

全局 phase 会把无关 Task 串行化，显著扩大 checkpoint、迁移和 Dashboard 协议面，也难以表达每个 Task 的不同 Cycle 进度，因此否决。

### 19.4 任意非零退出码作为 Red

会把语法、依赖、环境和崩溃错误误判为测试驱动证据，无法证明测试针对需求行为失败，因此否决。

### 19.5 用 Git 提交或文件时间戳证明先后

时间戳不能证明被执行的工作树内容，提交历史也可以重写；它们无法绑定 Oracle、Gate 和环境，因此否决。

### 19.6 Green 通过即跳过 Verify/Evaluate

目标测试不能覆盖项目回归、安全、构建和独立验收。Green 只能作为 Task 内执行证据，不能替代最终门禁，因此否决。

## 20. 与 DesignSet 实施计划的协同边界

本设计不授权代码实施。获得文档确认后，应修订现有 DesignSet 实施计划，而不是创建独立的事后 TDD 计划。建议依赖顺序：

1. Protocol 1.1 Profile/Capability records、Capability Compiler 与 Operation DAG；
2. Lite Kernel-only vertical slice 和零 TDD 工件证明；
3. DesignSet/test_strategy Schema、validator、approval preview 与 design_governance Module；
4. Plan TaskTddContract、Assertion Cluster 和 coverage validator；
5. isolated workspace、patch canonicalization 和 Phase Grant；
6. TddController、checkpoint、resume 和 invalidation；
7. Gate structured result、Failure Oracle、typed Evidence、TddCycleRecord 与 TaskVerdict；
8. TestInfrastructureTask、framework proof 和 dsh/test adapters 的分段 Run；
9. Finding/Profile upgrade 级联与 Protocol 1.0 migration；
10. Markdown Projection、Dashboard 渐进披露、三档 E2E、真实 Agent dogfood 和验收报告。

现有 DesignProposalPort、Design Approval、原子提交、Plan/Context/Preflight 强绑定和 Finding 回流仍是前置能力。协同计划必须在这些依赖点直接加入 TDD 工作，避免先完成一套 DesignSet 流程后再返工 Plan、Run、Evidence 和 UI。
