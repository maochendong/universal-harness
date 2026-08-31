# Universal Harness M4 本地 Multi-Agent 调度正式设计

日期：2026-08-31  
状态：设计章节已确认，待正式文档复核  
目标协议：Protocol 1.3  
范围：单仓库、单 Coordinator、单机同构 Agent Adapter 并发池  

依据：

- `docs/superpowers/specs/2026-08-11-universal-harness-m1-design.md`
- `docs/superpowers/specs/2026-08-15-m2-m3-scope-decisions.md`
- `docs/superpowers/specs/2026-08-18-harness-slim-profiles-design.md`
- `docs/superpowers/specs/2026-08-18-provable-tdd-protocol-design.md`
- `docs/superpowers/specs/2026-08-29-universal-harness-m3-remote-collaboration-design.md`
- `docs/plugin-contracts.md`

## 1. 结论

M4 首版在现有 Workflow Engine 内增加一个深模块 `LocalTaskScheduler`：它读取已经批准且
不可变的 Task DAG，使用确定性 `parallel_waves`、Task Lease、Effective Policy、预算预留和
资源声明，将同一个 Agent Adapter 的多个独立实例调度到本地 Git worktree。Agent 仍然只
提交 Proposal；Workflow Engine 继续独占 WorkingState、Ledger、Checkpoint 和权威集成 ref。

M4 不重新规划 Task，不让 Agent 共享可变状态，不引入远程 Worker、Scheduler Daemon、动态
模型路由或模型冲突解决。它只把 M1 已经建立的 Task 隔离边界从“顺序 DAG”扩展成“受治理的
本地并行 DAG”。

## 2. 已确认的设计决定

1. 首版使用本机同一 Agent Adapter 的并发池，不支持远程 Worker。
2. M4 只调度已批准 Plan 中的 Task，不在运行时拆分、合并或改写 DAG。
3. `DEPENDS_ON` 是唯一权威依赖；Plan Compiler 生成 digest-bound `parallel_waves`。
4. 每个 Task 使用独立 Git worktree；Harness 是唯一集成者。
5. 首次集成冲突在最新基线上受控重调度一次；再次冲突阻塞。
6. Lite 保持单槽位；Standard 默认两个本地槽位；Governed 在 Policy 约束下并行。
7. Task Lease 权威事实进入项目 Ledger；PID、心跳和 output tail 进入本地 SQLite。
8. Scheduler 使用确定性、不可抢占的 Plan 顺序，不使用模型排序。
9. Task 必须声明最小 `write_paths` 和必要的 `exclusive_resources`。
10. 不新增固定审批次数；只有 Policy 实际返回 `requires_approval` 时才请求人工审批。
11. 验证分为 Task worktree、候选集成树和 wave Mandatory Gates 三层。
12. Agent 瞬时失败和集成冲突各最多自动恢复一次，且共享原 Task 预算。
13. 用户设置 Project 默认预算和 Iteration 总上限；Planner 在 Plan 中分配 Task 预算。
14. Dashboard 在现有 Observatory 内增加 Scheduler 视图，不建设第二套前端。
15. M4 采用 Workflow Engine 内嵌深模块，不增加本地 HTTP Scheduler 服务。

## 3. 目标与非目标

### 3.1 目标

- 对已批准的 Task DAG 做确定性本地并行调度。
- 在 Plan 阶段明确依赖、最大并行波次、写路径、独占资源和预算。
- 保持每个 Task 的 Context、Budget、Run、Worktree、Evidence 和 Checkpoint 隔离。
- 对每次调度、重试、验证和集成留下可恢复、可审计的 Ledger Evidence。
- 在 Profile、Policy、Approval 和 Adapter Control Profile 下安全降级。
- 在 CLI 和 Dashboard 中提供同一份 Task、Slot、Lease、Budget 和 Finding 投影。

### 3.2 非目标

- 远程 Worker、自注册、任务领取或 Worker 心跳协议；
- 多 Coordinator、选主、高可用或后台常驻 Scheduler Daemon；
- 跨仓库执行；
- 动态修改、拆分、合并或重新排序 Task DAG；
- Agent 间聊天、共享 Memory、共享隐藏 Provider History 或协商；
- 模型调度、模型自动合并冲突或模型批准；
- 抢占、通用优先级、等待时间提升或可配置退避引擎；
- 用 Git worktree 冒充完整 OS Sandbox；
- 让 M4 直接写 M3 的远程目标分支。

## 4. 架构与模块边界

```text
Orchestrator / Workflow Engine（唯一权威写入者）
│
├─ Plan Compiler
│   ├─ 校验 DEPENDS_ON
│   ├─ 校验 write_paths / exclusive_resources
│   └─ 生成 digest-bound parallel_waves
│
├─ LocalTaskScheduler
│   ├─ 选择 Ready Task
│   ├─ 检查 Policy / Budget / Approval
│   ├─ 授予和回收 Task Lease
│   ├─ 管理确定性候选集成队列
│   └─ 决定暂停、重试、阻塞或完成
│
├─ LocalAgentPool
│   ├─ Slot 1 → AgentAdapter
│   ├─ Slot 2 → AgentAdapter
│   └─ Slot N → AgentAdapter
│
├─ TaskWorkspaceManager
│   └─ 组合现有 IsolatedWorkspacePort
│
└─ SchedulerProjectionStore
    └─ SQLite：PID、心跳、输出摘要、槽位状态
```

### 4.1 `LocalTaskScheduler`

`LocalTaskScheduler` 是 runtime 内部的深模块。外部只能启动或恢复一个 Operation、取消它并
读取投影；外部不能直接分配槽位、修改 Lease、移动 Task 或接受集成结果。调度循环在启动
`harness run`、`harness resume` 或用户从 Dashboard 显式恢复后运行。驱动进程退出时执行停止，
下一次 `resume` 从 Ledger 恢复；不存在隐藏的后台守护进程。

### 4.2 `LocalAgentPool`

Pool 只管理同一 Adapter 的独立进程实例、槽位和本地瞬时观测。它不读取 Plan，不判断 Task
成功，不写 Ledger，也不拥有 Git 集成权限。每个 Slot 必须使用独立 TaskEnvelope、Run identity、
预算计量和显式 ResumeContext，禁止复用隐藏对话历史或 Adapter-local mutable state。

### 4.3 `TaskWorkspaceManager`

M4 不新增第二套 Workspace 公共端口。`TaskWorkspaceManager` 是 runtime 内部组合层，复用现有：

- `IsolatedWorkspacePort`；
- `createGitWorktreeWorkspacePort`；
- `createInMemoryWorkspacePort`。

它负责 Task worktree、规范化 diff、Task commit、候选集成树和终态清理；它不拥有 Task 状态、
Policy 或 Ledger。

### 4.4 `SchedulerProjectionStore`

SQLite 保存 PID、心跳、槽位、输出 tail 和本地 worktree 定位信息。它是可删除投影：删除后必须
可从 Ledger 和 Git 临时对象重建权威 Task 状态；SQLite 内容永远不能使 Task 成功、批准或集成。

## 5. Port 契约

M4 正式落实 M1 中只以兼容名称保留的两个 Interface。

### 5.1 `TaskDagPort`

职责：读取批准后的 Plan、Task、Dependency、资源声明、波次和执行投影。它不修改 Plan，不
接受 Agent 自述，也不直接写 Checkpoint。提供 Ledger 实现和 InMemory conformance 实现。

### 5.2 `PolicyDecisionPort`

职责：对规范化 `dispatch_task`、`retry_task` 和 `integrate_wave` Action 返回：

```text
allow | deny | requires_approval
```

它不执行副作用。`deny` 不能被 Approval 覆盖；`requires_approval` 只允许绑定当前精确对象的
批准满足，不产生一般授权。

### 5.3 复用接口

- `AgentAdapter`
- `EvaluationPort`
- `ContextAssemblyPort`
- `ToolRegistryPort`
- `IsolatedWorkspacePort`

Git 和 SQLite 的实现 seam 保持 runtime 内部，不扩展插件公共 SDK。

## 6. Plan、依赖与资源模型

### 6.1 `TaskSpecification` 1.3 扩展

```ts
interface TaskSpecification {
  readonly id: string;
  readonly objective: string;
  readonly dependencies: readonly string[];

  readonly write_paths: readonly string[];
  readonly exclusive_resources: readonly string[];

  readonly budget: {
    readonly steps: number;
    readonly tokens: number;
    readonly duration_ms: number;
  };

  readonly impact_paths: readonly (readonly string[])[];
  readonly expected_outputs: readonly string[];
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly risk: TaskRisk;
  readonly acceptance: readonly TaskAcceptanceCriterion[];
  readonly assertions: readonly TaskAcceptanceAssertion[];
  readonly required_gates: readonly string[];
}
```

`write_paths` 必须使用已规范化的仓库相对路径或目录范围。`.git`、Harness 权威目录、绝对路径、
路径穿越和以仓库根目录掩盖未知范围的声明均被拒绝。`exclusive_resources` 使用项目内稳定资源键，
例如 `database-schema`、`service-port:8080` 或 `generated-client`。

### 6.2 权威依赖与波次

`dependencies` 及其 `DEPENDS_ON` 边是唯一权威依赖。ExecutionPlan 增加：

```ts
readonly iteration_budget: {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms: number;
};

readonly parallel_waves: readonly {
  readonly wave_index: number;
  readonly task_ids: readonly string[];
}[];
```

`iteration_budget` 是本次迭代实际采用的总预算，不等于 Project Policy ceiling；它由 Planner 在
ceiling 内提出，经 Plan Approval 后冻结并进入 Plan digest。运行时不能静默提高。

Plan Compiler 按以下步骤确定性生成波次：

1. 校验所有依赖存在且 DAG 无环；
2. 按依赖计算拓扑层级；
3. 在同层中拆分重叠写路径和相同独占资源；
4. 使用 Plan 中 Task 声明顺序作为稳定 tie-break；
5. 重算结果必须与持久化 `parallel_waves` 完全一致；
6. `parallel_waves` 进入 Plan semantic digest，但不允许被独立编辑。

只读访问不形成资源锁。同一 wave 的所有 Task 都读取同一个冻结 base commit；如果一个 Task
需要另一个 Task 的新输出，Plan 必须显式建立 `DEPENDS_ON`，而不能依赖并行执行的完成先后。
write/write 路径重叠和相同独占资源一定不能进入同一 wave。

### 6.3 旧 Plan

Protocol 1.0–1.2 Plan 不推断 `write_paths`，也不被静默并行化。它们继续顺序执行；用户要求
并行时必须重新生成并批准 Protocol 1.3 Plan。

## 7. Task 状态投影

批准后的 Task 节点保持不可变。Scheduler 与 Dashboard 根据 Ledger 的 Lease、Run、Gate、
Evidence、Finding、Approval 和 WaveIntegration 确定性投影：

```text
waiting_dependency
  ↓
ready
  ├─→ awaiting_approval ─→ ready
  ↓
running
  ↓
verifying
  ↓
integration_queued
  ↓
candidate_validated
  ↓
integrated
```

异常分支：

```text
running / verifying / integration_queued
  ├─→ retry_pending ─→ ready
  └─→ blocked

任意非终态 ─→ cancelled
```

- `waiting_dependency`：依赖尚未集成，或不属于最早未完成 wave；
- `ready`：依赖、能力、资源、预算和 freshness 条件满足；
- `awaiting_approval`：Policy 返回 `requires_approval`；
- `running`：当前 Lease 的 Agent 正在独立 worktree 中执行；
- `verifying`：Agent 已结束，正在验证 Assertions 和 Required Gates；
- `integration_queued`：Task 本地验证通过，等待确定性候选集成；
- `candidate_validated`：已在最新候选树通过相关 Gate，等待 wave 门禁；
- `retry_pending`：符合受控自动恢复条件；
- `integrated`：wave 已通过并产生 `WaveIntegrationRecord`；
- `blocked`：需要人工处理或回到上游阶段；
- `cancelled`：用户取消且副作用已完成对账。

不增加稳定 `failed` 状态：可恢复失败进入 `retry_pending`，不可恢复失败进入 `blocked`。

## 8. Task Lease 与预算预留

### 8.1 Lease 状态机

Task Lease 是独立的离线 Ledger 记录，不依赖 M3 Control Ref 或远程 Principal：

```text
granted
  ├─→ released
  ├─→ expired
  └─→ revoked
```

首版不写周期性 `renewed` 记录。SQLite heartbeat 只证明进程可能存活，不延长权威期限。需要提高
执行时限时，必须形成预算授权和新的 Lease epoch。

### 8.2 `TaskLeaseRecord`

```ts
interface TaskLeaseRecord {
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly plan_digest: Digest;
  readonly task_id: string;
  readonly task_digest: Digest;
  readonly run_id: string;
  readonly slot_id: string;
  readonly baseline_commit: GitCommit;
  readonly agent_adapter_digest: Digest;
  readonly policy_digest: Digest;
  readonly approval_digests: readonly Digest[];

  readonly lease_id: string;
  readonly previous_lease_digest?: Digest;
  readonly fencing_token: number;
  readonly state: "granted" | "released" | "expired" | "revoked";

  readonly attempt_number: number;
  readonly retry_kind?: "executor_retry" | "integration_retry";
  readonly reserved_budget: { readonly steps: number; readonly tokens: number };
  readonly consumed_budget: { readonly steps: number; readonly tokens: number };

  readonly issued_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly command_id: string;
}
```

同一 Task 的 `fencing_token` 单调递增。只有当前 token 对应的 Run 能进入验证或候选集成；旧进程
产生的输出只能作为 provisional Evidence。

### 8.3 Lease 生命周期的细化

Lease 覆盖 Agent 执行、Task 验证和当前 Task 的候选集成验证。Task 达到 `candidate_validated` 后，
进程、预算预留和运行时资源锁已经不再需要：Workflow Engine 写入终态 `released` Lease，但保留
其 fencing token 和 Evidence binding。后续 wave 门禁只能接受该已释放且正常完成的最新 Lease。

这一规则避免已经完成的 Task 因等待同 wave 慢 Task 而发生 Lease 过期，也不允许它被重新调度。
wave 成功后再通过 `WaveIntegrationRecord` 将 Task 投影为 `integrated`。

### 8.4 预算层级

```text
Installation Ceiling
  → Pack 默认
  → Project Policy 上限
  → Iteration 总预算
  → Plan Task 预算
  → Run / Retry 实际消耗
```

Project Policy 增加 ceiling：

```text
scheduler.max_concurrency
budgets.iteration.max_steps
budgets.iteration.max_tokens
budgets.iteration.max_duration_ms
```

Plan 中已批准的 `iteration_budget` 是运行时总额；其值不得超过 Pack、Project Policy 和
Installation Ceiling。有效 Task 预算为 Plan Task、Pack、Project Policy 和 Installation Ceiling
的最小值。Iteration 可用预算：

```text
available = iteration_limit - accumulated_consumption - active_reservations
```

Lease 发放前，Workflow Engine 在同一 Ledger 事务中预留 Task 剩余 steps/tokens。Lease 终止时，
实际消耗进入 Iteration 累计使用，未使用部分归还。Retry 只能使用该 Task 原始预算的剩余部分，
不能获得一份新预算。

duration 不做并行 Task 的加法预留：

```text
lease.expires_at = min(now + task_remaining_duration, iteration_deadline)
```

运行中的 Project/Installation Ceiling 只能收紧未来 Lease；已开始的原子步骤完成后，其结果必须
重新通过预算和 freshness 检查。

## 9. 确定性调度算法

每次调度循环严格执行：

1. 从 Ledger 重建 Task、Lease、预算和 Approval 状态；
2. 找到最早未完成 wave；
3. 按 Plan Task 顺序扫描；
4. 排除依赖未集成、资源冲突、预算不足、Context 过期或无槽位的 Task；
5. 校验 Adapter 能力与无人值守资格；
6. 调用 `PolicyDecisionPort`；
7. 必要时创建 ApprovalRequest，并只暂停该 Task；
8. 原子预留预算、获取资源锁并写入 `granted` Lease；
9. 创建 worktree、ContextBundle、CapabilityGrant 和 TaskEnvelope；
10. 启动 Agent Slot；
11. 按结果进入验证、候选集成、恢复或阻塞。

Scheduler 不抢占正常 Task，不越过当前 wave，不为了填满槽位扩大 Plan 允许的并行范围。降低
`max_concurrency` 只影响未来 Lease，不终止已经运行的 Task。

## 10. 能力匹配与 Profile

### 10.1 同构能力匹配

所有槽位使用同一 Adapter，但 Lease 发放前仍必须验证：

```text
Task.capabilities ⊆ PluginManifest.capabilities
Task.tools ⊆ CapabilityGrant.tools
Task.write_paths ⊆ CapabilityGrant.write_paths
Task.budget ≤ Effective Policy Ceiling
```

自动并行只允许 managed Adapter，或已证明 usage metering、side-effect interception、trajectory
coverage 和 resume semantics 的 delegated Adapter。manual 或不能满足 unattended eligibility 的
delegated Adapter 强制退化为单槽位监督执行。无法满足某个 Task 的 Adapter 不会被动态替换，
Scheduler 在写 Lease 前阻塞并生成可操作 Finding。

### 10.2 Profile

新增 Capability：

```text
parallel_task_execution
```

- Lite：inactive，有效并发为 1；
- Standard：active，默认本地槽位为 2；
- Governed：active，默认本地槽位为 2，高风险、共享资源或需批准 Task 按 Policy 串行。

本地 `.harness/runtime.json` 只保存期望槽位：

```json
{
  "agent_pool": {
    "slots": 4
  }
}
```

最终有效并发是 runtime 请求、Profile、Installation Policy、Project Policy 和本机资源上限的最小值。
本地配置不能扩大 Policy。

## 11. Policy 与 Approval

每个 Decision 输入至少包含 operation、iteration、Plan/Task digest、baseline、risk、capabilities、
tools、write paths、exclusive resources、Task/Iteration 剩余预算、Adapter manifest/control profile、
retry kind、Approval digest 和 Effective Policy digest。

批准规则：

- 不增加“每个 Task”或“每个 wave”的固定审批；
- 复用已经批准的 PRD、Impact、DesignSet 和 Plan；
- 只有 Policy 对 `dispatch_task`、`retry_task` 或 `integrate_wave` 返回 `requires_approval` 时请求批准；
- Approval 绑定精确对象、Plan、baseline、Policy、预算和 Adapter digest；
- 任一绑定漂移都使 Approval 失效；
- Agent 或 Model 只能提供 brief，不能批准。

## 12. 资源锁与写集治理

Plan 资源声明是权威输入，runtime 锁只提供执行保护。锁键确定性生成：

```text
write:<normalized-repository-path>
exclusive:<resource-key>
```

所有锁必须按规范化键排序后一次性获取，不允许部分持有，因此首版不需要优先级、锁升级或通用
死锁检测器。锁绑定 `task_id + fencing_token`；Lease 释放、撤销或过期时释放。Coordinator 重启
后从活动 Lease 重建锁，SQLite 旧锁无效。

Agent 实际 Git diff 必须完全位于批准 `write_paths`。未声明写入、`.git`、Harness 权威目录、
绝对路径、路径穿越或 symlink 逃逸会终止 Run 并产生 Finding；Scheduler 不动态扩权。

## 13. Worktree 与候选集成

### 13.1 Task Worktree

同一 wave 的 Task 从同一个冻结 base commit 创建独立 detached Git worktree。Agent 只在该
worktree 中执行，不获得主工作区、迭代分支或 Ledger 写权限。Task 结束后，Harness 规范化 diff、
验证写集并封装 Task commit；Agent 自己产生的 commit metadata 不作为权威输入。

### 13.2 三层验证

1. Task worktree 内运行 Assertions 和 Required Gates；
2. Task commit 应用到最新候选集成树后重跑相关 Gate；
3. wave 全部 `candidate_validated` 后运行项目 Mandatory Gates。

每层 Evidence 都必须绑定实际 baseline/candidate commit、Gate definition digest、Run、Task 和
Lease fencing token；旧 Evidence 不得复用。

### 13.3 Wave 原子集成

```text
各 Task 本地验证通过
  ↓
按 Plan 顺序应用到 candidate worktree
  ↓
逐 Task 候选树 Gate
  ↓
全部 candidate_validated
  ↓
wave Mandatory Gates
  ↓
最终 freshness + CAS
  ↓
一次推进 operation-local integration ref
  ↓
WaveIntegrationRecord
```

wave Gate 失败时权威 ref 不移动；候选树可以重建；Task branch、Evidence 和 Finding 保留。后继
Task 依赖的是前置 Task 的 `integrated`，不是 Agent completion claim。

### 13.4 最终 CAS

推进前必须再次验证 Plan/Task、Policy/Approval、Gate definition、Evidence freshness、最新 Lease
token 和目标 ref。目标不再等于 wave `base_commit` 时，不 force push，也不自动重放整个 wave；
生成 `baseline_drift` blocking Finding并返回 Impact/Plan 重新确认。

Git ref 和 Ledger 必须通过现有 staged transaction/CAS 机制一次接受，不能出现“代码已推进但
Ledger 未记录”。

## 14. `WaveIntegrationRecord`

M4 只增加两个权威领域记录：`TaskLeaseRecord` 和 `WaveIntegrationRecord`。不增加
`TaskStateRecord`、`SchedulerStateRecord` 或 `ParallelGroupRecord`。

```ts
interface WaveIntegrationRecord {
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly plan_digest: Digest;
  readonly wave_index: number;
  readonly task_ids: readonly string[];

  readonly base_commit: GitCommit;
  readonly candidate_commit: GitCommit;
  readonly accepted_source_tree_digest: Digest;

  readonly task_lease_digests: readonly Digest[];
  readonly task_evidence_digests: readonly Digest[];
  readonly candidate_gate_evidence_digests: readonly Digest[];
  readonly wave_gate_evidence_digests: readonly Digest[];

  readonly policy_digest: Digest;
  readonly approval_digests: readonly Digest[];
  readonly integrated_at: Timestamp;
}
```

`accepted_source_tree_digest` 只计算项目源树，不包含承载本记录的 Ledger 内容，从而避免让记录
引用包含自身的 Git commit。最终 Git commit 由 Ledger manifest 和 CAS 结果定位。该记录是 wave
内 Task 进入 `integrated` 的唯一新增依据。

## 15. 重试、失败与取消

### 15.1 自动恢复

两类调度级恢复各最多一次：

- `executor_retry`：Agent 进程崩溃或临时超时；仍须有剩余 Task/Iteration 预算；支持 resume 的
  Adapter 可使用显式 ResumeContext，否则创建新 Run；
- `integration_retry`：首次集成冲突；保留原分支/Evidence，基于最新已集成 commit 创建新
  worktree 并重新生成所有基线相关 Evidence。

Task 内现有 execute/verify 修复循环不计入 Scheduler Retry，但消耗同一 Task 预算。

以下情况不自动重试：未声明写入、Policy deny、批准缺失/失效、预算耗尽、Schema/digest/token
不一致和第二次同类失败。

### 15.2 取消

取消会停止新 Lease、请求终止活动 Slot、对账外部副作用、撤销活动 Lease并保留分支/Evidence。
无法确认终止的外部动作按现有 uncertain 语义处理。未集成 Task 投影为 `cancelled`，不自动删除
诊断工作区。

## 16. Coordinator 恢复

启动或 `resume`：

1. 从 Ledger 重建 Task、Lease、预算和 wave；
2. 使用 SQLite 定位可能残留的 PID/worktree；
3. 尝试终止孤儿进程并对账输出；
4. 将未正常结束的旧 Lease 写为 `revoked`；
5. 丢弃未接受的候选集成树；
6. 保留 Task branch、Run、Transcript 和 provisional Evidence；
7. 根据失败类型、剩余预算和重试次数进入 `retry_pending` 或 `blocked`；
8. 新执行取得更高 fencing token。

旧进程即使仍产生输出，也无法通过新 token 的验证和集成检查。

## 17. Digest 与失效

Task semantic digest 包含 objective、outputs、impact paths、dependencies、resource claims、budget、
capabilities、tools、risk、assertions 和 required gates。Plan digest 包含全部 Task digest、
`iteration_budget`、`parallel_waves` 以及 Requirement、Impact、DesignSet、Policy 和 baseline binding。

Lease digest 额外绑定 Plan/Task、baseline、Adapter manifest、Policy、fencing token 和 reserved
budget。Gate Evidence 绑定 Task、Run、Lease token、实际执行 commit、Gate definition、输入和
输出 digest。

以下变化使尚未开始的调度决定失效：

- Plan、Task、Dependency 或 wave；
- resource claim 或 budget；
- Policy 或 Approval；
- Adapter manifest/control profile；
- baseline；
- Gate definition；
- Context source。

运行中的原子 Agent/Tool 调用可以完成，但结果只能是 provisional；进入验证、候选集成或 Ledger
提交前必须重新检查 freshness。涉及 Task 语义、依赖或资源关系变化时必须回到 Plan 阶段。

## 18. Lifecycle Event 与可观测性

新增最小事件集：

- `TaskLeaseGranted`
- `TaskDispatched`
- `TaskIntegrationQueued`
- `TaskCandidateValidated`
- `TaskRetryScheduled`
- `WaveGateCompleted`
- `WaveIntegrated`
- `SchedulerRecovered`

Event 用于时间线和 Live Spool，不替代 Lease、Evidence 或 WaveIntegration 权威记录。

Live Spool 继续保存脱敏 heartbeat、output tail、tokens、steps、duration 和阶段变化。无法计量的
字段显示“Provider 未提供”，不能显示为 0。API key、Secret Value、完整环境变量和用户绝对路径
不进入 Event/Dashboard；raw trace 留在本地受管目录。

## 19. Dashboard

现有 Observatory 新增 `Scheduler` View，显示条件为 Capability 已激活或存在历史 M4 记录。

### 19.1 页面结构

1. 调度摘要：wave、槽位、Task 进度、Finding、Iteration 预算和活动预留；
2. Task DAG 与 waves：依赖、业务目标、状态和不能并行的原因；
3. Agent Pool：Slot、Task、Run、Lease、worktree 标识、heartbeat 和使用量；
4. Task Detail：Lease → Context → Execute → Verify → Integrate → Release、Assertions、Gate、
   Evidence、Budget、Retry 和 Finding。

默认展示中文业务描述；digest 放入技术详情。

### 19.2 Authoritative、Live 与 Provisional

- Authoritative：Ledger 中的 Lease、Run、Evidence、Finding、Approval、WaveIntegration；
- Live：SQLite/Live Spool 中的 PID、heartbeat、输出摘要和当前步骤；
- Provisional：尚未通过 freshness/validation 的 Agent 结果。

Live 状态丢失时显示“正在从 Ledger 重建”，不得将 Task 显示为失败或成功。

### 19.3 Read API

```text
GET /api/v1/scheduler?operation_id=<id>
```

一次返回 Operation、Plan/waves、Task projection、Slot projection、Budget、Pending Approval、
blocking Finding 和 presentation map。增量继续使用现有 SSE，不增加 WebSocket。Dashboard 不
直接读取 SQLite、worktree 或 raw trace。

### 19.4 写操作

允许：批准/拒绝/暂缓 Approval、恢复符合条件的 Operation、取消 Operation、提交预算或并发上限
Policy Proposal。

禁止：强制 Task 成功、跳过 Gate、修改 wave、手工移动槽位、强制释放 Lease、强制合并 candidate
或忽略 baseline drift。

所有写操作继续要求 loopback session、CSRF、actor、expected digest、Policy Decision 和 Ledger
Evidence。

### 19.5 Approval 卡

卡片展示 action、Task/wave 中文目标、风险、write paths、独占资源、Adapter/control profile、预算、
并行影响、Plan/baseline/Policy binding 和带引用的 grounded brief。批准后，存活的驱动进程自动
唤醒 Scheduler；驱动已退出则显示精确 `harness resume <operation-id>`。

## 20. CLI

不新增 `harness scheduler` 命令：

- `harness iterate`：生成 dependencies、resource claims、budgets 和 waves；
- `harness plan`：展示 DAG、waves、冲突和预算；
- `harness run`：前台驱动 Agent Pool；
- `harness resume <operation-id>`：恢复 Lease/worktree/未完成 Task；
- `harness status`：展示 wave、Task、Slot、Budget、Approval 和 Finding；
- `harness watch`：展示 M4 Event；
- `harness abort`：取消并对账；
- `harness serve`：提供 Scheduler UI；用户显式恢复后可在 serve 进程内驱动。

增加本次运行降权/选项：

```text
harness run --max-concurrency <n>
harness resume <id> --max-concurrency <n>
```

参数不能突破 Profile/Policy；降低并发不需要批准；提高到已经允许的范围不修改 Plan；提高 Policy
上限必须提交 Policy Proposal。`--json` stdout 仍只输出最终 CommandResult，实时信息进入 stderr
和 live spool。

## 21. Finding 与恢复体验

Dashboard 为 blocker 提供单一推荐动作：

- `approval_missing` → 打开 Approval；
- `budget_exhausted` → 提交预算 Policy Proposal 或缩小 Plan；
- `executor_failed` → 展示自动恢复是否已使用；
- `integration_conflict` → 展示原分支、retry 分支和冲突路径；
- `undeclared_write` → 返回 Plan 修订资源声明；
- `baseline_drift` → 返回 Impact/Plan 重新确认；
- `wave_gate_failed` → 打开 Gate Evidence，进入反馈/Plan 修订后生成修复 Task；
- `adapter_ineligible` → 修正 Adapter 或退化为监督单槽位。

不提供通用“忽略并继续”按钮。

## 22. M3 与 M4 组合边界

```text
M3 Operation Lease
  └─ 当前机器拥有整个 Operation
      └─ M4 本地 Task Leases
```

连接远程协作时：

- 必须先持有有效 M3 Operation Lease；
- Task Lease 仍只进入项目 Ledger，不进入 Control Ref；
- Task 只能在当前 Operation holder 所在机器并行；
- M4 wave 只推进 operation-local integration ref；
- 全部 wave 完成后，由 M3 Integration Lease 和 prepare/accept 发布远程目标；
- Remote Approval 先由 M3 materialize，再进入同一 ApprovalService；
- M4 不直接写远程目标分支。

未连接 M3 时，operation-local integration ref 最终通过现有本地 CAS 推进项目目标分支。

M4 本地实现不依赖三平台 Dogfood，因此可在 M3 代码门禁稳定后实施；Protocol 1.3 必须通过全部
Protocol 1.2 回归。M3 AC-01～14 和 M4 AC-01～20 未全部完成前，不能声明整体 1.0 完成。

## 23. 测试策略

M4 实施遵循已批准 Strict TDD；适用 Task 必须有成对 Red/Green Evidence，并进入现有
TaskVerdict。

### 23.1 纯函数与属性测试

- DAG 无环/缺失依赖；
- wave、Task 顺序和规范化确定性；
- write path/exclusive resource 冲突；
- Ready Task 选择；
- fencing token 单调性；
-预算预留、归还和 Retry 消耗；
-相同输入的调度结果一致。

### 23.2 Port Conformance

- Ledger/InMemory `TaskDagPort`；
-真实 Policy Evaluator/InMemory `PolicyDecisionPort`；
- Git/InMemory `IsolatedWorkspacePort`；
- SQLite/InMemory Scheduler Projection；
- managed/delegated/manual Agent Adapter fixture。

### 23.3 故障注入

覆盖 Lease 后/进程前、进程后/PID 前、Agent 后/Evidence 前、Task Gate 后/队列前、Task commit
后/Candidate Gate 前、Wave Gate 后/CAS 前、CAS 准备后/Ledger transaction 前、Approval 到达
前后及 Coordinator 重启。每处必须证明无重复集成、无旧 token 接受、无预算错误返还、无假成功。

### 23.4 真实 Git 集成测试

验证真实并行、路径/资源串行、独立 worktree、Plan 顺序候选集成、wave 原子性、一次冲突恢复、
第二次阻塞、baseline drift 和未声明写入拒绝。

### 23.5 Dashboard/CLI

Playwright 和 CLI golden 覆盖 DAG/wave/slot/detail、中文描述、三类状态、Approval、Budget、Retry、
SQLite 丢失降级、360px/desktop、`--json` stdout 和 SSE 恢复。

### 23.6 真实 Dogfood

至少一个真实项目，使用真实 Agent Adapter、真实 Git worktree、真实 Gate/Evidence，执行不少于四个
Task、两个可并行 Task 和两个 wave，最终完成 Evaluate/Snapshot。Dogfood 必须用 Run 时间区间
证明真实重叠；性能提升只作 Evidence，不以模型响应速度作为硬门禁。

## 24. 验收标准

- **AC-01**：Plan 明确生成全部 `DEPENDS_ON` 和 digest-bound waves。
- **AC-02**：循环、缺失依赖和不一致 wave 被拒绝。
- **AC-03**：写路径与独占资源冲突被机械串行化。
- **AC-04**：Lite=1，Standard/Governed 按有效上限并行。
- **AC-05**：不合格 Adapter 不能无人值守并行。
- **AC-06**：至少两个真实 Task 在隔离槽位并行。
- **AC-07**：Context、Budget、Run、worktree 和隐藏历史互不共享。
- **AC-08**：Task Lease、fencing 和重启恢复无重复接受。
- **AC-09**：并发预算预留不突破 Iteration 总上限。
- **AC-10**：Policy deny、requires-approval 和 Approval 漂移正确生效。
- **AC-11**：三层 Gate 与 wave 原子集成成立。
- **AC-12**：executor retry 和 integration retry 均最多一次。
- **AC-13**：第二次失败、越权写入和预算耗尽正确阻塞。
- **AC-14**：baseline drift 不会自动 force/rebase。
- **AC-15**：Evidence 绑定 Task、Run、Lease token 和实际基线。
- **AC-16**：Dashboard 展示完整调度与恢复状态。
- **AC-17**：CLI run/resume/status/watch/abort 形成闭环。
- **AC-18**：SQLite 删除后可从 Ledger 恢复权威状态。
- **AC-19**：M1/M2/M3 与顺序执行回归全部通过。
- **AC-20**：真实 Dogfood 完成并生成绑定当前提交的验收报告。

M4 必须 20/20 才能声明完成。

## 25. 性能门禁

使用确定性 stub 和固定规模数据：

- 1,000 Task Plan 的 wave 编译，CI 参考机 p95 `< 500ms`；
- 1,000 Task 状态下单次调度选择，p95 `< 100ms`；
- 1,000 Task Scheduler Read API，p95 `< 250ms`；
- SQLite 投影删除后重建结果与删除前一致；
- 并发测试用 Barrier 证明两个 Slot 同时 running，不使用“必须快两倍”的易波动断言。

真实 Dogfood 记录串行估算、并行耗时和等待原因，但只作为 Evidence。

## 26. Lifecycle Event 与 Record 版本

Protocol 1.3 Reader 必须读取 1.0–1.3；旧 Reader 遇到 1.3 权威记录 fail-closed。未启用 M4 的项目
继续使用原顺序路径，不写 M4 Record。Reader/Schema、canonical JSON、digest golden、domain
registry、transaction version pin 和 downgrade refusal 必须作为实施首个切片完成。

## 27. 建议实施顺序

正式实施计划按依赖展开，不在设计阶段预先固定 Task 数量：

```text
Protocol 1.3 Schema / Reader
  ↓
Plan resource claims + parallel_waves + budgets
  ↓
Task Lease + Budget reservation + deterministic scheduler
  ↓
Agent Pool + IsolatedWorkspacePort extension
  ↓
Candidate integration + wave gates + recovery
  ↓
CLI + Dashboard + Approval
  ↓
Fault injection + performance + compatibility
  ↓
真实 Dogfood + completion report
```

M4 实施必须从已批准且干净的 Git baseline 开始；任何无关工作区修改必须先明确归属，不能混入
M4 Task 提交。

## 28. 完成定义

M4 只有同时满足以下条件才完成：

1. 正式设计和实施计划均已批准；
2. 所有实现提交可追溯到 Plan Task；
3. Strict TDD 适用项具有 Red/Green Evidence；
4. AC-01～20 全部通过；
5. Release Gate 全绿；
6. 真实 Dogfood 绑定当前 HEAD；
7. Dashboard 与 CLI 可复盘每个 Task；
8. 不存在未接受的 P0/P1 Finding；
9. Completion Report 不依赖 Agent 自述。

## 29. 过度设计防线

为保持 M4 可实施，本设计显式拒绝：

- 第二套 Scheduler 服务或网络协议；
- 第二套 Workspace Port；
- TaskState、SchedulerState、ParallelGroup 等重复领域记录；
- 动态 Agent 注册、异构模型路由和抢占；
- 通用优先级、退避、死锁检测或分布式一致性系统；
- 每 Task/每 wave 固定人工审批；
- 模型自动规划、排序、冲突解决和批准；
- 用 SQLite、Live Event 或 Agent completion claim 充当权威事实。

未来需求只有在出现第二种真实 Adapter/部署形态并经独立设计批准后，才能扩大这些边界。
