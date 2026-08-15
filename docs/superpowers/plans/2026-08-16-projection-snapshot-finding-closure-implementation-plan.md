# 投影、Snapshot 锚点与 Finding 收敛实施计划

日期：2026-08-16  
状态：实施中  
设计依据：[投影、Snapshot 锚点与 Finding 收敛设计](../specs/2026-08-16-projection-snapshot-finding-closure-design.md)

## 目标

修复 Atlas T6/T7 dogfood 暴露的四项闭环缺口，同时保持 Git-native Ledger append-only、源码与 Ledger 双提交、人工投影保护和历史重放兼容。

## 测试接缝

1. `writeManagedOutput`：调用方只能自动替换摘要自洽的 Harness Markdown Projection。
2. `runIteration`/`resumeIteration`：完成迭代时源码提交先于 Snapshot，Snapshot 锚定源码提交，Ledger 独立提交。
3. `harness snapshot anchor`：通过 CLI 追加、查询并幂等重放历史 Snapshot Anchor Correction。
4. `auditGraph`/`reconcileProjectGraph`：Finding supersede 后所有关联活动边退休，第二次运行无新增操作。

## Task 1：可信投影自动重写

**测试先行**

- 在 Projection Runtime 测试中证明摘要自洽的旧 `tasks.md` 可自动重写。
- 证明正文、sources、view 或 `generation_digest` 任一被手改时仍拒绝覆盖。
- 在 Orchestrator 测试中完成两轮迭代，断言投影包含两轮计划及完成任务，而不是停留在首轮。

**实现**

- 增加 Harness Markdown Projection 头解析与摘要验证纯函数。
- 为 `writeManagedOutput` 增加仅限可信 Harness Projection 的重写选项。
- Snapshot Task Projection 使用该选项；显式人工覆盖语义不变。

**完成条件**

- 聚焦测试全绿；手改保护测试仍然有效。

## Task 2：源码提交先于完成 Snapshot

**测试先行**

- 完成迭代后断言存在源码提交与后续 Ledger 提交。
- Snapshot `final_commit` 等于源码提交；Outcome 同时暴露 `sourceCommit` 与兼容的 `finalCommit`。
- 不相关用户文件不进入源码提交。
- 无源码变化、提交失败和恢复重入均不产生重复源码提交。

**实现**

- 汇总成功 Run 的 `change_summary.paths`，规范化、去重并校验 Task Envelope 写边界。
- 在 Snapshot 构建前通过 VCS Adapter 提交精确源码路径。
- 将新 HEAD 写入 Snapshot；随后只提交 `.harness`。
- Checkpoint/恢复逻辑识别已存在且摘要匹配的源码提交。

**完成条件**

- Orchestrator 聚焦测试与现有恢复测试全绿。

## Task 3：追加式 Snapshot Anchor Correction

**测试先行**

- 正确 commit 与 Snapshot Gate Evidence 代码摘要一致时追加成功。
- 不存在的 Snapshot/commit、摘要不匹配、无有效 Evidence、冲突的第二个修正均失败。
- 相同修正重复执行为 `noop`。
- Snapshot commit 解析优先使用有效 Correction。

**实现**

- 定义 Runtime correction record、摘要与文件布局。
- 实现 Git commit 代码摘要计算，语义与 `hashWorktreeCode` 一致且排除 `.harness`。
- 新增 `snapshot anchor` CLI 路由、帮助、JSON 输出与稳定错误。
- reconcile/evidence freshness 的 Snapshot commit 读取支持 Correction。

**完成条件**

- Runtime、CLI 和帮助快照聚焦测试全绿。

## Task 4：Finding 全边退休

**测试先行**

- Audit 正常收敛和 graph reconcile 分别覆盖 Finding 作为 source/target 的 `BLOCKS`、追踪和评价边。
- Finding supersede 后这些边均追加 `superseded` 修订。
- 第二次 reconcile 节点、边、修订均为零。

**实现**

- 抽取 Finding 关联活动边筛选规则。
- 正常 Audit 与 reconcile 共用“所有关联边退休”语义。
- 保持 `block_edges_retired`，新增 `finding_edges_retired`。

**完成条件**

- Audit/reconcile 聚焦测试及图完整性测试全绿。

## Task 5：Universal Harness 全量收敛

- 修复当前 6 个 Prettier 违规文件。
- 更新 README/运维文档，说明双提交与 `snapshot anchor`。
- 运行 `pnpm verify`，要求 format、lint、build、typecheck、1138+ tests 和 Standalone 全绿。
- 提交并推送 `main`。

## Task 6：Atlas 历史迁移

1. 新增 `docs/decisions/0001-harness-governed-iteration.md`。
2. 使用新 CLI 执行 Finding reconcile；第二次运行必须 no-op。
3. 为 T6/T7 追加 Anchor Correction，并验证解析结果。
4. 重新生成 Task Projection，确认含 T6/T7。
5. 通过维护迭代扫描 ADR、运行项目 Gate、Audit 与 Snapshot。
6. 运行 JDK 21、Maven、Python、Graph Check、Audit、Status 完整验收。
7. 提交并推送 `main`。

## Task 7：分支清理与最终审计

- 删除前验证 `gitee/codex/harness-driven-t5` tip 是 `main` 祖先。
- 删除本地 `codex/harness-driven-t5`。
- 删除 Gitee 远程 `codex/harness-driven-t5`。
- 保留未被用户点名的备份/bootstrap 本地分支。
- `git fetch --prune` 后证明目标本地与远程引用均不存在。
- 最终确认 Universal Harness 与 Atlas 的 `main` 均和远程一致、工作区干净。

## 退出标准

- Atlas `tasks.md` 包含完成的 T6 与 T7。
- T6/T7 correction 分别解析到 `25883a2` 与 `4b59a08`，旧 Snapshot 未修改。
- Atlas `status` 为 0 blocker、0 warning、0 stale Evidence；Evaluation Coverage 不下降。
- Atlas `audit` 为 0 Finding；`graph check` 为 0 violation。
- 三项 Atlas 项目 Gate 全绿。
- Universal Harness `pnpm verify` 全绿。
- `codex/harness-driven-t5` 本地及 Gitee 远程均不存在。
- 两个仓库 `main` 已推送、无未提交改动。
