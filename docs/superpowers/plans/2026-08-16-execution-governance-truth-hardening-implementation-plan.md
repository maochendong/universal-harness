# 执行治理、真相投影与纵向闭环加固实施计划

日期：2026-08-16  
状态：执行中  
设计依据：[执行治理、真相投影与纵向闭环加固设计](../specs/2026-08-16-execution-governance-truth-hardening-design.md)

## 1. 实施原则

本计划按 red-green-refactor 执行。每个 Task 先增加一个会因当前缺陷失败的最小测试，确认失败原因正确后才修改生产代码；窄测试通过后再运行受影响包测试。每个纵向切片独立提交，不把六类治理问题压成一个不可评审提交。

公开测试接缝已经在批准设计第 20 节固定。本计划不得在实现过程中静默改变这些接口；若代码事实要求改变，先修订设计并重新确认。

兼容策略固定为 A：历史完成数据可读；旧开放迭代必须经过新 preflight，不能 warn-only 继续执行。

## 2. 基线与通用命令

在修改代码前记录基线：

```bash
pnpm test -- packages/runtime/test/planning packages/runtime/test/orchestration
pnpm test -- adapters/vcs-git/test packages/eval/test packages/cli/test
pnpm typecheck
```

每个 Task 至少运行其列出的窄测试。每个切片结束运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

最终运行：

```bash
pnpm verify
pnpm test:release
```

## 3. Task 1：协议扩展与兼容读取基础

### 测试先行

修改：

- `packages/core/test/schema/operation-runtime.test.ts`
- `packages/core/test/schema/golden-files.test.ts`
- 新增 `packages/runtime/test/compatibility/governance-records.test.ts`

先写失败断言：

1. `execution_authorization`、`capability_grant`、`task_verdict` 记录通过 runtime schema。
2. 未知字段、无效 digest、未排序的绑定集合和空授权均失败。
3. Legacy reader 能读取旧 Snapshot/Plan/ContextBundle，并标记 `legacy_inferred`。
4. Legacy reader 不能返回可供新 Run 使用的 authorization/grant。

### 实现

修改：

- `packages/core/src/schema/runtime.ts`
- `packages/core/src/schema/index.ts`
- `packages/core/scripts/write-schemas.mjs` 生成的 `packages/core/schemas/runtime.schema.json`
- 新增 `packages/runtime/src/compatibility/governance-records.ts`
- `packages/runtime/src/index.ts`

实现严格 TypeBox schema、规范化 reader 和 legacy projection。新字段优先放在版本化 record/extension 中，旧记录字节不修改。

### 验证

```bash
pnpm --filter @universal-harness-internal/core schema:generate
pnpm test -- packages/core/test/schema packages/runtime/test/compatibility/governance-records.test.ts
```

提交：`feat(protocol): add governance truth records`

## 4. Task 2：ExecutionBinding、模式强约束与 WorkflowExecutor

### 测试先行

修改：

- `packages/runtime/test/planning/mode-selector.test.ts`
- `packages/runtime/test/planning/execution-plan.test.ts`
- `packages/runtime/test/planning/validator.test.ts`
- 新增 `packages/runtime/test/orchestration/workflow-executor.test.ts`

先写失败断言：

1. `agent + deterministic + one task` 仍选择 `single-loop`。
2. `workflow + deterministic + one task` 才选择 `direct`。
3. direct Plan 绑定 Agent executor 时 preflight 前置拒绝，executor 调用计数保持零。
4. 需要实现变更、但未声明确定性 Tool 的 direct Task 被拒绝。
5. WorkflowExecutor 只调用注册 Tool，未知 Tool 或嵌入命令失败。

### 实现

修改/新增：

- `packages/runtime/src/planning/mode-selector.ts`
- `packages/runtime/src/planning/execution-plan.ts`
- `packages/runtime/src/planning/validator.ts`
- 新增 `packages/runtime/src/orchestration/execution-binding.ts`
- 新增 `packages/runtime/src/orchestration/workflow-executor.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/index.ts`
- `packages/cli/src/runtime-service.ts`
- `packages/cli/src/project-agent.ts`

引入 `ExecutionBinding`，将 CLI 的 DSH executor 显式标记为 agent/delegated；裸 execute 兼容适配为 unproven agent。移除实现型 Task 对零变更 direct attestation 的依赖。

### 验证

```bash
pnpm test -- packages/runtime/test/planning packages/runtime/test/orchestration/workflow-executor.test.ts packages/cli/test/project-runtime-config.test.ts
```

提交：`feat(execution): enforce workflow and agent modes`

## 5. Task 3：影响覆盖、路径预测与风险单调性

### 测试先行

新增：

- `packages/runtime/test/planning/impact-coverage.test.ts`
- `packages/runtime/test/planning/effective-risk.test.ts`
- `tests/golden/impact/agent-partial-coverage.json`
- `tests/golden/impact/agent-complete-coverage.json`

先写失败断言：

1. 只有 Intent/Requirement/Test 的 Agent coding Impact 为 partial。
2. 关联 Artifact/Component locator 或批准路径 forecast 后为 complete。
3. broad/unknown scope 提高风险。
4. Task risk 不能低于 Impact medium、delegated opacity high 或范围风险。
5. 相同输入产生稳定 coverage/forecast digest。

### 实现

新增/修改：

- 新增 `packages/runtime/src/planning/impact-coverage.ts`
- 新增 `packages/runtime/src/planning/effective-risk.ts`
- `packages/runtime/src/planning/task.ts`
- `packages/runtime/src/planning/validator.ts`
- `packages/runtime/src/planning/execution-plan.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/bootstrap/scanner.ts`
- `packages/runtime/src/bootstrap/records.ts`
- `packages/runtime/src/index.ts`

从 accepted 图节点的 canonical locator、Task output 与项目 write scope 构造 PathForecast。扫描器为可定位实现文件/模块产出 Artifact/Component 节点或 locator extension；概率语义边仍需批准后才能进入传播。

### 验证

```bash
pnpm test -- packages/runtime/test/planning packages/runtime/test/bootstrap packages/graph/test/impact
```

提交：`feat(impact): gate agent runs on covered monotonic risk`

## 6. Task 4：Task sizing、DAG 拆分与原子验收

### 测试先行

修改/新增：

- `packages/runtime/test/planning/validator.test.ts`
- `packages/runtime/test/planning/execution-plan.test.ts`
- `packages/runtime/test/orchestration/orchestrator.test.ts`
- 新增 `packages/runtime/test/planning/task-sizing.test.ts`

先写失败断言：

1. Task assertion 包含 `assertion_id/test_ids/required_gate_ids/evidence_requirements`。
2. 每个 accepted Test 必须被至少一个 assertion 覆盖。
3. 单个 omnibus legacy criterion 不能单独授权 Agent coding Task。
4. 多个独立 Test/output cluster 生成稳定顺序 DAG。
5. large 单任务 proposal 被拒绝或拆分，不能保留 low risk single-loop。

### 实现

修改/新增：

- `packages/runtime/src/planning/task.ts`
- `packages/runtime/src/planning/validator.ts`
- 新增 `packages/runtime/src/planning/task-sizing.ts`
- `packages/runtime/src/orchestration/orchestrator.ts` 的 `PlanTasksPort` 与默认 planner
- `packages/runtime/src/requirements/capture.ts`
- `packages/runtime/src/requirements/baseline.ts`
- `packages/cli/src/project-gates.ts`

默认 planner 按 Requirement/Test/expected output 聚类；不能证明原子性时返回输入缺口。保留 legacy criterion reader，但不得把它作为新执行授权。

### 验证

```bash
pnpm test -- packages/runtime/test/planning packages/runtime/test/requirements packages/runtime/test/orchestration/orchestrator.test.ts
```

提交：`feat(planning): decompose atomic acceptance dags`

## 7. Task 5：每 Task 独立 ContextBundle 与完整 Manifest

### 测试先行

修改/新增：

- `packages/runtime/test/context/compiler.test.ts`
- `packages/runtime/test/context/freshness.test.ts`
- 新增 `packages/runtime/test/context/task-bundles.test.ts`
- `packages/runtime/test/orchestration/orchestrator.test.ts`

先写失败断言：

1. Context record 的 `harness.context` extension 保存完整 manifest。
2. entry 包含 locator、revision、reason、priority、freshness、预算与压缩字段。
3. exclusions 包含 locator 和明确原因。
4. 三 Task DAG 产生三个不同 Bundle，Envelope 分别绑定正确 Bundle。
5. 复用其他 Task Bundle 或缺少 ImpactCoverage/Task digest 触发 binding drift。

### 实现

修改/新增：

- `packages/runtime/src/context/compiler.ts`
- `packages/runtime/src/context/selector.ts`
- `packages/runtime/src/context/freshness.ts`
- 新增 `packages/runtime/src/context/task-bundles.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/loop/task-envelope.ts`
- `packages/runtime/src/index.ts`

PipelineContext 将单值 bundle 改为 task-id map；load/commit 函数按 task id 工作。Manifest 进入 extension，顶层 source digests 保持兼容。

### 验证

```bash
pnpm test -- packages/runtime/test/context packages/runtime/test/orchestration/orchestrator.test.ts tests/performance/context-compile.test.ts
```

提交：`feat(context): compile traceable task-local bundles`

## 8. Task 6：ExecutionPreflight、Plan 级授权与完整 Grant

### 测试先行

新增/修改：

- `packages/runtime/test/policy/execution-preflight.test.ts`
- `packages/runtime/test/policy/capability-grant-record.test.ts`
- `packages/runtime/test/orchestration/orchestrator.test.ts`
- `tests/fault/approval-cascade-invalidation.test.ts`
- `tests/security/capability-escalation.test.ts`

先写失败断言：

1. 整个 Plan 只生成一次 ExecutionAuthorization 请求。
2. Authorization 绑定全部 Task/Context/GrantSpec、ImpactCoverage、Policy、Profile、baseline 和风险。
3. GrantSpec digest 不含 Authorization，GrantRecord 再绑定 Authorization，二者无循环。
4. 全部 GrantRecord 在第一个 RunStarted 前提交。
5. 缺失/漂移 Grant、Context、Plan、Approval 或 Profile 时 executor 调用为零。
6. DSH/unproven delegated 必须人工批准且只能 supervised。

### 实现

新增/修改：

- 新增 `packages/runtime/src/policy/execution-preflight.ts`
- 新增 `packages/runtime/src/policy/execution-authorization.ts`
- `packages/runtime/src/policy/capability-grant.ts`
- `packages/runtime/src/policy/action.ts`
- `packages/runtime/src/approval/request.ts`
- `packages/runtime/src/approval/invalidation.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/workflow/operation.ts`
- `packages/runtime/src/workflow/working-state.ts`
- `packages/runtime/src/index.ts`

execute 入口先构造全 Plan GrantSpecs，执行 preflight，解析一次批准，持久化 Authorization 和全部 GrantRecords，再开启第一个 Run。RunStarted extension 绑定三个 digest。

### 验证

```bash
pnpm test -- packages/runtime/test/policy packages/runtime/test/approval packages/runtime/test/orchestration/orchestrator.test.ts tests/security/capability-escalation.test.ts tests/fault/approval-cascade-invalidation.test.ts
```

提交：`feat(governance): authorize plans before agent execution`

## 9. Task 7：真实 DiffStat 与范围漂移闭环

### 测试先行

修改/新增：

- `adapters/vcs-git/test/status.test.ts`
- `adapters/vcs-git/test/adapter.test.ts`
- `adapters/agent-dsh/test/adapter.test.ts`
- `adapters/agent-command/test/adapter.test.ts`
- 新增 `packages/runtime/test/planning/scope-drift.test.ts`
- `tests/security/undeclared-write.test.ts`

fixture 覆盖普通文本、未跟踪文本、删除、rename、含空格路径和二进制文件。先写失败断言：

1. `parseGitDiffStat` 得到准确 files/insertions/deletions/rename/binary。
2. DSH RunResult 使用 Harness 检查结果，不再固定 0/0。
3. Grant 外路径为 undeclared write。
4. Grant 内但 Forecast 外路径或规模越级为 scope drift。
5. scope drift 不提交源码、不生成完成 Snapshot，并把恢复点设为 impact。

### 实现

修改/新增：

- `packages/plugin-sdk/src/vcs.ts`
- `adapters/vcs-git/src/status.ts`
- `adapters/vcs-git/src/adapter.ts`
- 新增 `adapters/vcs-git/src/diff-stat.ts`
- `adapters/agent-command/src/adapter.ts`
- `adapters/agent-dsh/src/adapter.ts`
- `packages/cli/src/project-agent.ts`
- 新增 `packages/runtime/src/planning/scope-drift.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`

扩展 VCS diff 端口包含 untracked/binary/rename 语义；RepositoryInspection 带 DiffStat。orchestrator 在 Run 后、verify/commit 前执行漂移决策。

### 验证

```bash
pnpm test -- adapters/vcs-git/test adapters/agent-command/test adapters/agent-dsh/test packages/runtime/test/planning/scope-drift.test.ts tests/security/undeclared-write.test.ts
```

提交：`feat(vcs): govern runs with truthful diff stats`

## 10. Task 8：预算可用性与 Control Profile 贯穿

### 测试先行

修改/新增：

- `packages/eval/test/deterministic/efficiency.test.ts`
- `packages/runtime/test/snapshot/builder.test.ts`
- `packages/runtime/test/status/status.test.ts`
- `packages/cli/test/status.test.ts`
- `adapters/agent-dsh/test/adapter.test.ts`

先写失败断言：

1. unmetered token/step 为 unavailable/null，不是 0。
2. duration 为 measured 且 Harness enforced。
3. Profile digest 在 Authorization、Run Evaluation、Snapshot、status 一致。
4. 完成后的 status 从 Snapshot/Run 投影 delegated，不返回 none。
5. efficiency scorer 只在 available 维度上计算利用率，并列出 unavailable fields。

### 实现

新增/修改：

- 新增 `packages/plugin-sdk/src/measurement.ts`
- `packages/plugin-sdk/src/agent.ts`
- `packages/eval/src/deterministic/efficiency.ts`
- `packages/eval/src/evaluator.ts`
- `packages/runtime/src/snapshot/builder.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/cli/src/commands/status.ts`

引入 BudgetObservation；保留旧 budget 数字 projection 供兼容读取，但新 JSON 输出明确 availability/enforcement。

### 验证

```bash
pnpm test -- packages/eval/test packages/runtime/test/snapshot packages/runtime/test/status packages/cli/test/status.test.ts adapters/agent-dsh/test
```

提交：`feat(observability): expose control and budget availability`

## 11. Task 9：RunFact、TaskVerdict、Evaluation 链与 Snapshot 真相

### 测试先行

修改/新增：

- `packages/eval/test/deterministic/correct-failure.test.ts`
- `packages/eval/test/evaluator.test.ts`
- 新增 `packages/runtime/test/evaluation/task-verdict.test.ts`
- `packages/runtime/test/orchestration/orchestrator.test.ts`
- `packages/runtime/test/snapshot/builder.test.ts`
- `tests/golden/evaluations/handoff.json`
- `tests/golden/projections/snapshot.md`

先写失败断言：

1. handoff/completion 原样保留，correct-failure 不称其为失败。
2. Gate/Evaluation/Assertion 全绿产生 `TaskVerdict: passed`。
3. Snapshot `run_outcomes` 只含 Run id/handoff，`task_verdicts` 含 Task id/passed。
4. completed Iteration 不依赖伪造 Run success。
5. `Run → Evidence → Test/EvaluationCase → Task/Requirement` 图链完整。
6. Run、Task、Test/assertion coverage 完成时全部为 N/N，不再出现 0/N。

### 实现

新增/修改：

- 新增 `packages/runtime/src/evaluation/task-verdict.ts`
- 新增 `packages/runtime/src/evaluation/outcome-projection.ts`
- `packages/eval/src/deterministic/correct-failure.ts`
- `packages/eval/src/deterministic/outcome.ts`
- `packages/eval/src/evaluator.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/snapshot/builder.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/audit/auditor.ts`
- `packages/runtime/src/index.ts`

TaskVerdict 作为严格 runtime artifact 持久化并建图。完成判断消费 verdict，不重写 Run outcome。

### 验证

```bash
pnpm test -- packages/eval/test packages/runtime/test/evaluation packages/runtime/test/snapshot packages/runtime/test/orchestration/orchestrator.test.ts packages/runtime/test/audit
```

提交：`feat(truth): separate run facts from task verdicts`

## 12. Task 10：无歧义 CommitRefs

### 测试先行

修改/新增：

- `packages/runtime/test/orchestration/orchestrator.test.ts`
- `packages/runtime/test/snapshot/builder.test.ts`
- `packages/runtime/test/snapshot/anchor.test.ts`
- `packages/cli/test/runtime-service.test.ts`
- `tests/e2e/node-adopt.test.ts`

先写失败断言：

1. Snapshot `source_commit` 与被 Gate 证明的源码提交一致，`final_commit` 只是兼容别名。
2. Snapshot 不持久化包含自身的 ledger commit。
3. 完成命令输出 `source_commit/ledger_commit/repository_head`。
4. JSON 不再用 `final_commit` 表示 Ledger commit。
5. 历史 Snapshot reader 把旧 `final_commit` 解析为 source commit，并能定位首次包含 artifact 的 ledger commit。

### 实现

修改/新增：

- `packages/runtime/src/snapshot/builder.ts`
- `packages/runtime/src/snapshot/anchor.ts`
- 新增 `packages/runtime/src/snapshot/commit-projection.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/cli/src/runtime-service.ts`
- `packages/cli/src/commands/snapshot.ts`
- `packages/runtime/src/index.ts`

OrchestrationOutcome 字段重命名为明确语义；compat adapter 仅服务旧 host，不进入新 CLI projection。

### 验证

```bash
pnpm test -- packages/runtime/test/snapshot packages/runtime/test/orchestration/orchestrator.test.ts packages/cli/test tests/e2e/node-adopt.test.ts
```

提交：`fix(snapshot): separate source and ledger commits`

## 13. Task 11：Blocker 生命周期统一投影

### 测试先行

修改/新增：

- `packages/runtime/test/workflow/working-state.test.ts`
- `packages/runtime/test/workflow/checkpoint.test.ts`
- `packages/runtime/test/status/status.test.ts`
- `packages/runtime/test/approval/service.test.ts`
- `tests/fault/expired-approval.test.ts`

先写失败断言：

1. approve/reject/supersede 后下一 checkpoint 不含旧 approval blocker。
2. defer 保留 pending blocker。
3. passed Task 清除对应运行失败 blocker。
4. closed/superseded Finding 不再阻塞。
5. WorkingState、Snapshot、status 使用同一 live blocker projector，结果一致。

### 实现

新增/修改：

- 新增 `packages/runtime/src/workflow/blockers.ts`
- `packages/runtime/src/workflow/working-state.ts`
- `packages/runtime/src/workflow/checkpoint.ts`
- `packages/runtime/src/workflow/operation.ts`
- `packages/runtime/src/approval/service.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/index.ts`

引入 typed blocker identity；旧字符串数组成为 projector 的兼容输出。每次 checkpoint 前从权威生命周期记录 reconcile。

### 验证

```bash
pnpm test -- packages/runtime/test/workflow packages/runtime/test/status packages/runtime/test/approval tests/fault/expired-approval.test.ts
```

提交：`fix(workflow): reconcile live blockers at checkpoints`

## 14. Task 12：长运行 CLI 实时投影

### 测试先行

修改/新增：

- `packages/runtime/test/observability/publisher.test.ts`
- 新增 `packages/runtime/test/observability/active-run.test.ts`
- `packages/cli/test/watch.test.ts`
- 新增 `packages/cli/test/live-progress.test.ts`
- `packages/cli/test/status.test.ts`

使用 fake clock 和 fake 65 秒 Agent。先写失败断言：

1. 底层 heartbeat 每五秒写 spool。
2. 当前命令 stderr 每三十秒最多输出一次聚合摘要，状态变化立即输出。
3. 摘要包含 task、adapter profile、elapsed、heartbeat、预算 availability。
4. `--json` stdout 始终是一个最终 JSON；进度只在 stderr。
5. status 在运行中显示 active_run，完成后显示最近 control profile 且 active_run 消失。

### 实现

新增/修改：

- 新增 `packages/runtime/src/observability/active-run.ts`
- `packages/runtime/src/observability/publisher.ts`
- `packages/runtime/src/observability/live-spool.ts`
- `packages/runtime/src/status/status.ts`
- 新增 `packages/cli/src/live-progress.ts`
- `packages/cli/src/runtime-service.ts`
- `packages/cli/src/router.ts`
- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/watch.ts`

CLI 订阅同一个 ObservationPublisher side channel，不另造权威事件源；终端聚合只影响显示。

### 验证

```bash
pnpm test -- packages/runtime/test/observability packages/cli/test/live-progress.test.ts packages/cli/test/watch.test.ts packages/cli/test/status.test.ts tests/fault/event-stream-recovery.test.ts
```

提交：`feat(cli): stream governed long-run progress`

## 15. Task 13：旧开放迭代严格迁移与恢复

### 测试先行

新增/修改：

- 新增 `packages/runtime/test/compatibility/open-iteration-migration.test.ts`
- `packages/runtime/test/workflow/resume.test.ts`
- `tests/fault/workflow-resume.test.ts`
- `tests/fault/process-kill.test.ts`
- `packages/cli/test/resume.test.ts`

fixture 包含旧 direct Agent Plan、单 Bundle、多 Task、裸 grant digest 和旧 Snapshot。先写失败断言：

1. 历史完成记录只读成功且不追加 artifact。
2. 旧开放迭代 execute 返回 migration_required，executor 调用为零。
3. migration 追加诊断并使旧 Plan/Context/Grant 授权失效，不改写旧文件。
4. 恢复点稳定回到 impact 或 plan，重新批准新 digest 后才执行。
5. 重复 resume 幂等，不重复批准、Grant 或 Run。

### 实现

新增/修改：

- 新增 `packages/runtime/src/compatibility/open-iteration.ts`
- `packages/runtime/src/workflow/state-machine.ts`
- `packages/runtime/src/workflow/resume.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/approval/invalidation.ts`
- `packages/cli/src/runtime-service.ts`

用追加式 invalidation/migration artifact 使 loadPlan/loadBundle 忽略旧授权链；不修改历史字节。

### 验证

```bash
pnpm test -- packages/runtime/test/compatibility packages/runtime/test/workflow tests/fault/workflow-resume.test.ts tests/fault/process-kill.test.ts packages/cli/test/resume.test.ts
```

提交：`feat(migration): enforce preflight on open legacy runs`

## 16. Task 14：完整闭环、文档与发布验收

### 测试先行

新增：

- `tests/integration/execution-governance-vertical-loop.test.ts`
- `tests/e2e/delegated-agent-vertical-loop.test.ts`
- `tests/golden/atlas-t8-shaped-run/`

fixture 模拟一个 delegated/external-only/unmetered Agent，包含多个 Requirement/Test、三个 DAG Task、三十个变更文件、rename、binary、一次 scope drift 和二次批准。断言：

1. 第一次运行因 incomplete impact 或 scope drift 阻断。
2. 图同步、Impact 重批、Plan 授权、Grant、执行、Gate、Evaluation、TaskVerdict、Snapshot 形成完整链。
3. 最终无 blocker/stale Evidence，三类 evaluation coverage 全量。
4. Run 保持 handoff，Task passed，Iteration completed。
5. CLI/Status/Snapshot 的 profile、预算、diff 与 commits 一致。

### 实现与文档

修改：

- `README.md`
- `docs/getting-started.md`
- `docs/operations-and-recovery.md`
- `docs/plugin-contracts.md`
- `docs/dsh-execution-backend.md`
- `docs/m1-acceptance-report.md`、`docs/m2-acceptance-report.md` 的生成注册
- `tests/reporting/acceptance-evidence.ts`
- `tests/reporting/aggregate-acceptance.ts`
- `scripts/generate-acceptance-report.mjs`

文档明确 direct/agent 约束、ExecutionAuthorization、Task-local Context、不可用预算、scope drift、三层真相、commit refs 和迁移策略 A。

### 验证

```bash
pnpm test -- tests/integration/execution-governance-vertical-loop.test.ts tests/e2e/delegated-agent-vertical-loop.test.ts
pnpm verify
pnpm test:release
git diff --check
```

提交：`test(release): prove governed delegated vertical loop`

## 17. 完成与推送

完成前必须确认：

- 工作区只有本计划产生的预期修改。
- 所有新 runtime artifact 均通过 schema 和 replay。
- 历史 Golden 可读，新 Golden 严格。
- `pnpm verify` 与 `pnpm test:release` 全绿。
- 设计状态更新为已完成，实施计划状态更新为已完成。
- 验收报告由脚本生成，不手改结果区。
- 本地 `main` 提交完整且无临时调试文件。

随后推送：

```bash
git push origin main
```
