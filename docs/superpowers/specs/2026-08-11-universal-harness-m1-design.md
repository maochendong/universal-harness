# Universal Harness M1: Complete Vertical Loop Design

**Date**: 2026-08-11  
**Status**: Approved design, pending written review  
**Repository**: `maochendong/universal-harness`  
**Package**: `universal-harness`  
**CLI binary**: `harness`  
**License**: Apache-2.0

## 1. Vision

Universal Harness is a graph-native, provider-neutral engineering harness for starting or adopting software projects and driving auditable iterations from intent to verified evidence.

The harness treats requirements, decisions, implementation, tests, agent runs, approvals, findings, and evidence as a connected engineering graph. Git remains the authoritative store. A local SQLite graph is a replaceable materialized view for fast impact analysis.

M1 targets common software projects: web applications, APIs, command-line tools, libraries, and agent applications. Technology-specific behavior is supplied by adapters and project packs rather than embedded in the core.

## 2. M1 Product Promise

M1 includes the complete vertical loop. A user starts it from one orchestration command:

```bash
harness new my-project --intent "Build the first capability"
harness adopt /path/to/project --intent "Introduce the requested change"
harness iterate "Implement the next change"
```

Each entry command orchestrates:

```text
project creation or adoption
→ requirement capture
→ graph synchronization
→ impact analysis
→ task planning
→ agent or manual execution
→ three-layer quality gates
→ targeted repair loop
→ iteration snapshot
```

“One command” means one orchestration entry point, not zero human oversight:

- Interactive mode requests mandatory approvals in the same command session and continues after approval.
- Non-interactive mode pauses safely at approval or external authorization points and returns a resumable operation ID.
- Resume continues from the last committed checkpoint without duplicating nodes, runs, evidence, or commits.
- A failed mandatory gate prevents a completed snapshot.

## 3. Goals

M1 must:

1. Create a new project that can begin its first iteration immediately.
2. Adopt an existing Git repository through deterministic scanning, semantic enrichment, preview, and approval.
3. Model feature, bugfix, refactor, security, and maintenance changes as auditable Iterations.
4. Maintain a Git-native Graph Ledger linking intent, requirements, constraints, decisions, components, tasks, code, tests, and evidence.
5. Generate a reviewable ImpactSet from a change or Finding.
6. Generate a Task DAG only after the ImpactSet is approved.
7. Execute through provider-neutral Agent Adapters and always support manual execution.
8. Enforce universal, stack-specific, and project-specific gates.
9. Recover safely from interruption, cache damage, repository drift, and adapter failure.
10. Create a final snapshot anchored to the resulting Git commit.

## 4. Scope and Milestones

The complete product is delivered through four independently accepted milestones:

1. **M1 — Core vertical loop**: CLI, Graph Ledger, new/adopt/iterate, adapters, policies, approvals, recovery, gates, and snapshots.
2. **M2 — Local graph dashboard**: local web views for graph exploration, impact paths, iterations, and evidence.
3. **M3 — Remote collaboration**: event synchronization, team approvals, and conflict handling.
4. **M4 — Multi-agent scheduling**: capability-based parallel scheduling using Task DAGs, leases, and policy decisions.

This document specifies M1 in detail. M2–M4 receive versioned compatibility ports in M1 and require separate design and implementation cycles. Version 1.0 is released after all four milestones are accepted.

### 4.1 M1 Non-goals

- Remote accounts, hosted services, or real-time team collaboration.
- A web dashboard.
- Distributed agent leasing, preemption, or scheduling.
- Replacing Git with a graph database.
- Requiring Neo4j, RDF, or OWL.
- Treating natural-language agent judgment as passing gate evidence.
- Embedding any specific business domain, product, API, or data model in the core.

## 5. Selected Architecture

M1 uses a stable kernel plus project packs.

- The installed kernel owns schemas, the Graph Ledger protocol, state machines, impact analysis, approvals, plugin execution, and atomic operation semantics.
- Project packs own stack conventions, quality thresholds, vocabulary, templates, and team policies.
- Packs use semantic versions and a lockfile. Upgrades provide preview, migration, and rollback.
- Project overrides are stored separately from upstream packs and cannot be overwritten by a CLI upgrade.

The provenance model borrows the Entity, Activity, Agent, and derivation-chain ideas from [W3C PROV](https://www.w3.org/TR/prov-o/). Runtime lineage events are inspired by the [OpenLineage object model](https://openlineage.io/docs/next/spec/object-model/). M1 adopts these principles without implementing either full standard.

### 5.1 Kernel Modules

| Module | Responsibility |
|---|---|
| Command Router | User-facing orchestration and advanced subcommands |
| Workflow Engine | Phase state, checkpoints, dependencies, pause, resume, and idempotency |
| Graph Ledger Engine | Node/edge validation, event commits, SQLite materialization, and queries |
| Impact Engine | Change seeds, propagation policies, scoring, and ImpactSet generation |
| Policy and Approval Engine | Risk rules, approval invalidation, mandatory gates, and task boundaries |
| Plugin Runtime | Capability discovery, protocol validation, subprocess invocation, and result normalization |
| Projection Engine | Human-readable PRD, architecture, specification, plan, and JSON views |

## 6. Implementation Workspace

The implementation is a TypeScript/Node.js workspace:

```text
universal-harness/
├── packages/
│   ├── cli/
│   ├── core/
│   ├── graph/
│   ├── plugin-sdk/
│   └── conformance/
├── adapters/
│   ├── agent-manual/
│   ├── agent-command/
│   ├── vcs-git/
│   └── projection-markdown/
├── packs/
│   ├── generic/
│   ├── node/
│   ├── python/
│   └── java/
├── fixtures/
│   ├── node-project/
│   ├── python-project/
│   └── java-project/
├── examples/
└── docs/
```

The public npm package is `universal-harness` and exposes the `harness` binary. Internal workspace packages remain private and use names under `@universal-harness-internal/*` until a public package split is deliberately designed.

## 7. Managed Project Layout

`harness new` creates, and `harness adopt` adds, the following project-owned control plane:

```text
project/
├── .harness/
│   ├── manifest.yaml
│   ├── harness.lock
│   ├── .gitignore
│   ├── artifacts/
│   │   ├── intents/
│   │   ├── requirements/
│   │   ├── constraints/
│   │   ├── decisions/
│   │   ├── components/
│   │   ├── tasks/
│   │   ├── tests/
│   │   └── iterations/
│   ├── ledger/
│   │   ├── edges.jsonl
│   │   └── operations/
│   ├── events/YYYY-MM/
│   ├── packs/
│   │   ├── upstream/
│   │   └── project/
│   ├── policies/
│   ├── views/
│   ├── cache/graph.db
│   └── staging/
├── src/
└── tests/
```

Artifacts, accepted edges, operation manifests, events, packs, policies, views, the manifest, and the lockfile are committed to Git. `.harness/.gitignore` excludes `cache/` and `staging/`, avoiding changes to an adopted repository’s root ignore rules.

## 8. Git-native Graph Ledger

### 8.1 Authority

- Structured artifacts, accepted edges, and committed events in Git are authoritative.
- SQLite is a disposable materialized query view.
- Markdown documents are human-readable projections, not independent relationship stores.
- Human narrative is stored in artifact fields or extension files so regeneration cannot silently discard it.

### 8.2 Core Nodes

| Category | Nodes |
|---|---|
| Containers | Project, Iteration |
| Intent | Intent, Requirement, Constraint |
| Design | Decision, Component |
| Delivery | Task, CodeArtifact, Test, Gate |
| Runtime | Run, Evidence, Approval |
| Feedback | Finding, ImpactSet |

Domain-specific concepts are pack extensions. They cannot redefine the semantics of core nodes.

### 8.3 Core Relations and Direction

| Family | Relations |
|---|---|
| Provenance | new artifact `DERIVES_FROM` old artifact; new node `SUPERSEDES` old node; artifact `GENERATED_BY` Run |
| Intent and implementation | Intent `DECOMPOSES_TO` Requirement; Decision `ADDRESSES` Requirement; controlled node `CONSTRAINED_BY` Constraint; Decision `SHAPES` Component; CodeArtifact `REALIZES` Component; Task `IMPLEMENTS` Requirement/Decision |
| Verification | Test `VERIFIES` Requirement/Constraint; Run `EXECUTES` Task/Gate; Run `PRODUCES` Evidence; Evidence `SUPPORTS`/`REFUTES` Test/Requirement; Finding `VIOLATES` Requirement/Constraint |
| Control | Task `DEPENDS_ON` Task; Finding `BLOCKS` Task/Iteration; Approval `APPROVES` controlled node; Project/Iteration `CONTAINS` child node |

The schema registry defines valid source types, target types, propagation direction, default risk, and whether inference is allowed for every relation.

### 8.4 Identity and Provenance

Every node and edge contains:

- `id`, `type`, `revision`, and `status`
- `source`: human, scanner, agent, gate, or migration
- `provenance`: iteration, run, agent, and timestamp
- `confidence`: `1.0` for explicit relationships; `0..1` for inferred relationships
- `digest`: normalized content hash
- `locator`: repository-relative URI, optionally narrowed to a symbol, API, or migration
- `extensions`: namespaced extension fields

Human-authored nodes use type-prefixed ULIDs. Scanned nodes use `UUIDv5(project_id, type + canonical_locator)` for deterministic identity. Renames use Git rename information or content digests. When identity is uncertain, the scanner creates a new node and links it with `SUPERSEDES` instead of reusing an uncertain ID.

### 8.5 Mutation Rules

- Definition and delivery nodes are revisioned; each revision emits an event.
- Run, Evidence, and Approval are append-only.
- Deletion produces a tombstone.
- Agent-inferred edges start as `proposed` and require approval or deterministic validation to become `accepted`.

## 9. Impact Analysis

Impact analysis does not rewrite every downstream document.

1. Start from changed node digests, Git diff mappings, or Findings.
2. Traverse only relation types, directions, and depths allowed by the active policy.
3. Score candidates using path, risk, confidence, revision, and evidence freshness.
4. Classify candidates as `must-change`, `inspect`, or `informational`.
5. Record paths, reasons, and confidence in an ImpactSet.
6. Freeze the ImpactSet after approval and generate the Task DAG from it.

Example failure propagation:

```text
Evidence REFUTES Test
→ Test VERIFIES Requirement
→ inverse traversal of Decision ADDRESSES Requirement
→ Decision SHAPES Component
→ inverse traversal of CodeArtifact REALIZES Component
→ related tasks and code enter the ImpactSet
```

Security or compliance failures default to `must-change`. Low-confidence inferred edges can produce only `inspect`. Projection drift triggers regeneration without mutating definition nodes.

## 10. Iteration and Git Lifecycle

An Iteration is one auditable change set of type feature, bugfix, refactor, security, or maintenance. It may contain multiple requirements and tasks.

Each Iteration:

- binds to a baseline commit;
- creates a dedicated branch using the default `harness/<iteration-id>-<slug>` convention;
- can optionally create a worktree;
- records the final commit and merge target.

State machine:

```text
draft → planned → running → verifying → completed
  └──────────────→ blocked
  └──────────────→ aborted
```

`blocked` resumes to its prior phase. `aborted` is terminal and preserves history, branches, and user files.

## 11. Command Surface

### 11.1 Orchestration Entry Commands

| Command | Complete behavior |
|---|---|
| `harness new <name> --intent <text>` | Create the project and Git repository, initialize the ledger and pack, capture requirements, plan, execute, verify, and snapshot |
| `harness adopt [path] --intent <text>` | Scan and approve a baseline, then capture the requested change, analyze, plan, execute, verify, and snapshot |
| `harness iterate <text>` | Run the same complete loop for a subsequent change |
| `harness resume <operation-id>` | Resume the paused orchestration from its last committed checkpoint |

### 11.2 Advanced Commands

| Command | Purpose |
|---|---|
| `harness impact [target]` | Generate or inspect an ImpactSet |
| `harness plan` | Generate a Task DAG from an approved ImpactSet |
| `harness run` | Execute task waves through an adapter; supports dry-run and resume |
| `harness verify` | Run three-layer gates and generate Evidence/Findings |
| `harness approve <id>` | Approve a requirement baseline, Decision, ImpactSet, or risky action |
| `harness snapshot` | Finalize artifacts, evidence, commits, and the iteration summary |
| `harness status` | Show state, blockers, stale evidence, approvals, and the next action |
| `harness doctor` | Diagnose environment, plugin, Git, schema, and cache problems |
| `harness graph sync/query/check` | Synchronize, query, and validate the graph |

The advanced commands exist for inspection, automation, and recovery. Normal usage centers on new, adopt, iterate, resume, and status.

## 12. Main Flows

### 12.1 New Project

```text
select or detect a stack profile
→ create directory and Git repository
→ initialize manifest, lockfile, packs, ledger, and SQLite
→ run doctor
→ create Bootstrap Iteration and branch
→ capture intent, requirements, and constraints
→ approve the requirement baseline
→ generate an ImpactSet and Task DAG
→ execute, verify, repair, and snapshot
```

### 12.2 Existing Project Adoption

```text
deterministic scan into staging
→ agent semantic enrichment as proposed edges
→ confidence, conflict, and unknown-item report
→ mandatory human approval
→ atomic baseline ledger commit
→ Baseline Snapshot
→ capture the requested change
→ impact, plan, execute, verify, repair, and snapshot
```

The authority ledger is unchanged before baseline approval. Rejected staging data remains available for revision or explicit discard.

### 12.3 Subsequent Iteration

```text
Intent
→ Requirement and Constraint
→ Graph Sync
→ ImpactSet
→ Approval
→ Task DAG
→ Agent or Manual Run
→ Gate, Finding, and targeted repair loop
→ Snapshot
```

## 13. Plugin Contracts

### 13.1 StackAdapter

- Detects the stack and returns confidence.
- Scans code artifacts, tests, and deterministic relationships.
- Provides default packs, gates, and projections.
- M1 includes Generic, Node, Python, and Java packs.

### 13.2 AgentAdapter

- Declares capabilities, limits, and resume support.
- Receives one Task Envelope at a time.
- Returns a structured Run, change summary, executed commands, and evidence locators.
- M1 includes Manual Adapter and a generic Command Adapter with provider manifests for common coding agents.

A Task Envelope includes the task ID, objective, input nodes, allowed relative paths, command capabilities, acceptance criteria, required gates, risk, approvals, timeout, baseline commit, and input digests.

### 13.3 GateProvider

Gate Providers execute test, lint, build, security, and project-specific commands. They normalize exit codes, structured results, log summaries, and artifact hashes into Evidence and Findings. They do not decide whether policy permits release.

Gates have three layers:

1. Universal integrity, approval, and audit gates.
2. Stack profile gates.
3. Project-specific gates.

### 13.4 VCS and Projection

- M1 implements only Git VcsAdapter.
- Markdown ProjectionProvider renders PRD, architecture, specification, and plan views.
- Every projection carries source node IDs, revisions, and a generation digest.

## 14. Approval and Security

- Requirement baselines, architecture Decisions, ImpactSets, destructive operations, external writes, and releases require approval by default.
- Routine implementation and verification may continue automatically within an approved Task Envelope.
- An Approval binds to object digest, impact paths, risk, and baseline commit. Any bound change invalidates it.
- Mandatory gates cannot be bypassed with `--force`.
- Agents operate only within declared paths and command capabilities.
- Secrets come from the environment or a Secret Provider and never enter ledger files, events, projections, or logs.
- Evidence is structurally redacted before commit. Unsafe raw logs remain local and are referenced by locator and hash.
- Pack installation and upgrades verify content digests and display provenance.

Plugins execute in subprocesses with minimized environment and declared host capabilities. M1 does not claim that subprocess isolation is an operating-system security sandbox. Third-party binaries are trusted code and new Command Adapter commands require explicit approval.

## 15. Atomicity, Errors, and Recovery

### 15.1 Logical Transactions

- Writes are prepared in `.harness/staging/<operation-id>/`.
- Schema, references, policy, and baseline revisions are validated before commit.
- Target files are atomically renamed, then a final `ledger/operations/<operation-id>.json` commit manifest is atomically written.
- Materialization reads only operations with a valid manifest and matching file digests.
- Events use one JSONL file per operation rather than concurrent appends to one shared file.
- Operation IDs make retries idempotent.
- M1 uses one project-level write lock while allowing concurrent read queries.

### 15.2 Error Policy

| Error | Default handling |
|---|---|
| Schema violation, dangling edge, invalid relation, or task cycle | Reject commit, preserve staging, and report exact locations |
| Missing environment or plugin | Mark the Iteration blocked and provide doctor guidance |
| Agent timeout or crash | Preserve the Run and partial output; resume or switch to manual execution |
| Gate failure | Create a Finding and ImpactSet; rerun only affected tasks and gates |
| Git baseline drift | Pause and recalculate diff, impact, and approvals |
| Policy conflict | Block until policy changes or explicit approval is obtained |
| SQLite damage | Delete the cache and rebuild from the Git ledger |

### 15.3 Checkpoints and Evidence Freshness

- Every phase records a checkpoint.
- Evidence binds to artifact, code, gate, and policy digests.
- Any input change marks evidence stale.
- Stale evidence cannot close a current Finding or satisfy a final snapshot.

## 16. Testing Strategy

- **Unit tests**: schemas, state machine, graph traversal, ImpactSet, Task DAG, policy, and approval invalidation.
- **Property tests**: randomized graph determinism, dangling-edge prevention, cycle detection, and idempotency.
- **Contract tests**: every plugin passes a shared Conformance Kit.
- **Integration tests**: temporary Git repositories, branches, checkpoints, SQLite rebuilds, ledger commits, and projections.
- **End-to-end tests**: Node, Python, and Java fixtures run new/adopt/iterate loops.
- **Fault injection**: process interruption, concurrent writes, cache damage, Git drift, expired approval, and partial gate failure.
- **Security tests**: path traversal, symlink escape, command injection, unsafe packs, secret redaction, and Task Envelope violations.
- **Golden tests**: fixed inputs produce stable graphs, ImpactSets, and projections.

### 16.1 Performance Baseline

On an `ubuntu-latest` CI generated dataset with 20,000 nodes and 100,000 edges:

- warm-cache Impact queries have p95 below two seconds;
- a full SQLite rebuild completes in under 30 seconds;
- identical inputs produce identical node IDs, edges, and normalized digests.

Exceeding either threshold blocks M1 release.

## 17. M1 Acceptance Criteria

1. One `harness new ... --intent ...` invocation can complete the first iteration, pausing only for mandatory input, approval, or external authorization.
2. One `harness adopt ... --intent ...` invocation can approve a baseline and complete the requested iteration under the same pause rules.
3. `harness iterate ...` runs the same complete loop for later changes.
4. Non-interactive pauses return a resumable operation ID, and resume creates no duplicate nodes, runs, evidence, or commits.
5. Identical repositories and configurations produce identical scanned node IDs, edges, and digests.
6. Known change scenarios produce correct ImpactSets without classifying unrelated artifacts as `must-change`.
7. Mandatory gate failure creates a Finding and prevents a completed snapshot.
8. Current repair evidence can close the Finding; stale evidence cannot.
9. Artifact, code, gate, or policy changes invalidate bound Approvals and Evidence.
10. Deleting or corrupting SQLite is recoverable from the Git Ledger.
11. Manual and Command Agent Adapters pass contract and end-to-end tests.
12. Generic, Node, Python, and Java packs pass their fixtures.
13. Linux, macOS, and Windows CI pass.
14. Pack and CLI upgrades preserve project overrides and failed migrations roll back.
15. Performance baselines pass.
16. Repository content, package metadata, examples, fixtures, and Git history remain standalone and contain no former project branding, paths, or business-domain examples.

## 18. M2–M4 Compatibility Ports

M1 freezes versioned interfaces for:

- `GraphQueryPort`: paginated nodes, edges, paths, ImpactSets, and neighborhoods.
- `EventStreamPort`: project, iteration, and sequence-based event reads.
- `TaskDagPort`: tasks, dependencies, states, capabilities, and checkpoints.
- `PolicyDecisionPort`: allow, deny, and requires-approval decisions.
- `PluginCapabilityManifest`: plugin capabilities, versions, and resource needs.

M2 reads through GraphQueryPort and EventStreamPort. M3 synchronizes versioned ledger events without taking ownership of local source files. M4 allocates work through TaskDagPort and PolicyDecisionPort without bypassing approvals or writing directly to the ledger.

## 19. Standalone Repository Rules

- The repository starts from a fresh `main` history.
- No commits, paths, generated assets, examples, or documentation are imported from another product repository.
- Initial history contains only this design, the project README, and Apache-2.0 license.
- The public repository is created only after the standalone content scan passes.
- Implementation begins only after this written design is reviewed and a detailed implementation plan is approved.

## 20. M1 Definition of Done

M1 is complete only when:

- all acceptance criteria in Section 17 pass;
- CLI, plugin SDK, packs, and migration behavior have executable examples;
- new and adopt are validated against standalone fixtures;
- design decisions, limitations, and future compatibility ports are documented;
- no unresolved P0/P1 defects, schema migration gaps, or approval bypasses remain;
- the complete vertical loop is demonstrated from one new command and one adopt command.
