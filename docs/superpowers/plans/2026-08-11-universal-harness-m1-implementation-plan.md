# Universal Harness M1 Implementation Plan

**Date**: 2026-08-11  
**Status**: Proposed, pending user approval  
**Design source**: `docs/superpowers/specs/2026-08-11-universal-harness-m1-design.md`  
**Target milestone**: M1 complete vertical loop

## 1. Purpose

This plan turns the approved M1 design into an executable, test-first delivery sequence. It covers the complete path from workspace bootstrap through `harness new` and `harness adopt`, bounded execution, verification, evaluation, feedback, recovery, and iteration snapshots.

No internal slice is an M1 release by itself. M1 is accepted only after the standalone new-project and adopted-project fixtures complete the full loop and all 28 design acceptance criteria pass.

## 2. Implementation Decisions

The implementation begins with these defaults. A change that alters an approved design boundary must update the design and this plan before code continues.

- TypeScript with strict compiler settings on a supported Node.js LTS baseline.
- A Corepack-pinned pnpm workspace with one lockfile and reproducible CI installs.
- ECMAScript modules for first-party packages; CommonJS is supported only at adapter boundaries where required.
- JSON Schema 2020-12 is the wire contract. TypeBox defines schemas and TypeScript types from one source; Ajv performs strict runtime validation.
- Canonical JSON plus SHA-256 supplies content digests. UUIDv5 supplies deterministic repository-qualified node IDs.
- Git-hosted JSON artifacts and append-only events are authoritative. SQLite is a disposable query projection behind a driver port.
- Vitest supplies unit, integration, and golden tests; fast-check supplies property tests.
- CLI subprocesses use argument arrays with `shell: false`. Shell command strings are not a core execution primitive.
- Release CI is deterministic and offline after dependency installation. Live AgentAdapter evaluation is opt-in and cannot gate M1.

Exact dependency versions are selected and locked during Task 1 after license, native-binary, and cross-platform checks. No implementation is copied from another product repository.

## 3. Delivery Discipline

Each numbered task follows the same cycle:

1. Add the smallest failing test or fixture that demonstrates the required behavior.
2. Run the narrow test and confirm the expected failure.
3. Implement only enough production code to pass it.
4. Run the package suite, then affected integration suites.
5. Refactor without changing behavior and rerun the tests.
6. Update public contracts, examples, and traceability metadata in the same commit.

Additional rules:

- Begin implementation from `codex/m1-implementation` after this plan is approved.
- Keep public exports explicit; packages may not import another package's private source path.
- Commit generated lockfiles and schemas, but not caches, raw traces, temporary repositories, or provider mirrors.
- Every persistent write is exercised through interruption or idempotent-replay tests.
- Every authority-changing operation has a preview or typed proposal, policy decision, and evidence-bearing result.
- A failing downstream test creates feedback artifacts; it never silently rewrites an upstream requirement or decision.

## 4. Target Workspace

```text
universal-harness/
├── packages/
│   ├── cli/
│   ├── core/
│   ├── graph/
│   ├── runtime/
│   ├── eval/
│   ├── plugin-sdk/
│   └── conformance/
├── adapters/
│   ├── agent-manual/
│   ├── agent-command/
│   ├── vcs-git/
│   └── projection-markdown/
├── packs/{generic,node,python,java}/
├── fixtures/{generic-project,node-project,python-project,java-project}/
├── tests/{integration,e2e,fault,security,performance,golden}/
├── examples/
└── docs/
```

The dependency direction is:

```text
core ← graph
core ← runtime ← eval
core ← plugin-sdk ← adapters and packs
core + graph + runtime + eval + adapters ← cli
all public contracts ← conformance
```

`core` has no dependency on another workspace package. Cycles fail an architecture test.

## 5. Slice 1 — Ledger Foundation

### Task 1: Bootstrap the reproducible workspace

**Create**:

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `.node-version`
- `.npmrc`
- `.gitignore`
- `tsconfig.base.json`
- `vitest.workspace.ts`
- `eslint.config.js`
- `.github/workflows/ci.yml`
- `scripts/check-standalone.mjs`
- `tests/architecture/workspace-boundaries.test.ts`
- `packages/{cli,core,graph,runtime,eval,plugin-sdk,conformance}/package.json`
- `packages/{cli,core,graph,runtime,eval,plugin-sdk,conformance}/src/index.ts`
- `adapters/{agent-manual,agent-command,vcs-git,projection-markdown}/package.json`
- `adapters/{agent-manual,agent-command,vcs-git,projection-markdown}/src/index.ts`
- `packs/{generic,node,python,java}/package.json`

**Steps**:

1. Add a failing architecture test that expects all designed workspace packages and rejects dependency cycles or private-source imports.
2. Scaffold package manifests, TypeScript project references, shared scripts, formatting, linting, test, and build configuration.
3. Add Linux, macOS, and Windows CI jobs for install, lint, typecheck, unit tests, build, and standalone-content scan.
4. Add a workspace smoke check that resolves every package's scaffold public export; the binary packaging smoke check is added with the CLI in Task 8.

**Verify**:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node scripts/check-standalone.mjs
```

**Done when**: the empty workspace passes locally and in the three CI operating systems, and contains no unrelated branding or absolute user paths.

### Task 2: Define canonical schemas and protocol versions

**Create**:

- `packages/core/src/schema/node.ts`
- `packages/core/src/schema/edge.ts`
- `packages/core/src/schema/event.ts`
- `packages/core/src/schema/operation.ts`
- `packages/core/src/schema/runtime.ts`
- `packages/core/src/schema/feedback.ts`
- `packages/core/src/schema/plugin.ts`
- `packages/core/src/schema/registry.ts`
- `packages/core/src/schema/index.ts`
- `packages/core/src/version.ts`
- `packages/core/schemas/*.schema.json`
- `packages/core/test/schema/*.test.ts`
- `packages/core/test/golden/schema/*.json`

**Steps**:

1. Write invalid/valid fixtures for every node category, relation, provenance source, status, run outcome, and termination reason.
2. Implement strict schemas with unknown-field rejection and explicit extension namespaces.
3. Export generated JSON Schemas and protocol-version constants.
4. Add compatibility tests that reject unsupported major versions and preserve unknown future data only inside extension fields.

**Verify**: `pnpm --filter @universal-harness-internal/core test`.

**Done when**: all persistent and plugin-facing records have one validated schema source and stable serialized examples.

### Task 3: Implement canonical identity, digests, and locators

**Create**:

- `packages/core/src/identity/canonical-json.ts`
- `packages/core/src/identity/digest.ts`
- `packages/core/src/identity/node-id.ts`
- `packages/core/src/identity/locator.ts`
- `packages/core/test/identity/*.test.ts`
- `packages/core/test/identity/*.property.test.ts`

**Steps**:

1. Add golden tests for repository-qualified locators and deterministic UUIDv5 node IDs.
2. Add properties for key-order independence, Unicode normalization, path separator normalization, and digest stability.
3. Implement canonicalization without resolving locators outside the repository boundary.
4. Reject absolute paths, traversal segments, ambiguous drive prefixes, and invalid symbol fragments.

**Verify**: `pnpm --filter @universal-harness-internal/core test -- identity`.

**Done when**: identical logical inputs produce identical IDs and digests on Linux, macOS, and Windows.

### Task 4: Implement the Git-native ledger transaction protocol

**Create**:

- `packages/core/src/ledger/layout.ts`
- `packages/core/src/ledger/lock.ts`
- `packages/core/src/ledger/transaction.ts`
- `packages/core/src/ledger/event-store.ts`
- `packages/core/src/ledger/repository.ts`
- `packages/core/test/ledger/*.test.ts`
- `tests/fault/ledger-interruption.test.ts`
- `tests/golden/ledger/*.json`

**Steps**:

1. Specify a transaction manifest containing operation ID, expected baseline, proposed artifacts, accepted edges, events, and digests.
2. Add tests for atomic success, validation failure, concurrent writer rejection, interruption before commit, and replay of a completed operation.
3. Implement staging, same-filesystem atomic renames, an atomic directory lock, and append-only sequence validation.
4. Recover incomplete staging without treating it as accepted authority.

**Verify**: `pnpm test -- ledger-interruption` and the core ledger suite.

**Done when**: no failure point exposes a partially accepted transaction and replay does not duplicate events.

### Task 5: Build SQLite materialization and the two graph views

**Create**:

- `packages/graph/src/sqlite/schema.sql`
- `packages/graph/src/sqlite/database.ts`
- `packages/graph/src/materializer.ts`
- `packages/graph/src/views/artifact-graph.ts`
- `packages/graph/src/views/execution-graph.ts`
- `packages/graph/src/query-port.ts`
- `packages/graph/test/materializer.test.ts`
- `packages/graph/test/graph-views.test.ts`
- `tests/golden/graph-views/*.json`

**Steps**:

1. Write golden queries proving that Artifact Graph and Execution Graph share ledger identities and remain mutually traceable.
2. Implement schema creation, event projection, revision replacement, and cursor metadata.
3. Implement paginated node, edge, neighborhood, and path queries with deterministic ordering.
4. Prove that deleting the database and replaying the ledger yields identical query results.

**Verify**: `pnpm --filter @universal-harness-internal/graph test`.

**Done when**: SQLite contains no authority-only state and both logical views rebuild deterministically from Git records.

### Task 6: Add graph integrity, migrations, and recovery commands

**Create**:

- `packages/graph/src/integrity.ts`
- `packages/graph/src/migrations/registry.ts`
- `packages/graph/src/migrations/runner.ts`
- `packages/graph/src/rebuild.ts`
- `packages/graph/test/integrity.property.test.ts`
- `packages/graph/test/migrations.test.ts`
- `tests/fault/sqlite-corruption.test.ts`

**Steps**:

1. Add properties for dangling-edge rejection, relation type compatibility, revision monotonicity, and illegal dependency cycles.
2. Implement forward migration preview, backup, apply, verify, and rollback.
3. Implement cache corruption detection and full rebuild.
4. Record migration events only after the authoritative migration succeeds.

**Verify**: graph tests plus `pnpm test -- sqlite-corruption`.

**Done when**: failed migrations roll back and a corrupt or absent database is fully recoverable.

### Task 7: Implement the Git VCS adapter

**Create**:

- `adapters/vcs-git/src/adapter.ts`
- `adapters/vcs-git/src/commands.ts`
- `adapters/vcs-git/src/status.ts`
- `adapters/vcs-git/src/worktree.ts`
- `adapters/vcs-git/test/*.test.ts`
- `packages/plugin-sdk/src/vcs.ts`

**Steps**:

1. Add contract tests for repository detection, clean/dirty status, baseline commit, branch creation, commit, diff summary, and drift detection.
2. Invoke Git with fixed executables and argument arrays; never interpolate user text into a shell.
3. Preserve user changes and refuse ambiguous destructive recovery.
4. Normalize Git errors into typed adapter results.

**Verify**: `pnpm --filter @universal-harness-internal/adapter-vcs-git test`.

**Done when**: temporary repositories exercise all supported Git operations without modifying files outside their fixture root.

### Task 8: Create the CLI shell and managed project layout

**Create**:

- `packages/cli/src/bin.ts`
- `packages/cli/src/router.ts`
- `packages/cli/src/io.ts`
- `packages/cli/src/errors.ts`
- `packages/cli/src/commands/{new,adopt,iterate,resume,status,doctor}.ts`
- `packages/cli/src/commands/graph/{sync,query,check}.ts`
- `packages/cli/test/help.test.ts`
- `packages/core/src/project/{manifest,layout,lockfile}.ts`
- `fixtures/generic-project/`

**Steps**:

1. Add CLI snapshot tests for help, structured JSON output, exit codes, and non-interactive errors.
2. Implement command routing and dependency injection without business logic in command handlers.
3. Implement `.harness` layout creation, manifest and pack lock validation, managed `.gitignore`, and root-boundary checks.
4. Make unfinished orchestration commands return an explicit not-implemented phase result until later tasks wire them, preventing false success.

**Verify**: `pnpm --filter universal-harness test` and `pnpm harness --help`.

**Done when**: the binary is installable locally, returns stable exit codes, and initializes only managed paths.

## 6. Slice 2 — Controlled Execution

### Task 9: Implement project creation and adoption staging

**Create**:

- `packages/runtime/src/bootstrap/new-project.ts`
- `packages/runtime/src/bootstrap/adopt-project.ts`
- `packages/runtime/src/bootstrap/scanner.ts`
- `packages/runtime/src/bootstrap/staging.ts`
- `packages/runtime/test/bootstrap/*.test.ts`
- `tests/integration/new-bootstrap.test.ts`
- `tests/integration/adopt-preview.test.ts`

**Steps**:

1. Test new-project creation, existing-path refusal, stack detection, initial repository ID, and Bootstrap Iteration records.
2. Test adoption scans into staging, ignores cache/VCS internals, reports conflicts and unknowns, and leaves authority untouched before approval.
3. Implement deterministic file/test/component scanning and proposed semantic-edge input.
4. Commit the baseline atomically only after an Approval bound to the preview digest.

**Verify**: bootstrap integration tests against temporary repositories.

**Done when**: both flows produce deterministic baselines and rejected adoption previews make no authoritative changes.

### Task 10: Implement the workflow state machine and checkpoints

**Create**:

- `packages/runtime/src/workflow/state-machine.ts`
- `packages/runtime/src/workflow/operation.ts`
- `packages/runtime/src/workflow/checkpoint.ts`
- `packages/runtime/src/workflow/resume.ts`
- `packages/runtime/src/workflow/working-state.ts`
- `packages/runtime/test/workflow/*.test.ts`
- `tests/fault/workflow-resume.test.ts`

**Steps**:

1. Add a transition table test for created, awaiting input, awaiting approval, planned, running, verifying, repairing, completed, blocked, and aborted states.
2. Enforce that only Workflow Engine commits WorkingState; adapters return typed proposals.
3. Persist checkpoints after authority commits, approvals, tasks, gates, external actions, and snapshots.
4. Resume from the latest valid checkpoint after validating baseline, input, policy, approval, and ContextBundle digests.

**Verify**: runtime workflow suite and interruption tests at every checkpoint boundary.

**Done when**: replay resumes without duplicating nodes, runs, evidence, commits, or completed steps.

### Task 11: Implement requirement capture and approval invalidation

**Create**:

- `packages/runtime/src/requirements/capture.ts`
- `packages/runtime/src/requirements/baseline.ts`
- `packages/runtime/src/approval/service.ts`
- `packages/runtime/src/approval/invalidation.ts`
- `packages/runtime/test/requirements/*.test.ts`
- `packages/runtime/test/approval/*.test.ts`

**Steps**:

1. Convert intent input into proposed Intent, Requirement, Constraint, and acceptance Test records.
2. Require clarification when mandatory requirement fields or verifiable acceptance criteria are missing.
3. Bind approvals to artifact, baseline, policy, and preview digests.
4. Invalidate approval when a bound digest changes; never permit self-approval by an agent or tool.

**Verify**: focused requirements and approval suites.

**Done when**: incomplete intent correctly blocks, while approved requirements become immutable revision inputs to impact analysis.

### Task 12: Implement ImpactSet generation

**Create**:

- `packages/graph/src/impact/seeds.ts`
- `packages/graph/src/impact/propagation.ts`
- `packages/graph/src/impact/scoring.ts`
- `packages/graph/src/impact/impact-set.ts`
- `packages/graph/test/impact/*.test.ts`
- `tests/golden/impact/*.json`

**Steps**:

1. Define golden feature, bugfix, refactor, security, maintenance, and Finding-driven scenarios.
2. Implement deterministic seed extraction, relation-aware propagation, risk and confidence, shortest explanatory paths, and `must-change`/`should-review` classification.
3. Isolate probabilistic semantic suggestions as proposed edges with reason and confidence.
4. Require approval of the exact ImpactSet digest before planning.

**Verify**: `pnpm --filter @universal-harness-internal/graph test -- impact`.

**Done when**: known scenarios include required artifacts and do not mark unrelated artifacts `must-change`.

### Task 13: Implement declarative ExecutionPlan generation

**Create**:

- `packages/runtime/src/planning/execution-plan.ts`
- `packages/runtime/src/planning/task.ts`
- `packages/runtime/src/planning/mode-selector.ts`
- `packages/runtime/src/planning/validator.ts`
- `packages/runtime/test/planning/*.test.ts`
- `tests/golden/plans/*.json`

**Steps**:

1. Add fixtures selecting `direct`, `single-loop`, and sequential `dag` modes.
2. Enforce the independent-value rule before creating multiple Task nodes.
3. Reject commands, raw shell fragments, unknown tools, cycles, missing gates, and capability expansion in planner proposals.
4. Bind every Task to approved ImpactSet paths, expected outputs, acceptance criteria, dependencies, risks, and required gates.

**Verify**: planning suite and golden plan snapshots.

**Done when**: planning cannot begin without an approved ImpactSet and emits only declarative, schema-valid plans.

### Task 14: Implement ContextBundle compilation

**Create**:

- `packages/runtime/src/context/compiler.ts`
- `packages/runtime/src/context/selector.ts`
- `packages/runtime/src/context/budget.ts`
- `packages/runtime/src/context/compression.ts`
- `packages/runtime/src/context/freshness.ts`
- `packages/runtime/test/context/*.test.ts`
- `packages/runtime/test/context/*.property.test.ts`

**Steps**:

1. Test source priority, protected fields, exclusions, per-layer budgets, compression, and immutable manifests.
2. Implement deterministic graph-neighborhood selection and source reason recording.
3. Make compression pluggable; M1's deterministic compressor preserves protected content and records size changes.
4. Invalidate bundles when any source, requirement, approval, policy, plan, or baseline digest changes.

**Verify**: context tests including randomized budget-preservation properties.

**Done when**: every Task receives a minimal traceable bundle whose digest and exclusions are reproducible.

### Task 15: Implement policy decisions and capability grants

**Create**:

- `packages/runtime/src/policy/action.ts`
- `packages/runtime/src/policy/decision.ts`
- `packages/runtime/src/policy/evaluator.ts`
- `packages/runtime/src/policy/capability-grant.ts`
- `packages/runtime/src/policy/path-boundary.ts`
- `packages/runtime/test/policy/*.test.ts`
- `tests/security/capability-escalation.test.ts`

**Steps**:

1. Test decisions across action, normalized parameters, resource, phase, risk, approval, and adapter control profile.
2. Implement allow, deny, and requires-approval results with stable reasons.
3. Enforce read/write path scopes, symlink-aware repository boundaries, state-field scopes, and dynamic capability narrowing.
4. Reject prompt-carried instructions that request policy changes, extra tools, new paths, self-approval, or evidence acceptance.

**Verify**: policy suite and security capability tests.

**Done when**: no adapter identity alone grants authority and every denied action is traced without mutation.

### Task 16: Implement the Tool Registry and idempotent external actions

**Create**:

- `packages/runtime/src/tools/definition.ts`
- `packages/runtime/src/tools/registry.ts`
- `packages/runtime/src/tools/invocation.ts`
- `packages/runtime/src/tools/action-intent.ts`
- `packages/runtime/src/tools/reconciliation.ts`
- `packages/runtime/test/tools/*.test.ts`
- `tests/fault/uncertain-external-action.test.ts`
- `tests/security/tool-validation.test.ts`

**Steps**:

1. Test unknown tools, invalid input/output, wrong phase, disallowed resource, expired approval, quotas, retries, redaction, and timeouts.
2. Implement before/during/after validation and normalized invocation Evidence.
3. Commit external action intent before invocation and completion or uncertain status afterward.
4. On resume, reconcile by idempotency key before retrying; require manual resolution when the provider cannot reconcile safely.

**Verify**: tool suites plus uncertain-action fault test.

**Done when**: a timed-out side effect is never blindly replayed and opaque provider internals are not reported as governed tools.

### Task 17: Implement LoopPolicy and managed loop control

**Create**:

- `packages/runtime/src/loop/policy.ts`
- `packages/runtime/src/loop/controller.ts`
- `packages/runtime/src/loop/repeat-detector.ts`
- `packages/runtime/src/loop/outcome.ts`
- `packages/runtime/src/loop/task-envelope.ts`
- `packages/runtime/test/loop/*.test.ts`
- `packages/runtime/test/loop/*.property.test.ts`

**Steps**:

1. Test step, token, duration, retry, repeat-action, and installation-level ceilings.
2. Fingerprint normalized tool calls plus relevant state and evidence progress.
3. Accept only typed state proposals, narrowing grants after each step.
4. Treat model completion as `verifying`; only external current evidence can produce `success`.
5. Emit defined outcomes and separate termination reasons for all exit paths.

**Verify**: loop suite with fake clocks, fake usage meters, and repeat traces.

**Done when**: a model cannot raise ceilings, disable repetition detection, commit state directly, or self-declare terminal success.

### Task 18: Implement Manual and Command AgentAdapters

**Create**:

- `adapters/agent-manual/src/adapter.ts`
- `adapters/agent-command/src/adapter.ts`
- `adapters/agent-command/src/manifest.ts`
- `adapters/agent-command/src/process.ts`
- `adapters/agent-command/src/telemetry.ts`
- `adapters/agent-{manual,command}/test/*.test.ts`
- `packages/plugin-sdk/src/agent.ts`
- `tests/security/delegated-provider.test.ts`

**Steps**:

1. Add shared contract fixtures for managed, delegated, and manual profiles and trajectory visibility levels.
2. Implement manual handoff, evidence attachment, and explicit resume.
3. Implement generic command execution with a fixed executable, argument template, bounded worktree, timeout, output limits, structured result parser, and pre/post repository inspection.
4. Force supervised mode unless the manifest proves required metering, interception, resume, and trajectory coverage.

**Verify**: both adapter suites and delegated-provider security tests.

**Done when**: adapter capability claims are measurable and an insufficiently controlled provider cannot be selected for unattended execution.

## 7. Slice 3 — Quality Feedback

### Task 19: Implement Gate Providers and evidence freshness

**Create**:

- `packages/runtime/src/gates/provider.ts`
- `packages/runtime/src/gates/runner.ts`
- `packages/runtime/src/gates/evidence.ts`
- `packages/runtime/src/gates/freshness.ts`
- `packages/runtime/test/gates/*.test.ts`
- `tests/integration/three-layer-gates.test.ts`

**Steps**:

1. Test universal, stack, and project gates with normalized results and artifact hashes.
2. Route gate commands through Tool Registry rather than invoking subprocesses directly.
3. Bind Evidence to artifact, code, ContextBundle, gate, EvaluationCase, and policy digests.
4. Mark evidence stale when a bound digest changes; stale evidence cannot close a Finding or complete a snapshot.

**Verify**: gate suite and three-layer integration fixture.

**Done when**: mandatory gate failure creates a Finding and prevents `completed` status.

### Task 20: Implement Agent Run evaluation

**Create**:

- `packages/eval/src/case.ts`
- `packages/eval/src/scorer.ts`
- `packages/eval/src/deterministic/{outcome,safety,trajectory,correct-failure,efficiency}.ts`
- `packages/eval/src/coverage.ts`
- `packages/eval/src/evaluator.ts`
- `packages/eval/test/*.test.ts`
- `tests/golden/evaluations/*.json`

**Steps**:

1. Build deterministic cases for success, clarification, permission denial, malformed tools, repeats, failure, budget exhaustion, and handoff.
2. Score outcomes, safety, visible trajectory, correct failure, and efficiency independently.
3. Report unavailable trajectory fields and calculate coverage from adapter visibility.
4. Keep semantic scorers optional, confidence-bearing, and unable to pass a mandatory gate by default.

**Verify**: eval unit tests and golden reports.

**Done when**: mandatory threshold failure produces a Finding and every report discloses its evidence coverage.

### Task 21: Implement Finding, RCA, repair routing, and ImprovementCandidates

**Create**:

- `packages/eval/src/feedback/finding.ts`
- `packages/eval/src/feedback/rca.ts`
- `packages/eval/src/feedback/router.ts`
- `packages/eval/src/feedback/improvement.ts`
- `packages/eval/src/feedback/promotion.ts`
- `packages/eval/test/feedback/*.test.ts`
- `tests/integration/feedback-cascade.test.ts`
- `tests/golden/feedback/*.json`

**Steps**:

1. Add a gate-failure fixture that must create Finding → RCA → ImpactSet → upstream revision Task → repair Evidence.
2. Enforce deterministic owner-phase routing for PRD, architecture, spec, plan, policy, tool, test, and eval targets.
3. Prevent downstream writers from directly revising upstream artifacts.
4. Create reproducible evaluation, knowledge, or engineering ImprovementCandidates with verification methods.
5. Require approval before promotion and record the target revision as an ordinary ledger change.

**Verify**: feedback suite and full cascade integration test.

**Done when**: current evidence can close a repaired Finding, stale evidence cannot, and reusable lessons remain proposals until approved.

### Task 22: Implement projections, audit, doctor, status, and snapshots

**Create**:

- `adapters/projection-markdown/src/{prd,architecture,spec,plan,snapshot}.ts`
- `packages/runtime/src/audit/auditor.ts`
- `packages/runtime/src/doctor/doctor.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/snapshot/builder.ts`
- `packages/runtime/test/{audit,doctor,status,snapshot}/*.test.ts`
- `tests/golden/projections/*.md`

**Steps**:

1. Generate Markdown views carrying source IDs, revisions, and generation digests.
2. Audit traceability, stale knowledge, contradictions, orphans, missing verification, context health, and unpromoted high-risk improvements.
3. Diagnose Git, schema, pack, adapter, cache, and environment problems with actionable typed results.
4. Show control level, evaluation coverage, blockers, stale evidence, approvals, budget, and next action in status.
5. Build `completed`, `blocked`, and `aborted` snapshots; reject completed snapshots with incomplete tasks, blocking Findings, stale evidence, or unresolved external actions.

**Verify**: projection goldens and runtime utility suites.

**Done when**: all human-readable views are reproducible projections and snapshot status follows evidence rather than agent claims.

### Task 23: Wire orchestration entry and advanced commands

**Modify**:

- `packages/cli/src/commands/*.ts`
- `packages/cli/src/commands/graph/*.ts`

**Create**:

- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/orchestration/phases.ts`
- `packages/runtime/src/orchestration/lifecycle-events.ts`
- `packages/runtime/test/orchestration/*.test.ts`
- `tests/e2e/generic-{new,adopt,iterate,resume}.test.ts`

**Steps**:

1. Wire advanced commands first: graph sync/query/check, impact, plan, run, verify, eval, approve, snapshot, audit, doctor, status.
2. Wire `new`, `adopt`, and `iterate` through the same phase orchestrator.
3. Make interactive approval continue in-session and non-interactive approval return a resumable operation ID.
4. Emit ordered lifecycle events around every committed phase without exposing a public Hook SDK.
5. Add interruption points and prove `resume` continues from each one without duplicate authority or side effects.

**Verify**: generic end-to-end tests using deterministic fake/manual adapters.

**Done when**: one entry command can traverse requirement capture through snapshot, pausing only for mandatory input, approval, or external authorization.

## 8. Slice 4 — Generalization and Release Hardening

### Task 24: Complete the Plugin SDK and Conformance Kit

**Create or complete**:

- `packages/plugin-sdk/src/{manifest,stack,agent,tool,gate,vcs,projection}.ts`
- `packages/plugin-sdk/src/compatibility.ts`
- `packages/plugin-sdk/src/subprocess.ts`
- `packages/conformance/src/{runner,fixtures,assertions}.ts`
- `packages/conformance/test/*.test.ts`
- `examples/plugin-minimal/`

**Steps**:

1. Freeze versioned M1 ports and capability manifests from the design.
2. Validate protocol version, declared capabilities, resource needs, output schemas, and control-profile claims before plugin execution.
3. Run plugins in minimized subprocess environments with bounded input/output and typed errors.
4. Publish one shared conformance runner used by every first-party adapter and pack.

**Verify**: plugin SDK and conformance suites plus minimal-plugin example build.

**Done when**: incompatible or dishonest manifests fail before execution and every first-party plugin passes the same contracts.

### Task 25: Implement Generic, Node, Python, and Java packs

**Create**:

- `packs/generic/{pack.json,policies,gates,templates}/`
- `packs/node/{pack.json,scanner,gates,templates}/`
- `packs/python/{pack.json,scanner,gates,templates}/`
- `packs/java/{pack.json,scanner,gates,templates}/`
- `packs/*/test/*.test.ts`
- `packages/runtime/src/packs/{resolver,lockfile,upgrade,migration}.ts`
- `packages/runtime/test/packs/*.test.ts`

**Steps**:

1. Implement Generic defaults, including the approved LoopPolicy ceilings.
2. Add deterministic detection, scanning, and default gate definitions for Node, Python, and Java.
3. Keep project overrides separate from upstream packs.
4. Implement upgrade preview, digest-bound approval, transactional migration, rollback, and lockfile update.

**Verify**: every pack's conformance fixture and failed-migration tests.

**Done when**: pack upgrades preserve overrides and all four packs supply valid context, gates, policies, and projections.

### Task 26: Build standalone cross-stack end-to-end fixtures

**Create**:

- `fixtures/node-project/`
- `fixtures/python-project/`
- `fixtures/java-project/`
- `tests/e2e/{node,python,java}-{new,adopt,iterate}.test.ts`
- `tests/e2e/complete-loop.assertions.ts`

**Steps**:

1. Create small original fixtures with deterministic local tests and no network needs.
2. Exercise new, adopt, and subsequent iterate flows for every stack.
3. Assert requirements, both graph views, ImpactSet, ExecutionPlan, ContextBundle, Run, gates, evaluation, feedback when injected, approvals, Evidence, and final snapshot.
4. Re-run each fixture from clean clones and compare normalized ledgers and projections.

**Verify**: `pnpm test:e2e` on Linux, macOS, and Windows.

**Done when**: each stack completes the same closed loop and deterministic records match across repeated runs.

### Task 27: Add security, fault, property, and performance release gates

**Create**:

- `tests/security/{path-traversal,symlink-escape,command-injection,secret-redaction,undeclared-write}.test.ts`
- `tests/fault/{concurrent-write,process-kill,git-drift,expired-approval,budget-exhaustion,partial-gate}.test.ts`
- `tests/performance/{dataset,impact,sqlite-rebuild}.test.ts`
- `scripts/generate-performance-dataset.mjs`

**Steps**:

1. Complete the design's security and fault-injection matrix.
2. Add repeatable process-kill boundaries for every durable operation.
3. Generate 20,000 nodes and 100,000 edges deterministically.
4. Measure warm Impact p95 below two seconds and full SQLite rebuild below 30 seconds on `ubuntu-latest`.
5. Fail release CI on any approval bypass, authority divergence, unreconciled action, secret leak, or performance regression beyond the approved threshold.

**Verify**: `pnpm test:security`, `pnpm test:fault`, and `pnpm test:performance`.

**Done when**: all hardening gates are deterministic, produce retained summaries, and pass release thresholds.

### Task 28: Package the CLI and close M1 documentation

**Create or modify**:

- `packages/cli/package.json`
- `packages/cli/src/public-api.ts`
- `README.md`
- `docs/getting-started.md`
- `docs/adopting-a-project.md`
- `docs/operations-and-recovery.md`
- `docs/plugin-contracts.md`
- `docs/m1-acceptance-report.md`
- `examples/{new-project,adopt-project,manual-adapter,command-adapter}/`

**Steps**:

1. Pack `universal-harness` locally and install it into clean temporary environments.
2. Verify the `harness` binary, ESM exports, license, README, files list, provenance metadata, and absence of internal-only sources.
3. Run all documented examples as tests.
4. Generate the M1 acceptance report from test and benchmark outputs, mapping every criterion to evidence.
5. Run the standalone-content scan over files, generated assets, package metadata, examples, fixtures, and Git history.

**Verify**:

```bash
pnpm clean
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:smoke
pnpm test:e2e
pnpm test:release
```

**Done when**: the packaged CLI completes both required vertical-loop demonstrations and the M1 acceptance report has no unresolved P0/P1 issue, migration gap, or approval bypass.

## 9. Acceptance Traceability

| Design acceptance criteria | Primary implementation tasks |
|---|---|
| AC1–AC4: new, adopt, iterate, resumable one-command flow | 8–11, 23, 26 |
| AC5–AC7: deterministic identity and dual graph/impact correctness | 3–6, 12 |
| AC8–AC9: approved declarative plans and execution modes | 12–13 |
| AC10–AC11: Task Envelope and immutable bounded context | 14, 17 |
| AC12–AC14: tool governance, idempotent actions, hard budgets | 15–18 |
| AC15: typed outcomes and correct failure | 17, 20 |
| AC16–AC20: gates, RCA cascade, improvements, freshness | 19–21 |
| AC21: complete evidence-bearing snapshots | 22–23 |
| AC22: SQLite recovery | 5–6 |
| AC23: adapter control profiles and behavioral evaluation | 18, 20, 24 |
| AC24: Generic/Node/Python/Java packs | 25–26 |
| AC25: cross-platform CI | 1, 3, 7, 26–28 |
| AC26: safe upgrades and rollback | 6, 25 |
| AC27: performance baselines | 27 |
| AC28: standalone repository and history | 1, 26, 28 |

Every acceptance criterion must also appear in `docs/m1-acceptance-report.md` with its test command, evidence artifact, result, and relevant commit.

## 10. Slice Exit Gates

### Ledger foundation exit

- Schema and identity goldens pass on all CI platforms.
- Atomic ledger operations survive interruption and replay.
- Both graph views rebuild identically from the ledger.
- `new` and `adopt` produce deterministic unexecuted baselines.

### Controlled execution exit

- Approved requirements produce ImpactSet, ExecutionPlan, ContextBundle, and Task Envelope.
- Managed loops enforce budgets and correct termination without model compliance.
- Tool policies, external action intents, approvals, checkpoints, and resume are fault-tested.
- Manual and delegated adapters expose honest control and visibility levels.

### Quality feedback exit

- Gates and evaluations create current Evidence or blocking Findings.
- Failure produces RCA, ImpactSet routing, repair work, and optional ImprovementCandidate.
- No downstream phase can silently mutate an upstream artifact.
- A generic project completes and snapshots the full loop.

### M1 release exit

- All 28 acceptance criteria have passing evidence.
- All four packs and three stack fixtures pass conformance and end-to-end tests.
- Cross-platform, security, fault, migration, standalone, packaging, and performance gates pass.
- One `harness new` and one `harness adopt` demonstration complete the entire vertical loop.

## 11. Review and Change Control

Before implementation starts, review this plan for package boundaries, dependency choices, task ordering, and acceptance coverage. After approval:

1. push the approved design and plan commits to the existing GitHub repository;
2. create `codex/m1-implementation` from the approved documentation baseline;
3. execute Tasks 1–28 in order, using a focused commit for each task or inseparable red/green pair;
4. stop and revise the design when implementation evidence contradicts an approved architectural boundary;
5. update the plan status and acceptance report as each task and slice exit gate completes.
