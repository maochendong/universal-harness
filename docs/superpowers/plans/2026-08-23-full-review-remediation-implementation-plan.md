# Universal Harness Full Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将全量评审中仍为 `component_complete` 的 P0–P3 能力接入生产权威链，并用真实 Evidence 证明 Provider 安全、CapabilityPlan DAG、strict TDD、Feedback、CI 与三档闭环均成立。

**Architecture:** Capture 作为 CapabilityPlan 产生前的唯一 bootstrap；之后由 accepted `CapabilityPlan.operation_dag` 和 `WorkflowDagEngine` 独占生产推进。宿主可信 Provider Registry 隔离项目配置与网络秘密，现有领域组件通过窄 runner/port 接入，不增加第二套状态机。

**Tech Stack:** TypeScript 6、Node.js 22、TypeBox、Vitest、Playwright、pnpm workspace、Git-native Ledger/Graph、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-08-23-full-review-remediation-design.md`

## Global Constraints

- `.harness/runtime.json` 是不可信项目输入，不能定义 endpoint、密钥环境变量、secret allowlist 或 loopback 放宽项。
- Protocol 1.0 已完成记录、digest 与 Snapshot 保持只读；Protocol 1.1 不得回退 legacy 固定流水线。
- 模型输出、Agent 自述、Dashboard 与 Markdown 均不是权威 Evidence。
- Standard/Governed required Provider 缺失或失败必须阻塞；Lite 只有未启用或 optional slot 才允许零调用。
- `strict_tdd` 只作为 execute 子图，生产写权限必须由 accepted RedEvidence 解锁。
- 每个切片遵循 Red → Green；不通过删除平台、降低 mandatory、自动批准全部对象或缩小扫描范围绕过失败。
- 保留当前工作树里的既有修复；`teach/` 不属于本计划，任何任务都不得修改或提交它。

---

### Task 1: WP0 — Stabilize the Existing Remediation Batch

**Files:**
- Modify: `packages/cli/test/managed-capture-orchestration.test.ts:561`
- Modify: `packages/runtime/test/orchestration/orchestrator.test.ts:2767`
- Modify: `packages/runtime/test/planning/default-planner-assertions.test.ts:43`
- Verify: `adapters/gate-llm-judge/src/transport.ts`
- Verify: `docs/evidence/t24-coordinator-migration-dogfood.md`
- Verify: `docs/superpowers/plans/2026-08-18-protocol-1.1-unified-implementation-plan.md`
- Verify: `docs/superpowers/plans/2026-08-20-follow-up-development-roadmap.md`
- Verify: `docs/superpowers/plans/2026-08-20-prompt-governance-addendum-implementation-plan.md`
- Verify: `packages/cli/src/commands/resume.ts`
- Verify: `packages/cli/src/managed-capture-coordinator.ts`
- Verify: `packages/cli/src/managed-pipeline-ports.ts`
- Verify: `packages/cli/src/model-providers.ts`
- Verify: `packages/cli/src/router.ts`
- Verify: `packages/cli/src/runtime-service.ts`
- Verify: `packages/cli/test/__snapshots__/help.test.ts.snap`
- Verify: `packages/cli/test/managed-capture-coordinator.test.ts`
- Verify: `packages/cli/test/managed-pipeline-ports.test.ts`
- Verify: `packages/cli/test/model-providers.test.ts`
- Verify: `packages/cli/test/profile-selection.test.ts`
- Verify: `packages/cli/test/resume.test.ts`
- Verify: `packages/core/schemas/model-invocation.schema.json`
- Verify: `packages/core/src/proposal/legacy.ts`
- Verify: `packages/core/src/schema/model-invocation.ts`
- Verify: `packages/core/test/proposal/legacy.test.ts`
- Verify: `packages/runtime/src/index.ts`
- Verify: `packages/runtime/src/model/capture-adapters.ts`
- Verify: `packages/runtime/src/model/invocation-records.ts`
- Verify: `packages/runtime/src/model/managed-runner.ts`
- Verify: `packages/runtime/src/model/openai-compat-provider.ts`
- Verify: `packages/runtime/src/model/result-artifact.ts`
- Verify: `packages/runtime/src/orchestration/capture-coordinator.ts`
- Verify: `packages/runtime/src/orchestration/kernel-coordinator.ts`
- Verify: `packages/runtime/src/orchestration/orchestrator.ts`
- Verify: `packages/runtime/src/orchestration/pipeline-types.ts`
- Verify: `packages/runtime/src/planning/plan-proposal.ts`
- Verify: `packages/runtime/src/requirements/capture.ts`
- Verify: `packages/runtime/src/workflow/working-state.ts`
- Verify: `packages/runtime/test/model/managed-runner.test.ts`
- Verify: `packages/runtime/test/model/openai-compat-provider.test.ts`
- Verify: `packages/runtime/test/orchestration/lite-loop.test.ts`
- Verify: `packages/runtime/test/orchestration/orchestrator.test.ts`
- Verify: `packages/runtime/test/planning/default-planner-assertions.test.ts`
- Verify: `packages/runtime/test/planning/plan-proposal.test.ts`
- Verify: `tests/fault/model-invocation-recovery.test.ts`
- Verify: `tests/security/model-invocation-boundary.test.ts`

**Interfaces:**
- Consumes: `runIteration()`, `resumeIteration()`, `ExecutionBinding`, risk-adaptive approval policy.
- Produces: a stable 157-test remediation regression set, exact Criterion→Test binding, deterministic model-result replay and an explicit no-executor negative contract.

- [x] **Step 1: Reproduce the six existing red tests**

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/cli/test/managed-capture-orchestration.test.ts \
  packages/runtime/test/planning/default-planner-assertions.test.ts \
  packages/runtime/test/orchestration/orchestrator.test.ts
```

Expected: six failures — two obsolete Capture approval assertions and four tests that omit an explicit executor.

- [x] **Step 2: Make Capture approval assertions policy-aware**

Replace fixed Capture approval expectations with the actually surfaced objects:

```ts
expect(outcome.required.object_type).toBe("ImpactSet");
expect(approvals).toEqual(["ImpactSet", "DesignSet", "ExecutionAuthorizationSpec"]);
```

Keep the existing session, model-call-count, criterion-pair and idempotent resume assertions; those prove auto-approval did not bypass Capture acceptance.

- [x] **Step 3: Turn the old implicit Direct Executor test into the fail-closed contract**

Use the public orchestration seam:

```ts
await expect(approveAndResume(deps, outcome)).rejects.toMatchObject({
  kind: "configuration",
  message: expect.stringContaining("executor_required"),
});
```

Rename the test to `fails closed when implementation work has no explicit executor`.

- [x] **Step 4: Inject explicit workflow executors where execution is incidental**

For phase progress and default Planner tests, add:

```ts
execution: {
  kind: "workflow",
  name: "test-explicit-direct-workflow",
  deterministic: true,
  execute: createDirectExecutor(),
},
```

Import `createDirectExecutor` from the runtime public index. Do not restore a production default.

- [x] **Step 5: Run the targeted set to green**

Run the Step 1 command.

Expected: all targeted files pass. The broader Step 6 regression count is 157 after adding replay, invalidation-crash and 1:1 Criterion/Test coverage.

- [x] **Step 6: Verify the complete partial-fix batch**

Run:

```bash
pnpm exec prettier --check \
  adapters/gate-llm-judge/src/transport.ts \
  packages/cli/src packages/cli/test \
  packages/core/src packages/core/test packages/core/schemas \
  packages/runtime/src packages/runtime/test \
  tests/fault tests/security
pnpm typecheck
pnpm exec vitest run --config vitest.workspace.ts \
  packages/cli/test/model-providers.test.ts \
  packages/cli/test/managed-capture-coordinator.test.ts \
  packages/cli/test/managed-capture-orchestration.test.ts \
  packages/cli/test/managed-pipeline-ports.test.ts \
  packages/cli/test/profile-selection.test.ts \
  packages/cli/test/resume.test.ts \
  packages/core/test/proposal/legacy.test.ts \
  packages/runtime/test/model/managed-runner.test.ts \
  packages/runtime/test/model/openai-compat-provider.test.ts \
  packages/runtime/test/planning/default-planner-assertions.test.ts \
  packages/runtime/test/planning/plan-proposal.test.ts \
  packages/runtime/test/orchestration/lite-loop.test.ts \
  packages/runtime/test/orchestration/orchestrator.test.ts \
  tests/fault/model-invocation-recovery.test.ts \
  tests/security/model-invocation-boundary.test.ts
```

Expected: formatting/lint pass for in-scope files, build and all 18 workspace typechecks pass, 15 targeted files / 157 tests pass.

- [x] **Step 7: Commit only the audited partial-fix batch**

Stage the exact modified files shown by `git status --short`, explicitly excluding `teach/`, inspect `git diff --cached --check`, then commit:

```bash
git commit -m "fix: stabilize managed capture and execution evidence"
```

### Task 2: WP1 — Define the Host-Owned Trusted Provider Registry

**Files:**
- Create: `packages/core/src/provider/trusted-provider.ts`
- Create: `packages/core/test/provider/trusted-provider.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: canonical digest helpers from `packages/core/src/identity`.
- Produces: `TrustedProviderRegistry`, `ResolvedTrustedProvider`, `TrustedProviderError`, `createTrustedProviderRegistry()`.

- [ ] **Step 1: Write the failing public-seam tests**

Cover exact provider/consumer lookup, duplicate refs, forbidden consumers and stable policy digest:

```ts
const registry = createTrustedProviderRegistry([{ 
  provider_ref: "deepseek",
  provider_identity: "provider_deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  api_key_env: "DEEPSEEK_API_KEY",
  env_allowlist: ["DEEPSEEK_API_KEY"],
  allowed_consumers: ["managed_model", "llm_judge"],
}]);
expect(registry.resolve({ provider_ref: "deepseek", consumer: "llm_judge" }))
  .toMatchObject({ endpoint: "https://api.deepseek.com/chat/completions" });
```

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/provider/trusted-provider.test.ts
```

Expected: fail because the module is absent.

- [ ] **Step 2: Implement the registry contract**

Use these public types:

```ts
export type TrustedProviderConsumer = "managed_model" | "llm_judge";
export interface TrustedProviderRegistry {
  resolve(input: { provider_ref: string; consumer: TrustedProviderConsumer }): ResolvedTrustedProvider;
}
export interface ResolvedTrustedProvider {
  readonly provider_ref: string;
  readonly provider_identity: string;
  readonly endpoint: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  readonly allow_loopback_http: boolean;
  readonly policy_digest: string;
}
```

Canonicalize URL and sorted allowlists before deriving `policy_digest`; reject duplicate refs and consumer mismatches with `TrustedProviderError`.

- [ ] **Step 3: Run core tests and typecheck**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/provider/trusted-provider.test.ts
pnpm --filter @universal-harness-internal/core typecheck
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/provider/trusted-provider.ts packages/core/test/provider/trusted-provider.test.ts packages/core/src/index.ts
git commit -m "feat(core): add trusted provider registry"
```

### Task 3: WP1 — Introduce Runtime Config v3 Provider References

**Files:**
- Modify: `packages/cli/src/project-runtime-config.ts`
- Modify: `packages/cli/src/bootstrap-project.ts`
- Modify: `packages/cli/test/project-runtime-config.test.ts`
- Modify: `packages/cli/test/bootstrap-project.test.ts`

**Interfaces:**
- Consumes: `TrustedProviderRegistry.resolve()` from Task 2.
- Produces: parsed `ProjectRuntimeConfigV3`, `ProjectModelProviderReference`, `ProjectJudgeGateReference`, and v1/v2 compatibility records.

- [ ] **Step 1: Write failing v3 and compatibility tests**

Assert that v3 accepts only reference-owned fields:

```ts
expect(readProjectRuntimeConfig(root).runtime_config_version).toBe(3);
expect(() => readConfigWithV3Field("endpoint")).toThrow(/unknown field endpoint/u);
expect(() => readConfigWithV3Field("api_key_env")).toThrow(/unknown field api_key_env/u);
expect(() => readConfigWithV3Field("allow_loopback_http")).toThrow(/unknown field/u);
```

Also assert v1/v2 parsing retains legacy assertions plus a deprecation marker, without reading any secret.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/cli/test/project-runtime-config.test.ts packages/cli/test/bootstrap-project.test.ts
```

Expected: fail because version 3 is unsupported.

- [ ] **Step 2: Add the discriminated config types**

```ts
export interface ProjectModelProviderReference {
  readonly provider_ref: string;
  readonly model: string;
  readonly slots: readonly string[];
  readonly is_default: boolean;
  readonly timeout_ms: number;
}
export interface ProjectJudgeGateReference {
  readonly gate_id: string;
  readonly name: string;
  readonly subject_id: string;
  readonly requested_mandatory: boolean;
  readonly provider_ref: string;
  readonly model: string;
  readonly prompt_version: string;
  readonly timeout_ms: number;
  readonly seed?: number;
}
```

Set `PROJECT_RUNTIME_CONFIG_VERSION = 3` and retain versions 1/2 as compatibility-only unions.

- [ ] **Step 3: Make new/adopt write v3**

Generated `.harness/runtime.json` must contain provider references only. Do not copy endpoint or env names into the project.

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/cli/test/project-runtime-config.test.ts packages/cli/test/bootstrap-project.test.ts
pnpm --filter universal-harness typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/project-runtime-config.ts packages/cli/src/bootstrap-project.ts packages/cli/test/project-runtime-config.test.ts packages/cli/test/bootstrap-project.test.ts
git commit -m "feat(cli): use provider references in runtime config v3"
```

### Task 4: WP1 — Route Managed Model Providers Through the Trusted Registry

**Files:**
- Modify: `packages/core/src/schema/capture.ts`
- Modify: `packages/core/src/capture/coordinator.ts`
- Modify: `packages/core/test/capture/coordinator.test.ts`
- Modify: `packages/cli/src/model-providers.ts`
- Modify: `packages/cli/src/managed-capture-coordinator.ts`
- Modify: `packages/cli/src/managed-pipeline-ports.ts`
- Modify: `packages/cli/test/model-providers.test.ts`
- Modify: `tests/security/model-invocation-boundary.test.ts`

**Interfaces:**
- Consumes: `ProjectModelProviderReference`, `TrustedProviderRegistry`.
- Produces: `assembleModelProviders(config, { registry, environment, fetch })` with full policy-bound config digest.

- [ ] **Step 1: Write the exfiltration red test**

Use a repository v3 config that attempts to add `endpoint` or `api_key_env`, place a sentinel in the ambient environment, and assert zero fetch calls plus no sentinel in thrown messages, records or artifacts.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/cli/test/model-providers.test.ts tests/security/model-invocation-boundary.test.ts
```

Expected: fail until assembly consumes only the trusted resolution.

- [ ] **Step 2: Replace per-file policy logic with Registry resolution**

Assembly must use:

```ts
const trusted = deps.registry.resolve({
  provider_ref: entry.provider_ref,
  consumer: "managed_model",
});
```

Pass `trusted.endpoint`, `trusted.api_key_env`, `trusted.env_allowlist` and host-only loopback flag to the transport. Include `trusted.policy_digest`, model, timeout, slots and default flag in `config_digest`.

- [ ] **Step 3: Implement v1/v2 exact-match compatibility**

Map legacy `provider_id` to `provider_ref`, compare every inline endpoint/env/allowlist/loopback field to the Registry resolution, emit one deprecation diagnostic, and reject any mismatch before secret lookup or fetch.

- [ ] **Step 4: Preserve required-call failures as typed resumable blockers**

Map required managed-model failures (`provider_required`, `provider_unavailable`, `timeout`, `budget_exhausted`, `invalid_output`, `independence_violation`, `version_mismatch`, `policy_denied`, `uncertain`) to a versioned Capture blocker reason and retain the failed Invocation record as the only failure truth. Do not leave the Capture session terminal `failed`, do not invent a second failure record, and do not let the Adapter choose an arbitrary resume state. After Registry/config/endpoint recovery, `resume` must continue from the same session and the last valid workflow checkpoint.

- [ ] **Step 5: Run managed-provider suites**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/cli/test/model-providers.test.ts packages/cli/test/managed-capture-orchestration.test.ts packages/cli/test/managed-pipeline-ports.test.ts tests/security/model-invocation-boundary.test.ts
```

Add the Core Capture recovery suite and expect all tests to pass, including provider failure → blocked → configuration repair → same-session resume.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema/capture.ts packages/core/src/capture/coordinator.ts packages/core/test/capture/coordinator.test.ts packages/cli/src/model-providers.ts packages/cli/src/managed-capture-coordinator.ts packages/cli/src/managed-pipeline-ports.ts packages/cli/test/model-providers.test.ts tests/security/model-invocation-boundary.test.ts
git commit -m "fix(security): bind model providers to host trust policy"
```

### Task 5: WP1 — Secure LLM Judge Resolution and Response Limits

**Files:**
- Modify: `packages/cli/src/project-gates.ts`
- Modify: `adapters/gate-llm-judge/src/transport.ts`
- Modify: `adapters/gate-llm-judge/src/provider.ts`
- Modify: `adapters/gate-llm-judge/test/transport.test.ts`
- Modify: `packages/cli/test/project-gates.test.ts`
- Modify: `tests/security/llm-judge-boundary.test.ts`

**Interfaces:**
- Consumes: `ProjectJudgeGateReference`, `TrustedProviderRegistry`.
- Produces: Judge Gate transport configured only from `ResolvedTrustedProvider`.

- [ ] **Step 1: Write red tests for secret routing and streaming limits**

Assert repository-controlled env names never reach fetch. Use a `ReadableStream` whose chunks cross `MAX_PROVIDER_RESPONSE_BYTES`; assert `cancel()` is called as soon as the limit is crossed and `arrayBuffer()` is never invoked.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts adapters/gate-llm-judge/test/transport.test.ts packages/cli/test/project-gates.test.ts tests/security/llm-judge-boundary.test.ts
```

Expected: fail because Judge still consumes inline config and buffers the full response.

- [ ] **Step 2: Resolve Judge providers at CLI assembly**

```ts
const trusted = registry.resolve({
  provider_ref: judge.provider_ref,
  consumer: "llm_judge",
});
```

Construct the adapter from the trusted endpoint/env/allowlist and include `policy_digest` in Evidence metadata.

- [ ] **Step 3: Replace `arrayBuffer()` with bounded streaming**

Implement `readBoundedBody(response.body, MAX_PROVIDER_RESPONSE_BYTES)` using `getReader()`, cumulative byte length, immediate reader cancellation on overflow, and a single concatenation only after EOF within budget.

- [ ] **Step 4: Run Judge and security suites**

Run the Step 1 command plus:

```bash
pnpm test:security
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/project-gates.ts adapters/gate-llm-judge/src/transport.ts adapters/gate-llm-judge/src/provider.ts adapters/gate-llm-judge/test/transport.test.ts packages/cli/test/project-gates.test.ts tests/security/llm-judge-boundary.test.ts
git commit -m "fix(security): isolate judge credentials and bound responses"
```

### Task 6: WP2 — Add Plan Supersession to the DAG Engine

**Files:**
- Modify: `packages/runtime/src/workflow/dag.ts`
- Modify: `packages/runtime/src/workflow/dag-engine.ts`
- Create: `packages/runtime/src/workflow/ledger-dag-checkpoint-store.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/workflow/dag-engine.test.ts`
- Create: `packages/runtime/test/workflow/ledger-dag-checkpoint-store.test.ts`

**Interfaces:**
- Consumes: `OperationDagNode`, Ledger append/replay primitives.
- Produces: `DagNodeResult.status = "plan_superseded"`, `DagRunOutcome.status = "replan_required"`, durable `LedgerDagCheckpointStore`.

- [ ] **Step 1: Write red supersession and crash-replay tests**

Use this result contract:

```ts
{
  status: "plan_superseded",
  next_plan_digest: "b".repeat(64),
  produces: [{ kind: "design_set", digest: "c".repeat(64) }],
}
```

Assert the design checkpoint commits once, engine returns `replan_required`, and a second run with the final DAG replays the prefix without rerunning Capture/Impact/Design.

- [ ] **Step 2: Extend public result/outcome unions**

Add the exact `plan_superseded` and `replan_required` discriminants; validate declared outputs before committing the checkpoint.

- [ ] **Step 3: Implement the Ledger checkpoint store**

Persist append-only checkpoint events by operation id. `truncate()` must append invalidation facts rather than delete historical Ledger entries; `load()` projects the latest valid prefix.

- [ ] **Step 4: Run workflow tests**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/workflow/dag-engine.test.ts packages/runtime/test/workflow/ledger-dag-checkpoint-store.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/workflow packages/runtime/test/workflow packages/runtime/src/index.ts
git commit -m "feat(runtime): resume capability dag across plan supersession"
```

### Task 7: WP2 — Make CapabilityPlan the Protocol 1.1 Production Router

**Files:**
- Create: `packages/runtime/src/orchestration/capability-dag-runtime.ts`
- Create: `packages/runtime/src/orchestration/capability-dag-runners.ts`
- Modify: `packages/runtime/src/orchestration/orchestrator.ts`
- Modify: `packages/runtime/src/orchestration/kernel-coordinator.ts`
- Modify: `packages/runtime/src/orchestration/profile-modules.ts`
- Modify: `packages/runtime/src/orchestration/pipeline-types.ts`
- Create: `packages/runtime/test/orchestration/capability-plan-routing.test.ts`
- Modify: `packages/runtime/test/orchestration/orchestrator.test.ts`

**Interfaces:**
- Consumes: `WorkflowDagEngine`, final/provisional `CapabilityPlanRecord`, existing phase contributions.
- Produces: `createCapabilityDagRuntime(deps)` and kernel/module `DagRunnerRegistry`.

- [ ] **Step 1: Write the Protocol 1.1 routing red test**

For each Profile, compare observed node calls to the accepted plan's `operation_dag.nodes`. Assert inactive nodes have zero calls, a missing plan blocks, provisional Standard cannot enter Plan, and a drifted plan digest invalidates from the first affected checkpoint.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/orchestration/capability-plan-routing.test.ts
```

Expected: fail because production still routes through profile heuristics.

- [ ] **Step 2: Build runner adapters around existing phase functions**

Expose a registry with kernel keys `capture`, `capability_decision`, `plan`, `context`, `execute`, `verify`, `snapshot` and module keys matching Capability ids. Each runner returns only declared binding digests or a typed pause/block.

- [ ] **Step 3: Import the Capture bootstrap checkpoint**

After Capture acceptance, compile the plan and append a capture checkpoint bound to the RequirementBaseline digest. Bootstrap must stop before impact/design/plan.

- [ ] **Step 4: Switch Protocol 1.1 operations to the DAG runtime**

Select by presence of an accepted Protocol 1.1 profile/plan, never by a profile-name phase branch. Keep `resolveProfileModules()` only behind the Protocol 1.0 compatibility path.

- [ ] **Step 5: Make Design finalization atomic**

Commit accepted DesignSet, final CapabilityPlan, operation-scope bindings and design checkpoint in one Ledger transaction. Return `plan_superseded`, reload the final plan and resume at Plan.

- [ ] **Step 6: Run routing, orchestration and fault suites**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/orchestration/capability-plan-routing.test.ts packages/runtime/test/orchestration/orchestrator.test.ts tests/fault
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/orchestration packages/runtime/test/orchestration tests/fault
git commit -m "feat(runtime): execute protocol 1.1 from capability plans"
```

### Task 8: WP2 — Wire the Provable strict TDD Execute Subgraph

**Files:**
- Create: `packages/runtime/src/tdd/execution-runner.ts`
- Modify: `packages/runtime/src/orchestration/capability-dag-runners.ts`
- Modify: `packages/runtime/src/orchestration/pipeline-types.ts`
- Modify: `packages/runtime/src/evaluation/task-verdict.ts`
- Create: `packages/runtime/test/tdd/execution-runner.test.ts`
- Create: `packages/runtime/test/orchestration/strict-tdd-routing.test.ts`

**Interfaces:**
- Consumes: `TaskTddContract`, `TddController`, `issueTddPhaseGrant()`, isolated workspace/gate/executor ports.
- Produces: `StrictTddExecutionPort.runTask(input): Promise<StrictTddTaskOutcome>` and accepted TDD cycle/evidence records.

- [ ] **Step 1: Write the production-write lock red test**

Assert the implementation executor is never called before accepted RedEvidence, test-authoring cannot write production paths, Red must hit a target Assertion and FailureOracle, and Green must reuse patch/gate/selectors/framework/environment digests.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/tdd/execution-runner.test.ts packages/runtime/test/orchestration/strict-tdd-routing.test.ts
```

Expected: fail because `strict_tdd` is still unwired.

- [ ] **Step 2: Define the phase execution port**

```ts
export interface StrictTddExecutionPort {
  runTask(input: {
    task: TaskSpecification;
    contract: TaskTddContract;
    capability_plan_digest: string;
  }): Promise<StrictTddTaskOutcome>;
}
```

The implementation must use separate grants for baseline, test authoring, red verification, implementation and refactor; no grant widening.

- [ ] **Step 3: Persist Baseline/Red/Green evidence and cycle records**

Only structured gate results accepted by the existing controller become Evidence. Crash/retry increments attempt ordinal and preserves prior immutable attempts.

- [ ] **Step 4: Route execute nodes by task applicability**

Required Task uses the strict runner; `controlled_not_applicable` requires accepted DesignSet/test-strategy binding and uses normal explicit execution; inactive capability yields `not_enabled_by_profile` without TDD artifacts.

- [ ] **Step 5: Enforce TaskVerdict**

When strict TDD applies, missing or mismatched Baseline/Red/Green evidence returns `tdd_incomplete_or_invalid` and blocks Snapshot.

- [ ] **Step 6: Run all TDD and orchestration suites**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/tdd packages/core/test/schema/tdd.test.ts packages/runtime/test/orchestration/strict-tdd-routing.test.ts packages/runtime/test/orchestration/orchestrator.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/tdd packages/runtime/src/orchestration packages/runtime/src/evaluation packages/runtime/test/tdd packages/runtime/test/orchestration
git commit -m "feat(runtime): enforce provable tdd during execution"
```

### Task 9: WP3 — Wire FeedbackAnalysis Before Feedback Routing

**Files:**
- Create: `packages/core/src/feedback/analysis-port.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/eval/src/feedback/analysis.ts`
- Create: `packages/runtime/src/finding/feedback-analysis-coordinator.ts`
- Create: `packages/runtime/src/model/feedback-analysis-adapter.ts`
- Modify: `packages/runtime/src/orchestration/capability-dag-runners.ts`
- Modify: `packages/cli/src/managed-pipeline-ports.ts`
- Create: `packages/runtime/test/finding/feedback-analysis-coordinator.test.ts`
- Create: `packages/runtime/test/orchestration/feedback-analysis-wiring.test.ts`

**Interfaces:**
- Consumes: deterministic RCA, Finding/Evidence bundle, CapabilityPlan `feedback_analysis` binding.
- Produces: core `FeedbackAnalysisPort`, `FeedbackAnalysisCoordinator.analyzeFinding()`, persisted advisory record and review disposition.

- [ ] **Step 1: Move the port contract without a package cycle**

Define `FeedbackAnalysisPort`, result union, `shouldInvokeFeedbackAnalysis()`, output validation and `candidateDisposition()` in core; keep `packages/eval` compatibility re-exports for one major.

- [ ] **Step 2: Write the invocation-boundary red test**

Assert deterministic RCA yields zero model calls; unclassified RCA yields exactly one call; cited low-risk/high-confidence candidates reach Router; high-risk or low-confidence candidates require human review; a model candidate never overwrites deterministic RCA or chooses target layer.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/finding/feedback-analysis-coordinator.test.ts packages/runtime/test/orchestration/feedback-analysis-wiring.test.ts
```

Expected: fail because no production call point exists.

- [ ] **Step 3: Implement the coordinator and model-backed adapter**

Bind each call to independent prompt, budget, conversation, run id, result artifact and Evidence. For pre-Snapshot Findings call before Snapshot; for `advanced_audit` Findings call before the next Capture accepts a change seed. Deduplicate by Finding digest plus binding digest.

- [ ] **Step 4: Enforce profile/binding failure modes**

Standard/Governed required binding missing or failed returns recoverable block. Lite without optional binding keeps deterministic RCA and performs zero model calls.

- [ ] **Step 5: Run feedback, model and orchestration tests**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/eval/test packages/runtime/test/finding packages/runtime/test/model packages/runtime/test/orchestration/feedback-analysis-wiring.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/feedback packages/core/src/index.ts packages/eval/src/feedback packages/runtime/src/finding packages/runtime/src/model packages/runtime/src/orchestration/capability-dag-runners.ts packages/cli/src/managed-pipeline-ports.ts packages/runtime/test/finding packages/runtime/test/orchestration/feedback-analysis-wiring.test.ts
git commit -m "feat(feedback): route cited analysis before change seeds"
```

### Task 10: WP4 — Make AC25 Consume Real Cross-Platform CI Evidence

**Files:**
- Create: `scripts/write-ci-platform-evidence.mjs`
- Modify: `scripts/generate-acceptance-report.mjs`
- Modify: `.github/workflows/ci.yml`
- Create: `tests/release/ci-platform-evidence.test.ts`
- Modify: `docs/m1-acceptance-report.md`

**Interfaces:**
- Consumes: per-platform commit/workflow/command/exit-status artifacts.
- Produces: `evaluateCiPlatformEvidence(input) -> "passed" | "failed" | "not_verified"` and AC25 report row.

- [ ] **Step 1: Write red evidence-set tests**

Use literal fixtures for all-three-pass, one-failed, one-missing and commit-drift cases. Only the first returns `passed`; missing/drift returns `not_verified`.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts tests/release/ci-platform-evidence.test.ts
```

Expected: fail because AC25 currently checks only local suites plus workflow existence.

- [ ] **Step 2: Implement the evidence evaluator and writer**

Each platform artifact contains:

```json
{
  "schema_version": "ci-platform-evidence.v1",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "workflow": "CI",
  "platform": "ubuntu-latest",
  "command": "pnpm verify",
  "exit_status": 0,
  "artifact_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The generator verifies schema, exact current commit, unique required platforms and digest before setting AC25.

- [ ] **Step 3: Restore the three-platform matrix and aggregate artifacts**

Use `ubuntu-latest`, `macos-latest`, `windows-latest`; upload each evidence file and download all three in the release job before report generation.

- [ ] **Step 4: Run release evidence tests locally**

```bash
pnpm exec vitest run --config vitest.workspace.ts tests/release/ci-platform-evidence.test.ts
node scripts/generate-acceptance-report.mjs
```

Expected locally: AC25 is `not_verified`, and the generator exits non-zero for release acceptance without CI artifacts.

- [ ] **Step 5: Commit**

```bash
git add scripts/write-ci-platform-evidence.mjs scripts/generate-acceptance-report.mjs .github/workflows/ci.yml tests/release/ci-platform-evidence.test.ts docs/m1-acceptance-report.md
git commit -m "fix(release): require real cross-platform evidence"
```

### Task 11: WP4 — Repair CI Git Fixtures and Standalone Truth

**Files:**
- Modify: `tests/e2e/helpers.ts`
- Modify: `packages/runtime/test/bootstrap/helpers.ts`
- Verify: `adapters/vcs-git/test/helpers.ts`
- Delete: `docs/codebuddy-to-universal-harness-evolution.md`
- Modify: `docs/superpowers/plans/2026-08-17-dashboard-approvals-and-dsh-output-implementation-plan.md`
- Modify: `scripts/check-standalone.mjs`
- Create: `scripts/standalone-scan.mjs`
- Create: `scripts/standalone-history-exceptions.json`
- Create: `tests/release/standalone-history-scan.test.ts`

**Interfaces:**
- Consumes: Git CLI and standalone scanner.
- Produces: hermetic temp Git repositories and `scanStandaloneRepository(input): string[]` with exact immutable-history exceptions.

- [ ] **Step 1: Reproduce clean-environment failures**

Run affected tests with temporary global Git configuration disabled:

```bash
GIT_CONFIG_GLOBAL=/dev/null pnpm test:e2e
GIT_CONFIG_GLOBAL=/dev/null pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/orchestration/orchestrator.test.ts
node scripts/check-standalone.mjs
```

Expected: Git identity failures and two standalone brand findings before the fix.

- [ ] **Step 2: Make every repository fixture self-contained**

Immediately after `git init`, run local configuration:

```ts
git(root, "config", "user.name", "Harness Test");
git(root, "config", "user.email", "harness-test@example.invalid");
git(root, "config", "core.autocrlf", "false");
```

Do not mutate global Git config.

- [ ] **Step 3: Remove former-product branding from tracked content and classify immutable history**

Delete the obsolete evolution document and replace the one filename reference with a product-neutral description. Keep the full-history scan, but replace the monolithic `git log -p` check with commit/path/blob-level findings. `standalone-history-exceptions.json` may suppress only the exact pre-remediation commit, path and blob digest for the migration document; an unknown commit, path or digest with the same brand must still fail. This preserves immutable Git history without turning a broad substring exception into a bypass.

The release test must prove both cases:

```ts
const accepted = scanStandaloneRepository({
  cwd: repositoryWithExactHistoricalException,
  exceptions: exactMigrationException,
});
const rejected = scanStandaloneRepository({
  cwd: repositoryWithNewBrandCommit,
  exceptions: exactMigrationException,
});
expect(accepted).toEqual([]);
expect(rejected).toContainEqual(
  expect.stringContaining("forbidden former-product brand"),
);
```

Export the following contract from `scripts/standalone-scan.mjs`; `scripts/check-standalone.mjs` is only its process-exit CLI wrapper:

```ts
export interface StandaloneHistoryException {
  readonly commit: string;
  readonly path: string;
  readonly blob_digest: string;
  readonly reason: string;
}
export function scanStandaloneRepository(input: {
  readonly cwd: string;
  readonly exceptions: readonly StandaloneHistoryException[];
}): string[];
```

- [ ] **Step 4: Run clean-environment and standalone checks**

Run the Step 1 commands.

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers.ts packages/runtime/test/bootstrap/helpers.ts adapters/vcs-git/test/helpers.ts docs/codebuddy-to-universal-harness-evolution.md docs/superpowers/plans/2026-08-17-dashboard-approvals-and-dsh-output-implementation-plan.md scripts/check-standalone.mjs scripts/standalone-scan.mjs scripts/standalone-history-exceptions.json tests/release/standalone-history-scan.test.ts
git commit -m "fix(ci): make git fixtures hermetic and standalone"
```

### Task 12: WP4 — Prove Three Real Profile Vertical Loops

**Files:**
- Modify: `scripts/dogfood-real-provider.mjs`
- Create: `scripts/dogfood-three-profile-loop.mjs`
- Create: `tests/e2e/three-profile-real-loop.test.ts`
- Create: `docs/evidence/full-remediation-three-profile-dogfood.md`
- Modify: `scripts/generate-acceptance-report.mjs`

**Interfaces:**
- Consumes: packaged CLI, trusted Provider Registry, explicit Agent execution binding, approval API, Ledger/Evidence readers.
- Produces: one completed Snapshot and evidence manifest per Lite/Standard/Governed profile.

- [ ] **Step 1: Write the local fake-provider/fake-agent E2E red test**

For each profile, assert terminal `completed`, final Snapshot, expected DAG nodes, explicit execution Run, profile-appropriate approvals/evaluation/TDD evidence, and clean worktree. Reject `aborted` or missing Snapshot evidence.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts tests/e2e/three-profile-real-loop.test.ts
```

Expected: fail because current dogfood intentionally has no executor and aborts blocked operations.

- [ ] **Step 2: Build the full-loop driver**

Use a real packaged CLI process, a local trusted fake Provider, an explicit deterministic command Agent, mechanical Gates and the shared approval service. Approval decisions follow risk policy; the driver must not auto-approve every object.

- [ ] **Step 3: Run the hermetic three-profile E2E**

Run the Step 1 command.

Expected: pass for all three profiles.

- [ ] **Step 4: Run real DeepSeek dogfood**

```bash
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY}" node scripts/dogfood-three-profile-loop.mjs .reports/acceptance/three-profile-dogfood.json
```

Expected: three completed snapshots. The script must exit 2 without a key and must never print or persist the key.

- [ ] **Step 5: Record redacted evidence and update acceptance generation**

The Markdown evidence lists operation/snapshot/evidence ids and digests, Provider/model identity, approval objects, Gate/Evaluation/TDD status and residual risk; no prompt body, response body or secret value.

- [ ] **Step 6: Commit**

```bash
git add scripts/dogfood-real-provider.mjs scripts/dogfood-three-profile-loop.mjs tests/e2e/three-profile-real-loop.test.ts docs/evidence/full-remediation-three-profile-dogfood.md scripts/generate-acceptance-report.mjs
git commit -m "test(e2e): prove three profile vertical loops"
```

### Task 13: WP5 — Split Coordinator Facades Without Duplicating State

**Files:**
- Create: `packages/runtime/src/orchestration/approval-runtime.ts`
- Create: `packages/runtime/src/orchestration/execution-runtime.ts`
- Create: `packages/runtime/src/orchestration/verification-runtime.ts`
- Create: `packages/runtime/src/orchestration/snapshot-runtime.ts`
- Modify: `packages/runtime/src/orchestration/kernel-coordinator.ts`
- Create: `packages/cli/src/runtime/configuration-service.ts`
- Create: `packages/cli/src/runtime/approval-service.ts`
- Create: `packages/cli/src/runtime/resume-service.ts`
- Modify: `packages/cli/src/runtime-service.ts`
- Create: `packages/runtime/test/orchestration/coordinator-facade.test.ts`
- Create: `packages/cli/test/runtime-service-facade.test.ts`

**Interfaces:**
- Consumes: stable runner/port/checkpoint interfaces from Tasks 6–9.
- Produces: thin runtime facades that delegate to one owner per state transition.

- [ ] **Step 1: Add characterization tests at public facades**

Record the same command outcomes, Ledger event sequence, checkpoint ids, approval decisions and snapshots before extraction; do not mock private functions.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/orchestration/coordinator-facade.test.ts packages/cli/test/runtime-service-facade.test.ts
```

Expected: pass against the pre-extraction behavior; these tests guard equivalence.

- [ ] **Step 2: Extract approval and resume ownership**

Move approval request/decision and resume/input bridge functions behind exported service interfaces. Leave all Ledger mutations in one owner; facades only translate arguments/results.

- [ ] **Step 3: Extract execution/TDD and verify/evaluate ownership**

Move runner bodies without changing discriminated outcomes or event order. `kernel-coordinator.ts` retains DAG facade and assembly only.

- [ ] **Step 4: Extract snapshot/recovery and CLI configuration assembly**

Keep snapshot transaction and recovery reconciliation together; split CLI configuration from command application service.

- [ ] **Step 5: Run full characterization and architecture checks**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/orchestration packages/cli/test
pnpm lint
pnpm typecheck
```

Expected: pass with identical public outcomes and no duplicated state transition implementation.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/orchestration packages/runtime/test/orchestration packages/cli/src/runtime packages/cli/src/runtime-service.ts packages/cli/test/runtime-service-facade.test.ts
git commit -m "refactor: split orchestration and cli runtime facades"
```

### Task 14: Final Evidence Audit and Documentation Truth

**Files:**
- Modify: `docs/superpowers/plans/2026-08-18-protocol-1.1-unified-implementation-plan.md`
- Modify: `docs/superpowers/plans/2026-08-20-prompt-governance-addendum-implementation-plan.md`
- Modify: `docs/superpowers/plans/2026-08-20-follow-up-development-roadmap.md`
- Modify: `README.md`
- Modify: `docs/graph-driven-harness-model.md`
- Create: `docs/evidence/full-review-remediation-completion.md`

**Interfaces:**
- Consumes: committed test outputs, CI platform artifacts, dogfood Ledger/Evidence and current Git state.
- Produces: requirement-by-requirement completion matrix with no self-attested pass rows.

- [ ] **Step 1: Run the complete local gate set**

```bash
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
node scripts/check-standalone.mjs
```

Expected: every command exits 0. Acceptance generation remains `not_verified` locally until same-commit CI artifacts exist.

- [ ] **Step 2: Audit every Spec completion item against authoritative evidence**

For Spec §13 items 1–9, record command/artifact ids, exact digest/commit, result and residual risk. A missing or indirect row is `not_verified`, never passed.

- [ ] **Step 3: Update plan and architecture status language**

Mark only evidence-proven checkboxes complete. README and graph model describe Provider references, DAG authority, strict TDD and Feedback routing as implemented only after their matching evidence rows pass.

- [ ] **Step 4: Verify clean tracked worktree and same-commit CI**

```bash
git status --short
gh run list --commit "$(git rev-parse HEAD)" --workflow CI --limit 1
```

Expected: no tracked changes after the documentation commit; CI Verify succeeds on Ubuntu/macOS/Windows, performance and release gates succeed for the same commit.

- [ ] **Step 5: Commit completion evidence**

```bash
git add README.md docs/graph-driven-harness-model.md docs/superpowers/plans docs/evidence/full-review-remediation-completion.md
git commit -m "docs: record full remediation evidence"
```

## Plan Self-Review Result

- Spec §5 maps to Task 1.
- Spec §6 maps to Tasks 2–5.
- Spec §7 maps to Tasks 6–8.
- Spec §8 maps to Task 9.
- Spec §9 maps to Tasks 10–12.
- Spec §10 maps to Task 13.
- Spec §11–§13 are enforced by every Red/Green task and closed by Task 14.
- Public type names are introduced before downstream consumption; the Feedback contract moves to core to avoid the existing eval → runtime dependency cycle.
- No task modifies `teach/`, rewrites Protocol 1.0 history, invents a second authority or treats local evidence as cross-platform proof.
