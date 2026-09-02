# Universal Harness M4 Local Multi-Agent Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在现有 Graph-native Workflow Engine 内实现受 Profile、Policy、Budget、Approval、Lease、Gate 与 Evidence 约束的单机同构 Multi-Agent 并行调度闭环。

**Architecture:** LocalTaskScheduler 作为 runtime 内嵌深模块读取已批准且不可变的 ExecutionPlan，以确定性 parallel_waves 驱动同一 AgentAdapter 的独立槽位；Task 只在隔离 worktree 或既有 Strict TDD 相位工作区中产生候选结果。Workflow Engine 继续独占 Ledger、WorkingState、候选集成、wave Gate 与 operation-local ref CAS，SQLite 与 Live Spool 仅保存可删除的瞬时投影。

**Tech Stack:** TypeScript 6、Node.js 22.13+（node:sqlite、node:fs、node:child_process）、TypeBox/Ajv、Vitest 与仓库既有 seeded property-test 工具、Playwright、pnpm workspace、Git CLI、Git-native Ledger/Graph。

**Spec:** docs/superpowers/specs/2026-08-31-universal-harness-m4-local-multi-agent-scheduling-design.md

**Status:** 设计已复核并批准实施；实施中。Task 1～10 已完成，Task 11～13 已交付可验证子集，Task 14 正在完成发布证据与独立复审；AC-06/10/16/17/20 的生产或真实 Provider 证据仍未满足。

## Global Constraints

- Node.js 必须满足仓库现有 >=22.13.0；不得增加 workspace package、Scheduler 服务、网络协议、数据库服务、消息队列或后台 Daemon。
- Protocol 1.3.0 保持 development；Reader 必须读取 1.0–1.3，旧 Reader 遇到 1.3 权威 Record/Event 必须 fail-closed 为 protocol_upgrade_required。
- 任一含 1.3 权威 Record/Event 的 Ledger transaction 必须使用现有 required_reader_version 字段并精确写入 1.3.0；不得新增第二个版本钉住字段。
- 1.0–1.2 Plan、ProfileDefinition、CapabilityPlan、Schema、canonical JSON 与 digest golden 必须继续可读且不被静默改写；旧 Plan 永远顺序执行。
- 批准后的 ExecutionPlanContent.tasks 是 Task 规划语义唯一权威源；Task Node、CONTAINS、DEPENDS_ON 与 parallel_waves 都是同事务确定性投影，不得单独编辑。
- M4 只增加 task_lease 与 wave_integration 两种权威领域记录；不得增加 TaskState、SchedulerState、ParallelGroup 或 DriverLock 领域记录。
- parallel_task_execution 只贡献 execute 外层 subgraph 和 wave_integration；Kernel verify 仍是 gate_evidence 的唯一生产者。
- Lite 禁用并行模块；Standard/Governed 必须激活。并发上限始终取 runtime 请求、Profile、Installation、Project Policy 与本机资源上限的最小值。
- AgentAdapter、IsolatedWorkspacePort、EvaluationPort、ContextAssemblyPort 与 ToolRegistryPort 保持既有责任边界；AgentRunOptions 只允许增加向后兼容的 optional AbortSignal 以请求终止受管子进程。TaskDagPort 与 PolicyDecisionPort 只在 runtime 内部公开。
- 同一 Operation 只有一个 Driver；本地 Driver Lock 与 Ledger transaction lock、M3 Operation Lease 各自独立，不能互相替代。
- Task 不共享 Context、Run、Budget、worktree、Provider hidden history 或 mutable Adapter state；Agent completion claim 永远不是完成证据。
- 所有 Task、candidate 与 wave Gate Evidence 必须绑定真实 commit、Plan/Task digest、Run、最新 Lease fencing token 与 Gate definition digest。
- executor_retry 与 integration_retry 各最多一次，并消耗原 Task 剩余预算；baseline drift、semantic conflict、undeclared write、Policy deny/block 与 wave gate failure 不自动重试。
- Git ref 推进与 Ledger 接受必须走现有 staged transaction/CAS；不得 force、隐式 rebase 或在目标 ref 漂移后盲重试。
- Dashboard 复用现有 Observatory、SSE、loopback session、CSRF 与 ApprovalService；不得提供强制成功、跳 Gate、移动槽位、释放 Lease 或强制合并。
- 每个任务遵循 Red → Green → Refactor；适用 Strict TDD 的实现任务必须留下成对 Red/Green Evidence。
- 每个任务单独提交并经过 fresh review gate；不得提交用户现有未跟踪目录 teach/。

## File Map

- packages/core/src/schema/scheduling.ts：Protocol 1.3 TaskLease/WaveIntegration strict Schema。
- packages/core/src/scheduling/records.ts：两类记录的确定性 identity、seal 与语义不变量。
- packages/core/src/protocol.ts、schema/registry.ts、ledger/transaction.ts：1.3 Reader、Schema Registry 与 transaction version pin。
- packages/core/src/schema/profile.ts、schema/capability.ts、capability/*：版本化 Profile/Capability registry 与 parallel_task_execution Module。
- packages/runtime/src/planning/task.ts、execution-plan.ts、waves.ts：Task 1.3 字段、预算、资源声明、Task digest 与确定性 wave 编译。
- packages/runtime/src/scheduling/ports.ts：TaskDagPort、PolicyDecisionPort 与内部只读快照。
- packages/runtime/src/scheduling/task-dag-adapters.ts、policy-adapters.ts：Workflow/Ledger、Policy Evaluator 与 InMemory Adapter。
- packages/runtime/src/scheduling/lease.ts、budget.ts：Lease/fencing 状态机与原子预算预留/结算。
- packages/runtime/src/scheduling/resource-locks.ts、driver-lock.ts：运行时资源锁与 operation-scoped 本地 Driver Lock。
- packages/runtime/src/scheduling/workspace-manager.ts：非 TDD Task worktree 与 Strict TDD 最终 revision 组合。
- packages/runtime/src/scheduling/agent-pool.ts、scheduler.ts：同构 Agent Slot 与确定性调度循环。
- packages/runtime/src/scheduling/projection.ts、sqlite-projection.ts、events.ts：权威状态投影、SQLite live 投影与最小事件集。
- packages/runtime/src/scheduling/integration.ts、recovery.ts：候选树、三层 Gate、wave 原子 CAS 与恢复。
- packages/runtime/src/orchestration/scheduler-runtime.ts：Capability DAG execute subgraph 与既有纵向闭环接线。
- packages/cli/src/commands/*、runtime-service.ts：run/resume/status/watch/abort/serve 的并行调度入口与单 Driver。
- packages/dashboard/src/scheduler-api.ts、assets/*：Scheduler Read API、Approval/恢复动作与 Observatory UI。
- packages/conformance/src/scheduling.ts：TaskDag、Policy、Workspace、Projection 的共享 conformance cases。
- tests/{e2e,fault,security,performance}：真实 Git、崩溃恢复、边界与性能证据。
- scripts/dogfood-m4-local-scheduler.mjs：真实 Agent/worktree/Gate 的四 Task 两波次 dogfood。
- docs/evidence/m4-local-multi-agent-scheduling-completion.md：绑定当前提交的 AC-01～20 验收矩阵。

## Shared Interfaces and Ownership Rules

以下签名是任务之间的编译边界。后续任务不得自行改名；确需改变时必须先修订本计划并重新复核。

~~~ts
export interface ParallelWave {
  readonly wave_index: number;
  readonly task_ids: readonly string[];
}

export interface IterationBudget {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms: number;
}

export interface TaskDagSnapshot {
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly plan_id: string;
  readonly plan_digest: string;
  readonly baseline_commit: string;
  readonly tasks: readonly Protocol13TaskSpecification[];
  readonly parallel_waves: readonly ParallelWave[];
  readonly iteration_budget: IterationBudget;
}

export interface TaskDagPort {
  readonly name: string;
  readApproved(input: {
    readonly operation_id: string;
    readonly expected_plan_digest?: string;
  }): Promise<TaskDagSnapshot>;
}

export interface PolicyDecisionPort {
  readonly name: string;
  decide(input: SchedulerPolicyInput): Promise<PolicyDecision>;
}

export interface SchedulerProjectionStore {
  replace(snapshot: SchedulerLiveSnapshot): Promise<void>;
  read(operationId: string): Promise<SchedulerLiveSnapshot | null>;
  clear(operationId: string): Promise<void>;
}

export interface LocalTaskScheduler {
  drive(input: SchedulerDriveInput): Promise<SchedulerDriveResult>;
  recover(input: SchedulerRecoverInput): Promise<SchedulerDriveResult>;
  cancel(input: SchedulerCancelInput): Promise<SchedulerDriveResult>;
  read(operationId: string): Promise<SchedulerReadModel>;
}
~~~

共享 barrel 文件所有权被冻结以允许真实并行开发：

- Task 1 独占 packages/core/src/index.ts、packages/core/src/schema/index.ts 和 Protocol registry 导出。
- Task 2 独占 Capability/Profile 的 core barrel 与 goldens。
- Task 3 只修改 planning 目录，暂不修改 packages/runtime/src/index.ts。
- Task 4～7 不修改 packages/runtime/src/index.ts；Task 8 统一接入 scheduling barrel。
- Task 10 独占 packages/runtime/src/index.ts、orchestration 公共接线与 Scheduler Read Model。
- Task 11 只修改 CLI；Task 12 只修改 Dashboard，因此可在 Task 10 后并行。

---

### Task 1: Freeze Protocol 1.3 Scheduling Records and Reader Compatibility

**Depends on:** 无。

**Parallel with:** 无；这是全计划的协议地基。

**Files:**
- Create: packages/core/src/schema/scheduling.ts
- Create: packages/core/src/scheduling/records.ts
- Create: packages/core/src/scheduling/index.ts
- Create: packages/core/test/scheduling/records.test.ts
- Create: packages/core/test/protocol/protocol-1.3.test.ts
- Modify: packages/core/src/protocol.ts
- Modify: packages/core/src/schema/envelope.ts
- Modify: packages/core/src/schema/event.ts
- Modify: packages/core/src/schema/operation.ts
- Modify: packages/core/src/schema/runtime.ts
- Modify: packages/core/src/schema/registry.ts
- Modify: packages/core/src/schema/domain-registry.ts
- Modify: packages/core/src/ledger/transaction.ts
- Modify: packages/core/src/ledger/event-store.ts
- Modify: packages/core/src/schema/index.ts
- Modify: packages/core/src/index.ts
- Generate: packages/core/schemas/task-lease.schema.json
- Generate: packages/core/schemas/wave-integration.schema.json
- Generate: packages/core/schemas/event.schema.json
- Generate: packages/core/schemas/ledger-operation.schema.json

**Interfaces:**
- Consumes: recordEnvelopeSchemaFor(), sealRecordEnvelope(), contentDigest(), existing Protocol 1.0–1.2 reader semantics.
- Produces: PROTOCOL_1_3_VERSION, PROTOCOL_1_3_SCHEMA_REGISTRY, TaskLeaseRecord, WaveIntegrationRecord, SchedulingRecord, buildTaskLeaseRecord(), buildWaveIntegrationRecord(), assertSchedulingRecordSemantics().

- [x] **Step 1: Write failing Protocol registry, downgrade and version-pin tests**

Add assertions that 1.3 is development, a 1.3 reader accepts 1.0–1.3, a 1.2 reader rejects authoritative 1.3 content, and the existing transaction field is mandatory:

~~~ts
expect(assertKnownProtocol("1.3.0")).toEqual({
  version: "1.3.0",
  status: "development",
});
expect(() =>
  assertProtocolReaderCanProject({
    readerVersion: "1.2.0",
    recordVersion: "1.3.0",
    authoritative: true,
  }),
).toThrowError(expect.objectContaining({ kind: "protocol_upgrade_required" }));
expect(() => validateLedgerOperation(protocol13OperationWithoutPin)).toThrow(
  /required_reader_version.*1\.3\.0/u,
);
expect(validateLedgerOperation({ ...protocol13Operation, required_reader_version: "1.3.0" }))
  .toBeUndefined();
~~~

Run:

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/protocol/protocol-1.3.test.ts
~~~

Expected: FAIL because Protocol 1.3 and its authoritative-content detection do not exist.

- [x] **Step 2: Register Protocol 1.3 and generalize transaction version detection**

Add:

~~~ts
export const PROTOCOL_1_3_VERSION = "1.3.0" as const;

export const KNOWN_PROTOCOLS = [
  { version: PROTOCOL_VERSION, status: "stable" },
  { version: PROTOCOL_1_1_VERSION, status: "development" },
  { version: PROTOCOL_1_2_VERSION, status: "development" },
  { version: PROTOCOL_1_3_VERSION, status: "development" },
] as const;
~~~

Replace Protocol-1.2-specific transaction detection with a single newest-authoritative-version reducer. A transaction containing 1.2 and 1.3 content must require 1.3.0; transactions containing only legacy records must preserve their existing manifest bytes.

- [x] **Step 3: Write failing strict record and digest tests**

Use complete fixtures to assert both record kinds, stable record_digest, rejection of caller-filled drift, Lease-chain identity separation and exact field arrays:

~~~ts
const granted = buildTaskLeaseRecord(taskLeaseDraft);
expect(granted).toMatchObject({
  protocol_version: "1.3.0",
  record_kind: "task_lease",
  state: "granted",
  fencing_token: 1,
});
expect(recordDigestOf(granted)).toBe(granted.record_digest);
expect(granted.task_lease_record_id).not.toBe(granted.lease_id);

const integration = buildWaveIntegrationRecord(waveIntegrationDraft);
expect(integration.task_ids).toEqual(["task_api", "task_ui"]);
expect(integration.record_digest).toBe(recordDigestOf(integration));
~~~

Also test: fencing token must be positive; released/expired/revoked records require previous_lease_record_digest; consumed budget cannot exceed reserved budget; task/evidence arrays are unique and Plan ordered; wave_index is non-negative; command_id is non-empty.

Run the two new test files. Expected: FAIL because the schemas and builders do not exist.

- [x] **Step 4: Implement the two Protocol 1.3 record schemas**

Construct both with recordEnvelopeSchemaFor(PROTOCOL_1_3_VERSION, ...). Export strict TypeBox schemas and static types. TaskLeaseRecord must use the exact design fields and these strict literals:

~~~ts
export const TaskLeaseStateSchema = enumerated([
  "granted",
  "released",
  "expired",
  "revoked",
] as const);

export const TaskRetryKindSchema = enumerated([
  "executor_retry",
  "integration_retry",
] as const);
~~~

WaveIntegrationRecord must include accepted_source_tree_digest plus the four evidence/lease digest arrays. Do not add TaskState or SchedulerState schemas.

- [x] **Step 5: Implement sealed builders and semantic invariants**

Builders accept drafts without protocol_version, record_kind or record_digest:

~~~ts
export type TaskLeaseRecordDraft = Omit<
  TaskLeaseRecord,
  "protocol_version" | "record_kind" | "record_digest"
>;

export function buildTaskLeaseRecord(draft: TaskLeaseRecordDraft): TaskLeaseRecord {
  const record = sealRecordEnvelope({
    protocol_version: PROTOCOL_1_3_VERSION,
    record_kind: "task_lease",
    ...draft,
  });
  assertSchedulingRecordSemantics(record);
  return record as TaskLeaseRecord;
}
~~~

Use the same pattern for WaveIntegrationRecord. Semantic checks run both on construction and read, so syntactically valid but impossible chains fail closed.

- [x] **Step 6: Register schemas, records and the minimal event vocabulary**

Register only:

~~~ts
"TaskLeaseGranted",
"TaskDispatched",
"TaskIntegrationQueued",
"TaskCandidateValidated",
"TaskRetryScheduled",
"WaveGateCompleted",
"WaveIntegrated",
"SchedulerRecovered",
~~~

Events are timeline facts, not substitutes for TaskLeaseRecord or WaveIntegrationRecord. Add both record kinds to Domain Registry and PROTOCOL_1_3_SCHEMA_REGISTRY; teach EventStore/transaction inspection to classify them as authoritative 1.3 content.

- [x] **Step 7: Generate schemas and verify all legacy goldens**

Run:

~~~bash
pnpm --filter @universal-harness-internal/core schema:generate
pnpm --filter @universal-harness-internal/core typecheck
pnpm exec vitest run --config vitest.workspace.ts packages/core/test
pnpm exec prettier --check packages/core/src packages/core/test packages/core/schemas
~~~

Expected: all core tests pass; new schemas use the 1.3 namespace; 1.0–1.2 golden files do not drift except intentional shared Event/LedgerOperation unions.

- [x] **Step 8: Commit the protocol slice**

~~~bash
git add packages/core/src packages/core/test packages/core/schemas
git diff --cached --check
git commit -m "feat(core): define protocol 1.3 scheduling records"
~~~

### Task 2: Version Profile, Capability Module, DAG and Policy Vocabulary

**Depends on:** Task 1.

**Parallel with:** Task 3 after Task 1; Task 2 owns core Capability/Profile files, Task 3 owns runtime planning files.

**Files:**
- Create: packages/core/test/capability/parallel-task-execution.test.ts
- Create: packages/core/test/profile/protocol-1.3-profile.test.ts
- Modify: packages/core/src/schema/profile.ts
- Modify: packages/core/src/schema/capability.ts
- Modify: packages/core/src/capability/registry.ts
- Modify: packages/core/src/profile/definitions.ts
- Modify: packages/core/src/capability/compiler.ts
- Modify: packages/core/src/capability/dag.ts
- Modify: packages/core/src/capability/status-projection.ts
- Modify: packages/core/src/schema/registry.ts
- Modify: packages/core/test/capability/compiler.test.ts
- Modify: packages/core/test/capability/dag.test.ts
- Modify: packages/core/test/profile/definitions.test.ts
- Modify: packages/runtime/src/policy/action.ts
- Modify: packages/runtime/src/policy/evaluator.ts
- Modify: packages/runtime/test/policy/action.test.ts
- Modify: packages/runtime/test/policy/evaluator.test.ts
- Create: packages/runtime/test/policy/scheduler-policy.test.ts
- Generate: packages/core/schemas/capability-plan-1.3.schema.json

**Interfaces:**
- Consumes: PROTOCOL_1_3_VERSION and versioned schema registry from Task 1.
- Produces: CAPABILITY_IDS_1_1, CAPABILITY_IDS_1_3, profileDefinitionForProtocol(), profileDefinitionByDigest(), capabilityModuleDefinitionsForProtocol(), parallel_task_execution Module contract, wave_integration BindingKind, three new PolicyActionKind values.

- [x] **Step 1: Write failing versioned Profile compatibility tests**

Pin legacy and current behavior independently:

~~~ts
expect(profileDefinitionForProtocol("lite", "1.1.0").capabilities)
  .not.toHaveProperty("parallel_task_execution");
expect(profileDefinitionForProtocol("lite", "1.3.0").capabilities.parallel_task_execution)
  .toBe("disabled");
expect(profileDefinitionForProtocol("standard", "1.3.0").capabilities.parallel_task_execution)
  .toBe("required");
expect(profileDefinitionForProtocol("governed", "1.3.0").capabilities.parallel_task_execution)
  .toBe("required");
expect(profileDefinitionByDigest(legacyStandardDigest).protocol_version).toBe("1.1.0");
~~~

Run:

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/profile/protocol-1.3-profile.test.ts
~~~

Expected: FAIL because the current registry has only five capabilities and one ProfileDefinition version.

- [x] **Step 2: Add versioned Capability/Profile schemas without rotating old digests**

Keep the legacy identifiers explicit:

~~~ts
export const CAPABILITY_IDS_1_1 = [
  "impact_analysis",
  "design_governance",
  "independent_evaluation",
  "strict_tdd",
  "advanced_audit",
] as const;

export const CAPABILITY_IDS_1_3 = [
  ...CAPABILITY_IDS_1_1,
  "parallel_task_execution",
] as const;
~~~

Create ProfileDefinitionV11Schema and ProfileDefinitionV13Schema; expose ProfileDefinitionSchema as their reader union. Build separate sealed registries keyed by protocol version and a digest index:

~~~ts
export function profileDefinitionForProtocol(
  profileId: ProfileId,
  protocolVersion: "1.1.0" | "1.3.0",
): ProfileDefinition;

export function profileDefinitionByDigest(digest: string): ProfileDefinition;
~~~

Protocol 1.2 operations continue resolving the 1.1 definitions. Existing ProjectProfileRecord assertions must resolve by referenced profile_definition_digest, not by blindly comparing against the newest definition.

- [x] **Step 3: Write failing Module/DAG tests**

Assert the exact contract and the corrected single-producer topology:

~~~ts
expect(capabilityModuleDefinition("parallel_task_execution", "1.3.0")).toMatchObject({
  depends_on: [],
  required_providers: ["isolated_workspace_provider", "structured_gate_provider"],
  input_bindings: ["execution_plan", "context_bundle"],
  output_bindings: ["wave_integration"],
  checkpoint_boundary: "execute",
  invalidated_by: ["execution_plan", "context_bundle"],
  approval_objects: [],
});

const dag = buildOperationDag(new Set(["strict_tdd", "parallel_task_execution"]), "1.3.0");
expect(dag.find((node) => node.node_id === "execute")?.subgraph)
  .toBe("parallel_task_execution");
expect(dag.filter((node) => node.produces.includes("gate_evidence"))).toHaveLength(1);
~~~

Also assert that parallel inactive plus strict_tdd keeps subgraph strict_tdd, Lite produces no scheduling invocation, and legacy Protocol 1.1 DAG bytes remain stable.

- [x] **Step 4: Implement the Protocol 1.3 Module and versioned DAG**

Add wave_integration to the 1.3 binding schema only. Register Module version 1.3.0. Extend the 1.3 OperationDagNode subgraph union to strict_tdd | parallel_task_execution; keep the 1.1 record schema literal unchanged. Capability Compiler must select definitions from the operation protocol and emit a Protocol 1.3 CapabilityPlan revision when the new Module participates.

Do not create a nested generic subgraph. When both capabilities are active, Scheduler invokes StrictTddExecutionPort per Task inside the sole parallel_task_execution outer subgraph.

- [x] **Step 5: Extend Policy action vocabulary and deterministic evaluation**

Add:

~~~ts
export const SCHEDULER_POLICY_ACTION_KINDS = [
  "dispatch_task",
  "retry_task",
  "integrate_wave",
] as const;
~~~

Append them to POLICY_ACTION_KINDS. Tests must prove normalization keeps exact parameters/digest stability, prompt-origin input cannot carry approval authority, and the evaluator can return allow, deny, requires_approval and block for all three kinds. Unknown values remain invalid_action.

The scheduler Policy resolver recognizes the exact numeric hard-ceiling paths scheduler.max_concurrency, budgets.iteration.max_steps, budgets.iteration.max_tokens and budgets.iteration.max_duration_ms. Missing new fields preserve compatibility: concurrency defaults to the Profile default of 2, while iteration ceilings fall back to the already effective loop.max_steps, loop.max_tokens and loop.max_duration_ms. A present non-positive or non-numeric field blocks instead of silently falling back.

- [x] **Step 6: Run focused and compatibility suites**

~~~bash
pnpm --filter @universal-harness-internal/core schema:generate
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/capability packages/core/test/profile packages/runtime/test/policy
pnpm --filter @universal-harness-internal/core typecheck
pnpm --filter @universal-harness-internal/runtime typecheck
~~~

Expected: new Protocol 1.3 cases and all legacy Profile/Capability/Policy cases pass.

- [x] **Step 7: Commit**

~~~bash
git add packages/core/src packages/core/test packages/core/schemas packages/runtime/src/policy packages/runtime/test/policy
git diff --cached --check
git commit -m "feat(capability): activate protocol 1.3 parallel execution"
~~~

### Task 3: Make Plan the Authority for Resources, Budgets and Deterministic Waves

**Depends on:** Task 1.

**Parallel with:** Task 2. It must not modify core Capability/Profile files or packages/runtime/src/index.ts.

**Files:**
- Create: packages/runtime/src/planning/waves.ts
- Create: packages/runtime/test/planning/waves.test.ts
- Create: packages/runtime/test/planning/waves.property.test.ts
- Create: tests/performance/m4-wave-compiler.test.ts
- Modify: packages/runtime/src/planning/task.ts
- Modify: packages/runtime/src/planning/validator.ts
- Modify: packages/runtime/src/planning/execution-plan.ts
- Modify: packages/runtime/src/planning/task-sizing.ts
- Modify: packages/runtime/test/planning/validator.test.ts
- Modify: packages/runtime/test/planning/execution-plan.test.ts

**Interfaces:**
- Consumes: contentDigest(), TaskSpecification.dependencies and the existing atomic Plan/Task/Edge projection.
- Produces: IterationBudget, ParallelWave, normalizeTaskWritePath(), taskSemanticDigest(), compileParallelWaves(), assertParallelWaves(), Protocol 1.3 ExecutionPlanContent fields.

- [x] **Step 1: Write failing Task 1.3 validation tests**

Add a legal task and boundary cases:

~~~ts
const task = validatePlanProposal([{
  ...baseTask,
  write_paths: ["packages/runtime/src/scheduling"],
  exclusive_resources: ["generated-client"],
  budget: { steps: 12, tokens: 8_000, duration_ms: 300_000 },
}], protocol13Constraints)[0];

expect(task.write_paths).toEqual(["packages/runtime/src/scheduling"]);
expect(task.exclusive_resources).toEqual(["generated-client"]);
expect(task.budget.duration_ms).toBe(300_000);
~~~

Reject absolute paths, dot segments, .git, .harness authoritative directories, empty/root-wide declarations, symlink escapes, duplicate/non-canonical paths, invalid resource keys and non-positive duration. Legacy proposal mode must continue accepting the old two-field budget and mark it sequential-only.

- [x] **Step 2: Extend TaskSpecification and semantic digest**

Use:

~~~ts
export interface LegacyTaskBudget {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms?: number;
}

export interface Protocol13TaskBudget extends LegacyTaskBudget {
  readonly duration_ms: number;
}

export interface TaskSpecification {
  // existing fields stay unchanged
  readonly budget: LegacyTaskBudget;
  readonly write_paths?: readonly string[];
  readonly exclusive_resources?: readonly string[];
}

export interface Protocol13TaskSpecification extends TaskSpecification {
  readonly budget: Protocol13TaskBudget;
  readonly write_paths: readonly string[];
  readonly exclusive_resources: readonly string[];
}
~~~

Add an explicit PlanProtocolMode parameter to proposal validation so new plans require all 1.3 fields while legacy readers do not synthesize authority. Export assertProtocol13TaskSpecification() to narrow the compatible reader shape before scheduling. taskSemanticDigest() must include objective, outputs, impact paths, dependencies, resource claims, budget, capabilities, tools, risk, assertions and required gates in canonical order.

- [x] **Step 3: Write failing deterministic wave examples and properties**

Pin stable Kahn order and earliest-wave displacement:

~~~ts
const waves = compileParallelWaves([
  task("task_a", [], ["src/a"], []),
  task("task_b", [], ["src/b"], []),
  task("task_c", [], ["src/a/x"], []),
  task("task_d", ["task_c"], ["src/d"], []),
]);

expect(waves).toEqual([
  { wave_index: 0, task_ids: ["task_a", "task_b"] },
  { wave_index: 1, task_ids: ["task_c"] },
  { wave_index: 2, task_ids: ["task_d"] },
]);
~~~

Use the repository's existing deterministic seeded-generator pattern to prove over at least 1,000 generated DAGs: identical canonical input gives byte-identical waves; every dependency is in an earlier actual wave; no write/write or exclusive-resource conflict shares a wave; every Task appears exactly once; permutations are rejected or preserve declared Plan order rather than becoming an implicit second ordering.

- [x] **Step 4: Implement path conflicts and stable Kahn wave compilation**

Export:

~~~ts
export function compileParallelWaves(
  tasks: readonly Protocol13TaskSpecification[],
): readonly ParallelWave[];

export function assertParallelWaves(
  tasks: readonly Protocol13TaskSpecification[],
  persisted: readonly ParallelWave[],
): void;
~~~

For each Task in stable topological frontier order, compute earliest_wave from dependencies' actual wave, then scan forward to the first conflict-free wave. Treat path equality or ancestor/descendant overlap as conflict. Resource keys conflict only by exact normalized equality. Throw typed PlanningError for unknown dependency, cycle, duplicate Task, invalid path and persisted wave drift.

- [x] **Step 5: Bind iteration budget, baseline and waves into Plan digest**

Extend PlanSharedContext with baseline_commit and capability_plan_digest for 1.3. Extend ExecutionPlanContent with iteration_budget and parallel_waves. generateExecutionPlan() must:

1. validate Task 1.3 fields;
2. ensure each Task budget and iteration budget stay within approved ceilings;
3. preserve iteration_budget as the runtime aggregate authority without rejecting a Plan merely because the sum of Task maxima is larger;
4. compile waves;
5. compute every Task semantic digest;
6. atomically emit Plan, Task Nodes, CONTAINS and exact DEPENDS_ON Edge set.

readExecutionPlanContent() must recompile and byte-compare waves and Graph projection before returning an approved 1.3 snapshot. It must not infer resource claims for old plans.

- [x] **Step 6: Add the 1,000-Task performance gate**

Build a deterministic fixture with mixed dependencies and conflicts. Measure 20 warm runs:

~~~ts
expect(percentile95(samples)).toBeLessThan(500);
expect(contentDigest(compileParallelWaves(tasks)))
  .toBe(contentDigest(compileParallelWaves(tasks)));
~~~

Run:

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/planning --run
pnpm exec vitest run --config vitest.performance.ts tests/performance/m4-wave-compiler.test.ts
~~~

Expected: all planning tests pass and 1,000-Task compilation p95 is below 500ms on the CI reference configuration.

- [x] **Step 7: Commit**

~~~bash
git add packages/runtime/src/planning packages/runtime/test/planning tests/performance/m4-wave-compiler.test.ts
git diff --cached --check
git commit -m "feat(planning): compile deterministic parallel waves"
~~~

### Task 4: Implement TaskDagPort and PolicyDecisionPort Conformance

**Depends on:** Task 2 and Task 3.

**Parallel with:** 无；Task 4 冻结 Task 5～10 共用的内部端口契约。

**Files:**
- Create: packages/runtime/src/scheduling/ports.ts
- Create: packages/runtime/src/scheduling/task-dag-adapters.ts
- Create: packages/runtime/src/scheduling/policy-adapters.ts
- Create: packages/runtime/test/scheduling/task-dag-port.test.ts
- Create: packages/runtime/test/scheduling/policy-decision-port.test.ts
- Create: packages/conformance/src/scheduling.ts
- Create: packages/conformance/test/scheduling.conformance.test.ts
- Modify: packages/conformance/src/index.ts

**Interfaces:**
- Consumes: readExecutionPlanContent(), assertParallelWaves(), PolicyAction, PolicyLayerInput, PolicyDecision and decideAction().
- Produces: TaskDagPort, TaskDagSnapshot, SchedulerPolicyAction, SchedulerPolicyInput, PolicyDecisionPort, createWorkflowTaskDagAdapter(), createInMemoryTaskDagPort(), createPolicyDecisionAdapter(), createInMemoryPolicyDecisionPort().

- [x] **Step 1: Write failing TaskDagPort conformance cases**

Define a shared factory contract:

~~~ts
export interface TaskDagPortFactory {
  create(fixture: ApprovedTaskDagFixture): TaskDagPort;
}

export function taskDagPortConformanceCases(
  factory: TaskDagPortFactory,
): readonly ConformanceCase[];
~~~

Every Adapter must return the same canonical TaskDagSnapshot and reject:

- an unapproved Plan;
- expected_plan_digest drift;
- missing, extra or reversed DEPENDS_ON edges;
- Task Node semantic digest drift;
- persisted waves that differ from compileParallelWaves();
- a legacy Plan requested for parallel execution.

Run:

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/conformance/test/scheduling.conformance.test.ts
~~~

Expected: FAIL because TaskDagPort and its Adapters do not exist.

- [x] **Step 2: Implement TaskDagPort and both Adapters**

Use the frozen signature:

~~~ts
export interface TaskDagPort {
  readonly name: string;
  readApproved(input: {
    readonly operation_id: string;
    readonly expected_plan_digest?: string;
  }): Promise<TaskDagSnapshot>;
}
~~~

createWorkflowTaskDagAdapter() receives narrow read functions for Plan, Task Nodes, Edge Records and current approved baseline; it does not receive a Ledger write capability. createInMemoryTaskDagPort() accepts an immutable fixture and runs the same assertTaskDagSnapshot() guard before returning. The guard recomputes Task digests, edge equality and waves on every read.

- [x] **Step 3: Write failing PolicyDecisionPort conformance cases**

Use the complete input:

~~~ts
export interface SchedulerPolicyInput {
  readonly action: "dispatch_task" | "retry_task" | "integrate_wave";
  readonly operation_id: string;
  readonly iteration_id: string;
  readonly plan_digest: string;
  readonly task_digest?: string;
  readonly wave_index?: number;
  readonly baseline_commit: string;
  readonly risk: TaskRisk;
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly write_paths: readonly string[];
  readonly exclusive_resources: readonly string[];
  readonly task_remaining_budget?: Protocol13TaskBudget;
  readonly iteration_remaining_budget: IterationBudget;
  readonly adapter_manifest_digest: string;
  readonly adapter_control_profile: AdapterControlProfile;
  readonly retry_kind?: "executor_retry" | "integration_retry";
  readonly approval_digest?: string;
  readonly effective_policy_digest: string;
}
~~~

Cases must cover all three actions crossed with allow, deny, requires_approval and block. Assert that approval only satisfies a matching requires_approval object; it cannot override deny/block or a stale Plan/baseline/Policy/Adapter digest.

- [x] **Step 4: Implement production and InMemory Policy Adapters**

createPolicyDecisionAdapter() translates SchedulerPolicyInput to a normalized control-plane PolicyAction and delegates to decideAction(). It must include every binding above in canonical parameters. createInMemoryPolicyDecisionPort() accepts a deterministic resolver for conformance/fault injection but still validates returned action_digest and effective_policy_digest.

~~~ts
export function createPolicyDecisionAdapter(options: {
  readonly readLayers: () => readonly PolicyLayerInput[];
  readonly readGrant: (taskId: string | undefined) => CapabilityGrant | undefined;
}): PolicyDecisionPort;
~~~

Neither Adapter writes Approval, Lease, Finding or Ledger state.

- [x] **Step 5: Run focused conformance, type and legacy policy tests**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/conformance/test/scheduling.conformance.test.ts packages/runtime/test/scheduling/task-dag-port.test.ts packages/runtime/test/scheduling/policy-decision-port.test.ts packages/runtime/test/policy
pnpm --filter @universal-harness-internal/runtime typecheck
pnpm --filter @universal-harness-internal/conformance typecheck
~~~

Expected: production and InMemory Adapters pass the same cases; legacy Policy behavior remains green.

- [x] **Step 6: Commit**

~~~bash
git add packages/runtime/src/scheduling packages/runtime/test/scheduling packages/conformance/src packages/conformance/test
git diff --cached --check
git commit -m "feat(runtime): define scheduling decision ports"
~~~

### Task 5: Build Task Lease, Fencing and Atomic Budget Accounting

**Depends on:** Task 4.

**Parallel with:** Task 6 and Task 7. This task owns lease.ts and budget.ts only; shared scheduling exports wait for Task 8.

**Files:**
- Create: packages/runtime/src/scheduling/lease.ts
- Create: packages/runtime/src/scheduling/budget.ts
- Create: packages/runtime/test/scheduling/lease.test.ts
- Create: packages/runtime/test/scheduling/lease.property.test.ts
- Create: packages/runtime/test/scheduling/budget.test.ts
- Create: packages/runtime/test/scheduling/budget.property.test.ts
- Create: tests/fault/m4-lease-budget-boundaries.test.ts

**Interfaces:**
- Consumes: TaskLeaseRecord builders from Task 1, TaskDagSnapshot and PolicyDecisionPort from Task 4.
- Produces: TaskLeaseChain, nextFencingToken(), grantTaskLease(), terminateTaskLease(), assertCurrentFencingToken(), IterationBudgetAccount, reserveTaskBudget(), settleTaskBudget(), restoreBudgetAccount().

- [x] **Step 1: Write failing Lease transition and property tests**

Pin the only state transitions:

~~~ts
const granted = grantTaskLease(grantInput);
const released = terminateTaskLease(granted, {
  state: "released",
  consumed_budget: { steps: 7, tokens: 3_200 },
  command_id: "cmd_release_1",
});

expect(released.previous_lease_record_digest).toBe(granted.record_digest);
expect(released.lease_id).toBe(granted.lease_id);
expect(released.task_lease_record_id).not.toBe(granted.task_lease_record_id);
expect(() => terminateTaskLease(released, terminationInput)).toThrow(/terminal/u);
~~~

Use deterministic seeded chains to prove fencing_token strictly increases across attempts, an old token never becomes current again, commands are idempotent by command_id, and only granted can transition to released/expired/revoked.

Run the Lease tests. Expected: FAIL because the reducer does not exist.

- [x] **Step 2: Implement the pure Lease reducer**

Export:

~~~ts
export interface TaskLeaseChain {
  readonly latest_by_task: ReadonlyMap<string, TaskLeaseRecord>;
  readonly records: readonly TaskLeaseRecord[];
}

export function nextFencingToken(chain: TaskLeaseChain, taskId: string): number;
export function assertCurrentFencingToken(
  chain: TaskLeaseChain,
  taskId: string,
  token: number,
): void;
~~~

grantTaskLease() requires an allow PolicyDecision or an exact satisfied requires_approval decision, binds Plan/Task/baseline/Adapter/Policy/approval digests and creates a new lease_id for every attempt. Termination preserves lease_id, links the previous record digest and cannot increase consumed budget.

- [x] **Step 3: Write failing concurrent budget reservation tests**

Use immutable accounting state:

~~~ts
const first = reserveTaskBudget(account, {
  task_id: "task_a",
  steps: 6,
  tokens: 4_000,
});
expect(() =>
  reserveTaskBudget(first.account, {
    task_id: "task_b",
    steps: 6,
    tokens: 4_000,
  }),
).toThrowError(expect.objectContaining({ kind: "budget_exhausted" }));

const settled = settleTaskBudget(first.account, {
  task_id: "task_a",
  consumed: { steps: 4, tokens: 2_500 },
});
expect(settled.remaining).toEqual({ steps: 6, tokens: 5_500 });
~~~

Properties must prove accumulated_consumption + active_reservations never exceeds the approved iteration limit, unused reservation returns exactly once, Retry cannot exceed the Task original remainder, and duration uses a deadline rather than additive reservation.

- [x] **Step 4: Implement budget accounting and restore from Ledger**

Use:

~~~ts
export interface IterationBudgetAccount {
  readonly limit: IterationBudget;
  readonly consumed: Readonly<Record<string, {
    readonly steps: number;
    readonly tokens: number;
  }>>;
  readonly reservations: Readonly<Record<string, {
    readonly lease_id: string;
    readonly fencing_token: number;
    readonly steps: number;
    readonly tokens: number;
  }>>;
  readonly iteration_deadline: string;
}
~~~

reserveTaskBudget() returns a new account and the exact steps/tokens stored in the granted Lease. settleTaskBudget() accepts only the current Lease token. restoreBudgetAccount() replays authoritative Lease records and rejects duplicate settlement, consumed > reserved, reservation without current granted Lease or accumulated overrun.

- [x] **Step 5: Add atomic commit boundary fault cases**

Drive an in-memory Ledger transaction harness through:

~~~text
policy allow → reserve → granted Lease → process start
~~~

Kill after each boundary. Assert no state can expose a reservation without its granted Lease, no process is started before the commit succeeds, replay of the same command_id is idempotent, and a failed transaction returns no budget.

- [x] **Step 6: Run the focused suites**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/scheduling/lease.test.ts packages/runtime/test/scheduling/lease.property.test.ts packages/runtime/test/scheduling/budget.test.ts packages/runtime/test/scheduling/budget.property.test.ts tests/fault/m4-lease-budget-boundaries.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
~~~

Expected: all Lease, budget and crash-boundary tests pass.

- [x] **Step 7: Commit**

~~~bash
git add packages/runtime/src/scheduling/lease.ts packages/runtime/src/scheduling/budget.ts packages/runtime/test/scheduling/lease.test.ts packages/runtime/test/scheduling/lease.property.test.ts packages/runtime/test/scheduling/budget.test.ts packages/runtime/test/scheduling/budget.property.test.ts tests/fault/m4-lease-budget-boundaries.test.ts
git diff --cached --check
git commit -m "feat(runtime): account task leases and budgets"
~~~

### Task 6: Enforce Resource Locks and the Operation Driver Lock

**Depends on:** Task 4.

**Parallel with:** Task 5 and Task 7. This task does not modify LedgerRepository lock code or packages/runtime/src/index.ts.

**Files:**
- Create: packages/runtime/src/scheduling/resource-locks.ts
- Create: packages/runtime/src/scheduling/driver-lock.ts
- Create: packages/runtime/test/scheduling/resource-locks.test.ts
- Create: packages/runtime/test/scheduling/driver-lock.test.ts
- Create: tests/fault/m4-driver-lock-recovery.test.ts
- Create: tests/security/m4-path-and-lock-boundary.test.ts

**Interfaces:**
- Consumes: normalized Task write_paths/exclusive_resources from Task 3 and active Lease facts from Task 5.
- Produces: ResourceLockTable, acquireTaskResources(), releaseTaskResources(), rebuildResourceLocks(), DriverLockHandle, createFileSystemDriverLock().

- [x] **Step 1: Write failing all-or-nothing resource lock tests**

~~~ts
const first = acquireTaskResources(emptyTable, {
  task_id: "task_a",
  fencing_token: 1,
  write_paths: ["packages/runtime/src"],
  exclusive_resources: ["database-schema"],
});
expect(() =>
  acquireTaskResources(first, {
    task_id: "task_b",
    fencing_token: 1,
    write_paths: ["packages/runtime/src/scheduling"],
    exclusive_resources: [],
  }),
).toThrowError(expect.objectContaining({ kind: "resource_busy" }));
expect(first.entries).toHaveLength(2);
~~~

Assert keys are sorted before acquisition, a failed acquisition holds nothing, release requires exact task_id + fencing_token, and rebuild from current granted Leases is byte-equivalent.

- [x] **Step 2: Implement resource lock projection**

Lock keys are exactly:

~~~ts
function resourceKeys(task: Protocol13TaskSpecification): readonly string[] {
  return [
    ...task.write_paths.map((path) => "write:" + path),
    ...task.exclusive_resources.map((resource) => "exclusive:" + resource),
  ].sort();
}
~~~

Path conflict uses the same ancestor/descendant function as compileParallelWaves(), not a divergent implementation. The table is in-memory and reconstructable; no ResourceLockRecord is written.

- [x] **Step 3: Write failing CLI/Dashboard Driver Lock race tests**

Create two contenders for one operation and one for another:

~~~ts
const cli = await lock.acquire({
  operation_id: "operation_1",
  driver_kind: "cli",
});
await expect(
  lock.acquire({ operation_id: "operation_1", driver_kind: "dashboard" }),
).rejects.toMatchObject({ kind: "driver_lock_unavailable" });
await expect(
  lock.acquire({ operation_id: "operation_2", driver_kind: "dashboard" }),
).resolves.toBeDefined();
~~~

Also test alive PID refuses reclamation, dead PID is reclaimed, malformed owner metadata blocks rather than being deleted, release by another owner fails, and Ledger transaction commits still work while Driver Lock is held.

- [x] **Step 4: Implement the atomic-directory Driver Lock**

Use an internal interface:

~~~ts
export interface DriverLockHandle {
  readonly operation_id: string;
  readonly owner_token: string;
  readonly path: string;
  release(): Promise<void>;
}

export interface DriverLock {
  acquire(input: {
    readonly operation_id: string;
    readonly driver_kind: "cli" | "dashboard";
  }): Promise<DriverLockHandle>;
}

export function createFileSystemDriverLock(options: {
  readonly harness_root: string;
  readonly host: string;
  readonly pid: number;
  readonly is_process_alive?: (pid: number) => boolean;
}): DriverLock;
~~~

Acquire with mkdir of .harness/locks/operation- plus the first 24 hexadecimal characters of contentDigest(operation_id), followed by .lock. Then atomically write owner.json containing operation_id, pid, host, driver_kind, acquired_at and random owner_token. Resolve/revalidate the exact lock root before mutation. Reclaim only same-host dead PID locks; never treat age alone as death.

- [x] **Step 5: Add path, symlink and owner-file security tests**

Prove operation_id cannot escape the lock root, a symlinked lock path is rejected, reserved .git/.harness writes are rejected before lock creation, owner JSON never contains environment values, and concurrent mkdir has exactly one winner.

- [x] **Step 6: Run focused tests**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/scheduling/resource-locks.test.ts packages/runtime/test/scheduling/driver-lock.test.ts tests/fault/m4-driver-lock-recovery.test.ts tests/security/m4-path-and-lock-boundary.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
~~~

Expected: resource mutual exclusion, dead-owner recovery and boundary rejection all pass.

- [x] **Step 7: Commit**

~~~bash
git add packages/runtime/src/scheduling/resource-locks.ts packages/runtime/src/scheduling/driver-lock.ts packages/runtime/test/scheduling/resource-locks.test.ts packages/runtime/test/scheduling/driver-lock.test.ts tests/fault/m4-driver-lock-recovery.test.ts tests/security/m4-path-and-lock-boundary.test.ts
git diff --cached --check
git commit -m "feat(runtime): guard scheduler resources and drivers"
~~~

### Task 7: Compose Task Workspaces with Strict TDD

**Depends on:** Task 2, Task 3 and Task 4.

**Parallel with:** Task 5 and Task 6. This task owns workspace-manager.ts and TDD workspace changes only.

**Files:**
- Create: packages/runtime/src/scheduling/workspace-manager.ts
- Create: packages/runtime/test/scheduling/workspace-manager.test.ts
- Create: packages/runtime/test/scheduling/workspace-manager.git.test.ts
- Modify: packages/runtime/src/tdd/workspace.ts
- Modify: packages/runtime/src/tdd/git-workspace.ts
- Modify: packages/runtime/src/tdd/phase-grants.ts
- Modify: packages/runtime/src/tdd/execution-runner.ts
- Modify: packages/runtime/test/tdd/workspace.test.ts
- Modify: packages/runtime/test/tdd/git-workspace.test.ts
- Modify: packages/runtime/test/tdd/execution-runner.test.ts

**Interfaces:**
- Consumes: IsolatedWorkspacePort, StrictTddExecutionPort, TaskSpecification, CapabilityGrant, PhaseGrant and normalized Task resource scopes.
- Produces: task_execution workspace purpose, TaskWorkspaceManager, TaskExecutionWorkspace, TaskCandidatePatch, prepareTaskWorkspace(), collectTaskCandidate(), collectStrictTddCandidate(), discardTaskWorkspace().

- [x] **Step 1: Write failing non-TDD isolated worktree tests**

Use a real temporary Git repository. Create two Task workspaces from the same base commit, write disjoint changes and prove:

~~~ts
expect(left.handle.baseline_commit).toBe(base);
expect(right.handle.baseline_commit).toBe(base);
expect(left.root).not.toBe(right.root);
expect(await gitHead(repositoryRoot)).toBe(base);
expect(leftCandidate.changed_paths).toEqual(["src/a.ts"]);
expect(rightCandidate.changed_paths).toEqual(["src/b.ts"]);
~~~

Deletion, binary content and mode changes must produce a canonical patch artifact; untracked files are included; .git, .harness, absolute, traversal and symlink escape changes are rejected.

- [x] **Step 2: Extend workspace purpose and add the internal manager**

Extend only the existing union:

~~~ts
export type TddWorkspacePurpose =
  | "baseline"
  | "test_authoring"
  | "red_verification"
  | "implementation"
  | "refactor"
  | "task_execution";
~~~

TaskWorkspaceManager is an internal composition layer, not a plugin SDK port:

~~~ts
export interface TaskCandidatePatch {
  readonly task_id: string;
  readonly baseline_commit: string;
  readonly changed_paths: readonly string[];
  readonly patch_locator: string;
  readonly patch_digest: string;
  readonly source_tree_digest: string;
  readonly source_revision?: string;
}

export interface TaskExecutionWorkspace {
  readonly workspace_id: string;
  readonly root: string;
  readonly handle: WorkspaceHandle;
}

export interface TaskWorkspaceInput {
  readonly task: Protocol13TaskSpecification;
  readonly baseline_commit: string;
  readonly slot_id: string;
}

export interface CollectTaskCandidateInput {
  readonly task: Protocol13TaskSpecification;
  readonly workspace: TaskExecutionWorkspace;
  readonly task_grant: CapabilityGrant;
}

export interface CollectStrictTddCandidateInput {
  readonly task: Protocol13TaskSpecification;
  readonly outcome: StrictTddTaskOutcome;
  readonly task_grant: CapabilityGrant;
  readonly phase_grant: CapabilityGrant;
  readonly path_policy: TddPathPolicy;
}

export interface TaskWorkspaceManager {
  prepareTaskWorkspace(input: TaskWorkspaceInput): Promise<TaskExecutionWorkspace>;
  collectTaskCandidate(input: CollectTaskCandidateInput): Promise<TaskCandidatePatch>;
  collectStrictTddCandidate(input: CollectStrictTddCandidateInput): Promise<TaskCandidatePatch>;
  discardTaskWorkspace(workspaceId: string): Promise<void>;
}
~~~

The production implementation uses exact git argument arrays, git diff --binary for the managed patch artifact and git ls-tree for source_tree_digest. It never trusts Agent commit metadata.

- [x] **Step 3: Write failing Strict TDD composition tests**

Assert there is no outer task_execution worktree and the accepted implementation_revision is the only patch source:

~~~ts
const candidate = await manager.collectStrictTddCandidate({
  task,
  outcome: completedTddOutcome,
  task_grant: taskGrant,
  phase_grant: greenGrant,
  path_policy: contract.path_policy,
});
expect(workspaceCreates.map((entry) => entry.purpose))
  .not.toContain("task_execution");
expect(candidate.source_revision).toBe(completedTddOutcome.implementation_revision);
~~~

Reject revision missing from Git, revision differing from TddCycle, absent accepted Red/Green Evidence and any path outside all four write-scope sets.

- [x] **Step 4: Implement four-way write-scope intersection**

Add:

~~~ts
export function effectiveTddWriteScopes(input: {
  readonly task_write_paths: readonly string[];
  readonly task_grant_write_paths: readonly string[];
  readonly phase_policy_write_paths: readonly string[];
  readonly phase_grant_write_paths: readonly string[];
}): readonly string[];
~~~

Compute true path-scope intersection, not string-array equality. Empty intersection blocks before execution. After resolving implementation_revision, attest every observed final path against the same intersection and verify the revision matches the accepted TDD Cycle/Evidence.

- [x] **Step 5: Make workspace cleanup idempotent**

destroy/discard may be replayed after a crash. Remove only a workspace registered by the manager and located under its exact managed root. Keep diagnostic workspace when policy marks the result blocked; normal release removes it after patch/evidence persistence.

- [x] **Step 6: Run TDD, workspace and Git tests**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/tdd packages/runtime/test/scheduling/workspace-manager.test.ts packages/runtime/test/scheduling/workspace-manager.git.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
~~~

Expected: existing Strict TDD tests stay green; non-TDD workspaces and accepted TDD revisions produce equivalent canonical TaskCandidatePatch objects.

- [x] **Step 7: Commit**

~~~bash
git add packages/runtime/src/scheduling/workspace-manager.ts packages/runtime/test/scheduling/workspace-manager.test.ts packages/runtime/test/scheduling/workspace-manager.git.test.ts packages/runtime/src/tdd packages/runtime/test/tdd
git diff --cached --check
git commit -m "feat(runtime): isolate task execution workspaces"
~~~

### Task 8: Build the Isolated Agent Pool and Reconstructable Live Projection

**Depends on:** Task 5, Task 6 and Task 7.

**Parallel with:** 无；它统一消费上一波三个互不冲突的实现，并首次拥有 packages/runtime/src/scheduling/index.ts。

**Files:**
- Create: packages/runtime/src/scheduling/agent-pool.ts
- Create: packages/runtime/src/scheduling/projection.ts
- Create: packages/runtime/src/scheduling/sqlite-projection.ts
- Create: packages/runtime/src/scheduling/events.ts
- Create: packages/runtime/src/scheduling/index.ts
- Create: packages/runtime/test/scheduling/agent-pool.test.ts
- Create: packages/runtime/test/scheduling/projection.test.ts
- Create: packages/runtime/test/scheduling/sqlite-projection.test.ts
- Modify: packages/runtime/src/scheduling/ports.ts
- Modify: packages/plugin-sdk/src/agent.ts
- Modify: packages/plugin-sdk/src/subprocess.ts
- Create: packages/plugin-sdk/test/agent.test.ts
- Modify: packages/plugin-sdk/test/subprocess.test.ts
- Modify: adapters/agent-command/src/adapter.ts
- Modify: adapters/agent-command/test/adapter.test.ts
- Modify: adapters/agent-dsh/src/adapter.ts
- Modify: adapters/agent-dsh/test/adapter.test.ts

**Interfaces:**
- Consumes: AgentAdapter, TaskWorkspaceManager, Task Lease/budget/resource guards and Protocol 1.3 event names.
- Produces: optional AgentRunOptions.signal, AgentSlotFactory, LocalAgentPool, AgentPoolSlot, TaskSchedulingStatus, projectSchedulerState(), SchedulerProjectionStore, createSqliteSchedulerProjectionStore(), createInMemorySchedulerProjectionStore().

- [x] **Step 1: Write failing Agent Pool isolation and Barrier tests**

Define the only per-slot factory seam:

~~~ts
export interface AgentSlotFactory {
  readonly adapter_manifest_digest: string;
  readonly manifest: AgentProviderManifest;
  create(input: {
    readonly slot_id: string;
    readonly worktree_root: string;
    readonly evidence_dir: string;
  }): AgentAdapter;
}
~~~

Use a Barrier-backed fake Adapter and two worktrees:

~~~ts
const runs = await Promise.all([
  pool.run(slotInput("slot_1", taskA, workspaceA)),
  pool.run(slotInput("slot_2", taskB, workspaceB)),
]);
expect(barrier.maximumConcurrent).toBe(2);
expect(runs.map((run) => run.task_id)).toEqual(["task_a", "task_b"]);
expect(adapterInstances).toHaveLength(2);
expect(adapterInstances[0]).not.toBe(adapterInstances[1]);
~~~

Assert unique TaskEnvelope, Run identity, evidence directory and explicit ResumeContext; no Adapter instance or hidden conversation is reused. manual/ineligible delegated Adapters force supervised single-slot behavior before a process starts.

- [x] **Step 2: Add compatible subprocess cancellation and implement fixed-slot LocalAgentPool**

Extend the existing run option, preserving every existing caller:

~~~ts
export interface AgentRunOptions {
  readonly mode: AgentRunMode;
  readonly resume?: AgentResumeContext;
  readonly on_output?: (output: AgentRunOutput) => void;
  readonly signal?: AbortSignal;
}
~~~

Pass signal through command/dsh adapters to PluginSubprocessOptions. runPluginSubprocess() sends SIGTERM once on abort, reports a distinct aborted flag/termination reason, removes its listener on close and preserves timeout/output-limit behavior. An Adapter that ignores the optional signal is treated as termination-unconfirmed and follows existing uncertain side-effect semantics; the Scheduler never claims cancellation succeeded from intent alone.

Use:

~~~ts
export interface LocalAgentPool {
  readonly capacity: number;
  run(input: AgentPoolRunInput): Promise<AgentPoolRunOutcome>;
  cancel(runId: string): Promise<void>;
  snapshot(): readonly AgentPoolSlot[];
}

export interface AgentPoolRunInput {
  readonly task_id: string;
  readonly run_id: string;
  readonly workspace_root: string;
  readonly evidence_dir: string;
  readonly envelope: AgentTaskEnvelope;
  readonly mode: AgentRunMode;
  readonly resume?: AgentResumeContext;
}

export interface AgentPoolRunOutcome {
  readonly slot_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly result: AgentRunResult;
}

export interface AgentPoolSlot {
  readonly slot_id: string;
  readonly state: "idle" | "running" | "cancelling";
  readonly task_id?: string;
  readonly run_id?: string;
}
~~~

The Pool owns only idle/running slot state and process observation. It does not read Plan, decide Policy, issue Lease, accept completion, write Ledger or integrate Git. Clamp capacity once from the effective concurrency supplied by Scheduler. cancel(runId) aborts that run's controller and waits for the Adapter result/termination accounting; it does not kill by PID outside the supervised child. on_output writes redacted tail observations through SchedulerProjectionStore; unavailable tokens/steps remain null.

- [x] **Step 3: Write failing authoritative Task status projection tests**

Cover the complete status union:

~~~ts
export const TASK_SCHEDULING_STATUSES = [
  "waiting_dependency",
  "ready",
  "awaiting_approval",
  "running",
  "verifying",
  "integration_queued",
  "candidate_validated",
  "retry_pending",
  "integrated",
  "blocked",
  "cancelled",
] as const;
export type TaskSchedulingStatus = (typeof TASK_SCHEDULING_STATUSES)[number];

export interface SchedulerLiveSnapshot {
  readonly operation_id: string;
  readonly observed_at: string;
  readonly slots: readonly AgentPoolSlot[];
  readonly tasks: readonly {
    readonly task_id: string;
    readonly pid: number | null;
    readonly heartbeat_at: string | null;
    readonly output_tail: string | null;
    readonly steps: number | null;
    readonly tokens: number | null;
    readonly duration_ms: number;
    readonly worktree_id: string | null;
  }[];
}

export interface SchedulerAuthorityFacts {
  readonly dag: TaskDagSnapshot;
  readonly leases: readonly TaskLeaseRecord[];
  readonly runs: readonly RunRecord[];
  readonly gate_evidence: readonly GateEvidenceRecord[];
  readonly approvals: readonly ApprovalRequestRecord[];
  readonly findings: readonly FindingRecord[];
  readonly wave_integrations: readonly WaveIntegrationRecord[];
}
~~~

Given Plan, Lease, Run, Gate, Evidence, Approval, Finding and WaveIntegration fixtures, assert deterministic state precedence. In particular: Agent completion never yields integrated; released Lease plus valid candidate Evidence yields candidate_validated; only WaveIntegrationRecord yields integrated; an open blocker wins over stale live PID.

- [x] **Step 4: Implement projectSchedulerState() as a pure projection**

~~~ts
export function projectSchedulerState(
  facts: SchedulerAuthorityFacts,
  live: SchedulerLiveSnapshot | null,
): SchedulerStateProjection;
~~~

Authoritative facts determine status. Live only decorates PID, heartbeat, output tail, worktree locator and current step. If live data is absent, return live_state: rebuilding rather than failed/success. Every provisional result is labeled provisional and cannot satisfy dependencies.

- [x] **Step 5: Write failing SQLite delete/rebuild and redaction tests**

Create, close, delete and rebuild the database:

~~~ts
await sqlite.replace(liveSnapshot);
expect(await sqlite.read("operation_1")).toEqual(liveSnapshot);
await sqlite.clear("operation_1");
expect(await sqlite.read("operation_1")).toBeNull();
expect(projectSchedulerState(authorityFacts, null))
  .toEqual(projectSchedulerState(authorityFacts, rebuiltLiveSnapshot));
~~~

Compare authoritative fields only. Inspect sqlite_master and raw database bytes to prove no API key, full environment, raw transcript, approval reason, user home path or authoritative digest chain is stored.

- [x] **Step 6: Implement node:sqlite projection and minimal event builders**

Use tables operation_live, slot_live and task_live keyed by operation_id plus slot/task. Store observed_at on every row. Replace an operation snapshot in one SQLite transaction. Validate rows on read and discard malformed live data without changing authoritative state.

events.ts exports typed builders for exactly the eight M4 events; builders redact absolute paths and output tail before appending Live Spool/Event payloads.

- [x] **Step 7: Run focused tests and shared barrels**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/plugin-sdk/test/agent.test.ts packages/plugin-sdk/test/subprocess.test.ts adapters/agent-command/test/adapter.test.ts adapters/agent-dsh/test/adapter.test.ts packages/runtime/test/scheduling/agent-pool.test.ts packages/runtime/test/scheduling/projection.test.ts packages/runtime/test/scheduling/sqlite-projection.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
~~~

Expected: Barrier proves two concurrent slots; all authoritative projections survive SQLite deletion.

- [x] **Step 8: Commit**

~~~bash
git add packages/plugin-sdk/src packages/plugin-sdk/test adapters/agent-command/src/adapter.ts adapters/agent-command/test/adapter.test.ts adapters/agent-dsh/src/adapter.ts adapters/agent-dsh/test/adapter.test.ts packages/runtime/src/scheduling packages/runtime/test/scheduling
git diff --cached --check
git commit -m "feat(runtime): run isolated local agent slots"
~~~

### Task 9: Implement the Deterministic LocalTaskScheduler

**Depends on:** Task 8.

**Parallel with:** 无；这是 M4 的核心状态机切片。

**Files:**
- Create: packages/runtime/src/scheduling/scheduler.ts
- Create: packages/runtime/src/scheduling/readiness.ts
- Create: packages/runtime/test/scheduling/readiness.test.ts
- Create: packages/runtime/test/scheduling/scheduler.test.ts
- Create: packages/runtime/test/scheduling/scheduler.property.test.ts
- Create: tests/performance/m4-scheduler-selection.test.ts
- Modify: packages/runtime/src/scheduling/index.ts

**Interfaces:**
- Consumes: TaskDagPort, PolicyDecisionPort, Lease/budget/resource reducers, LocalAgentPool, TaskWorkspaceManager, ProjectionStore and existing ApprovalService/Context assembly callbacks.
- Produces: LocalTaskScheduler, SchedulerDriveInput, SchedulerDriveResult, SchedulerTransition, selectReadyTasks(), effectiveMaxConcurrency(), createLocalTaskScheduler().

- [x] **Step 1: Write failing readiness and selection tests**

Pin scan order and wave barrier:

~~~ts
const selected = selectReadyTasks({
  dag,
  facts,
  resources,
  available_slots: 2,
  effective_max_concurrency: 2,
});
expect(selected.map((entry) => entry.task.id)).toEqual(["task_a", "task_b"]);
expect(selected.every((entry) => entry.wave_index === 0)).toBe(true);
~~~

If one wave-0 Task is awaiting approval, independent wave-0 Tasks may dispatch, but no wave-1 Task may cross the barrier. Exclude stale Context, unavailable budget/resource, ineligible Adapter and Tasks with active/current Lease. Keep Plan declaration order; never sort by duration, risk or model score.

- [x] **Step 2: Implement pure readiness and concurrency clamping**

~~~ts
export function effectiveMaxConcurrency(input: {
  readonly runtime_requested: number;
  readonly profile_limit: number;
  readonly installation_limit: number;
  readonly project_limit: number;
  readonly local_resource_limit: number;
  readonly unattended_eligible: boolean;
}): number;
~~~

Return the minimum positive bound; force 1 when unattended_eligible is false. selectReadyTasks() finds the earliest incomplete wave, scans its task_ids in Plan order and returns at most the lower of free slots and effective concurrency.

- [x] **Step 3: Write the failing dispatch transaction test**

Use an authority fixture that records transitions:

~~~ts
const result = await scheduler.drive(driveInput);
expect(authority.transitions.slice(0, 3).map((entry) => entry.kind)).toEqual([
  "policy_decided",
  "budget_reserved_and_lease_granted",
  "task_dispatched",
]);
expect(pool.startedBeforeLeaseCommit).toBe(false);
~~~

Cross Policy outcomes:

- allow commits reservation + granted Lease before Pool start;
- requires_approval creates one digest-bound ApprovalRequest and marks only that Task awaiting_approval;
- deny produces a blocking Finding without Lease;
- block produces a policy-conflict Finding without Lease and cannot consume an Approval.

- [x] **Step 4: Implement the drive loop with one authoritative transition seam**

Use these command/result contracts:

~~~ts
export interface SchedulerDriveInput {
  readonly operation_id: string;
  readonly expected_plan_digest: string;
  readonly requested_max_concurrency: number;
  readonly driver_lock: DriverLockHandle;
  readonly operation_lease?: LeaseRecord;
}

export interface SchedulerRecoverInput extends SchedulerDriveInput {
  readonly recovery_command_id: string;
}

export interface SchedulerCancelInput {
  readonly operation_id: string;
  readonly command_id: string;
  readonly reason: string;
  readonly driver_lock: DriverLockHandle;
}

export interface SchedulerDriveResult {
  readonly status: "completed" | "paused" | "blocked" | "cancelled";
  readonly operation_id: string;
  readonly read_model: SchedulerReadModel;
}
~~~

Use:

~~~ts
export type SchedulerTransition =
  | { readonly kind: "grant_lease"; readonly record: TaskLeaseRecord }
  | { readonly kind: "terminate_lease"; readonly record: TaskLeaseRecord }
  | { readonly kind: "append_evidence"; readonly evidence: readonly {
      readonly kind: string;
      readonly locator: string;
      readonly digest: string;
    }[] }
  | { readonly kind: "request_approval"; readonly request: ApprovalRequestRecord }
  | { readonly kind: "create_finding"; readonly finding: FindingRecord }
  | { readonly kind: "append_event"; readonly event: LifecycleEvent };
~~~

createLocalTaskScheduler() receives an internal SchedulerAuthority whose commit() maps one transition batch to the existing Ledger transaction. Keep this seam internal to runtime tests; do not export it from packages/runtime/src/index.ts.

The loop order must exactly follow design §9: reconstruct → earliest wave → Plan-order scan → eligibility → Policy → Approval → atomic Lease/budget/resource → workspace/context/grant/envelope → Pool → result classification. A returned Agent result enters verifying or retry/block logic; completion_claimed alone changes nothing.

- [x] **Step 5: Add executor retry, cancellation and token fencing tests**

Prove:

~~~ts
expect(firstCrash.retry_kind).toBe("executor_retry");
expect(secondCrash.status).toBe("blocked");
expect(secondCrash.remaining_budget).toEqual(
  subtractBudget(originalBudget, firstCrash.consumed_budget),
);
expect(() => scheduler.acceptRun(staleTokenResult)).toThrow(/stale fencing token/u);
~~~

Cancellation stops new Lease, requests active Pool cancellation, records uncertain external effects through the existing semantics, revokes active Lease and preserves diagnostic Evidence/worktrees. It never deletes accepted artifacts.

- [x] **Step 6: Add deterministic replay and 1,000-Task selection performance**

Property tests replay identical facts through different process restart points and require the same next transition digest. Performance test performs 100 warm selections over 1,000 Tasks:

~~~ts
expect(percentile95(samples)).toBeLessThan(100);
~~~

No wall-clock comparison between one and two Agent processes is accepted as the concurrency assertion.

- [x] **Step 7: Run scheduler tests**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/scheduling/readiness.test.ts packages/runtime/test/scheduling/scheduler.test.ts packages/runtime/test/scheduling/scheduler.property.test.ts
pnpm exec vitest run --config vitest.performance.ts tests/performance/m4-scheduler-selection.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
~~~

Expected: deterministic selection, four-state Policy, one retry, cancellation and p95 below 100ms all pass.

- [x] **Step 8: Commit**

~~~bash
git add packages/runtime/src/scheduling packages/runtime/test/scheduling tests/performance/m4-scheduler-selection.test.ts
git diff --cached --check
git commit -m "feat(runtime): schedule approved task waves"
~~~

### Task 10: Accept Candidates, Gate Waves and Recover without False Success

**Depends on:** Task 9.

**Parallel with:** 无；integration/recovery consumes the complete Scheduler state machine.

**Files:**
- Create: packages/runtime/src/scheduling/integration.ts
- Create: packages/runtime/src/scheduling/recovery.ts
- Create: packages/runtime/test/scheduling/integration.test.ts
- Create: packages/runtime/test/scheduling/integration.git.test.ts
- Create: packages/runtime/test/scheduling/recovery.test.ts
- Create: tests/fault/m4-wave-integration-boundaries.test.ts
- Create: tests/integration/m4-wave-cas.test.ts
- Modify: packages/runtime/src/scheduling/scheduler.ts
- Modify: packages/runtime/src/scheduling/index.ts
- Modify: adapters/vcs-git/src/worktree.ts
- Modify: adapters/vcs-git/test/worktree.test.ts

**Interfaces:**
- Consumes: TaskCandidatePatch, TaskLeaseRecord, WaveIntegrationRecord builder, Gate/Evidence services and existing staged Git/Ledger CAS.
- Produces: CandidateIntegrationController, queueTaskCandidate(), rebuildWaveCandidate(), validateTaskCandidate(), acceptWave(), recoverSchedulingOperation().

- [x] **Step 1: Write failing Plan-order candidate application tests**

Complete Task B before Task A but require Plan-order application:

~~~ts
await controller.queueTaskCandidate(candidateB);
await controller.queueTaskCandidate(candidateA);
const prepared = await controller.rebuildWaveCandidate(wave0);
expect(prepared.applied_task_ids).toEqual(["task_a", "task_b"]);
expect(prepared.base_commit).toBe(planBaseline);
~~~

Every Task candidate starts from the wave frozen base. A patch apply failure on the first candidate attempt produces integration_retry once; a second failure blocks. A clean textual apply that fails a candidate Gate is semantic conflict and must not consume integration_retry.

- [x] **Step 2: Implement deterministic candidate tree rebuild**

Use an internal controller:

~~~ts
export interface CandidateIntegrationController {
  queueTaskCandidate(candidate: TaskCandidatePatch): Promise<void>;
  rebuildWaveCandidate(input: RebuildWaveInput): Promise<WaveCandidate>;
  validateTaskCandidate(input: ValidateTaskCandidateInput): Promise<TaskCandidateValidation>;
  acceptWave(input: AcceptWaveInput): Promise<WaveIntegrationRecord>;
}

export interface RebuildWaveInput {
  readonly dag: TaskDagSnapshot;
  readonly wave: ParallelWave;
  readonly expected_base_commit: string;
}

export interface WaveCandidate {
  readonly wave_index: number;
  readonly base_commit: string;
  readonly candidate_commit: string;
  readonly applied_task_ids: readonly string[];
}

export interface ValidateTaskCandidateInput {
  readonly candidate: WaveCandidate;
  readonly task: Protocol13TaskSpecification;
  readonly lease: TaskLeaseRecord;
  readonly evidence: readonly {
    readonly kind: string;
    readonly locator: string;
    readonly digest: string;
  }[];
}

export interface TaskCandidateValidation {
  readonly task_id: string;
  readonly status: "candidate_validated" | "blocked";
  readonly evidence_digests: readonly string[];
}

export interface AcceptWaveInput {
  readonly dag: TaskDagSnapshot;
  readonly candidate: WaveCandidate;
  readonly validations: readonly TaskCandidateValidation[];
  readonly policy_decision: PolicyDecision;
  readonly approval_digests: readonly string[];
  readonly command_id: string;
}
~~~

Create a disposable candidate worktree at wave base, apply managed binary patches with git apply --index in Plan order and create Harness-owned Task commits with fixed identity/message inputs. Never use Agent commit metadata and never use git apply --3way, merge, rebase or force.

- [x] **Step 3: Write failing three-layer Gate and Evidence freshness tests**

Assert:

~~~text
Task workspace assertions/gates
  → Task patch on current candidate tree relevant gates
  → all candidate_validated
  → wave Mandatory Gates
  → final freshness
  → CAS
~~~

For every Evidence fixture, mutate one of actual commit, Plan/Task digest, Run, Lease token or Gate definition digest and require rejection. A released current Lease is valid for wave acceptance only when its terminal state was candidate_validated; expired/revoked/stale tokens are invalid.

- [x] **Step 4: Implement candidate and wave validation**

queueTaskCandidate() writes TaskIntegrationQueued. validateTaskCandidate() rechecks undeclared writes, Task assertions/gates and current fencing before writing TaskCandidateValidated and releasing runtime resources/unused budget. After all Tasks validate, run project Mandatory Gates once against the complete candidate.

Wave Gate failure leaves operation-local ref unchanged, creates wave_gate_failed Finding and blocks feedback/Impact/Plan revision. It must not move Tasks to retry_pending.

- [x] **Step 5: Write failing final CAS and source-tree digest tests**

Use a real repository and injected failure after each boundary. Assert:

~~~ts
expect(await readRef(operationRef)).toBe(baseCommit);
await controller.acceptWave(validInput);
expect(await readRef(operationRef)).toBe(candidateCommit);
expect(accepted.accepted_source_tree_digest).toBe(
  await sourceTreeDigest(candidateCommit, { excludeHarnessLedger: true }),
);
~~~

Move the target ref before acceptance and require baseline_drift without integration retry. Inject CAS success + lost response and require command_id replay to discover the already accepted WaveIntegrationRecord rather than advance twice.

- [x] **Step 6: Implement staged CAS plus WaveIntegrationRecord**

Immediately before acceptance revalidate Plan/Task, Policy/Approval, Gate definition, Evidence freshness, latest Lease token and expected base OID. Stage the Ledger manifest and operation-local ref update through the existing transaction/CAS mechanism. accepted_source_tree_digest excludes Harness Ledger content to avoid self-reference.

Unconnected mode updates refs/heads/operation/ followed by the exact operation_id. Connected M3 mode requires current Operation Lease and publishes the same local operation branch only through existing publish_operation_candidate; M4 never writes the remote target branch.

- [x] **Step 7: Implement crash recovery and provisional downgrade**

recoverSchedulingOperation():

1. rebuilds Plan/Lease/budget/wave from Ledger;
2. uses SQLite only to locate possible PID/worktree;
3. terminates orphan processes when provable;
4. revokes abnormal current Leases;
5. discards unaccepted candidate trees;
6. marks candidate-bound Evidence provisional;
7. preserves Task branch/Run/transcript;
8. selects retry_pending or blocked from typed failure and remaining budget;
9. issues a higher token only on a new grant.

If wave_gate_failed or Plan drift Finding remains open, recovery must not rebuild/accept the candidate. Otherwise it replays valid Task patches in Plan order and reruns candidate plus wave Gates; it never restores candidate_validated from old candidate Evidence.

- [x] **Step 8: Run Git, fault and integration suites**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/scheduling/integration.test.ts packages/runtime/test/scheduling/integration.git.test.ts packages/runtime/test/scheduling/recovery.test.ts adapters/vcs-git/test/worktree.test.ts tests/fault/m4-wave-integration-boundaries.test.ts tests/integration/m4-wave-cas.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
pnpm --filter @universal-harness-internal/adapter-vcs-git typecheck
~~~

Expected: no injected boundary produces duplicate integration, stale Evidence acceptance, ref-without-Ledger or false Task success.

- [x] **Step 9: Commit**

~~~bash
git add packages/runtime/src/scheduling packages/runtime/test/scheduling adapters/vcs-git/src/worktree.ts adapters/vcs-git/test/worktree.test.ts tests/fault/m4-wave-integration-boundaries.test.ts tests/integration/m4-wave-cas.test.ts
git diff --cached --check
git commit -m "feat(runtime): integrate task waves atomically"
~~~

### Task 11: Connect the Scheduler to the Capability DAG and Vertical Loop

**Implementation state:** 除 Step 4 的完整批准后自动唤醒/反馈闭环外，其余步骤已有提交与测试证据；该缺口继续计入 AC-17，不以显式 `resume` 的可用性替代。

**Depends on:** Task 10.

**Parallel with:** 无；Task 11 冻结 CLI 与 Dashboard 共用的 runtime service/read model。

**Files:**
- Create: packages/runtime/src/orchestration/scheduler-runtime.ts
- Create: packages/runtime/src/scheduling/read-model.ts
- Create: packages/runtime/test/orchestration/scheduler-runtime.test.ts
- Create: packages/runtime/test/scheduling/read-model.test.ts
- Modify: packages/runtime/src/orchestration/capability-dag-runners.ts
- Modify: packages/runtime/src/orchestration/capability-dag-runtime.ts
- Modify: packages/runtime/src/orchestration/kernel-coordinator.ts
- Modify: packages/runtime/src/orchestration/pipeline-types.ts
- Modify: packages/runtime/src/orchestration/profile-modules.ts
- Modify: packages/runtime/src/orchestration/lifecycle-events.ts
- Modify: packages/runtime/src/status/status.ts
- Modify: packages/runtime/src/index.ts
- Modify: packages/runtime/test/orchestration/capability-plan-routing.test.ts
- Modify: packages/runtime/test/orchestration/strict-tdd-routing.test.ts
- Modify: packages/runtime/test/orchestration/orchestrator.test.ts

**Interfaces:**
- Consumes: Protocol 1.3 CapabilityPlan execute subgraph, LocalTaskScheduler, CandidateIntegrationController, Driver Lock proof, M3 Operation Lease proof and existing verify/evaluate/snapshot runtimes.
- Produces: ParallelTaskExecutionPort, driveParallelTaskExecution(), SchedulerReadModel, readSchedulerModel(), parallel execute binding and sequential compatibility routing.

- [x] **Step 1: Write failing Capability DAG routing tests**

Pin all three combinations:

~~~ts
expect(resolveExecuteSubgraph(active("parallel_task_execution", "strict_tdd")))
  .toBe("parallel_task_execution");
expect(resolveExecuteSubgraph(active("strict_tdd")))
  .toBe("strict_tdd");
expect(resolveExecuteSubgraph(active()))
  .toBeUndefined();
~~~

When parallel is inactive, assert TaskDagPort, PolicyDecisionPort, Agent Pool and Task Lease builders are never invoked and the old sequential execution output is byte-equivalent. When active, execute produces wave_integration binding once, then Kernel verify remains the only gate_evidence producer.

- [x] **Step 2: Implement the parallel execute runner**

Use:

~~~ts
export interface ParallelTaskExecutionPort {
  run(input: {
    readonly operation_id: string;
    readonly iteration_id: string;
    readonly capability_plan_digest: string;
    readonly expected_plan_digest: string;
    readonly driver_lock: DriverLockHandle;
    readonly operation_lease?: LeaseRecord;
  }): Promise<ParallelTaskExecutionOutcome>;
}

export interface ParallelTaskExecutionOutcome {
  readonly status: "completed" | "paused" | "blocked" | "cancelled";
  readonly operation_id: string;
  readonly wave_integration_digests: readonly string[];
  readonly scheduler_state_digest: string;
}
~~~

driveParallelTaskExecution() verifies the active Capability resolution, Driver Lock and connected-mode M3 Operation Lease before calling Scheduler. It loops until all waves integrate, a recoverable Approval pause occurs, cancellation occurs or a blocker exists. It persists checkpoints through existing Workflow Engine callbacks; it does not invent a new global phase.

- [x] **Step 3: Write failing full lifecycle and invalidation tests**

Drive:

~~~text
capture → capability_decision → impact → design → plan
→ context → execute[parallel_task_execution]
→ verify → evaluate → snapshot
~~~

Assert Plan, Task, resource, budget, Policy, Approval, Adapter, baseline, Gate definition or Context source drift invalidates pending scheduling decisions before Lease and makes in-flight results provisional before verification/integration. Design/Impact/Profile legacy invalidation behavior must remain unchanged.

- [ ] **Step 4: Integrate findings, approvals, checkpoints and feedback**

Map typed blockers to existing Finding/Recovery actions:

~~~ts
export const SCHEDULER_RECOVERY_ACTIONS = {
  approval_missing: "open_approval",
  budget_exhausted: "submit_budget_policy_proposal",
  executor_failed: "inspect_retry",
  integration_conflict: "inspect_candidate_conflict",
  undeclared_write: "revise_plan_resources",
  baseline_drift: "return_to_impact_and_plan",
  wave_gate_failed: "open_gate_evidence_and_replan",
  adapter_ineligible: "change_adapter_or_supervise",
} as const;
~~~

Approval arrival wakes only a live driver. If no driver exists, project the exact command harness resume operation_123 using the real operation id. Feedback from wave gate failure returns through existing feedback → impact/design/plan cascade and requires an explicit fix Task in a newly approved Plan.

- [x] **Step 5: Write failing Scheduler Read Model tests**

Freeze the API-facing runtime shape:

~~~ts
export interface SchedulerReadModel {
  readonly capability_status: "active" | "inactive_by_profile";
  readonly operation: {
    readonly operation_id: string;
    readonly iteration_id: string;
    readonly status: string;
  };
  readonly plan: {
    readonly plan_id: string;
    readonly plan_digest: string;
    readonly waves: readonly ParallelWave[];
  } | null;
  readonly tasks: readonly SchedulerTaskProjection[];
  readonly slots: readonly AgentPoolSlot[];
  readonly budget: {
    readonly limit: IterationBudget;
    readonly consumed_steps: number;
    readonly consumed_tokens: number;
    readonly reserved_steps: number;
    readonly reserved_tokens: number;
  };
  readonly approvals: readonly ApprovalRequestRecord[];
  readonly findings: readonly FindingRecord[];
  readonly presentation_map: Readonly<Record<string, string>>;
  readonly digest: string;
}

export interface SchedulerTaskProjection {
  readonly task_id: string;
  readonly title: string;
  readonly wave_index: number;
  readonly status: TaskSchedulingStatus;
  readonly authority: "ledger" | "provisional";
  readonly dependency_ids: readonly string[];
  readonly non_parallel_reasons: readonly string[];
  readonly current_lease_digest?: string;
  readonly current_run_id?: string;
  readonly retry_kind?: "executor_retry" | "integration_retry";
}
~~~

~~~ts
const view = await readSchedulerModel("operation_1");
expect(view).toMatchObject({
  capability_status: "active",
  operation: { operation_id: "operation_1" },
  budget: { limit: iterationBudget },
});
expect(view.tasks[0]).toMatchObject({
  task_id: "task_api",
  authority: "ledger",
});
~~~

The model includes Operation, Plan/waves, Task projection, Slot live projection, Budget/reservations, pending Approvals, blocking Findings and presentation map in one snapshot. Lite/inactive returns capability_status: inactive_by_profile and no fabricated tasks. Live loss returns rebuilding.

- [x] **Step 6: Implement readSchedulerModel() and 1,000-Task timing fixture**

Read Ledger/Graph first, read SQLite/live spool second, then join through projectSchedulerState(). Never let Dashboard callers read SQLite/worktrees/raw trace directly. Add an internal benchmark fixture that Task 14 will expose as the <250ms release gate.

- [x] **Step 7: Run orchestration and status regressions**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/orchestration packages/runtime/test/scheduling/read-model.test.ts packages/runtime/test/status
pnpm --filter @universal-harness-internal/runtime typecheck
~~~

Expected: parallel, strict-TDD-only and legacy sequential routes all pass; no second gate_evidence producer appears.

- [x] **Step 8: Commit**

~~~bash
git add packages/runtime/src/orchestration packages/runtime/src/scheduling/read-model.ts packages/runtime/src/status packages/runtime/src/index.ts packages/runtime/test/orchestration packages/runtime/test/scheduling/read-model.test.ts packages/runtime/test/status
git diff --cached --check
git commit -m "feat(orchestration): drive parallel execution subgraph"
~~~

### Task 12: Expose the Scheduler through Existing CLI Commands

**Implementation state:** Step 2～7 已落地。Step 1 仍未完成“超过 Policy 上限时生成 Policy Proposal”的生产路径，且 Host/CLI 尚未接入权威 Policy layer source，因此 AC-10 继续阻塞。

**Depends on:** Task 11.

**Parallel with:** Task 13. Task 12 owns packages/cli only.

**Files:**
- Create: packages/cli/test/m4-scheduling.test.ts
- Create: packages/cli/test/m4-driver-lock.test.ts
- Modify: packages/cli/src/project-agent.ts
- Modify: packages/cli/src/project-runtime-config.ts
- Modify: packages/cli/src/runtime-service.ts
- Modify: packages/cli/src/commands/iterate.ts
- Modify: packages/cli/src/commands/plan.ts
- Modify: packages/cli/src/commands/run.ts
- Modify: packages/cli/src/commands/resume.ts
- Modify: packages/cli/src/commands/status.ts
- Modify: packages/cli/src/commands/watch.ts
- Modify: packages/cli/src/commands/abort.ts
- Modify: packages/cli/src/commands/serve.ts
- Modify: packages/cli/src/router.ts
- Modify: packages/cli/test/runtime-service-facade.test.ts

**Interfaces:**
- Consumes: ParallelTaskExecutionPort, SchedulerReadModel, AgentSlotFactory, createFileSystemDriverLock() and existing CommandResult contract.
- Produces: runtime agent_pool.slots config, --max-concurrency parsing, thin run/resume/status/watch/abort/serve scheduling routes.

- [ ] **Step 1: Write failing config and argument tests**

~~~ts
expect(readRuntimeConfig({
  agent_pool: { slots: 4 },
})).toEqual({ agent_pool: { slots: 4 } });
expect(parseRunArgs(["--max-concurrency", "3"]).max_concurrency).toBe(3);
expect(() => parseRunArgs(["--max-concurrency", "0"])).toThrow(/positive integer/u);
~~~

The local value is a request, never authority. Assert requested 8 with Policy 2 results in 2, decreasing needs no Approval, and raising beyond Policy yields a Policy Proposal path rather than silent expansion.

- [x] **Step 2: Build an isolated AgentSlotFactory in project-agent.ts**

For every slot/worktree invocation, create a fresh existing Adapter with that worktree and a run-specific evidence directory. Do not cache the Adapter instance. Preserve the current dsh/command/manual provider selection and existing manifest validation.

~~~ts
export function createProjectAgentSlotFactory(
  context: ProjectAgentContext,
): AgentSlotFactory;
~~~

If the manifest is manual or fails unattended eligibility, surface supervised single-slot mode before run starts.

- [x] **Step 3: Write failing command behavior and stdout tests**

Cover:

- iterate generates resource claims/budgets/waves through Plan compiler;
- plan displays Task dependencies, waves, conflicts and budgets;
- run/resume accept --max-concurrency;
- status shows wave/Task/Slot/Budget/Approval/Finding;
- watch displays the eight M4 Events;
- abort cancels and reconciles;
- serve remains read-only until an explicit Dashboard resume action.

For --json, capture streams:

~~~ts
expect(JSON.parse(stdout)).toEqual(expectedCommandResult);
expect(stdout.trim().split("\n")).toHaveLength(1);
expect(stderr).toContain("wave 1");
~~~

Live progress belongs on stderr/live spool; stdout remains one final CommandResult.

- [x] **Step 4: Enforce the shared Driver Lock on every driving path**

run and resume acquire driver_kind cli; Dashboard resume inside serve acquires driver_kind dashboard. status/watch/serve reads do not acquire it. Losing acquisition returns driver_lock_unavailable without a new domain record. Release in finally after Scheduler stops/pauses. Connected mode independently verifies M3 Operation Lease.

- [x] **Step 5: Implement status, watch and recovery copy**

Use the presentation map from SchedulerReadModel and Chinese business descriptions by default. Print digests only in technical details/JSON. Every blocker displays exactly one recommended recovery action from SCHEDULER_RECOVERY_ACTIONS; do not add ignore/force switches.

- [x] **Step 6: Run CLI unit and golden tests**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/cli/test
pnpm --filter @universal-harness-internal/cli typecheck
pnpm --filter @universal-harness-internal/cli build
~~~

Expected: legacy commands and new parallel views pass; CLI/Dashboard drive collision has one winner.

- [x] **Step 7: Commit**

~~~bash
git add packages/cli/src packages/cli/test
git diff --cached --check
git commit -m "feat(cli): drive and inspect local task waves"
~~~

### Task 13: Add the Observatory Scheduler View and Approval Experience

**Implementation state:** Read API、只读 Scheduler 视图、受保护的既有写动作、响应式 UI 与当前 Playwright 门禁已落地；生产 Policy Proposal、完整 grounded approval context 和 driver-alive 批准自动唤醒仍未完成，Step 3/5/6 保持未勾选并计入 AC-16/17。

**Depends on:** Task 11.

**Parallel with:** Task 12. Task 13 owns packages/dashboard and its Playwright file only.

**Files:**
- Create: packages/dashboard/src/scheduler-api.ts
- Create: packages/dashboard/test/scheduler-api.test.ts
- Create: tests/e2e/dashboard-m4-scheduler.test.ts
- Modify: packages/dashboard/src/read-api.ts
- Modify: packages/dashboard/src/write-api.ts
- Modify: packages/dashboard/src/router.ts
- Modify: packages/dashboard/src/server.ts
- Modify: packages/dashboard/src/presentation.ts
- Modify: packages/dashboard/src/assets.ts
- Modify: packages/dashboard/src/index.ts
- Modify: packages/dashboard/assets/dashboard.html
- Modify: packages/dashboard/assets/dashboard.css
- Modify: packages/dashboard/assets/dashboard.js
- Modify: packages/dashboard/test/assets.test.ts
- Modify: packages/dashboard/test/security.test.ts

**Interfaces:**
- Consumes: readSchedulerModel(), existing SSE, ApprovalService, loopback session/CSRF/actor/expected-digest guards.
- Produces: GET /api/v1/scheduler?operation_id=operation_123, Scheduler navigation/view, approval/recovery/budget-concurrency proposal actions.

- [x] **Step 1: Write failing Read API authority tests**

~~~ts
const response = await api.read({ operation_id: "operation_1" });
expect(response.tasks[0]).toMatchObject({
  title: "实现 API 契约",
  status_label: "候选已验证",
  authority: "authoritative",
});
expect(response.slots[0]).toMatchObject({
  authority: "live",
});
~~~

Reject missing/invalid operation_id. Assert endpoint returns one coherent snapshot with Plan/waves, Tasks, Slots, Budget, Approvals, Findings and presentation map. It never returns raw environment, absolute user path, raw trace or direct SQLite locator.

- [x] **Step 2: Implement the thin Scheduler API route**

Route only GET /api/v1/scheduler. It delegates to readSchedulerModel(), applies existing problem+json errors and preserves loopback/session policy. Use SSE for incremental refresh; do not add WebSocket or a Scheduler HTTP service.

- [ ] **Step 3: Write failing allowed/forbidden write-action tests**

Allowed actions:

~~~text
approval decide/defer
explicit operation resume
operation cancel
budget/concurrency Policy Proposal
~~~

Forbidden action names must return 404/invalid_action and create no write:

~~~text
force_task_success
skip_gate
move_task_to_slot
force_release_lease
force_merge_candidate
ignore_baseline_drift
~~~

Every allowed write requires loopback session, CSRF, actor, expected object digest, Policy Decision and Ledger Evidence.

- [x] **Step 4: Build the Scheduler view with improved information hierarchy**

Add one Observatory navigation item and four responsive regions:

1. summary strip: current wave, slots, Task progress, Findings, total/used/reserved budget;
2. DAG/waves: dependency edges, business objective, status and exact non-parallel reason;
3. Agent Pool: Slot, Task, Run, Lease, heartbeat and usage, with worktree shown only as redacted identifier;
4. Task detail timeline: Lease → Context → Execute → Verify → Integrate → Release, Assertions, Gates, Evidence, Retry and Finding.

Use existing visual tokens but improve scanability with status chips, compact budget bars, sticky Task detail on desktop and one-column cards at 360px. Chinese business attributes remain primary; digest is collapsed in 技术详情.

- [ ] **Step 5: Render authoritative, live and provisional states distinctly**

Authoritative Ledger facts use solid state labels; Live rows include observed_at and a live marker; provisional Agent/candidate results use dashed treatment and cannot appear green/success. When SQLite disappears, render 正在从 Ledger 重建 and keep authoritative progress unchanged.

Approval cards show action, Task/wave objective, risk, write paths, exclusive resources, Adapter/control profile, budget, parallel impact, Plan/baseline/Policy bindings and cited grounded brief. If no driver is alive after approval, show exact harness resume command.

- [ ] **Step 6: Add desktop/mobile Playwright flows**

At desktop and 360px:

- navigate to Scheduler;
- inspect two waves and two concurrent Slots;
- open Task detail;
- approve a requires_approval dispatch and observe resume;
- reject an integrate_wave request;
- display budget_exhausted recovery;
- delete live projection and observe rebuilding;
- prove CLI-held Driver Lock prevents Dashboard resume;
- prove no force controls exist.

- [x] **Step 7: Run Dashboard unit, security and Playwright tests**

~~~bash
pnpm exec vitest run --config vitest.workspace.ts packages/dashboard/test
pnpm exec playwright test --config playwright.dashboard.config.ts tests/e2e/dashboard-m4-scheduler.test.ts
pnpm --filter @universal-harness-internal/dashboard typecheck
pnpm --filter @universal-harness-internal/dashboard build
~~~

Expected: Scheduler view is usable at both widths, Approval/restore behavior is correct and existing Observatory routes remain green.

- [x] **Step 8: Commit**

~~~bash
git add packages/dashboard/src packages/dashboard/assets packages/dashboard/test tests/e2e/dashboard-m4-scheduler.test.ts
git diff --cached --check
git commit -m "feat(dashboard): visualize local task scheduling"
~~~

### Task 14: Prove Conformance, Recovery, Performance and Real Dogfood

**Implementation state:** Conformance、真实 Git managed-fixture E2E、故障矩阵、安全与性能门禁已落地；真实 dsh 只能形成受监督单槽探针，完整四 Task/双槽/wave Dogfood 尚不可证明。发布报告链正在绑定最终提交重新生成。

**Depends on:** Task 12 and Task 13.

**Parallel with:** 无；这是完成声明的唯一发布证据任务。

**Files:**
- Modify: packages/conformance/src/scheduling.ts
- Modify: packages/conformance/test/scheduling.conformance.test.ts
- Create: tests/e2e/m4-local-multi-agent.test.ts
- Create: tests/e2e/m4-sequential-compatibility.test.ts
- Create: tests/fault/m4-scheduler-crash-matrix.test.ts
- Create: tests/security/m4-scheduler-boundaries.test.ts
- Create: tests/performance/m4-scheduler-read-api.test.ts
- Create: tests/performance/m4-sqlite-rebuild.test.ts
- Create: scripts/dogfood-m4-local-scheduler.mjs
- Create: scripts/dogfood-m4-redaction.mjs
- Create: docs/evidence/m4-local-multi-agent-scheduling-completion.md
- Modify: scripts/generate-acceptance-report.mjs
- Modify: package.json
- Modify: vitest.workspace.ts
- Modify: .github/workflows/ci.yml
- Modify: README.md
- Modify: docs/graph-driven-harness-model.md

**Interfaces:**
- Consumes: all M4 production Adapters, Scheduler APIs, CLI/Dashboard surfaces and AC-01～20.
- Produces: complete scheduling conformance suites, crash matrix, performance gates, real dogfood Evidence and current-commit completion report.

- [x] **Step 1: Complete all Port/Adapter conformance suites**

Extend scheduling conformance with:

~~~ts
export function workspaceConformanceCases(factory: WorkspaceFactory): readonly ConformanceCase[];
export function schedulerProjectionConformanceCases(
  factory: ProjectionFactory,
): readonly ConformanceCase[];
export function agentControlProfileCases(factory: AgentFixtureFactory): readonly ConformanceCase[];
~~~

Run Git and InMemory IsolatedWorkspace, SQLite and InMemory Projection, plus managed/delegated/manual Agent fixtures through identical cases. Keep TaskDag and Policy cases from Task 4. Every production Adapter must pass before E2E runs.

- [x] **Step 2: Add the complete real-Git E2E**

Use a temporary real repository, real Git worktrees, deterministic managed Agent fixture and real Gate/Evidence adapters:

~~~text
approved 4-Task Plan
  wave 0: task_api || task_ui
  wave 1: task_contract
  wave 2: task_release
→ two-slot Barrier proves task_api/task_ui overlap
→ Task gates
→ Plan-order candidate validation
→ wave gates/CAS/records
→ generic verify/evaluate/snapshot
~~~

Assert exact dependency Graph, Task isolation, unique Run/Lease identities, Evidence binding, budget totals, wave records and final source tree. Then run the same fixture under Lite and a Protocol 1.2 Plan to prove sequential fallback with no M4 records/events.

- [x] **Step 3: Add the full fault-injection matrix**

Kill after:

~~~text
Lease commit / before process
process start / before PID projection
Agent result / before Evidence
Task Gate / before integration queue
Task commit / before candidate Gate
candidate Gate / before Lease release
wave Gate / before CAS
CAS preparation / before Ledger transaction
CAS success / lost response
Approval request / decision arrival
Driver Lock acquisition / driver exit
Coordinator restart / SQLite deletion
~~~

For every boundary assert no duplicate process acceptance, no duplicate integration, no stale fencing token acceptance, no incorrect budget return, no ref/Ledger split and no false success.

- [x] **Step 4: Add security and performance release gates**

Security covers path traversal, symlink escape, reserved .git/.harness writes, command argument injection, stale Approval, Adapter privilege expansion, output/SQLite/Event secret scanning and Dashboard force-action rejection.

Performance uses fixed deterministic data:

~~~ts
expect(waveCompileP95).toBeLessThan(500);
expect(scheduleSelectP95).toBeLessThan(100);
expect(schedulerReadApiP95).toBeLessThan(250);
expect(rebuiltAuthorityDigest).toBe(originalAuthorityDigest);
~~~

SQLite rebuild equality is mandatory. Do not assert that two agents are two times faster; concurrency proof remains the Barrier and overlapping Run intervals.

- [ ] **Step 5: Run real M4 dogfood and redact its Evidence**

scripts/dogfood-m4-local-scheduler.mjs must require a clean repository and real configured AgentAdapter. It executes at least four real Tasks, at least two concurrent Tasks and at least two waves through worktree, Gate, Evaluation and Snapshot. Record:

- baseline/Plan/Task/Lease/Run/Gate/Evidence/Wave/Snapshot digests;
- start/end interval per Task proving overlap;
- serial estimate, actual elapsed and wait reasons as observational Evidence;
- command, exit code, git commit SHA and adapter manifest digest.

Pipe all artifacts through scripts/dogfood-m4-redaction.mjs. If provider/config/gates are unavailable, record blocked with the exact prerequisite; never mark AC-20 passed from a fake Adapter or Agent self-report.

- [ ] **Step 6: Generate the AC-01～20 completion matrix**

docs/evidence/m4-local-multi-agent-scheduling-completion.md has one row per AC:

The generated row is sourced from the acceptance result object, not hand-entered:

~~~ts
const row = {
  ac: result.acceptance_id,
  status: result.status,
  commit: report.commit_sha,
  command: result.command,
  evidence_digest: result.evidence_digest,
  design_section: result.design_section,
};
~~~

The generator fills real SHA/digests from machine-readable results. It fails when a row is absent, not passed, bound to another commit or backed only by narrative. M4 completion is false until all 20 rows and dogfood bind the same current commit.

- [ ] **Step 7: Update public architecture documentation**

README and docs/graph-driven-harness-model.md must show:

- Lite sequential execute versus Standard/Governed parallel_task_execution subgraph;
- Plan DAG → deterministic waves → Lease/Pool/worktree → candidate/wave Gate → WaveIntegration → verify/evaluate/snapshot;
- authoritative Ledger versus live SQLite versus provisional Agent result;
- Driver Lock and optional M3 Operation Lease nesting;
- Scheduler Dashboard screenshot after Playwright confirms the final UI.

Do not describe remote workers, heterogeneous model routing, background Scheduler service, dynamic Task rewriting or automatic conflict resolution.

- [ ] **Step 8: Wire CI and run the complete release gate**

~~~bash
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm test:security
pnpm test:fault
pnpm test:performance
pnpm test:e2e
pnpm test:e2e:dashboard
pnpm pack:smoke
node scripts/generate-acceptance-report.mjs
~~~

Expected: every repository-local command passes, M1/M2/M3 and sequential compatibility remain green, AC-01～20 report binds current HEAD, and real dogfood Evidence is present.

- [ ] **Step 9: Commit the release proof**

~~~bash
git add packages/conformance tests scripts docs/evidence/m4-local-multi-agent-scheduling-completion.md package.json vitest.workspace.ts .github/workflows/ci.yml README.md docs/graph-driven-harness-model.md
git diff --cached --check
git commit -m "test(release): prove M4 local multi-agent scheduling"
~~~

## Dependency Graph and Parallel Execution Waves

计划执行器必须遵循下图。箭头是硬依赖；同一括号中的任务只有在前置任务已通过 fresh review、使用独立 worktree 且遵守共享文件所有权时才可并行。

~~~text
Wave P0
  Task 1  Protocol 1.3 records/reader
      │
      ├──────────────────┐
Wave P1                  │
  Task 2  Capability/Profile/DAG/Policy
      │                  │
  Task 3  Plan/waves/resources/budget     (Task 2 || Task 3)
      └─────────┬────────┘
                ↓
Wave P2
  Task 4  TaskDagPort + PolicyDecisionPort
                │
      ┌─────────┼─────────┐
      ↓         ↓         ↓
Wave P3
  Task 5     Task 6     Task 7
  Lease/     Locks/     Workspace/
  Budget     Driver     Strict TDD         (Task 5 || Task 6 || Task 7)
      └─────────┼─────────┘
                ↓
Wave P4
  Task 8  Agent Pool + projection
                ↓
Wave P5
  Task 9  Deterministic Scheduler
                ↓
Wave P6
  Task 10 Candidate/wave integration + recovery
                ↓
Wave P7
  Task 11 Orchestration + shared Read Model
           ┌────┴────┐
           ↓         ↓
Wave P8
  Task 12 CLI    Task 13 Dashboard         (Task 12 || Task 13)
           └────┬────┘
                ↓
Wave P9
  Task 14 Conformance/fault/perf/dogfood/release
~~~

Task 2 与 Task 3 是并行开发，不是同一 commit：Task 2 合入后 Task 3 必须在最新基线上重跑 planning tests；反向亦然。Task 5/6/7 不得各自修改 runtime 公共 barrel，由 Task 8 一次完成接线。Task 12/13 合流后，Task 14 先跑 CLI + Dashboard focused gates，再开始真实 dogfood。

## Acceptance Coverage Matrix

| Design / Acceptance | Owning task(s) |
| --- | --- |
| AC-01 Plan 唯一权威、Graph/wave 原子投影 | Task 3、Task 4 |
| AC-02 DAG、缺失依赖、wave drift 与不确定拆分拒绝 | Task 3、Task 4 |
| AC-03 write path / exclusive resource 机械串行化 | Task 3、Task 6 |
| AC-04 Capability Module 与三档 Profile | Task 2、Task 11 |
| AC-05 Adapter 无人值守资格 | Task 8、Task 9 |
| AC-06 两个真实隔离 Task 并行 | Task 8、Task 14 |
| AC-07 Context/Budget/Run/worktree/hidden-history 隔离与 TDD 四层写集 | Task 7、Task 8、Task 14 |
| AC-08 Lease、fencing、Envelope 与重启恢复 | Task 1、Task 5、Task 10、Task 14 |
| AC-09 Iteration 并发预算不超限 | Task 5、Task 9 |
| AC-10 三 Action、Policy 四态与 Approval drift | Task 2、Task 4、Task 9 |
| AC-11 三层 Gate 与 wave 原子集成 | Task 7、Task 10 |
| AC-12 两类 Retry 各最多一次 | Task 9、Task 10 |
| AC-13 二次失败、越权写入与预算耗尽阻塞 | Task 7、Task 9、Task 10 |
| AC-14 baseline drift 不 force/rebase | Task 10 |
| AC-15 Evidence 完整 binding 与 candidate 丢弃后重验 | Task 10 |
| AC-16 Dashboard 完整调度与恢复状态 | Task 11、Task 13 |
| AC-17 CLI 闭环与 CLI/Dashboard 单 Driver | Task 6、Task 11、Task 12、Task 13 |
| AC-18 SQLite 删除后权威状态可恢复 | Task 8、Task 10、Task 14 |
| AC-19 Protocol 1.3 与 M1/M2/M3/顺序回归 | Task 1、Task 2、Task 3、Task 11、Task 14 |
| AC-20 当前提交真实 dogfood 与验收报告 | Task 14 |

## Fresh Review Gates

每个 Task 提交后由下一位执行者开始前完成以下门禁：

1. 检查 git show --stat 与本 Task Files 清单，发现跨任务文件必须先解释并复核；
2. 运行本 Task focused tests、typecheck 与 git diff --check；
3. 核对 Interfaces 中 Produces 与后续 Consumes 的名字、字段和 optionality；
4. 核对该提交没有 teach/、.env、SQLite、worktree、raw trace 或 secret；
5. 核对 Agent 自述没有被写成 passed Evidence；
6. 同一并行波次的提交合流后重跑双方 focused suites；
7. P0/P1 Finding 未关闭时不得进入下一依赖波次。

## Completion Rule

M4 只有在以下条件同时满足后才能声明完成：

1. Task 1～14 均有独立提交并通过 fresh review；
2. AC-01～20 全部由当前 HEAD 的不可变 Evidence 证明；
3. Protocol 1.0–1.3、M1/M2/M3、Lite/legacy sequential 回归全绿；
4. 完整 release gate 全绿；
5. 真实 AgentAdapter dogfood 包含至少四个 Task、两个并行 Task、两个 wave 和重叠 Run 时间区间；
6. Dashboard 与 CLI 能从 Ledger 复盘每个 Task，SQLite 删除不改变权威结论；
7. 不存在未接受的 P0/P1 Finding；
8. Completion Report 不依赖 Agent completion claim、Dashboard 截图或文档自述。
