# SSE 产出引用盘点（实现前核对）

核对日期：2026-09-08；基线：`2084617`，加本轮事件读取修复。此表是代码盘点，不是正文导航的通过证明。
原六任务计划要求盘点先于编码；本轮先完成了可独立复现的事件读取修复，随后补此盘点，执行顺序与原计划不同。
尚未增加 Protocol 1.4、ArtifactAvailable、ApprovalDecided 或通用 Artifact REST API。

## 通用引用边界

- 权威文件均相对 `.harness/`；必须先找到已提交 manifest，再验证文件字节 SHA-256 属于该 manifest 的 `artifact_digests`。
- 文件名中的 digest、领域 `digest/record_digest` 不必等于字节 SHA-256，不能互相替代。
- `commitArtifacts()` 默认没有生命周期事件（[实现](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L540)）。
  之后的 Checkpoint 属于另一次事务，不能假定其 manifest 包含上一次的资产。
- 单资产用 artifact scope；无独立根记录的批次/派生视图用 manifest scope，并列出完整源引用。
- 当前浏览器只注册十类观测事件（[实现](../../packages/dashboard/assets/dashboard.js#L1630)）。
  表中的 Ledger 事件存在不等于浏览器已经订阅，更不等于能打开历史正文。

## 15 类实际落点

| kind               | 权威来源和实际写入点                                                                                                                                                  | 当前事件/导航绑定                                                                                     | 现有读取与缺口                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| approval_decision  | `artifacts/approvals/<id>.json`；[resolveDecision](../../packages/runtime/src/approval/service.ts#L366)                                                               | Decision 与 approval Checkpoint 同事务；尚无 ApprovalDecided                                          | Approval 服务可读决定；Dashboard 待决卡片不是按字节 digest 读取的历史决定摘要          |
| prd                | `artifacts/capture/accepted/<prd>/<revision>.json`；[Capture acceptance](../../packages/core/src/acceptance/commit.ts#L321)                                           | accepted/Proposal/baseline 同事务，events 为空；需要直接引用该事务                                    | Capture 有领域读取；缺通用指定版本正文入口                                             |
| design_set         | `artifacts/design-sets/<id>/<revision>.json` 及 design assets；[design contributor](../../packages/runtime/src/orchestration/contributors/design-contributor.ts#L205) | 资产与后续 Checkpoint 分开提交                                                                        | Graph 可查设计节点；不是 DesignSet 历史资产全集视图                                    |
| plan               | `artifacts/plans/<id>.json` 和 tasks；[phasePlan](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L2874)                                               | PlanAccepted 在后续 Checkpoint；只有 planId 等业务字段，不是资产所在 manifest                         | Iteration/Graph 可查 Plan；缺按字节 digest 固定版本的任务明细                          |
| context_manifest   | `artifacts/context-bundles/<id>.json`；[phaseContext](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L3005)                                           | 多 Task bundle 批次先提交，ContextCompiled 后提交；批次用 manifest scope                              | 运行时读取 bundle；缺完整批次来源和保护字段安全视图                                    |
| run_summary        | `artifacts/run-results/<run>.json` + Run 流；[phaseExecute](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L3842)                                     | RunTerminated 是 Live；结果另行 commit，无直接权威完成事件                                            | Scheduler/Iteration 有摘要；派生摘要必须绑定结果和 Run 源集合，不得返回原始 transcript |
| gate_result        | verify summary + 本批 Evidence；[phaseVerify](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L4202)                                                   | GateCompleted 观测/Checkpoint 不等于本批资产事务；批次可用 manifest scope                             | Evidence 列表可查；缺历史 verify 批次正文，失败分支也须覆盖                            |
| evidence           | `artifacts/evidence/<id>/<digest>.json`；[phaseVerify](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L4204)，Scheduler 也提交                        | 应引用文件字节 digest；现有语义 digest 不可直接作为字节引用                                           | `/api/v1/evidence` 提供列表；缺统一已提交版本正文和脱敏约束                            |
| evaluation         | `artifacts/evaluations/<id>/<digest>.json`；[evaluateTaskRun](../../packages/runtime/src/orchestration/contributors/evaluation-contributor.ts#L337)                   | EvaluationCompleted 在后续 phase Checkpoint，只摘要末项；不能覆盖所有独立评估提交                     | 评估参与图查询；缺该次评价、Findings 与源 Evidence 的固定版本视图                      |
| snapshot           | `artifacts/snapshots/<id>.json`；[phaseSnapshot](../../packages/runtime/src/orchestration/kernel-pipeline-driver.ts#L442)，blocked 路径也提交                         | OperationCompleted 在后续 advance；不是快照所在事务                                                   | Iteration API 可查看迭代状态；不能视作已验证的历史 Snapshot 字节导航                   |
| tdd_artifact       | cycles/evidence/grants；[executeRequiredTddTask](../../packages/runtime/src/orchestration/execution-runtime.ts#L132)，执行阶段提交返回的 artifacts                    | 本批次多种记录；不能只看 TddCycle 类事件名推断覆盖；优先 manifest scope                               | TDD 读模型存在；缺批次中红/绿/授权的完整安全来源链接                                   |
| finding_group      | `artifacts/findings/<id>/<status>.json`、图关系及组成员；[phaseVerify](../../packages/runtime/src/orchestration/kernel-coordinator.ts#L4208)                          | 组是派生对象，不是独立权威 artifact；需按事务边界重建源记录集合                                       | `/api/v1/finding-groups` 是当前组列表；缺历史组快照与完整输入引用                      |
| wave_result        | `artifacts/scheduling/<op>/waves/<id>.json`；[SchedulerAuthority.commit](../../packages/runtime/src/orchestration/scheduler-runtime.ts#L1010)                         | WaveIntegrated 带 wave_integration_id，可在同 transition batch 的 manifest 绑定资产；非终态更新需另测 | Scheduler View 展示波次；缺独立指定版本安全正文                                        |
| integration_record | `artifacts/integrations/<id>.json`；[integration write plan](../../packages/runtime/src/collaboration/integration.ts#L686)                                            | IntegrationAccepted 与资产同 manifest；payload 的 record_digest 仍需映射到字节 digest                 | Collaboration 列表/冲突视图；缺通用历史 Integration 正文                               |
| task_lease         | `artifacts/scheduling/<op>/leases/<id>.json`；[SchedulerAuthority.commit](../../packages/runtime/src/orchestration/scheduler-runtime.ts#L1002)                        | TaskLeaseGranted 可与 grant_lease 在同 batch；终止 Lease 同样需要覆盖检查                             | Scheduler View 读租约；缺历史指定版本与 fencing 等敏感字段安全摘要                     |

## 条件事件补缺清单与测试落点

可以复用已有同事务事件的类别：审批 Checkpoint（将由专用 ApprovalDecided 补充语义）、IntegrationAccepted、
携带资产的 Scheduler transition batch。不得仅因已有某个事件名就对所有更新分支判定覆盖。

需要在原提交点补直接产出引用的明确类别：Capture acceptance、DesignSet、Plan/Task、Context bundle、
Run result、Verify Evidence/summary/Findings、独立 Evaluation、Snapshot，以及无同事务事件的 TDD 批次。
采用原设计的唯一条件性 ArtifactAvailable；不新增每资产一种事件。

Task 5 实施时，以下仍为**未实施/未验证**：

1. `packages/runtime/test/observability/artifact-reader.test.ts`：15 kind 参数化真实 Ledger fixture；
   同对象两版本、旧事件打开旧版本、伪造/缺失/修改字节、orphan artifact、manifest scope 全源集合。
2. `packages/dashboard/test` 与 `tests/security/dashboard-artifact-boundaries.test.ts`：
   不接受客户端路径、不返回 raw transcript/prompt/PII、字节 digest 与 semantic digest 不混用、受控分页。
3. `tests/e2e/dashboard-transparency.test.ts`：动态订阅注册事件、点击安全正文、历史批准/拒绝/暂缓、
   reset 后恢复和旧服务兼容。

现有 `packages/core/test/ledger/observer-validation.test.ts` 和
`packages/runtime/test/observability/event-stream-recovery.test.ts` 只验证事件源/游标，不代替上述正文覆盖。
完整产出导航、32 KiB 摘要帧、四客户端共享读取、浏览器延迟/RSS 门槛尚不能据此表判定通过。
