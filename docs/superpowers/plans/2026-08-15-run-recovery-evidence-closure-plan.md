# Universal Harness 运行恢复与证据闭环实施计划

日期：2026-08-15  
依据：[运行恢复与证据闭环设计](../specs/2026-08-15-run-recovery-evidence-closure-design.md)

## 目标

以垂直 TDD 切片修复真实 Atlas T5 dogfood 暴露的恢复与图谱闭环缺口，并在不删除历史记录的前提下把 Atlas 恢复到 `blockers=[]`、Run 评估覆盖率 17/17。

## 已确认测试接缝

- `hashWorktreeCode(projectRoot)`：调用者观察稳定或变化的绑定摘要。
- `runIteration` / `resumeIteration` + `collectProjectStatus`：调用者观察失败重试、live blocker、Run 覆盖率和终态。
- 完成快照公共结果：调用者观察 blocking audit Finding 能否阻止 `completed`。
- `harness graph reconcile --json`：操作者观察追加计数、skipped、幂等结果和最终项目状态。

## 切片 1：Git-aware 代码绑定

### Red

在 `packages/runtime/test/orchestration/orchestrator.test.ts` 增加公共函数行为测试：

1. tracked 源码和未忽略 untracked 源码变化会改变摘要；
2. `.gitignore` 排除的 `target/`、`.venv/` 或 Gate 日志变化不会改变摘要；
3. 符号链接只绑定链接目标，不读取仓库外内容。

执行：

```bash
pnpm vitest run packages/runtime/test/orchestration/orchestrator.test.ts -t "hashes Git-visible project code"
```

### Green

- 将 `hashWorktreeCode` 改为基于 `git ls-files --cached --others --exclude-standard -z`。
- 绑定路径、mode/类型和文件内容或链接目标。
- Git 查询失败时抛 typed configuration error。

### 验证

重跑目标测试，并运行 runtime typecheck。

## 切片 2：失败 Run 最终评估与恢复 blocker

### Red

扩展已有“失败后 resume”编排测试：

- 第一次执行返回 typed adapter failure；
- 第二次执行成功；
- 两个 Run 都有最终 EvaluationCase；
- EvaluationCase 为 `accepted`，失败 Run 的扩展为 `passed=false`；
- `evaluation_coverage=2/2`；
- 成功 Task 为 accepted，旧 `task ... did not complete` 不再是 live blocker。

### Green

- 抽取幂等 `evaluateAndCommitRun`。
- 失败 Run 在 `blockWithSnapshot` 前评估；成功 Run 仍在 evaluate phase 评估。
- `EvaluationCase.status` 由 final/provisional 决定，不由 passed 决定。
- execute checkpoint 精确清理当前 Task 拥有的旧失败 blocker。
- 状态投影对历史已恢复 Task 过滤不再 live 的 task-failure blocker。

### 验证

运行目标编排测试和 status 测试。

## 切片 3：审计成为完成前置门禁

### Red

新增两个编排行为测试：

1. Gate 产生 ignored 输出并新增 Test，完成阶段仍能复用新鲜 Evidence；审计不产生 `missing_verification`。
2. 新 Test 没有当前 Evidence 或存在其他 blocking audit Finding 时，结果必须是 blocked，不能产生 completed Snapshot/Iteration。

### Green

- 调整 snapshot phase：增量扫描 → Evidence 关联 → audit 级联 → blocker 判断 → completed Snapshot。
- blocker 恢复点设为 verify。
- warning 不阻止完成。
- 保持重复 resume 幂等。

### 验证

运行编排器目标测试，检查快照、Iteration 节点和 Finding/BLOCKS 边。

## 切片 4：追加式 `graph reconcile`

### Red

新增 runtime/CLI 集成 fixture，包含：

- 一个无 `EXECUTES`/EvaluationCase 的终态失败 Run；
- 已通过且绑定仍匹配的 Gate Evidence；
- 新扫描 Test 与 open `missing_verification` Finding；
- 已恢复 Task 的历史失败 blocker。

断言第一次 reconcile：

- 补齐 Run–Task 与评估图链；
- 补齐 Evidence–Test 边；
- supersede 已解决 Finding 并退役 BLOCKS 边；
- 状态无 blocker、覆盖率全量。

断言第二次 reconcile 新增数均为 0。

### Green

- 新建 runtime reconcile service，复用评估回填、Evidence 关联和审计级联模块。
- 新增 `packages/cli/src/commands/graph/reconcile.ts` 和 router/help。
- 结构化返回 nodes/edges/revisions/findings/skipped。
- 映射或绑定不确定时拒绝猜测并返回非零状态。

### 验证

运行 runtime、CLI、help snapshot 目标测试。

## 切片 5：仓库级回归

运行：

```bash
pnpm format
pnpm verify
```

验收：

- 格式、lint、build、typecheck 通过；
- 162+ 测试文件全部通过；
- standalone 扫描通过；
- 无未预期快照变化。

提交 Universal Harness：

```text
fix(runtime): close run recovery and evidence graph loops
```

## 切片 6：Atlas 迁移验证

1. 使用新构建的 CLI 在 Atlas 执行 `harness graph reconcile --json`。
2. 第二次执行验证 no-op。
3. 执行 `harness graph sync`、`graph check`、`audit`、`status`。
4. 重建任务投影；仅在内容变化时显式批准覆盖。
5. 重跑：
   - `scripts/harness/check-jdk21`
   - `scripts/harness/maven-test`
   - `scripts/harness/python-test`
   - `scripts/smoke.sh`
6. 验收 `blockers=[]`、无 stale evidence、Run 评估覆盖率 17/17。
7. 追加迁移账本提交并推送 `codex/harness-driven-t5`。

## 最终交付

- Universal Harness `main`：设计、计划、实现、测试和 CLI 文档。
- Atlas `codex/harness-driven-t5`：T5 源码提交、完整 Harness 快照、追加式 reconcile 迁移证据。
- 最终报告列出提交 SHA、远端引用、门禁结果、图谱覆盖和剩余非阻断 warning。
