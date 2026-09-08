# SSE 产出引用盘点（实现前核对）

核对日期：2026-09-08（Task 5 实施完成时复核）；基线：`00f0c9e`（Task 1–4 已合入）。此表是代码盘点与测试落点记录。
Task 1–4 已落地：Protocol 1.4 与 ApprovalDecided（Task 3）、审批决定共享摘要与
`/api/v1/artifacts/:digest?kind=approval_decision&scope=artifact` 受控入口（Task 4）均已存在。
Task 5 已落地：15 类产出的通用指定版本正文读取（`readArtifactView`）、9 个提交点的 ArtifactAvailable 补缺事件（1.4 pin）、
REST 分页导航与浏览器 SSE 链接点击呈现。

## 通用引用边界

- 权威文件均相对 `.harness/`；必须先找到已提交 manifest，再验证文件字节 SHA-256 属于该 manifest 的 `artifact_digests`。
- 文件名中的 digest、领域 `digest/record_digest` 不必等于字节 SHA-256，不能互相替代。
- `commitArtifacts()` 默认没有生命周期事件（[实现](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L540)）。
  之后的 Checkpoint 属于另一次事务，不能假定其 manifest 包含上一次的资产。
- 单资产用 artifact scope；无独立根记录的批次/派生视图用 manifest scope，并列出完整源引用。
- 当前浏览器按 session `event_types` 注册命名监听（[实现](../../packages/dashboard/assets/dashboard.js#L1790)），
  旧服务无该字段时回退到十类观测事件静态表（[实现](../../packages/dashboard/assets/dashboard.js#L1760)）。
  表中的 Ledger 事件存在不等于浏览器已经订阅，更不等于能打开历史正文。

## 15 类实际落点

| kind               | 权威来源和实际写入点                                                                                                                                                  | 当前事件/导航绑定                                                                                     | 现有读取与缺口                                                                         | 目标测试（Task 5） |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------ |
| approval_decision  | `artifacts/approvals/<id>.json`；[resolveDecision](../../packages/runtime/src/approval/service.ts#L344)                                                               | ApprovalDecided 与 Decision 同事务（1.4 pin），payload 带 decision_digest 字节摘要                    | `readApprovalSummary` 按字节 digest 读取指定版本；REST `kind=approval_decision&scope=artifact` 已通；其余 kind 待 Task 5 | artifact-reader.test.ts `approval_decision` 参数化用例；dashboard-artifact-boundaries.test.ts |
| prd                | `artifacts/capture/accepted/<prd>/<revision>.json`；[Capture acceptance](../../packages/core/src/acceptance/commit.ts#L321)                                           | accepted/Proposal/baseline 同事务，events 为空；需要直接引用该事务                                    | Capture 有领域读取；缺通用指定版本正文入口                                             | artifact-reader.test.ts `prd` 参数化用例；dashboard-transparency.test.ts |
| design_set         | `artifacts/design-sets/<id>/<revision>.json` 及 design assets；[design contributor](../../packages/runtime/src/orchestration/contributors/design-contributor.ts#L205) | 资产与后续 Checkpoint 分开提交                                                                        | Graph 可查设计节点；不是 DesignSet 历史资产全集视图                                    | artifact-reader.test.ts `design_set` 参数化用例；dashboard-transparency.test.ts |
| plan               | `artifacts/plans/<id>.json` 和 tasks；[phasePlan](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L2778)                                               | PlanAccepted 在后续 Checkpoint；只有 planId 等业务字段，不是资产所在 manifest                         | Iteration/Graph 可查 Plan；缺按字节 digest 固定版本的任务明细                          | artifact-reader.test.ts `plan` 参数化用例（同对象两版本）；dashboard-transparency.test.ts |
| context_manifest   | `artifacts/context-bundles/<id>.json`；[phaseContext](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L2910)                                           | 多 Task bundle 批次先提交，ContextCompiled 后提交；批次用 manifest scope                              | 运行时读取 bundle；缺完整批次来源和保护字段安全视图                                    | artifact-reader.test.ts `context_manifest` 参数化用例；dashboard-transparency.test.ts |
| run_summary        | `artifacts/run-results/<run>.json` + Run 流；[phaseExecute](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L3460)                                     | RunTerminated 是 Live；结果另行 commit，无直接权威完成事件                                            | Scheduler/Iteration 有摘要；派生摘要必须绑定结果和 Run 源集合，不得返回原始 transcript | artifact-reader.test.ts `run_summary` 参数化用例（无原始 transcript）；dashboard-transparency.test.ts |
| gate_result        | verify summary + 本批 Evidence；[phaseVerify](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L4152)                                                   | GateCompleted 观测/Checkpoint 不等于本批资产事务；批次可用 manifest scope                             | Evidence 列表可查；缺历史 verify 批次正文，失败分支也须覆盖                            | artifact-reader.test.ts `gate_result` 参数化用例（含失败分支）；dashboard-transparency.test.ts |
| evidence           | `artifacts/evidence/<id>/<digest>.json`；[phaseVerify](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L4204)，Scheduler 也提交                        | 应引用文件字节 digest；现有语义 digest 不可直接作为字节引用                                           | `/api/v1/evidence` 提供列表；缺统一已提交版本正文和脱敏约束                            | artifact-reader.test.ts `evidence` 参数化用例；dashboard-artifact-boundaries.test.ts（digest 不混用） |
| evaluation         | `artifacts/evaluations/<id>/<digest>.json`；[evaluateTaskRun](../../packages/runtime/src/orchestration/contributors/evaluation-contributor.ts#L337)                   | EvaluationCompleted 在后续 phase Checkpoint，只摘要末项；不能覆盖所有独立评估提交                     | 评估参与图查询；缺该次评价、Findings 与源 Evidence 的固定版本视图                      | artifact-reader.test.ts `evaluation` 参数化用例；dashboard-transparency.test.ts |
| snapshot           | `artifacts/snapshots/<id>.json`；[phaseSnapshot](../../packages/runtime/src/orchestration/kernel-pipeline-driver.ts#L442)，blocked 路径也提交                         | OperationCompleted 在后续 advance；不是快照所在事务                                                   | Iteration API 可查看迭代状态；不能视作已验证的历史 Snapshot 字节导航                   | artifact-reader.test.ts `snapshot` 参数化用例；dashboard-transparency.test.ts |
| tdd_artifact       | cycles/evidence/grants；[executeRequiredTddTask](../../packages/runtime/src/orchestration/execution-runtime.ts#L132)，执行阶段提交返回的 artifacts                    | 本批次多种记录；不能只看 TddCycle 类事件名推断覆盖；优先 manifest scope                               | TDD 读模型存在；缺批次中红/绿/授权的完整安全来源链接                                   | artifact-reader.test.ts `tdd_artifact` 参数化用例；dashboard-transparency.test.ts |
| finding_group      | `artifacts/findings/<id>/<status>.json`、图关系及组成员；[phaseVerify](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L4208)                          | 组是派生对象，不是独立权威 artifact；需按事务边界重建源记录集合                                       | `/api/v1/finding-groups` 是当前组列表；缺历史组快照与完整输入引用                      | artifact-reader.test.ts `finding_group` 参数化用例（manifest scope 全源集合）；dashboard-transparency.test.ts |
| wave_result        | `artifacts/scheduling/<op>/waves/<id>.json`；[SchedulerAuthority.commit](../../packages/runtime/src/orchestration/scheduler-runtime.ts#L983)                          | WaveIntegrated 带 wave_integration_id，可在同 transition batch 的 manifest 绑定资产；非终态更新需另测 | Scheduler View 展示波次；缺独立指定版本安全正文                                        | artifact-reader.test.ts `wave_result` 参数化用例；dashboard-transparency.test.ts |
| integration_record | `artifacts/integrations/<id>.json`；[integration write plan](../../packages/runtime/src/collaboration/integration.ts#L686)                                            | IntegrationAccepted 与资产同 manifest；payload 的 record_digest 仍需映射到字节 digest                 | Collaboration 列表/冲突视图；缺通用历史 Integration 正文                               | artifact-reader.test.ts `integration_record` 参数化用例；dashboard-transparency.test.ts |
| task_lease         | `artifacts/scheduling/<op>/leases/<id>.json`；[SchedulerAuthority.commit](../../packages/runtime/src/orchestration/scheduler-runtime.ts#L983)                         | TaskLeaseGranted 可与 grant_lease 在同 batch；终止 Lease 同样需要覆盖检查                             | Scheduler View 读租约；缺历史指定版本与 fencing 等敏感字段安全摘要                     | artifact-reader.test.ts `task_lease` 参数化用例（fencing 字段安全摘要）；dashboard-transparency.test.ts |

## 条件事件补缺清单与测试落点

可以复用已有同事务事件的类别：approval_decision（ApprovalDecided 已随 Task 3 同事务提交）、
integration_record（IntegrationAccepted 同事务）、携带资产的 Scheduler transition batch
（TaskLeaseGranted/WaveIntegrated 与 lease/wave 记录同 manifest）。不得仅因已有某个事件名就对所有更新分支判定覆盖。

需要在原提交点补直接产出引用的明确类别：Capture acceptance、DesignSet、Plan/Task、Context bundle、
Run result、Verify Evidence/summary/Findings、独立 Evaluation、Snapshot，以及无同事务事件的 TDD 批次。
采用原设计的唯一条件性 ArtifactAvailable；不新增每资产一种事件。

Task 5 已按清单在 9 个提交点补入 ArtifactAvailable（payload `artifact_kind`/`record_digest`/`summary`，
事务 pin Protocol 1.4，schema 生成物已重新生成）：capture acceptance（core commit.ts）、
design-contributor.commitAcceptedDesign、phasePlan、phaseContext、phaseExecute（run result 与 TDD 批次）、
phaseVerify、kernel-coordinator.blockWithSnapshot、kernel-pipeline-driver.phaseSnapshot。
残留缺口：phaseExecute legacy 路径的 TDD 批次提交点无独立端到端测试，由 builder 单测、
artifact-reader fixture 与 dashboard-transparency e2e 覆盖；governed profile 的 DAG runner 路径
（createStrictTddExecuteDagRunner）不走 legacy commitArtifacts，未补事件。

Task 5 测试落点（均已通过）：

1. `packages/runtime/test/observability/artifact-reader.test.ts`（34 用例）：15 kind 参数化真实 Ledger
   fixture；同对象两版本、旧事件打开旧版本、伪造/缺失/修改字节、orphan artifact、manifest scope 全源集合、
   分页 cursor、8KiB 文本分片、256KiB 视图上限、secret 脱敏。
2. `packages/dashboard/test`（artifact-view 10、presentation 26、sse 16）与
   `tests/security/dashboard-artifact-boundaries.test.ts`（5 用例）：不接受客户端路径、不返回 raw
   transcript/prompt/PII、字节 digest 与 semantic digest 不混用、符号链接逃逸 fail-closed、env secret 脱敏、
   kind 伪装拒绝、超大帧只有界 stream_error 且不自动重连。
3. `tests/e2e/dashboard-transparency.test.ts`（19 用例，已注册进 playwright.dashboard.config.ts 并从
   vitest.workspace.ts 排除）：14 个 artifact-scope kind 的 SSE 链接点击打开固定字节 digest 安全视图、
   finding_group manifest scope 安全视图、伪造 href 拒绝（零网络请求）、旧服务缺 event_types 回退、
   未知新事件类型回退呈现、stream reset 后重放并 live→ledger 同行升级。
4. 提交点事件断言：`packages/core/test/acceptance/acceptance.test.ts`（ArtifactAvailable 同事务）、
   `packages/runtime/test/orchestration/orchestrator.test.ts`（全迭代六类事件可解析且
   provenance.ledger_operation_id 绑定）、`design-phase.test.ts`（design_set）、
   `phases.test.ts`（builder 单测）、`packages/core/test/protocol/protocol-1.4.test.ts`（payload 严格校验）。

现有 `packages/core/test/ledger/observer-validation.test.ts` 和
`packages/runtime/test/observability/event-stream-recovery.test.ts` 只验证事件源/游标，不代替上述正文覆盖。
四客户端共享读取、浏览器延迟/RSS 门槛不在 Task 5 范围，此表不作判定。
