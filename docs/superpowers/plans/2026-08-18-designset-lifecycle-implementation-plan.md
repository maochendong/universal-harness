# Universal Harness DesignSet 生命周期实施计划

日期：2026-08-18  
状态：已规划，待批准实施  
设计依据：[Universal Harness DesignSet 生命周期设计](../specs/2026-08-18-designset-lifecycle-design.md)

## 1. 实施原则

本计划按 red-green-refactor 执行。每个 Task 先写一个因当前能力缺失而失败的最小测试，确认失败原因正确后再修改生产代码；窄测试通过后运行受影响包测试；每个 Task 独立提交，不把 Protocol、Orchestrator、dsh、Projection 和 Dashboard 压进一个不可评审提交。

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

如果代码事实迫使上述任何约束改变，必须先修订设计文档并重新获得确认。

## 2. 基线、分支与通用验证

开始代码实施前：

```bash
git status --short --branch
git switch -c codex/designset-lifecycle
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
T1 Protocol Schema
 ├─→ T2 Graph Relations
 └─→ T3 Design Domain + Validator
       ├─→ T4 Input Compiler + Port
       └─→ T5 Proposal Persistence + Approval
              └─→ T6 Atomic Committer
                     └─→ T7 Orchestration Phase
                            ├─→ T8 Legacy Migration
                            ├─→ T9 Plan/Context/Preflight Binding
                            └─→ T10 Feedback Cascade
T4 ─→ T11 CLI Config + dsh Adapter
T6/T9 ─→ T12 Markdown Projection
T5/T7/T10 ─→ T13 Dashboard
T1–T13 ─→ T14 E2E/Docs/Acceptance
```

T1–T7 是最小权威闭环，必须串行完成。T8–T13 在 T7 之后可以按依赖分批，但同一工作区内仍应保持小提交和完整窄测试。

## 4. Task 1：Protocol 1.1 与 Design 记录 Schema

### 测试先行

修改：

- `packages/core/test/schema/protocol-version.test.ts`
- `packages/core/test/schema/persisted-records.test.ts`
- `packages/core/test/schema/operation-runtime.test.ts`
- `packages/core/test/schema/schema-export.test.ts`
- 新增 `packages/core/test/schema/design-records.test.ts`
- 新增 `packages/core/test/fixtures/protocol-1.0-designless-ledger.json`

先写失败断言：

1. 新记录默认使用 `1.1.0`，reader 仍接受 `1.0.0`。
2. Node 类型接受 DesignSet、DesignArtifact；未知类型仍失败。
3. Runtime Schema 接受严格的 `design_set_proposal`，拒绝未知字段、空 digest、非法 action 和未排序集合。
4. DesignArtifact kind 仅接受 `api_contract/data_contract/test_strategy/ui_design`。
5. 旧 1.0 fixture 可以读取，且没有任何自动补造的 DesignSet。
6. 生成的 JSON Schema 包含新 Node/Edge/Runtime 定义。

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

新增严格 TypeBox Schema：DesignArtifact content、DesignSet content、DesignSetProposalRecord、node/edge changes、reused assets、coverage、risk summary。旧记录只按 major version 兼容读取，不修改原始字节。

### 验证

```bash
pnpm --filter @universal-harness-internal/core schema:generate
pnpm test -- packages/core/test/schema
pnpm --filter @universal-harness-internal/core typecheck
```

提交：`feat(protocol): add DesignSet 1.1 records`

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

### 实现

新增：

- `packages/runtime/src/design/model.ts`
- `packages/runtime/src/design/canonical.ts`
- `packages/runtime/src/design/coverage.ts`
- `packages/runtime/src/design/validator.ts`
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

提交：`feat(design): validate canonical DesignSet proposals`

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

## 12. Task 9：Plan、Context 与 Preflight 的 DesignSet 强绑定

### 测试先行

修改/新增：

- `packages/runtime/test/planning/execution-plan.test.ts`
- `packages/runtime/test/planning/validator.test.ts`
- `packages/runtime/test/planning/impact-coverage.test.ts`
- `packages/runtime/test/context/compiler.test.ts`
- `packages/runtime/test/context/task-bundles.test.ts`
- `packages/runtime/test/orchestration/execution-binding.test.ts`
- 新增 `packages/runtime/test/planning/design-coverage.test.ts`

先写失败断言：

1. 没有 accepted DesignSet 时 `generateExecutionPlan` 失败。
2. Plan shared context 同时绑定 RequirementBaseline、ImpactSet、DesignSet、Policy digest。
3. Planner 输入包含 Decision/Component/DesignArtifact/coverage 摘要。
4. Task IMPLEMENTS Requirement、Decision 和适用 DesignArtifact。
5. ContextBundle 绑定 design_set_digest，并选择 L2 设计邻域。
6. reuse DesignSet 的引用资产也进入 ContextBundle manifest。
7. Plan/Context/Run 前任一 DesignSet 或资产 revision drift 阻止 executor 调用。
8. ImpactCoverage 将 architecture/design coverage 纳入 complete 条件。

### 实现

修改：

- `packages/runtime/src/planning/execution-plan.ts`
- `packages/runtime/src/planning/validator.ts`
- `packages/runtime/src/planning/impact-coverage.ts`
- `packages/runtime/src/planning/task.ts`
- `packages/runtime/src/context/compiler.ts`
- `packages/runtime/src/context/selector.ts`
- `packages/runtime/src/context/task-bundles.ts`
- `packages/runtime/src/orchestration/execution-binding.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/workflow/resume.ts`

不要使用 legacy inferred design authorization。1.1 Run 只能消费真实 accepted DesignSet。

### 验证

```bash
pnpm test -- packages/runtime/test/planning packages/runtime/test/context packages/runtime/test/orchestration/execution-binding.test.ts
```

提交：`feat(planning): bind execution to approved designs`

## 13. Task 10：Finding 级联、Design revision 与 Audit 语义

### 测试先行

修改/新增：

- `tests/integration/feedback-cascade.test.ts`
- `packages/runtime/test/audit/auditor.test.ts`
- 新增 `packages/runtime/test/finding/governance.test.ts`
- 新增 `packages/runtime/test/design/feedback-router.test.ts`
- 新增 `tests/fault/designset-finding-invalidation.test.ts`

先写失败断言：

1. Finding → Change Seed → new ImpactSet → new DesignSet revision → new Plan。
2. 设计确实改变时，新 revision/SUPERSEDES 链可查询，旧 digest 不变。
3. 设计无需改变时也生成绑定新 ImpactSet 的 reuse DesignSet。
4. 旧 Plan/Context/未启动 Run 授权失效，历史 completed Snapshot 不变。
5. Protocol 1.1 的设计缺口在 design phase 阻塞，不再等到 snapshot 才 warning。
6. Protocol 1.0 历史 `missing_design_artifact` 保持 warning，避免追溯阻塞。
7. ImprovementCandidate 针对 Decision/Component/DesignArtifact 时走同一反馈链。

### 实现

新增：

- `packages/runtime/src/design/feedback-router.ts`

修改：

- `packages/runtime/src/audit/auditor.ts`
- `packages/runtime/src/finding/governance.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/status/status.ts`
- `packages/graph/src/impact/seeds.ts`

所有失效均追加事件/新 revision，不删除旧 Artifact。Dashboard 所需的 reason 和 earliest affected phase 由 router 输出规范字段。

### 验证

```bash
pnpm test -- packages/runtime/test/design/feedback-router.test.ts packages/runtime/test/audit packages/runtime/test/finding tests/integration/feedback-cascade.test.ts tests/fault/designset-finding-invalidation.test.ts
```

提交：`feat(feedback): cascade findings through design revisions`

## 14. Task 11：项目配置与 dsh DesignProposalPort Adapter

### 测试先行

修改/新增：

- `packages/cli/test/project-runtime-config.test.ts`
- 新增 `packages/cli/test/runtime-service.test.ts`
- 新增 `packages/cli/test/doctor.test.ts`
- `adapters/agent-dsh/test/prompt.test.ts`
- `adapters/agent-dsh/test/adapter.test.ts`
- 新增 `adapters/agent-dsh/test/design-adapter.test.ts`
- 新增 `adapters/agent-dsh/test/fixtures/design-proposal.mjs`
- 新增 `packages/conformance/test/design-adapters.conformance.test.ts`

先写失败断言：

1. runtime config v3 接受独立 `designer`，旧 v1/v2 仍可读。
2. designer 配置没有 proposed_write_paths，出现写路径字段直接失败。
3. resolution 顺序固定：测试注入 Port → explicit designer config → compatible dsh agent 的只读派生配置 → typed designer_required。
4. dsh prompt 清楚区分不可信上下文、输出 JSON Schema、禁止项目/Ledger 写入。
5. adapter 拒绝 malformed/stdout flood/timeout/contract mismatch/任何工作区变更。
6. adapter 输出 usage、steps、duration、stdout tail Evidence，不把 provider metadata 放进 DesignSet content digest。
7. `harness doctor` 报告 designer 配置、版本、模型契约和只读范围。

### 实现

修改/新增：

- `packages/cli/src/project-runtime-config.ts`
- `packages/cli/src/project-agent.ts`
- `packages/cli/src/runtime-service.ts`
- `packages/cli/src/commands/doctor.ts`
- 新增 `packages/cli/src/project-designer.ts`
- 新增 `adapters/agent-dsh/src/design-prompt.ts`
- 新增 `adapters/agent-dsh/src/design-adapter.ts`
- `adapters/agent-dsh/src/index.ts`
- `packages/plugin-sdk/src/agent.ts` 或新增 `packages/plugin-sdk/src/design.ts`
- `packages/plugin-sdk/src/index.ts`

优先复用现有受管 dsh process/telemetry 基础，但 Design adapter 必须构造独立只读 envelope，不复用带写权限的 AgentTaskEnvelope。未来其他 LLM adapter 只实现同一 DesignProposalPort。

### 验证

```bash
pnpm test -- packages/cli/test/project-runtime-config.test.ts packages/cli/test/runtime-service.test.ts packages/cli/test/doctor.test.ts adapters/agent-dsh/test packages/conformance/test/design-adapters.conformance.test.ts
```

提交：`feat(adapter): add pluggable dsh design proposals`

## 15. Task 12：Architecture、Specification、Plan 和 Snapshot 投影

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

提交：`feat(projection): render approved design assets`

## 16. Task 13：Dashboard Design 视图与全视图设计语义

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

Design 视图读取权威 Ledger/物化图，不依赖 Live 事件是否被浏览器错过。Live 仍是可删除观测层，不参与 DesignSet 成败。

### 验证

```bash
pnpm test -- packages/dashboard/test tests/e2e/dashboard-readonly.test.ts tests/e2e/dashboard-live-approval.test.ts tests/security/dashboard-security.test.ts tests/performance/m2-dashboard.test.ts
pnpm test:e2e:dashboard
```

提交：`feat(dashboard): visualize governed design sets`

## 17. Task 14：全链路 E2E、文档、Dogfood 与验收报告

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
- README 图与 Dashboard 截图展示 Design 视图；
- runtime config v3 提供 designer 配置示例；
- 操作手册列出 DesignSet approve/reject/defer、迁移 blocker 和恢复命令；
- 插件合同记录 DesignProposalPort 的只读能力和 Schema。

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
6. 完成 Agent 执行、正式 Gates、Evaluation、Snapshot；
7. 创建一个受控 Finding，验证 ImpactSet/DesignSet revision/Plan 级联；
8. 把 run、approval、gate、evaluation 和 snapshot ids 写入验收报告。

### 最终发布验证

```bash
pnpm verify
pnpm test:release
git status --short --branch
```

提交：`docs(acceptance): prove DesignSet vertical loop`

## 18. 实施提交序列

预期提交保持如下顺序：

1. `feat(protocol): add DesignSet 1.1 records`
2. `feat(graph): propagate approved design contracts`
3. `feat(design): validate canonical DesignSet proposals`
4. `feat(design): compile governed proposal inputs`
5. `feat(design): govern DesignSet approvals`
6. `feat(design): commit approved design graphs atomically`
7. `feat(orchestration): add governed design phase`
8. `feat(migration): require design for open legacy iterations`
9. `feat(planning): bind execution to approved designs`
10. `feat(feedback): cascade findings through design revisions`
11. `feat(adapter): add pluggable dsh design proposals`
12. `feat(projection): render approved design assets`
13. `feat(dashboard): visualize governed design sets`
14. `docs(acceptance): prove DesignSet vertical loop`

每个提交必须能单独通过对应窄测试；不得把失败测试留给后续提交修复。

## 19. 最终验收清单

- [ ] Protocol 1.1 写入与 Protocol 1.0 兼容读取通过。
- [ ] DesignSet、DesignArtifact、SPECIFIES 和扩展 IMPLEMENTS 通过 Schema/Graph integrity。
- [ ] DesignProposalPort 可替换且无项目/Ledger 写权限。
- [ ] Proposal 校验失败不会进入物化工程图。
- [ ] DesignSet approve/reject/defer 和摘要失效都有 Ledger 证据。
- [ ] accepted DesignSet、资产和边一次事务原子提交。
- [ ] 所有 1.1 迭代都经过 design；reuse 不跳过。
- [ ] 覆盖不足机械阻止 Plan。
- [ ] Plan、Context、Preflight 均强绑定 DesignSet。
- [ ] Finding 能产生新 ImpactSet、DesignSet revision 和 Plan。
- [ ] completed 1.0 历史不改写，开放 operation 安全迁移。
- [ ] dsh Design adapter 输出流、usage、steps 和失败可观测。
- [ ] Architecture、Specification、Plan、Snapshot 可从权威图重建。
- [ ] Dashboard Design 与全部相关视图使用中文业务描述。
- [ ] new/adopt/iterate/resume 纵向闭环 E2E 通过。
- [ ] `pnpm verify` 和 `pnpm test:release` 全绿。
- [ ] 真实 dsh dogfood 的 Approval/Gate/Evidence/Snapshot ids 已写入验收报告。
