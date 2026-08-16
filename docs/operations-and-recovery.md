# 运维与恢复手册

本文是 M1 的运行手册：`new`/`adopt`/`iterate` 三条编排路径的全部批准点、触发条件、可用 Decision、暂停/恢复行为，以及各类故障下的恢复操作。

M2 的 Finding 分组、语义建议、LLM Judge、Dashboard 与 EventStream 运维见 [M2 运维指南](operations.md)。

## 执行治理、迁移与长运行观测

Agent 执行入口采用 fail-closed 预检。缺失影响路径、原子验收、Task-local Context、CapabilityGrant 或 ExecutionAuthorization 时不会调用 Provider。当前结构完整但尚未批准时返回 `approval_required`；旧开放迭代结构不完整时返回 `migration_required`，并把精确原因追加到 `.harness/artifacts/migrations/`。

迁移记录与 blocked checkpoint 在同一个 Ledger 事务中提交。执行 `harness resume <workflow-operation-id>` 后，Harness 稳定回到 `impact` 或 `plan`，重建失效的下游 artifact。旧文件保持原字节、只读可审计；重复 resume 不会复制 migration、Approval、Grant 或 Run。不要通过手改 WorkingState 或复制旧 approval digest 绕过迁移。

当前命令的聚合进度写 stderr，最终人类输出或 JSON 写 stdout。live spool 每 5 秒记录 heartbeat，终端每 30 秒最多显示一次摘要；另一个终端可运行 `harness watch --follow`，或用 `harness status --json` 查看 `active_run`。live spool 可删除、可截断，不参与完成判定。

status、Snapshot 与后续 checkpoint 使用同一个 live blocker 投影：approve/reject/supersede、passed TaskVerdict、closed/superseded Finding 会消除对应 blocker；defer 始终保留 pending blocker。

## 1. 批准点总表

M1 的治理原则是 Agent 提案、Harness 决策。以下每个批准点都会暂停编排，直到人工作出 Decision。**M1 不提供批量批准**：每个批准请求绑定一个对象及其内容摘要（digest），必须逐一显式解决；`approve` 一次只解决一个请求。

| 批准点 | 触发条件 | 可用 Decision | 暂停行为 |
|---|---|---|---|
| AdoptionBaseline（staging 预览） | `harness adopt` 扫描完成、生成 Preview Digest 后 | approve / reject / defer | 非交互：返回 `staging_operation_id`，以 `harness adopt ... --approve <id>` 恢复；reject 关闭提案但保留审计历史 |
| RequirementBaseline | 每次迭代录入需求后、影响分析前 | approve / reject / defer | 非交互：退出码 11，返回 `request_id` 与 `workflow_operation_id`；`harness approve` + `harness resume` 恢复 |
| ImpactSet | 影响分析生成 ImpactSet 后、生成 ExecutionPlan 前 | approve / reject / defer | 同上；批准后 ImpactSet 被冻结，Planning 只能从冻结集开始 |
| Tool / 外部动作授权 | Policy Decision 为 `requires-approval`（提升能力、受限资源或外部副作用）时 | approve / reject / defer | 同上；`deny` 永远不能被批准改成 `allow` |
| ImprovementCandidate promotion | 存在可复用经验、提案晋升为目标 Artifact 的正式 Revision 前 | approve / reject / defer | 未批准的候选不修改任何 Requirement、Decision、Policy、Tool 或 Evaluation 资产 |
| Pack 安装 / 升级 | Pack 版本变化，校验 Content Digest 并展示 Provenance 与迁移预览后 | approve / reject / defer | 失败的迁移自动回滚；Project Override 永远不被升级覆盖 |

交互式终端中，批准点在同一命令会话内展示预览并等待回答；EOF、Ctrl-C 或终端断开一律视为 `defer`（保留可恢复提案），不会意外批准。

非交互会话中，批准点返回结构化 ApprovalRequest（JSON 中的 `request_id`、`object_type`、`object_id`、`object_digest`、`workflow_operation_id`、`resume_command`），退出码为 11（`approval_required`）；恢复固定为：

```bash
harness approve <request-id> --decision approve --actor human:<id>
harness resume <workflow-operation-id>
```

## 2. 暂停、Checkpoint 与 Resume

- 编排按 phase 推进，每个 phase 边界提交 Checkpoint。`blocked` 状态保存 `resume_state`，`harness resume <workflow-operation-id>` 从**最近提交的 Checkpoint** 继续。
- Resume 幂等：不重复创建 Node、Run、Evidence、commit 或外部副作用。同一对象同一 digest 的批准请求永不重复创建；已终止的 approve 决定直接重放。
- 进程中断（kill、崩溃）不会留下半成品权威记录：恢复时为未终止 Run 恰好追加一条 `RunInterrupted` 与 `RESUMES` 关系，并对账处于不确定状态的外部动作，而不是盲目重放。
- Mandatory Gate 或强制评估阈值失败会创建 Finding 并阻止 `completed` 快照；可恢复失败生成带 Resume Phase 的 `blocked` 快照，只有显式取消或类型化不可恢复原因才生成 `aborted`。
- Approval、ContextBundle 与 Evidence 绑定对象 digest：Requirement、Policy、Impact、Artifact 或 Gate 变化会按适用范围使它们级联失效，需要重新批准/编译。

## 3. 故障恢复手册

| 症状 | 恢复操作 |
|---|---|
| 进程中断后状态不明 | `harness status` 查看下一步；`harness resume <workflow-operation-id>` 从 Checkpoint 继续 |
| Baseline 漂移封死 resume/approve（HEAD 在 Checkpoint 后前进） | `harness abort <workflow-operation-id>` 显式终止该编排（待批准请求一并 reject，审计留痕），再重新 `iterate`；reject 决定本身不受漂移限制 |
| SQLite 缓存删除或损坏 | `harness graph sync` 从 Git Ledger 完整重建（SQLite 只是可丢弃投影） |
| Ledger 与缓存不一致、分片冲突 | `harness graph check` 校验完整性；冲突（同 `ledger_operation_id` digest 不同、Revision 分叉、Baseline 不兼容）会被阻塞，要求显式解决 |
| Git 仓库漂移（HEAD 与 Ledger Baseline 不一致） | `harness doctor` 诊断；按提示重新同步或显式解决后再迭代 |
| 批准过期或被级联失效 | 重新走批准点：旧请求保持终态，新 digest 生成新请求 |
| 预算耗尽（step/token/duration/retry/repeat-action 上限） | Run 以类型化原因终止并生成 Finding；调整 Policy（受 Hard Ceiling 约束）或缩小 Task 后 `iterate` |
| 部分 Gate 失败 | 失败的 Mandatory Gate 生成 Finding 与 RCA，修复证据 fresh 后 Finding 关闭，迭代继续 |
| 审计 Finding 需要人工处置 | `harness finding accept\|close\|supersede <id>`（close 需 `--evidence` 绑定当前通过的修复证据）；历史欠账的关系缺口用 `harness graph propose-edge` + `approve-edge` 正规补边 |
| 外部动作结果不确定 | Resume 对账（reconcile）该动作的 intent 记录，幂等续跑，不产生重复副作用 |

## 4. M1 限制

- 不批量批准：没有"全部批准"开关，也不存在把 `deny` 改为 `allow` 的管理员例外；Installation Hard Bound 不能被 Project/Pack Policy 放宽。
- 缺少等价控制的 Delegated Adapter 被强制设为 Supervised Mode，不允许无人值守运行；Opaque Delegated Provider 永远不会被描述为完全受治理。
- 单一仓库：M1 只操作一个仓库（identity 已为 M3 预留 repository 限定）。
- 原始轨迹（Raw Trace）不入 Git；已脱敏结构化 Event 全量保留。
