# Universal Harness DesignSet 与可证明 TDD 协同实施计划

日期：2026-08-18  
状态：已规划，待批准实施  
设计依据：

- [Universal Harness DesignSet 生命周期设计](../specs/2026-08-18-designset-lifecycle-design.md)
- [Universal Harness 可证明 TDD 协议设计](../specs/2026-08-18-provable-tdd-protocol-design.md)

## 1. 实施原则

本计划按 red-green-refactor 执行。每个 Task 先写一个因当前能力缺失而失败的最小测试，确认失败原因与设计中的 Oracle 一致后再修改生产代码；窄测试通过后运行受影响包测试；每个 Task 独立提交，不把 Protocol、Orchestrator、TddController、dsh、Projection 和 Dashboard 压进一个不可评审提交。

严格 TDD 协议尚未实现前，前置任务使用仓库开发纪律保留 Red/Green 命令和结果；TddController、Evidence 和 TaskVerdict 可用后，后续任务必须通过 Harness 自身 dogfood 留下可重放的 Baseline/Red/Green 证据。不能用“本计划要求 TDD”替代运行时协议验收。

以下设计约束不得在实施中静默改变：

1. 生命周期固定为 `capture → impact → design → plan → context → execute → verify → evaluate → snapshot`。
2. 所有 Protocol 1.1 迭代都必须产生 accepted DesignSet；reuse 也不能跳过。
3. DesignProposalPort 只提案，不具备项目写或 Ledger 写能力。
4. Proposal 在批准前不进入物化工程图。
5. DesignSet 以整个集合的 content digest 原子审批、原子提交。
6. 覆盖不足不能进入 Plan。
7. Plan、Context 和 Preflight 必须绑定 DesignSet digest。
8. Reject 关闭当前 proposal 并携带理由重提案，不终止整个迭代。
9. 已完成 1.0 历史不改写；旧开放 operation 不能越过 design 继续执行。
10. 模型供应商可以替换，Harness 的 Schema、校验、审批和权威状态不随之改变。
11. test_strategy 是 TDD 适用性、Failure Oracle、Gate 和路径策略的唯一设计来源；Planner 只能收紧。
12. Protocol 1.1 的 required Task 必须经过健康 Baseline、test-only Red、Red 后生产解锁和同源 Green。
13. 一个 Protocol 1.1 Task 只允许一种 TDD mode；required Task 只有一个 logical cycle，可覆盖共享 test patch/Gate 的多个 Assertion。
14. RedEvidence 只能由 `baseline + frozen test patch` 的隔离工作区和结构化 Oracle 匹配产生。
15. Red accepted 后测试变化、环境漂移或越权写入必须失效 Cycle；历史 Evidence 不改写。
16. Green 不替代完整 Verify、独立 Evaluation 或 Finding 的 ImpactSet/DesignSet 反馈级联。
17. TestInfrastructureTask 使用 framework_bootstrap proof，不能借“缺少测试框架”降级生产 Task。

如果代码事实迫使上述任何约束改变，必须先修订设计文档并重新获得确认。

## 2. 基线、分支与通用验证

开始代码实施前：

```bash
git status --short --branch
test "$(git branch --show-current)" = "main"
pnpm test -- packages/core/test/schema packages/graph/test/impact
pnpm test -- packages/runtime/test/planning packages/runtime/test/orchestration
pnpm test -- packages/cli/test packages/dashboard/test adapters/projection-markdown/test
pnpm typecheck
```

每个 Task 至少运行其列出的窄测试。每个纵向切片完成后运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

最终发布验证：

```bash
pnpm verify
pnpm test:release
```

真实 dsh dogfood 需要本机现有凭据和项目配置，不能替代可重复的自动测试；自动测试必须使用受控 fixture adapter，真实 dsh 结果作为额外 Evidence 留存。

## 3. 依赖顺序

```text
T1 Protocol Design + TDD Schema
 ├─→ T2 Graph Relations
 └─→ T3 Design Domain + Validator
       ├─→ T4 Input Compiler + Port
       └─→ T5 Proposal Persistence + Approval
              └─→ T6 Atomic Committer
                     └─→ T7 Orchestration Phase
                            ├─→ T8 Legacy Migration
                            └─→ T9 Plan/Context/Preflight + TDD Contract
                                  └─→ T10 Isolated Workspace + Patch
                                        └─→ T11 Phase Grants + TddController
                                              └─→ T12 Structured Gate + Evidence
                                                    └─→ T13 Cycle Record + Verdict
T9/T13 ─→ T14 Framework Bootstrap
T7/T13/T14 ─→ T15 Feedback Cascade + Invalidation
T4/T11/T12/T14 ─→ T16 CLI Config + dsh Adapters
T6/T9/T13 ─→ T17 Markdown Projection
T5/T7/T13/T15 ─→ T18 Dashboard
T1–T18 ─→ T19 E2E/Docs/Dogfood/Acceptance
```

T1–T7 是 DesignSet 最小权威闭环；T9–T14 是可证明 TDD 最小权威闭环。关键链 `T1 → T3 → T9 → T10 → T11 → T12 → T13` 必须按顺序完成。无直接依赖的 Graph、Migration、Projection 和 Dashboard 工作可以分批，但同一工作区内仍应保持小提交和完整窄测试。

## 4. Task 1：Protocol 1.1 DesignSet、TDD、Evidence 与 Event Schema

### 测试先行

修改：

- `packages/core/test/schema/protocol-version.test.ts`
- `packages/core/test/schema/persisted-records.test.ts`
- `packages/core/test/schema/operation-runtime.test.ts`
- `packages/core/test/schema/schema-export.test.ts`
- 新增 `packages/core/test/schema/design-records.test.ts`
- 新增 `packages/core/test/schema/tdd-records.test.ts`
- 新增 `packages/core/test/schema/tdd-events.test.ts`
- 新增 `packages/core/test/fixtures/protocol-1.0-designless-ledger.json`

先写失败断言：

1. 新记录默认使用 `1.1.0`，reader 仍接受 `1.0.0`。
2. Node 类型接受 DesignSet、DesignArtifact；未知类型仍失败。
3. Runtime Schema 接受严格的 `design_set_proposal`，拒绝未知字段、空 digest、非法 action 和未排序集合。
4. DesignArtifact kind 仅接受 `api_contract/data_contract/test_strategy/ui_design`。
5. 旧 1.0 fixture 可以读取，且没有任何自动补造的 DesignSet。
6. 生成的 JSON Schema 包含新 Node/Edge/Runtime 定义。
7. test_strategy profile 严格接受 required/not_applicable 的形状，拒绝未知 category、空/畸形 Oracle、非法路径/Gate ID 和未知字段；跨引用与路径冲突留给 Task 3 纯校验器。
8. Runtime Schema 接受 TaskTddContract、TddCycleRecord 和 9 个 TDD lifecycle events，拒绝未知字段和不合法 status/field 组合。
9. Evidence 继续使用统一 Node 类型，只允许注册的 `framework_result/baseline_test_result/red_test_result/green_test_result/refactor_test_result`。
10. completed Cycle 必须具有 Baseline/Red/Green/implementation bindings；blocked/invalidated 不得伪造未到达阶段的字段。
11. 1.0 历史 fixture 没有自动补造 TDD proof，兼容 reader 保持原始 digest。

### 实现

修改：

- `packages/core/src/version.ts`
- `packages/core/src/schema/node.ts`
- `packages/core/src/schema/edge.ts`
- `packages/core/src/schema/runtime.ts`
- `packages/core/src/schema/index.ts`
- `packages/core/src/schema/registry.ts`
- `packages/core/scripts/write-schemas.mjs`
- 重新生成 `packages/core/schemas/*.schema.json`
- `packages/core/src/index.ts`

新增严格 TypeBox Schema：DesignArtifact content、DesignSet content、DesignSetProposalRecord、node/edge changes、reused assets、coverage、risk summary、test_strategy TDD profile、TaskTddContract、TddCycleRecord、typed Evidence extension 和 TDD lifecycle events。事件 payload 只保存规范 ID/摘要/状态/原因，大输出通过 locator/digest 引用。旧记录只按 major version 兼容读取，不修改原始字节。

### 验证

```bash
pnpm --filter @universal-harness-internal/core schema:generate
pnpm test -- packages/core/test/schema
pnpm --filter @universal-harness-internal/core typecheck
```

提交：`feat(protocol): add DesignSet and TDD 1.1 records`

## 5. Task 2：设计关系矩阵与影响传播

### 测试先行

修改/新增：

- `packages/graph/test/integrity.test.ts`
- `packages/graph/test/impact/propagation.test.ts`
- `packages/graph/test/impact/scoring.test.ts`
- `packages/graph/test/impact/impact-set.test.ts`
- `packages/graph/test/fixtures.ts`
- `packages/graph/test/impact/fixtures.ts`
- 新增 `tests/golden/impact/designset-change.json`
- 新增 `tests/golden/impact/contract-change.json`

先写失败断言：

1. `DesignSet DERIVES_FROM ImpactSet`、`DesignSet CONTAINS design asset` 合法，错误方向失败。
2. `DesignArtifact SPECIFIES Requirement/Decision/Component/Test` 合法，其他 target 失败。
3. `Task IMPLEMENTS DesignArtifact` 合法。
4. SPECIFIES 双向传播、默认 high risk、禁止沿 proposed/inferred edge 满足 must-change。
5. CONTAINS 不参与影响传播。
6. ImpactSet 变化能通过 inverse DERIVES_FROM 定位依赖它的 DesignSet。
7. 同一图和种子稳定生成相同 explanation path、classification 和 digest。

### 实现

修改：

- `packages/graph/src/integrity.ts`
- `packages/graph/src/impact/propagation.ts`
- `packages/graph/src/impact/scoring.ts`
- `packages/graph/src/views/artifact-graph.ts`
- `packages/graph/src/index.ts`

把 DesignSet、DesignArtifact 加入 versionable/view 类型，扩展关系兼容矩阵和传播策略。CONTAINS 继续只属于结构关系，不进入影响传播；SPECIFIES 把影响传播关系从 17 个增加到 18 个。

### 验证

```bash
pnpm test -- packages/graph/test tests/golden/impact
pnpm --filter @universal-harness-internal/graph typecheck
```

提交：`feat(graph): propagate approved design contracts`

## 6. Task 3：DesignSet 规范模型、覆盖率与纯校验器

### 测试先行

新增：

- `packages/runtime/test/design/model.test.ts`
- `packages/runtime/test/design/canonical.property.test.ts`
- `packages/runtime/test/design/coverage.test.ts`
- `packages/runtime/test/design/validator.test.ts`
- 新增 `packages/runtime/test/design/test-strategy.test.ts`
- 新增 `packages/runtime/test/design/failure-oracle.test.ts`
- `packages/runtime/test/design/fixtures.ts`

先写失败断言：

1. 任意 node/edge/coverage 输入顺序产生同一 canonical content 和 digest。
2. create/revise/reuse 的 base/target revision 规则准确拒绝跳号、分叉和 drift。
3. 每个 must-change Requirement 必须有 Decision 和 test_strategy。
4. Decision 必须 SHAPES Component，或带结构化 component not_applicable reason。
5. API/data/UI 必须 covered、reused 或带非空 not_applicable reason。
6. inferred/proposed edge 不能满足 must-change 覆盖。
7. proposed extensions 中嵌套的 command/shell/tool invocation 被递归拒绝。
8. 冲突 Decision、重复 asset/edge、非法 endpoint 和超限 body 产生稳定 ValidationReport code/path。
9. round-trip 后语义与 digest 不变。
10. 每个 must-change Requirement 的 test_strategy 都有 required 或受控 not_applicable TDD policy；代码、配置、Schema、迁移、安全和缺陷修复不能 not_applicable。
11. required policy 必须绑定已注册的 baseline guards、target Gate/selectors、Failure Oracle、无冲突 path policy、存在的 framework profile digest 和 refactor policy。
12. `missing_symbol` 只有精确 symbol/error code 可用；syntax/discovery/environment/timeout/crash 不能进入 Oracle。
13. test/production 路径重叠时，缺少受信任语法感知 classifier 的策略失败；Design Agent 不能用 not_applicable 绕过。
14. project Policy 可以收紧 not_applicable registry、Oracle 和路径，不能放宽 Protocol deny。

### 实现

新增：

- `packages/runtime/src/design/model.ts`
- `packages/runtime/src/design/canonical.ts`
- `packages/runtime/src/design/coverage.ts`
- `packages/runtime/src/design/validator.ts`
- `packages/runtime/src/design/test-strategy.ts`
- `packages/runtime/src/design/failure-oracle.ts`
- `packages/runtime/src/design/errors.ts`
- `packages/runtime/src/design/index.ts`

修改：

- `packages/runtime/src/index.ts`

校验器保持纯函数：不读文件、不查网络、不调用模型、不写 Ledger。Graph snapshot、当前 revisions 和 frozen ImpactSet 通过输入参数显式传入。

### 验证

```bash
pnpm test -- packages/runtime/test/design
pnpm --filter @universal-harness-internal/runtime typecheck
```

提交：`feat(design): validate DesignSet and TDD strategies`

## 7. Task 4：DesignInputCompiler 与 DesignProposalPort

### 测试先行

新增：

- `packages/runtime/test/design/input-compiler.test.ts`
- `packages/runtime/test/design/input-compiler.property.test.ts`
- `packages/runtime/test/design/port.test.ts`
- `packages/runtime/test/design/budget.test.ts`

先写失败断言：

1. 输入 Bundle 只包含冻结 ImpactSet 命中的 Requirement/Test 和受控设计/实现邻域。
2. Bundle 绑定 baseline/impact/policy/repository digest，并对同一输入稳定。
3. 仓库内容被标记为 untrusted data，不被拼接为高优先级指令。
4. token/step/attempt 和单资产尺寸预算生效，超限返回 typed failure。
5. Port 只允许 proposed/clarification_required/failed 三类结果。
6. validation report 和 reject reason 只在重提案时进入受控 feedback 区域。
7. 测试 Port 可以在没有外部 LLM 的情况下重复返回固定 proposal。

### 实现

新增：

- `packages/runtime/src/design/input.ts`
- `packages/runtime/src/design/input-compiler.ts`
- `packages/runtime/src/design/port.ts`
- `packages/runtime/src/design/budget.ts`
- `packages/runtime/src/design/test-port.ts`

修改：

- `packages/runtime/src/context/selector.ts`
- `packages/runtime/src/index.ts`

DesignSet 和 DesignArtifact 加入 L2 knowledge layer。Port 不复用 `OrchestrationExecutor`，避免执行能力与设计提案能力混为一体。

### 验证

```bash
pnpm test -- packages/runtime/test/design packages/runtime/test/context/selector.test.ts
```

提交：`feat(design): compile governed proposal inputs`

## 8. Task 5：Proposal 持久化、审批预览与 Reject 重提案

### 测试先行

修改/新增：

- `packages/runtime/test/approval/request.test.ts`
- `packages/runtime/test/approval/invalidation.test.ts`
- `packages/runtime/test/approval/service.test.ts`
- 新增 `packages/runtime/test/design/proposal-repository.test.ts`
- 新增 `packages/runtime/test/design/approval.test.ts`
- `packages/dashboard/test/presentation.test.ts` 先增加共享中文预览 golden

先写失败断言：

1. ProposalRecord 写入 `artifacts/design-set-proposals/<id>.json`，但 materialized graph 查不到 DesignSet/DesignArtifact。
2. ApprovalRequest 绑定 proposal content、baseline、policy、impact 和 repository digest。
3. CLI/Dashboard 中文 Preview 与 JSON API 来自同一 ProposalRecord。
4. defer 保持原 proposal pending。
5. reject 必须有非空理由，关闭当前 proposal，下一轮获得新 proposal id/content digest。
6. approve 前任一绑定漂移使旧 ApprovalRequest 失效并重签。
7. 模型、actor 或 Dashboard 不能自我批准或批量批准其他 DesignSet。
8. Preview 按 Requirement 展示 TDD required/not_applicable、中文理由、Baseline/target Gates、Oracle、路径和 framework profile；JSON 与中文视图来自同一 canonical proposal。
9. 人工批准 DesignSet 不能扩大 Policy deny，也不能只批准设计资产而跳过 test_strategy TDD profile。

### 实现

新增：

- `packages/runtime/src/design/proposal-repository.ts`
- `packages/runtime/src/design/approval.ts`
- `packages/runtime/src/design/presentation.ts`

修改：

- `packages/runtime/src/approval/request.ts`
- `packages/runtime/src/approval/invalidation.ts`
- `packages/runtime/src/approval/service.ts`
- `packages/runtime/src/approval/interaction.ts`
- `packages/runtime/src/index.ts`

Design-specific reject 语义放在 `DesignApprovalCoordinator`，不改变 RequirementBaseline/ImpactSet 已有 reject 终止行为。ApprovalDecision Schema 不放宽；仅对 DesignSet reject 增加 reason 必填校验。

### 验证

```bash
pnpm test -- packages/runtime/test/approval packages/runtime/test/design/approval.test.ts packages/runtime/test/design/proposal-repository.test.ts
```

提交：`feat(design): govern DesignSet approvals`

## 9. Task 6：DesignCommitter 原子提交与演化链

### 测试先行

新增：

- `packages/runtime/test/design/committer.test.ts`
- `packages/runtime/test/design/committer.property.test.ts`
- `tests/fault/designset-atomic-commit.test.ts`
- `tests/fault/designset-binding-drift.test.ts`

先写失败断言：

1. approve 后一次 Ledger Operation 写入 accepted DesignSet、资产 revisions、语义边、DERIVES_FROM、CONTAINS 和 checkpoint payload。
2. commit 前可以预测并复验全部目标 digest。
3. 任一 base revision/baseline/impact/policy/repository drift 时零设计节点落地。
4. 注入事务中断时不存在部分资产或部分关系。
5. 同一 proposal 幂等重试不重复写节点、边或 ApprovalDecision。
6. 同一 iteration 使用稳定 DesignSet id 和连续 revision。
7. 新 iteration 使用新 id，并 SUPERSEDES 上一个项目有效 DesignSet。
8. 被复用资产可以被多个 DesignSet CONTAINS，但自身 revision/digest 不改变。

### 实现

新增：

- `packages/runtime/src/design/records.ts`
- `packages/runtime/src/design/committer.ts`
- `packages/runtime/src/design/identity.ts`

修改：

- `packages/runtime/src/workflow/checkpoint.ts`
- `packages/runtime/src/index.ts`

DesignCommitter 是唯一能把已批准 proposal 物化为设计事实的模块。结构边由 committer 生成；Design Agent 不得提供 DERIVES_FROM、CONTAINS 或 IMPLEMENTS。

### 验证

```bash
pnpm test -- packages/runtime/test/design/committer.test.ts packages/runtime/test/design/committer.property.test.ts tests/fault/designset-atomic-commit.test.ts tests/fault/designset-binding-drift.test.ts
```

提交：`feat(design): commit approved design graphs atomically`

## 10. Task 7：Orchestrator design 相位与恢复状态机

### 测试先行

修改/新增：

- `packages/runtime/test/orchestration/phases.test.ts`
- `packages/runtime/test/orchestration/orchestrator.test.ts`
- 新增 `packages/runtime/test/orchestration/lifecycle-events.test.ts`
- 新增 `packages/runtime/test/orchestration/design-phase.test.ts`
- `tests/fault/expired-approval.test.ts`
- `tests/fault/approval-cascade-invalidation.test.ts`

先写失败断言：

1. phase 顺序在 impact 与 plan 之间包含 design。
2. frozen ImpactSet 后调用 DesignInputCompiler/DesignProposalPort，而不是直接进入 plan。
3. valid proposal 暂停在 DesignSet ApprovalRequest；approve 后原子提交并进入 plan。
4. invalid proposal 在 phase budget 内重提案，耗尽后形成可恢复 blocker。
5. clarification_required 返回 input_required，恢复后重新编译输入。
6. defer/resume 不重复调用模型；绑定漂移时才重新提案。
7. reject reason 被带入下一轮 proposal，operation 不终止。
8. design checkpoint 只在权威提交后推进。
9. resume 不重复已提交 DesignSet revision 或 phase lifecycle event。

### 实现

修改：

- `packages/runtime/src/orchestration/phases.ts`
- `packages/runtime/src/orchestration/lifecycle-events.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/workflow/resume.ts`
- `packages/runtime/src/workflow/checkpoint.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/index.ts`

优先把 `phaseDesign` 放在独立 `packages/runtime/src/orchestration/design-phase.ts`，orchestrator 只负责依赖注入和 phase dispatch，避免继续扩大单文件职责。

### 验证

```bash
pnpm test -- packages/runtime/test/orchestration packages/runtime/test/workflow tests/fault/expired-approval.test.ts tests/fault/approval-cascade-invalidation.test.ts
```

提交：`feat(orchestration): add governed design phase`

## 11. Task 8：Protocol 1.0 开放迭代迁移

### 测试先行

修改/新增：

- `packages/runtime/test/compatibility/open-iteration-migration.test.ts`
- 新增 `packages/runtime/test/compatibility/design-phase-migration.test.ts`
- 新增 `tests/e2e/protocol-1.0-design-migration.test.ts`

使用真实 1.0 fixture，先写失败断言：

1. completed Snapshot 保持原字节和 digest，不补 DesignSet。
2. capture/impact 开放 checkpoint 在有效 frozen ImpactSet 后路由 design。
3. plan/context/execute 开放 checkpoint 追加 migration blocker，使旧 Plan/Run 授权失效，并回到 impact/design。
4. 缺失或 drifted ImpactSet 不猜测，阻塞并输出明确恢复动作。
5. 迁移重复执行幂等，不重复 blocker/invalidated event。
6. completed 1.0 Verdict/Projection 标记“历史记录，无 DesignSet/TDD 证明”，不生成伪 Red/Green。
7. 开放 1.0 operation 的新 Plan 必须按 accepted test_strategy 编译 TaskTddContract；旧 Run 不能被当作已有 Red/Green。

### 实现

修改：

- `packages/runtime/src/compatibility/open-iteration.ts`
- `packages/runtime/src/workflow/resume.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`

新增 design-specific migration reason/error code。迁移只追加新记录，不改写 1.0 artifact。

### 验证

```bash
pnpm test -- packages/runtime/test/compatibility tests/e2e/protocol-1.0-design-migration.test.ts
```

提交：`feat(migration): require design for open legacy iterations`

## 12. Task 9：Plan、Context、Preflight 与 TaskTddContract

### 测试先行

修改/新增：

- `packages/runtime/test/planning/execution-plan.test.ts`
- `packages/runtime/test/planning/validator.test.ts`
- `packages/runtime/test/planning/impact-coverage.test.ts`
- `packages/runtime/test/context/compiler.test.ts`
- `packages/runtime/test/context/task-bundles.test.ts`
- `packages/runtime/test/orchestration/execution-binding.test.ts`
- 新增 `packages/runtime/test/planning/design-coverage.test.ts`
- 新增 `packages/runtime/test/planning/tdd-contract.test.ts`
- 新增 `packages/runtime/test/planning/tdd-coverage.property.test.ts`
- 新增 `packages/runtime/test/orchestration/tdd-preflight.test.ts`

先写失败断言：

1. 没有 accepted DesignSet 时 `generateExecutionPlan` 失败。
2. Plan shared context 同时绑定 RequirementBaseline、ImpactSet、DesignSet、Policy digest。
3. Planner 输入包含 Decision/Component/DesignArtifact/coverage 摘要。
4. Task IMPLEMENTS Requirement、Decision 和适用 DesignArtifact。
5. ContextBundle 绑定 design_set_digest，并选择 L2 设计邻域。
6. reuse DesignSet 的引用资产也进入 ContextBundle manifest。
7. Plan/Context/Run 前任一 DesignSet 或资产 revision drift 阻止 executor 调用。
8. ImpactCoverage 将 architecture/design coverage 纳入 complete 条件。
9. required test_strategy 编译为 TaskTddContract；Plan digest 覆盖 strategy、Contract 和 Assertion Cluster。
10. Planner 只能缩小 selector、path、Oracle 和 budget，任何 required → not_applicable 或能力扩大都失败。
11. 一个 required Task 恰好一个 logical cycle，可覆盖共享 test patch/target Gate 的多个 Assertion；不同 patch/Gate 或不同 mode 必须拆 Task。
12. 每个 required Assertion 恰好属于一个当前 Cluster；遗漏和重复覆盖都失败。
13. not_applicable Task 绑定批准的 category/reason；framework_bootstrap Task 不含 production Requirement 或 production path。
14. 缺少 framework profile 时 Planner 插入 TestInfrastructureTask DAG 依赖，生产 Task 保持阻塞。
15. Preflight 验证 Adapter isolation、patch canonicalization、structured Gate 和当前 TDD checkpoint 能力，不支持 strict TDD 时 fail closed。

### 实现

修改：

- `packages/runtime/src/planning/execution-plan.ts`
- `packages/runtime/src/planning/validator.ts`
- `packages/runtime/src/planning/impact-coverage.ts`
- `packages/runtime/src/planning/task.ts`
- 新增 `packages/runtime/src/planning/tdd-contract.ts`
- 新增 `packages/runtime/src/planning/tdd-coverage.ts`
- `packages/runtime/src/context/compiler.ts`
- `packages/runtime/src/context/selector.ts`
- `packages/runtime/src/context/task-bundles.ts`
- `packages/runtime/src/orchestration/execution-binding.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/workflow/resume.ts`

不要使用 legacy inferred design authorization。1.1 Run 只能消费真实 accepted DesignSet。TaskTddContract 使用 discriminated mode 和 canonical digest；Plan validator 而不是 Agent prompt 负责唯一覆盖、不可降级和 DAG 约束。

### 验证

```bash
pnpm test -- packages/runtime/test/planning packages/runtime/test/context packages/runtime/test/orchestration/execution-binding.test.ts
```

提交：`feat(planning): compile governed TDD contracts`

## 13. Task 10：隔离工作区、规范 Patch 与写集合证明

### 测试先行

新增：

- `packages/runtime/test/tdd/patch.test.ts`
- `packages/runtime/test/tdd/patch.property.test.ts`
- `packages/runtime/test/tdd/workspace.test.ts`
- `packages/runtime/test/tdd/workspace-resume.test.ts`
- `tests/fault/tdd-unauthorized-write.test.ts`
- `tests/fault/tdd-workspace-interruption.test.ts`

先写失败断言：

1. Baseline workspace 精确绑定 repository baseline，未应用 test 或 production patch。
2. Test Authoring workspace 只接受 test/test-config diff；production/immutable path 使 patch 拒绝并返回稳定 reason/path。
3. 规范化 patch 不受文件遍历顺序、临时时间戳、绝对路径和换行差异影响，digest 稳定。
4. Red workspace 必须由 clean baseline + accepted frozen test patch 重建，不能继承 Test Authoring 的瞬态生产变更。
5. Implementation workspace 从同一 baseline + frozen test patch 创建，test/test-config path 标记只读。
6. 共置测试缺少受信任 syntax-aware classifier 时 preflight fail closed；classifier 只能批准测试区域 hunk。
7. 任一工作区中断不污染主工作树，resume 只在 baseline/patch/worktree digest 完全匹配时继续。
8. cleanup 使用受控临时目录或隔离 worktree，不执行针对仓库根、`$HOME` 或未知路径的破坏性 Git 操作。

### 实现

新增：

- `packages/runtime/src/tdd/patch.ts`
- `packages/runtime/src/tdd/patch-manifest.ts`
- `packages/runtime/src/tdd/workspace.ts`
- `packages/runtime/src/tdd/workspace-provider.ts`
- `packages/runtime/src/tdd/structural-classifier.ts`
- `packages/runtime/src/tdd/errors.ts`
- `packages/runtime/src/tdd/index.ts`

修改：

- `packages/runtime/src/policy/path-boundary.ts`
- `packages/runtime/src/policy/execution-preflight.ts`
- `packages/plugin-sdk/src/agent.ts`
- `packages/runtime/src/index.ts`

WorkspaceProvider 暴露 create/inspect/extract/apply/discard，不把 shell/git 命令泄露给 Agent。即使 Adapter 只能在任务结束后报告 diff，Red 也必须在 Harness 新建的 clean verification workspace 中运行，从而机械证明被验证状态只包含 baseline + accepted test patch。

### 验证

```bash
pnpm test -- packages/runtime/test/tdd/patch.test.ts packages/runtime/test/tdd/patch.property.test.ts packages/runtime/test/tdd/workspace.test.ts packages/runtime/test/tdd/workspace-resume.test.ts tests/fault/tdd-unauthorized-write.test.ts tests/fault/tdd-workspace-interruption.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
```

提交：`feat(tdd): isolate test and implementation workspaces`

## 14. Task 11：Phase Grant、TddController 与恢复状态机

### 测试先行

新增/修改：

- 新增 `packages/runtime/test/tdd/controller.test.ts`
- 新增 `packages/runtime/test/tdd/controller.property.test.ts`
- 新增 `packages/runtime/test/tdd/checkpoint.test.ts`
- 新增 `packages/runtime/test/tdd/budget.test.ts`
- `packages/runtime/test/policy/capability-grant.test.ts`
- `packages/runtime/test/policy/capability-grant-record.test.ts`
- `packages/runtime/test/workflow/resume.test.ts`
- `packages/runtime/test/orchestration/orchestrator.test.ts`
- `packages/runtime/test/loop/task-envelope.test.ts`

先写失败断言：

1. 状态顺序固定为 contract_ready → baseline_guard → test_authoring → red_verification → implementation → green_verification → optional refactor → completed。
2. 每个状态撤销旧 Grant 并重新签发独立 Grant；不能在原 Grant 上直接扩权。
3. `TddRedAccepted` 之前无法签发 production write path，Agent transcript 或 exit code 不能解锁。
4. Test Authoring 只写 test/test-config；Implementation/Refactor 只写批准 production path 且 frozen test patch 只读。
5. Green 失败在 implementation budget 内重试，不生成新的 Red；测试变化使当前 attempt invalidated 并回到 test_authoring。
6. planned refactor 使用更窄 Grant；失败丢弃隔离 patch并保留 Green checkpoint。
7. 每个 lifecycle event、checkpoint 和 Grant 在 resume/replay 下幂等，不重复解锁或扣减预算。
8. baseline/Gate/framework/environment/Contract drift 撤销 Grant，并回到最早受影响状态。
9. tokens/steps unavailable 时仍强制 duration/run budget，并把 unavailable 明确记入 telemetry；不能当作零消耗。
10. 不同 Task 按 DAG 并行时，各自 Cycle/Grant/workspace 不串扰；单 Task 只有一个 logical cycle。

### 实现

新增：

- `packages/runtime/src/tdd/state.ts`
- `packages/runtime/src/tdd/controller.ts`
- `packages/runtime/src/tdd/checkpoint.ts`
- `packages/runtime/src/tdd/budget.ts`
- `packages/runtime/src/tdd/grant.ts`

修改：

- `packages/runtime/src/policy/capability-grant.ts`
- `packages/runtime/src/policy/execution-authorization.ts`
- `packages/runtime/src/loop/task-envelope.ts`
- `packages/runtime/src/loop/controller.ts`
- `packages/runtime/src/orchestration/lifecycle-events.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/workflow/checkpoint.ts`
- `packages/runtime/src/workflow/resume.ts`
- `packages/runtime/src/status/status.ts`

TddController 只消费 accepted TaskTddContract 和 Ledger Evidence，不解析自然语言完成声明。Orchestrator 负责 Task DAG dispatch，Controller 负责单 Task 内部状态；两者通过 typed result 协作，避免把 TDD 分支继续堆入 orchestrator 大函数。

### 验证

```bash
pnpm test -- packages/runtime/test/tdd/controller.test.ts packages/runtime/test/tdd/controller.property.test.ts packages/runtime/test/tdd/checkpoint.test.ts packages/runtime/test/tdd/budget.test.ts packages/runtime/test/policy packages/runtime/test/workflow/resume.test.ts packages/runtime/test/loop/task-envelope.test.ts
```

提交：`feat(tdd): govern red green phase transitions`

## 15. Task 12：结构化 Gate、Failure Oracle 与 Typed Evidence

### 测试先行

新增/修改：

- 新增 `packages/runtime/test/tdd/failure-classifier.test.ts`
- 新增 `packages/runtime/test/tdd/oracle-matcher.test.ts`
- 新增 `packages/runtime/test/tdd/evidence-binding.test.ts`
- `packages/runtime/test/gates/provider.test.ts`
- `packages/runtime/test/gates/runner.test.ts`
- `packages/runtime/test/gates/evidence.test.ts`
- `packages/runtime/test/gates/freshness.test.ts`
- `packages/conformance/test/gate-providers.conformance.test.ts`
- 新增 `tests/fault/tdd-evidence-forgery.test.ts`

先写失败断言：

1. Gate Provider 输出稳定 selector、assertion、result、failure_kind、error code/symbol 和原始报告 digest。
2. assertion_failure、contract_mismatch、expected_exception_not_thrown 可按 Oracle 匹配；missing_symbol 只有精确预声明且绑定目标 selector 才可用。
3. 通用 syntax/compile、discovery、dependency/environment、timeout、crash、无目标结果和模糊 nonzero 永远不能形成 accepted RedEvidence；仅允许预声明并绑定目标 selector 的精确 missing_symbol 或稳定 contract_mismatch 例外。
4. 新测试 baseline 使用批准的 component guard Gates，并记录目标测试不存在；“no tests found”不能当作 Red。
5. RedEvidence 绑定 baseline、frozen test patch、target Gate、framework、environment、Grant 和 observed write set。
6. GreenEvidence 必须引用同一 logical cycle/current Red，且 test patch/Gate/framework/environment 完全一致。
7. project source/lockfile 变化进入 production revision；不能伪装为 executor environment drift。
8. Agent 直接提交 accepted Evidence、篡改报告或只提供 stdout/exit code 时被拒绝。
9. output 大小、嵌套和附件受限；完整报告以 artifact digest/locator 留存，Evidence 只保留规范摘要。

### 实现

新增：

- `packages/runtime/src/tdd/failure-classifier.ts`
- `packages/runtime/src/tdd/oracle-matcher.ts`
- `packages/runtime/src/tdd/evidence-binding.ts`
- `packages/runtime/src/tdd/evidence-validator.ts`

修改：

- `packages/plugin-sdk/src/gate.ts`
- `packages/runtime/src/gates/provider.ts`
- `packages/runtime/src/gates/runner.ts`
- `packages/runtime/src/gates/evidence.ts`
- `packages/runtime/src/gates/freshness.ts`
- `packages/runtime/src/index.ts`

Provider 只报告结构化运行事实；Evidence Validator 根据 Contract、workspace manifest 和 Gate 结果计算 accepted/rejected。Failure Oracle 使用枚举、稳定 code/symbol 和受限 pattern，不执行任意 regex 或测试输出中的指令。

### 验证

```bash
pnpm test -- packages/runtime/test/tdd/failure-classifier.test.ts packages/runtime/test/tdd/oracle-matcher.test.ts packages/runtime/test/tdd/evidence-binding.test.ts packages/runtime/test/gates packages/conformance/test/gate-providers.conformance.test.ts tests/fault/tdd-evidence-forgery.test.ts
```

提交：`feat(tdd): validate structured red green evidence`

## 16. Task 13：TddCycleRecord、唯一配对与 TaskVerdict

### 测试先行

新增/修改：

- 新增 `packages/runtime/test/tdd/cycle-record.test.ts`
- 新增 `packages/runtime/test/tdd/cycle-record.property.test.ts`
- 新增 `packages/runtime/test/tdd/cycle-repository.test.ts`
- 新增 `packages/runtime/test/tdd/invalidation.test.ts`
- `packages/runtime/test/evaluation/task-verdict.test.ts`
- `packages/runtime/test/evaluation-backfill.test.ts`
- `packages/runtime/test/snapshot/builder.test.ts`

先写失败断言：

1. 每个 attempt 写入不可变 Record；completed 必须有 Baseline/Red/Green/implementation，blocked/invalidated 只含到达阶段和 reason。
2. Record digest 对同一规范内容稳定，旧 Record 不因后续 invalidation 原地变化。
3. TddCycleInvalidated 追加后，materialized current view 不再选择旧 completed attempt。
4. 每个 required Assertion 必须恰好找到一个当前有效 completed logical cycle；缺失、重复、过期或 binding drift 都失败。
5. planned refactor 缺少 RefactorEvidence 时 Verdict 失败；not_planned 不伪造 refactor proof。
6. controlled not_applicable、framework_proven、historical_without_tdd_proof 和 tdd_incomplete_or_invalid 使用不同 Verdict code/中文描述。
7. TDD proven 仍不能覆盖 required Gate/Evaluation 失败。
8. Protocol 1.0 Verdict/backfill 保持旧字节和语义，不追溯生成 Cycle。

### 实现

新增：

- `packages/runtime/src/tdd/cycle-record.ts`
- `packages/runtime/src/tdd/cycle-repository.ts`
- `packages/runtime/src/tdd/current-cycle-view.ts`
- `packages/runtime/src/tdd/invalidation.ts`

修改：

- `packages/runtime/src/evaluation/task-verdict.ts`
- `packages/runtime/src/evaluation/outcome-projection.ts`
- `packages/runtime/src/evaluation/backfill.ts`
- `packages/runtime/src/snapshot/builder.ts`
- `packages/runtime/src/index.ts`

活动状态从 append-only events/checkpoint 重建；终止 attempt 才写 TddCycleRecord。TaskVerdict 只消费 accepted Evidence、Record 和 Evaluation，不读取 Live Spool 或 transcript。

### 验证

```bash
pnpm test -- packages/runtime/test/tdd/cycle-record.test.ts packages/runtime/test/tdd/cycle-record.property.test.ts packages/runtime/test/tdd/cycle-repository.test.ts packages/runtime/test/tdd/invalidation.test.ts packages/runtime/test/evaluation/task-verdict.test.ts packages/runtime/test/evaluation-backfill.test.ts packages/runtime/test/snapshot/builder.test.ts
```

提交：`feat(evaluation): require paired TDD cycle evidence`

## 17. Task 14：TestInfrastructureTask 与 FrameworkEvidence

### 测试先行

新增/修改：

- 新增 `packages/runtime/test/tdd/framework-bootstrap.test.ts`
- 新增 `packages/runtime/test/tdd/framework-evidence.test.ts`
- `packages/runtime/test/planning/tdd-contract.test.ts`
- `packages/runtime/test/planning/validator.test.ts`
- 新增 `tests/integration/tdd-framework-bootstrap.test.ts`
- 新增 `tests/fixtures/tdd/no-test-framework/`

先写失败断言：

1. 缺少 structured Gate/framework profile 时 Planner 插入 mode=framework_bootstrap 的 TestInfrastructureTask。
2. Bootstrap 只能写 test framework/config/fixture path，不能获得 production path 或实现 production Requirement。
3. FrameworkEvidence 同时证明 discovery、隔离 pass fixture 和隔离 fail fixture 的结构化 failure kind。
4. 受控 fail fixture 不留在项目默认测试套件，也不能让完整 Gate 永久失败。
5. Bootstrap 不递归要求普通 Red/Green Cycle，也不能被标记 not_applicable。
6. production Task 在 FrameworkEvidence accepted 前阻塞；profile/config digest 漂移后重新阻塞。
7. TestInfrastructureTask Verdict 明确为 framework_proven，不伪装 tdd_proven。

### 实现

新增：

- `packages/runtime/src/tdd/framework-bootstrap.ts`
- `packages/runtime/src/tdd/framework-evidence.ts`

修改：

- `packages/runtime/src/planning/tdd-contract.ts`
- `packages/runtime/src/planning/validator.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/evaluation/task-verdict.ts`
- `packages/runtime/src/status/status.ts`

Bootstrap fixture 在隔离 workspace 中运行；accepted project patch 只包含框架/config 和不会破坏默认 suite 的通过样例或结构化测试资产。

### 验证

```bash
pnpm test -- packages/runtime/test/tdd/framework-bootstrap.test.ts packages/runtime/test/tdd/framework-evidence.test.ts packages/runtime/test/planning/tdd-contract.test.ts packages/runtime/test/planning/validator.test.ts tests/integration/tdd-framework-bootstrap.test.ts
```

提交：`feat(tdd): bootstrap verifiable test frameworks`

## 18. Task 15：Finding 级联、TDD 失效、Design revision 与 Audit 语义

### 测试先行

修改/新增：

- `tests/integration/feedback-cascade.test.ts`
- `packages/runtime/test/audit/auditor.test.ts`
- 新增 `packages/runtime/test/finding/governance.test.ts`
- 新增 `packages/runtime/test/design/feedback-router.test.ts`
- 新增 `packages/runtime/test/tdd/feedback-invalidation.test.ts`
- 新增 `tests/fault/designset-finding-invalidation.test.ts`
- 新增 `tests/fault/tdd-finding-invalidation.test.ts`

先写失败断言：

1. Finding → Change Seed → new ImpactSet → new DesignSet revision → new Plan。
2. 设计确实改变时，新 revision/SUPERSEDES 链可查询，旧 digest 不变。
3. 设计无需改变时也生成绑定新 ImpactSet 的 reuse DesignSet。
4. 旧 Plan/Context/未启动 Run 授权失效，历史 completed Snapshot 不变。
5. Protocol 1.1 的设计缺口在 design phase 阻塞，不再等到 snapshot 才 warning。
6. Protocol 1.0 历史 `missing_design_artifact` 保持 warning，避免追溯阻塞。
7. ImprovementCandidate 针对 Decision/Component/DesignArtifact 时走同一反馈链。
8. Verify/Evaluate Finding 一律成为 Change Seed；即使设计不变也生成 reuse DesignSet 和新 Plan/Contract。
9. DesignSet/Plan/Oracle/Gate/path 漂移撤销 Phase Grant，并追加 TddCycleInvalidated；旧 Evidence/Record 字节不变。
10. Green 验证阶段的局部失败在当前 implementation budget 内修复，不提前创建新 Finding 或伪造第二个 Red。
11. Dashboard/Audit 可以从规范 reason 定位 earliest affected phase、logical cycle 和失效 Evidence。

### 实现

新增：

- `packages/runtime/src/design/feedback-router.ts`

修改：

- `packages/runtime/src/audit/auditor.ts`
- `packages/runtime/src/finding/governance.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/tdd/invalidation.ts`
- `packages/graph/src/impact/seeds.ts`

所有失效均追加事件/新 revision，不删除旧 Artifact、Evidence 或 Cycle Record。Dashboard 所需的 reason、earliest affected phase、logical cycle 和 evidence digests 由 router 输出规范字段。

### 验证

```bash
pnpm test -- packages/runtime/test/design/feedback-router.test.ts packages/runtime/test/tdd/feedback-invalidation.test.ts packages/runtime/test/audit packages/runtime/test/finding tests/integration/feedback-cascade.test.ts tests/fault/designset-finding-invalidation.test.ts tests/fault/tdd-finding-invalidation.test.ts
```

提交：`feat(feedback): cascade findings through design and TDD`

## 19. Task 16：项目配置与 dsh DesignProposalPort/TDD Adapter

### 测试先行

修改/新增：

- `packages/cli/test/project-runtime-config.test.ts`
- 新增 `packages/cli/test/runtime-service.test.ts`
- 新增 `packages/cli/test/doctor.test.ts`
- `adapters/agent-dsh/test/prompt.test.ts`
- `adapters/agent-dsh/test/adapter.test.ts`
- 新增 `adapters/agent-dsh/test/design-adapter.test.ts`
- 新增 `adapters/agent-dsh/test/tdd-prompt.test.ts`
- 新增 `adapters/agent-dsh/test/tdd-adapter.test.ts`
- 新增 `adapters/agent-dsh/test/tdd-phased-runs.test.ts`
- 新增 `adapters/agent-dsh/test/fixtures/design-proposal.mjs`
- 新增 `adapters/agent-dsh/test/fixtures/tdd-agent.mjs`
- 新增 `packages/conformance/test/design-adapters.conformance.test.ts`
- 新增 `packages/conformance/test/tdd-agent-adapters.conformance.test.ts`

先写失败断言：

1. runtime config v3 接受独立 `designer`，旧 v1/v2 仍可读。
2. designer 配置没有 proposed_write_paths，出现写路径字段直接失败。
3. resolution 顺序固定：测试注入 Port → explicit designer config → compatible dsh agent 的只读派生配置 → typed designer_required。
4. dsh prompt 清楚区分不可信上下文、输出 JSON Schema、禁止项目/Ledger 写入。
5. adapter 拒绝 malformed/stdout flood/timeout/contract mismatch/任何工作区变更。
6. adapter 输出 usage、steps、duration、stdout tail Evidence，不把 provider metadata 放进 DesignSet content digest。
7. `harness doctor` 报告 designer 配置、版本、模型契约和只读范围。
8. Agent Adapter 明确声明 isolation、structured Gate、phase envelope 和 write-set capabilities；缺失能力不能运行 strict TDD。
9. dsh 按 Controller 指令分别执行 test-authoring、implementation 和可选 refactor Run，不在一个 prompt/envelope 中混合测试与生产写权限。
10. test-authoring prompt 只包含测试任务、Oracle 和 test paths；implementation prompt 只包含 frozen test manifest、生产目标和 production paths。
11. Adapter 不能自行宣称 Red/Green accepted 或请求扩大 Grant；所有结果由 Harness workspace/Gate/Evidence validator 复验。
12. heartbeat、tokens、steps、duration、stdout tail 和 terminated reason 在每个 phase Run 可观测；unavailable 使用明确状态而不是 0。
13. fixture Adapter 能稳定模拟 valid Red/Green、invalid Red、越权写入、timeout、crash 和 resume，无外部模型也可重复测试。

### 实现

修改/新增：

- `packages/cli/src/project-runtime-config.ts`
- `packages/cli/src/project-agent.ts`
- `packages/cli/src/runtime-service.ts`
- `packages/cli/src/commands/doctor.ts`
- 新增 `packages/cli/src/project-designer.ts`
- 新增 `adapters/agent-dsh/src/design-prompt.ts`
- 新增 `adapters/agent-dsh/src/design-adapter.ts`
- 新增 `adapters/agent-dsh/src/tdd-prompt.ts`
- 新增 `adapters/agent-dsh/src/tdd-adapter.ts`
- 新增 `adapters/agent-dsh/src/capabilities.ts`
- `adapters/agent-dsh/src/index.ts`
- `packages/plugin-sdk/src/agent.ts` 或新增 `packages/plugin-sdk/src/design.ts`
- `packages/plugin-sdk/src/index.ts`

优先复用现有受管 dsh process/telemetry 基础，但 Design adapter 必须构造独立只读 envelope，不复用带写权限的 AgentTaskEnvelope。TDD adapter 只执行 TddController 签发的 phase envelope；它不拥有状态机、Oracle 判定或 Evidence 接受权。未来其他 LLM adapter 分别实现相同 DesignProposalPort 和 phased Agent contract。

### 验证

```bash
pnpm test -- packages/cli/test/project-runtime-config.test.ts packages/cli/test/runtime-service.test.ts packages/cli/test/doctor.test.ts adapters/agent-dsh/test packages/conformance/test/design-adapters.conformance.test.ts packages/conformance/test/tdd-agent-adapters.conformance.test.ts
```

提交：`feat(adapter): add governed dsh design and TDD runs`

## 20. Task 17：Architecture、Specification、Plan、TDD 与 Snapshot 投影

### 测试先行

修改/新增：

- `adapters/projection-markdown/test/projections.test.ts`
- `tests/golden/projections/architecture.md`
- `tests/golden/projections/spec.md`
- `tests/golden/projections/plan.md`
- `tests/golden/projections/prd.md`
- `tests/golden/projections/snapshot.md`
- `packages/conformance/test/projection.conformance.test.ts`
- `packages/runtime/test/projection/projection.test.ts`

先写失败断言：

1. Architecture 展示 DesignSet revision、Decision、Component、API/data/UI assets 和关系。
2. Specification 展示 Requirement、Constraint、Test、contracts 和 test strategy。
3. Plan 展示 design_set_id/digest 以及 Task 实施的设计资产。
4. PRD 链接 Requirement → Decision → DesignSet。
5. Snapshot 记录 DesignSet 和设计 Approval Evidence。
6. 1.0 历史投影显示明确兼容提示，不伪造设计内容。
7. Projection source digest 漂移时从权威图重建。
8. Specification 展示每个 Requirement 的 TDD 适用性、Oracle、Gate 和测试策略中文说明。
9. Plan 展示 TaskTddContract mode、Assertion Cluster、phase budgets 和 required Evidence，不暴露 secret 或超长输出。
10. Snapshot 区分 tdd_proven、controlled_not_applicable、framework_proven、historical_without_tdd_proof 和 invalid/incomplete。
11. Red/Green/Refactor 摘要来自 accepted Evidence/TddCycleRecord；Live transcript 不能进入权威投影。

### 实现

修改：

- `adapters/projection-markdown/src/architecture.ts`
- `adapters/projection-markdown/src/spec.ts`
- `adapters/projection-markdown/src/plan.ts`
- `adapters/projection-markdown/src/prd.ts`
- `adapters/projection-markdown/src/snapshot.ts`
- `adapters/projection-markdown/src/index.ts`
- `packages/runtime/src/projection/managed-output.ts`
- `packages/runtime/src/projection/drift.ts`
- `packages/runtime/src/snapshot/commit-projection.ts`

投影只读 accepted graph；Proposal 只能出现在审批 Preview，不进入正式 Architecture/Specification。

### 验证

```bash
pnpm test -- adapters/projection-markdown/test packages/conformance/test/projection.conformance.test.ts packages/runtime/test/projection
```

提交：`feat(projection): render design and TDD evidence`

## 21. Task 18：Dashboard Design/TDD 视图与全视图业务语义

### 测试先行

修改/新增：

- 新增 `packages/dashboard/test/read-api.test.ts`
- `packages/dashboard/test/presentation.test.ts`
- `packages/dashboard/test/server.test.ts`
- `packages/dashboard/test/write-api.test.ts`
- `packages/dashboard/test/sse.test.ts`
- `packages/dashboard/test/assets.test.ts`
- `tests/e2e/dashboard-readonly.test.ts`
- `tests/e2e/dashboard-live-approval.test.ts`
- `tests/security/dashboard-security.test.ts`
- `tests/performance/m2-dashboard.test.ts`

先写失败断言：

1. Read API 从 Ledger 重建 current/history DesignSet、coverage、asset changes 和 evolution links。
2. 新 Design 视图显示中文业务描述、digest、风险、适用性和 relation path。
3. Overview/Graph/Impact/Iterations/Evidence/Findings/Live/Approvals 统一识别 design phase 和设计节点。
4. DesignSet Approval 卡片显示同源 Preview，reject 必填 reason。
5. Live 显示 DesignProposalPort progress、stdout tail、usage/steps unavailable 的明确回退。
6. 历史 1.0 Designless 状态有明确提示。
7. session、Origin、CSRF、actor、expected digest 和 409 conflict 保护保持有效。
8. 大图/多 revision 查询保持既有性能门槛。
9. Iterations/Task 以 Baseline → Test Authoring → Red → Implementation → Green → Refactor 时间线展示 Ledger 重建状态。
10. Evidence/Verdict 显示 Requirement/Assertion/test selector、Oracle 匹配、Gate、revision 和配对结论；digest 为可展开审计字段。
11. 当前 Phase Grant、预算、阻塞原因、Finding 和恢复入口有中文业务描述，不只显示 unavailable/digest。
12. Live 显示 phase heartbeat、tokens/steps/duration 和 stdout tail，但删除 Live Spool 后 TDD 时间线与 Verdict 仍完整。
13. controlled_not_applicable、framework_proven、historical_without_tdd_proof 和 invalid/incomplete 使用不同状态与解释。
14. Dashboard 不能直接解锁 implementation、接受 Evidence 或修改 Cycle；写 API 只暴露已有受治理的 approval/recovery action。

### 实现

修改：

- `packages/dashboard/src/read-api.ts`
- `packages/dashboard/src/presentation.ts`
- `packages/dashboard/src/router.ts`
- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/write-api.ts`
- `packages/dashboard/src/sse.ts`
- `packages/dashboard/assets/dashboard.html`
- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/assets/dashboard.css`

Design/TDD 视图读取权威 Ledger、物化图、typed Evidence 和 TddCycleRecord，不依赖 Live 事件是否被浏览器错过。Live 仍是可删除观测层，不参与 DesignSet/TDD 成败或 Grant 解锁。

### 验证

```bash
pnpm test -- packages/dashboard/test tests/e2e/dashboard-readonly.test.ts tests/e2e/dashboard-live-approval.test.ts tests/security/dashboard-security.test.ts tests/performance/m2-dashboard.test.ts
pnpm test:e2e:dashboard
```

提交：`feat(dashboard): visualize design and TDD cycles`

## 22. Task 19：全链路 E2E、文档、Dogfood 与验收报告

### 测试先行

修改/新增：

- `tests/e2e/complete-loop.assertions.ts`
- `tests/e2e/generic-new.test.ts`
- `tests/e2e/generic-adopt.test.ts`
- `tests/e2e/generic-iterate.test.ts`
- `tests/e2e/generic-resume.test.ts`
- `tests/e2e/node-new.test.ts`
- `tests/e2e/python-adopt.test.ts`
- `tests/e2e/java-iterate.test.ts`
- `tests/e2e/delegated-agent-vertical-loop.test.ts`
- `tests/e2e/m2-vertical-loop.test.ts`
- 新增 `tests/e2e/designset-reuse-loop.test.ts`
- 新增 `tests/e2e/designset-reject-reproposal.test.ts`
- 新增 `tests/e2e/tdd-strict-loop.test.ts`
- 新增 `tests/e2e/tdd-not-applicable.test.ts`
- 新增 `tests/e2e/tdd-framework-bootstrap.test.ts`
- 新增 `tests/e2e/tdd-invalidation-resume.test.ts`
- 新增 `tests/e2e/tdd-finding-cascade.test.ts`
- `tests/e2e/documentation-examples.test.ts`

先让共享纵向断言因缺少以下证据失败：

1. DesignSetProposalRecord；
2. DesignSet ApprovalRequest/Decision；
3. accepted DesignSet 和设计资产/关系边；
4. ExecutionPlan design_set binding；
5. ContextBundle design_set binding；
6. Gate/Evaluation/Snapshot 的设计证据链；
7. reuse 和 reject/reproposal 分支；
8. Finding 触发的新 DesignSet revision。
9. accepted test_strategy、TaskTddContract 和唯一 Assertion Cluster；
10. healthy Baseline、test-only Red、TddRedAccepted 后的 Implementation Grant、同源 Green 和 optional Refactor；
11. typed Evidence、TddCycleRecord、TaskVerdict 与 Snapshot 配对；
12. invalid Red 不解锁、test change/environment drift 失效、resume 幂等；
13. framework_bootstrap 和 controlled_not_applicable 分支；
14. 完整 Gate/Evaluation Finding 触发 ImpactSet/DesignSet/Plan/Contract 级联。

### 实现与文档

修改：

- `README.md`
- `docs/getting-started.md`
- `docs/adopting-a-project.md`
- `docs/operations.md`
- `docs/operations-and-recovery.md`
- `docs/plugin-contracts.md`
- `docs/graph-driven-harness-model.md`
- `docs/dsh-execution-backend.md`
- `docs/m1-acceptance-report.md` 或新增对应 M2/DesignSet 验收报告
- `scripts/generate-acceptance-report.mjs`

文档同步：

- 生命周期图加入 design；
- 关系类型从 17 个影响关系更新为 18 个，并解释 SPECIFIES；
- Node/Edge/Event 总览加入 DesignSet/DesignArtifact；
- Event 总览加入 TDD lifecycle events，Evidence 总览加入 framework/baseline/red/green/refactor 类型；
- README 图与 Dashboard 截图展示 Design 视图；
- README/模型文档展示 Task 内 Baseline → Red → Green 状态机、Phase Grant 和 Evidence 配对；
- runtime config v3 提供 designer 配置示例；
- 操作手册列出 DesignSet approve/reject/defer、TDD blocker/invalidation、迁移 blocker 和恢复命令；
- 插件合同记录 DesignProposalPort 的只读能力、strict TDD Adapter capability、structured Gate 和 workspace isolation contract；
- 验收报告明确区分测试 fixture Evidence 与真实 Agent dogfood Evidence。

### 自动 E2E 验证

```bash
pnpm test:e2e
pnpm test:fault
pnpm test:security
pnpm test:performance
pnpm test:e2e:dashboard
```

### 真实 dsh Dogfood

在一个临时或明确授权的受管项目中：

1. 配置 dsh DesignProposalPort；
2. 运行 `harness iterate`；
3. 在 Dashboard 查看 design phase、输出流和 Approval 卡片；
4. 先 reject 一次并填写理由，确认新 proposal digest；
5. approve 后验证 accepted DesignSet、资产、边和 Plan binding；
6. 查看 TaskTddContract、BaselineEvidence 和 test-authoring Grant，确认生产路径未解锁；
7. 验证 Red 的 failure kind/Oracle/test patch，确认 TddRedAccepted 后才签发 implementation Grant；
8. 完成同一测试补丁的 Green、可选 Refactor、完整 Gates、Evaluation 和 Snapshot；
9. 人为触发一次 invalid Red 或测试补丁变化，验证不解锁/失效/新 attempt；
10. 创建一个受控 Verify/Evaluate Finding，验证 ImpactSet/DesignSet revision/Plan/Contract 级联；
11. 把 design run、approval、phase runs、grants、baseline/red/green evidence、cycle、gate、evaluation 和 snapshot ids 写入验收报告。

### 最终发布验证

```bash
pnpm verify
pnpm test:release
git status --short --branch
```

提交：`docs(acceptance): prove DesignSet and TDD vertical loop`

## 23. 实施提交序列

预期提交保持如下顺序：

1. `feat(protocol): add DesignSet and TDD 1.1 records`
2. `feat(graph): propagate approved design contracts`
3. `feat(design): validate DesignSet and TDD strategies`
4. `feat(design): compile governed proposal inputs`
5. `feat(design): govern DesignSet approvals`
6. `feat(design): commit approved design graphs atomically`
7. `feat(orchestration): add governed design phase`
8. `feat(migration): require design for open legacy iterations`
9. `feat(planning): compile governed TDD contracts`
10. `feat(tdd): isolate test and implementation workspaces`
11. `feat(tdd): govern red green phase transitions`
12. `feat(tdd): validate structured red green evidence`
13. `feat(evaluation): require paired TDD cycle evidence`
14. `feat(tdd): bootstrap verifiable test frameworks`
15. `feat(feedback): cascade findings through design and TDD`
16. `feat(adapter): add governed dsh design and TDD runs`
17. `feat(projection): render design and TDD evidence`
18. `feat(dashboard): visualize design and TDD cycles`
19. `docs(acceptance): prove DesignSet and TDD vertical loop`

每个提交必须能单独通过对应窄测试；不得把失败测试留给后续提交修复。

## 24. 最终验收清单

- [ ] Protocol 1.1 写入与 Protocol 1.0 兼容读取通过。
- [ ] DesignSet、DesignArtifact、SPECIFIES 和扩展 IMPLEMENTS 通过 Schema/Graph integrity。
- [ ] DesignProposalPort 可替换且无项目/Ledger 写权限。
- [ ] Proposal 校验失败不会进入物化工程图。
- [ ] DesignSet approve/reject/defer 和摘要失效都有 Ledger 证据。
- [ ] accepted DesignSet、资产和边一次事务原子提交。
- [ ] 所有 1.1 迭代都经过 design；reuse 不跳过。
- [ ] 覆盖不足机械阻止 Plan。
- [ ] Plan、Context、Preflight 均强绑定 DesignSet。
- [ ] required test_strategy 编译为不可降级 TaskTddContract；每个 Assertion 唯一归属一个 logical cycle。
- [ ] strict TDD Adapter 缺少隔离 workspace、规范 patch 或 structured Gate 能力时 preflight fail closed。
- [ ] Baseline 证明既有目标测试或受影响组件健康；pre-existing failure 不被当作 Red。
- [ ] Red workspace 可由 baseline + frozen test patch 重建，且 production path 在 Red accepted 前不可写。
- [ ] Failure Oracle 拒绝 syntax/discovery/environment/timeout/crash 和模糊 nonzero；只接受结构化目标失败。
- [ ] Implementation Grant 只在 TddRedAccepted 后签发；Green 与 Red 使用同一 patch/Gate/framework/environment。
- [ ] Red 后测试变化、环境漂移和越权写入会失效 Cycle；resume/replay 幂等。
- [ ] TddCycleRecord、typed Evidence 和 TaskVerdict 对 required Assertion 唯一配对。
- [ ] TestInfrastructureTask 产生 FrameworkEvidence，并在完成前阻塞 production Task。
- [ ] Verdict 区分 tdd_proven、controlled_not_applicable、framework_proven、historical_without_tdd_proof 和 invalid/incomplete。
- [ ] TDD Green 不替代完整 Gate 或 Evaluation，Finding 仍级联新 ImpactSet/DesignSet/Plan/Contract。
- [ ] Finding 能产生新 ImpactSet、DesignSet revision 和 Plan。
- [ ] completed 1.0 历史不改写，开放 operation 安全迁移。
- [ ] dsh Design/TDD adapters 的分段 Run、输出流、usage、steps 和失败可观测。
- [ ] Architecture、Specification、Plan、TDD Evidence、Snapshot 可从权威图/Ledger 重建。
- [ ] Dashboard Design/TDD 与全部相关视图使用中文业务描述，Live 删除后权威时间线不丢失。
- [ ] new/adopt/iterate/resume 纵向闭环 E2E 通过。
- [ ] `pnpm verify` 和 `pnpm test:release` 全绿。
- [ ] 真实 dsh dogfood 的 Approval/Phase Run/Grant/Baseline/Red/Green/Cycle/Gate/Evaluation/Snapshot ids 已写入验收报告。
