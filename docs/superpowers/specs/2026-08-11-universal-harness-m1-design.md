# Universal Harness M1: Complete Vertical Loop Design

**Date**: 2026-08-11  
**Status**: Approved for implementation planning  
**Repository**: `maochendong/universal-harness`  
**Package**: `universal-harness`  
**CLI binary**: `harness`  
**License**: Apache-2.0

## 1. Vision

Universal Harness is a graph-native, provider-neutral engineering harness for starting or adopting software projects and driving auditable iterations from intent to verified evidence and reusable improvement proposals.

The harness treats requirements, decisions, implementation, tests, agent runs, approvals, findings, root-cause analyses, and evidence as one connected engineering ledger with two logical views: a long-lived Artifact Graph and an iteration-scoped Execution Graph. Git remains the authoritative store. A local SQLite graph is a replaceable materialized view for fast impact analysis.

M1 targets common software projects: web applications, APIs, command-line tools, libraries, and agent applications. Technology-specific behavior is supplied by adapters and project packs rather than embedded in the core.

The governing principle is **Agent proposes; Harness decides**. Models may interpret intent, propose relationships, or execute bounded tasks. Deterministic routing, permissions, budgets, termination, evidence acceptance, and authoritative mutations remain under Harness control.

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
→ Artifact Graph synchronization
→ impact analysis
→ declarative execution planning
→ context compilation
→ direct, bounded agent-loop, or manual execution
→ three-layer quality gates and run evaluation
→ Finding, root-cause analysis (RCA), and targeted repair
→ reviewable improvement candidates when a reusable lesson exists
→ iteration snapshot
```

“One command” means one orchestration entry point, not zero human oversight:

- Interactive mode requests mandatory approvals in the same command session and continues after approval.
- Non-interactive mode pauses safely at approval or external authorization points and returns a resumable operation ID.
- Resume continues from the last committed checkpoint without duplicating nodes, runs, evidence, commits, or external side effects.
- A failed mandatory gate prevents a completed snapshot.
- A proposed improvement never mutates a requirement, architecture decision, specification, policy, tool, or evaluation asset without approval.

## 3. Goals

M1 must:

1. Create a new project that can begin its first iteration immediately.
2. Adopt an existing Git repository through deterministic scanning, semantic enrichment, preview, and approval.
3. Model feature, bugfix, refactor, security, and maintenance changes as auditable Iterations.
4. Maintain a Git-native Graph Ledger exposing Artifact Graph and Execution Graph views without creating two authorities.
5. Generate a reviewable ImpactSet from a change or Finding.
6. Generate a declarative ExecutionPlan only after the ImpactSet is approved.
7. Default to a bounded single-agent loop and create multiple Task nodes only when they have independent execution or verification value.
8. Compile a minimal, traceable ContextBundle for every agent task.
9. Route every Harness-invoked executable capability through a Tool Registry and action-based policy decision.
10. Enforce step, token, duration, retry, and repeat-action limits independently of the model for managed execution, and prevent unattended use when a delegated adapter cannot provide equivalent control.
11. Enforce universal, stack-specific, and project-specific gates.
12. Turn failures into Findings, structured root-cause results, impact paths, and reviewable improvement candidates.
13. Evaluate outcomes, safety, trajectories, efficiency, and correct failure behavior.
14. Recover safely from interruption, cache damage, repository drift, adapter failure, and repeated external actions.
15. Create a final snapshot anchored to the resulting Git commit and containing the execution outcome, trace summary, budget use, evidence, unresolved items, and improvement candidates.

## 4. Scope and Milestones

The complete product is delivered through four independently accepted milestones:

1. **M1 — Core vertical loop**: CLI, dual graph views, new/adopt/iterate, context compilation, bounded single-agent loops, tool governance, policies, approvals, recovery, gates, evaluation, feedback assets, and snapshots.
2. **M2 — Local graph dashboard**: local web views for graph exploration, impact paths, iterations, and evidence.
3. **M3 — Remote collaboration**: event synchronization, team approvals, and conflict handling.
4. **M4 — Multi-agent scheduling**: capability-based parallel scheduling using Task DAGs, leases, and policy decisions.

This document specifies M1 in detail. M2–M4 receive versioned compatibility ports in M1 and require separate design and implementation cycles. Version 1.0 is released after all four milestones are accepted.

### 4.1 M1 Non-goals

- Remote accounts, hosted services, or real-time team collaboration.
- A web dashboard.
- Distributed agent leasing, preemption, or scheduling.
- Autonomous multi-agent execution, dynamic model routing, or agent-to-agent negotiation.
- A public third-party Hook SDK; M1 emits ordered lifecycle events only for the kernel and versioned compatibility port.
- Automatic long-term memory writes, a vector database, or an unreviewed self-refinement mechanism.
- Cross-repository execution; M1 reserves repository-qualified identity for M3 but operates on one repository.
- Replacing Git with a graph database.
- Requiring Neo4j, RDF, or OWL.
- Treating natural-language agent judgment as passing gate evidence.
- Embedding any specific business domain, product, API, or data model in the core.

### 4.2 M1 Internal Delivery Slices

M1 remains one acceptance milestone but is implemented through four ordered, independently tested slices:

1. **Ledger foundation**: schemas, one-ledger/two-view materialization, repository-qualified identity, CLI shell, project layout, transactions, and migrations.
2. **Controlled execution**: ImpactSet, declarative ExecutionPlan, Context Compiler, WorkingState, Loop Controller, Tool Registry, approvals, and recovery.
3. **Quality feedback**: gates, Agent Run evaluation, Finding/RCA cascade, ImprovementCandidates, audit, and snapshots.
4. **Generalization**: Manual and Command AgentAdapters, Generic/Node/Python/Java packs, provider projections, conformance fixtures, and cross-platform end-to-end validation.

No slice is released as M1 by itself. This decomposition controls implementation and review size without weakening the complete-loop acceptance criteria.

## 5. Selected Architecture

M1 uses a stable kernel plus project packs.

- The installed kernel owns schemas, the Graph Ledger protocol, state machines, impact analysis, approvals, plugin execution, and atomic operation semantics.
- Project packs own stack conventions, quality thresholds, vocabulary, templates, and team policies.
- Packs use semantic versions and a lockfile. Upgrades provide preview, migration, and rollback.
- Project overrides are stored separately from upstream packs and cannot be overwritten by a CLI upgrade.

### 5.1 Architecture Principles

1. **Agent proposes; Harness decides.** An agent can return semantic proposals and task results, but cannot approve its own plan, expand its own capabilities, change its own budget, accept evidence, or commit directly to the authority ledger.
2. **Deterministic before probabilistic.** Measurable routing, schema checks, permissions, budgets, retries, termination ceilings, and mandatory gates are code. Model judgment is used only for semantic interpretation and produces a confidence-bearing proposal.
3. **One ledger, two graph views.** The Artifact Graph explains what and why; the Execution Graph explains how, when, and with which controls. Both are projections of the same Git-native ledger.
4. **Single loop by default.** M1 uses `direct`, `single-loop`, or `dag` execution modes. A Task deserves its own node only when it has an independently reviewable output, distinct capability boundary, failure isolation need, or dependency relationship. M1 executes DAG tasks through one adapter at a time; M4 may schedule them concurrently across agents.
5. **Owned artifacts and explicit feedback.** A downstream task or reviewer cannot edit an upstream requirement, decision, or specification. It creates a blocking Finding, and the Workflow Engine routes a revision task to the owner phase.
6. **Minimal context and capabilities.** Each task receives only the relevant graph neighborhood, state, tools, paths, and budget. Authority is based on action, parameters, resource, phase, risk, and approval rather than agent identity alone.
7. **Objective evidence over self-assessment.** Natural-language claims can explain a result but cannot satisfy a mandatory gate without deterministic evidence or explicit human approval.
8. **Learning is proposed, not automatic.** Reusable lessons become ImprovementCandidates. Promotion into policies, knowledge, tools, tests, or evaluation assets requires approval and creates normal graph revisions.

The provenance model borrows the Entity, Activity, Agent, and derivation-chain ideas from [W3C PROV](https://www.w3.org/TR/prov-o/). Runtime lineage events are inspired by the [OpenLineage object model](https://openlineage.io/docs/next/spec/object-model/). M1 adopts these principles without implementing either full standard.

### 5.2 Kernel Modules

| Module | Responsibility |
|---|---|
| Command Router | User-facing orchestration and advanced subcommands |
| Workflow Engine | Declarative plans, execution modes, phase routing, dependencies, pause, resume, and idempotency |
| Graph Ledger Engine | Node/edge validation, event commits, SQLite materialization, and queries |
| Impact Engine | Change seeds, propagation policies, scoring, and ImpactSet generation |
| Context Compiler | Role- and task-aware ContextBundle assembly, prioritization, freshness, compression, and digesting |
| Loop Controller | WorkingState, budgets, dynamic capability narrowing, repeat detection, termination, and structured outcomes |
| Tool Registry | Tool schemas, action policies, risk, quotas, idempotency, invocation validation, and normalized results |
| Policy and Approval Engine | Risk rules, approval invalidation, mandatory gates, and task boundaries |
| Evaluation and RCA Engine | Deterministic and semantic scorers, trajectory evaluation, root-cause routing, and ImprovementCandidate generation |
| Plugin Runtime | Capability discovery, protocol validation, minimized subprocess invocation, and result normalization |
| Projection Engine | Human-readable PRD, architecture, specification, plan, and JSON views |

### 5.3 Alternatives Rejected

| Alternative | Decision |
|---|---|
| One undifferentiated graph view | Rejected because long-lived engineering meaning and short-lived execution state need different query, mutation, retention, and context policies |
| Separate artifact and workflow databases | Rejected because two authorities create synchronization and recovery ambiguity; M1 uses two views over one ledger |
| A Task DAG and multiple agents for every change | Rejected because simple work becomes more expensive and harder to debug; M1 defaults to `direct` or `single-loop` and reserves multi-agent scheduling for M4 |
| Automatic memory writes after every correction | Rejected because unreviewed lessons become stale or contradictory knowledge; reusable lessons enter as reviewable ImprovementCandidates |
| Prompt-only gates and evaluation | Rejected for deterministic conditions; prompts may assist semantic scoring but cannot replace schemas, scripts, evidence, or approvals |

## 6. Implementation Workspace

The implementation is a TypeScript/Node.js workspace:

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
│   │   ├── repositories/
│   │   ├── intents/
│   │   ├── requirements/
│   │   ├── constraints/
│   │   ├── decisions/
│   │   ├── components/
│   │   ├── plans/
│   │   ├── tasks/
│   │   ├── tests/
│   │   ├── eval-cases/
│   │   ├── contexts/
│   │   ├── runs/
│   │   ├── evidence/
│   │   ├── findings/
│   │   ├── root-causes/
│   │   ├── approvals/
│   │   ├── improvements/
│   │   └── iterations/
│   ├── ledger/
│   │   ├── edges.jsonl
│   │   └── operations/
│   ├── events/YYYY-MM/
│   ├── checkpoints/
│   ├── packs/
│   │   ├── upstream/
│   │   └── project/
│   ├── policies/
│   ├── views/
│   ├── generated/providers/
│   ├── raw-traces/
│   ├── cache/graph.db
│   └── staging/
├── src/
└── tests/
```

Artifacts, accepted edges, operation manifests, redacted structural events, checkpoints, packs, policies, views, the manifest, and the lockfile are committed to Git. `.harness/.gitignore` excludes `cache/`, `staging/`, `raw-traces/`, and generated provider mirrors. Generated mirrors are reproducible from canonical packs, graph nodes, and ContextBundles and never overwrite pre-existing provider configuration without preview and approval. This avoids changes to an adopted repository's root ignore rules.

## 8. Git-native Graph Ledger

### 8.1 Authority

- Structured artifacts, accepted edges, and committed events in Git are authoritative.
- SQLite is a disposable materialized query view.
- Markdown documents are human-readable projections, not independent relationship stores.
- Human narrative is stored in artifact fields or extension files so regeneration cannot silently discard it.
- Checkpoint nodes contain the committed, structured WorkingState required for recovery. Provider chat history and raw traces are never authoritative task state.

### 8.2 Core Nodes

| Category | Nodes |
|---|---|
| Containers | Project, Repository, Iteration |
| Intent | Intent, Requirement, Constraint |
| Design | Decision, Component |
| Delivery | ExecutionPlan, Task, CodeArtifact |
| Control | Policy, ToolDefinition |
| Verification | Test, EvaluationCase, Gate |
| Runtime | ContextBundle, Run, Checkpoint, Evidence, Approval |
| Feedback | Finding, RootCauseAnalysis, ImprovementCandidate, ImpactSet |

M1 creates exactly one Repository per Project but qualifies identity with `repository_id` so M3 can add repositories without changing locators. Policy nodes materialize canonical policy files; ToolDefinition nodes materialize registered provider manifests. Domain-specific concepts are pack extensions. They cannot redefine the semantics of core nodes.

### 8.3 Core Relations and Direction

| Family | Relations |
|---|---|
| Provenance | new artifact `DERIVES_FROM` old artifact; new node `SUPERSEDES` old node; artifact `GENERATED_BY` Run |
| Intent and implementation | Intent `DECOMPOSES_TO` Requirement; Decision `ADDRESSES` Requirement; controlled node `CONSTRAINED_BY` Constraint and `GOVERNED_BY` Policy; Decision `SHAPES` Component; CodeArtifact `REALIZES` Component; Task `IMPLEMENTS` Requirement/Decision |
| Verification | Test `VERIFIES` Requirement/Constraint; EvaluationCase `EVALUATES` Task/Run; Run `EXECUTES` Task/Gate/EvaluationCase and `INVOKES` ToolDefinition; Run `PRODUCES` Evidence; Evidence `SUPPORTS`/`REFUTES` Test/Requirement/EvaluationCase; Finding `VIOLATES` Requirement/Constraint/Policy |
| Control | ExecutionPlan `CONTAINS` Task; Task `DEPENDS_ON` Task; Run `USES_CONTEXT` ContextBundle; Checkpoint `CAPTURES` Run/Iteration; Finding `BLOCKS` Task/Iteration; Approval `APPROVES` controlled node; Project/Repository/Iteration `CONTAINS` child node |
| Feedback | Finding `DIAGNOSED_BY` RootCauseAnalysis; RootCauseAnalysis `PRODUCES` ImprovementCandidate; ImprovementCandidate `PROPOSES_CHANGE_TO` any revisioned Requirement/Constraint/Decision/Component/ExecutionPlan/Task/CodeArtifact/Policy/ToolDefinition/Test/EvaluationCase/Gate; Finding/ImprovementCandidate `TRIGGERS` ImpactSet |

The schema registry defines valid source types, target types, propagation direction, default risk, and whether inference is allowed for every relation.

### 8.4 Identity and Provenance

Every node and edge contains:

- `id`, `type`, `revision`, and `status`
- `source`: human, scanner, agent, workflow, tool, gate, evaluation, audit, or migration
- `provenance`: iteration, run, actor, and timestamp
- `confidence`: `1.0` for explicit relationships; `0..1` for inferred relationships
- `digest`: normalized content hash
- `locator`: repository-qualified URI containing `repository_id` and a relative path, optionally narrowed to a symbol, API, or migration
- `extensions`: namespaced extension fields

Human-authored nodes use type-prefixed ULIDs. Scanned nodes use `UUIDv5(project_id, repository_id + type + canonical_locator)` for deterministic identity. Renames use Git rename information or content digests. When identity is uncertain, the scanner creates a new node and links it with `SUPERSEDES` instead of reusing an uncertain ID.

### 8.5 Mutation Rules

- Authoritative non-runtime nodes are revisioned; each revision emits an event.
- ContextBundle, Run, Checkpoint, Evidence, and Approval are append-only.
- Deletion produces a tombstone.
- Agent-inferred edges start as `proposed` and require approval or deterministic validation to become `accepted`.
- ContextBundle nodes store source references, priorities, revisions, freshness, exclusions, token allocation, and a digest. Raw assembled context may remain local when policy classifies it as sensitive.
- A downstream phase cannot revise an upstream artifact directly. It creates a Finding; the Workflow Engine creates a revision Task owned by the upstream phase.
- ImprovementCandidates start as `proposed`. Promotion requires approval and creates an ordinary revision of the target artifact, pack, policy, tool manifest, test, or EvaluationCase.

### 8.6 Logical Graph Views

The two views are query and policy boundaries, not separate databases:

```text
Artifact Graph
Intent → Requirement → Decision → Component → CodeArtifact → Test → Evidence
                                     ↑                            │
                                     └──── approved feedback ─────┘

Execution Graph
ExecutionPlan → Task → ContextBundle → Run → Gate/EvaluationCase → Evidence
                    ↘ Approval/Checkpoint          ↘ Finding → RCA → ImprovementCandidate
```

- Artifact Graph nodes are long-lived, revisioned engineering knowledge.
- Execution Graph nodes are scoped to an Iteration and preserve orchestration, budgets, tool activity summaries, approvals, failures, and recovery points.
- A Task is not split merely to make the graph more detailed. If two tasks can be merged without losing an independent output, capability boundary, failure boundary, or dependency, the planner must merge them.
- Deterministic edges drive routing. Model-inferred relationships can enrich context or create `inspect` impact candidates but cannot independently authorize a route, write, or release.

### 8.7 Knowledge Layers and Health

M1 does not create a parallel knowledge store. Existing nodes have a `knowledge_layer` classification used by context selection and audit. The schema supplies the node-type defaults below; packs can override a node only with an explicit, validated layer:

| Layer | Typical Graph Ledger representation |
|---|---|
| L1 principles | Constraint and Policy |
| L2 architecture | Decision and Component |
| L3 standards | Pack-supplied Policy, Constraint, ToolDefinition, and Gate |
| L4 implementation | CodeArtifact, Test, and generated examples |
| L5 experience | Finding, Evidence, RootCauseAnalysis, and approved ImprovementCandidate outcomes |

`harness audit` checks traceability coverage, stale knowledge, contradictory accepted constraints, orphan nodes, missing verification, unpromoted high-risk improvements, and ContextBundle source health. Audit findings enter the same Finding and ImpactSet flow as test and review failures.

## 9. Impact Analysis

Impact analysis does not rewrite every downstream document.

1. Start from changed node digests, Git diff mappings, Findings, RootCauseAnalyses, or ImprovementCandidates.
2. Traverse only relation types, directions, and depths allowed by the active policy.
3. Score candidates using path, risk, confidence, revision, and evidence freshness.
4. Classify candidates as `must-change`, `inspect`, or `informational`.
5. Record paths, reasons, and confidence in an ImpactSet.
6. Freeze the ImpactSet after approval and generate a declarative ExecutionPlan from it.

Example failure propagation:

```text
Evidence REFUTES Test
→ Test VERIFIES Requirement
→ inverse traversal of Decision ADDRESSES Requirement
→ Decision SHAPES Component
→ inverse traversal of CodeArtifact REALIZES Component
→ related tasks and code enter the ImpactSet
```

Security or compliance failures default to `must-change`. Low-confidence inferred edges can produce only `inspect`. Projection drift triggers regeneration without mutating definition nodes. Routing predicates based on type, risk, confidence, status, freshness, or gate results are deterministic code; a model may propose a semantic classification but cannot select a privileged route by itself.

### 9.1 Feedback Cascade

Test, review, audit, runtime, and evaluation failures share one feedback protocol:

```text
Evidence or Trace
→ Finding
→ RootCauseAnalysis
→ ImpactSet
→ approved upstream revision Task
→ PRD / Architecture / Specification / Plan projection refresh
→ downstream implementation and targeted gates
→ current Evidence
→ Snapshot
```

RootCauseAnalysis records the observed symptom, evidence, responsible layer, responsible module, root-cause category, confidence, and proposed verification. Deterministic rules assign known failure patterns first; semantic analysis handles unclassified cases; high-risk or low-confidence conclusions require human review.

When the lesson is reusable, the RCA also produces one or more ImprovementCandidates with `target_kind` equal to `evaluation`, `knowledge`, or `engineering` and `target_layer` equal to `prd`, `architecture`, `spec`, `plan`, `policy`, `tool`, `test`, or `eval`. Candidates must be reproducible, have an explicit expected behavior, identify a representative failure class, contain no unapproved sensitive data, and name their verification method before promotion.

Target layers resolve to authoritative graph nodes rather than directly edited Markdown:

| Target layer | Owning nodes |
|---|---|
| `prd` | Intent and Requirement |
| `architecture` | Decision and Component |
| `spec` | Requirement, Constraint, and acceptance Test |
| `plan` | ExecutionPlan and Task |
| `policy` | Policy and pack-supplied Constraint |
| `tool` | ToolDefinition and its provider manifest |
| `test` | Test |
| `eval` | EvaluationCase and scorer policy |

The cascade never blindly rewrites every downstream artifact. The ImpactSet identifies `must-change`, `inspect`, and `informational` nodes; the Workflow Engine routes each required revision to its owning phase; projections are regenerated from accepted graph revisions; only affected tasks, gates, and evaluation cases rerun.

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

### 10.1 Execution Modes and Declarative Plans

Every approved ImpactSet compiles to one ExecutionPlan:

| Mode | Selection rule | M1 behavior |
|---|---|---|
| `direct` | All work is deterministic and requires no semantic agent action | Workflow Engine invokes registered tools and gates directly |
| `single-loop` | One bounded objective has one independently reviewable output | One Task runs through one AgentAdapter or Manual Adapter |
| `dag` | Two or more tasks have independent outputs, capability boundaries, failure isolation, or dependencies | Tasks run in dependency order through one adapter at a time; M4 may parallelize eligible tasks |

A planner outputs declarative Task specifications: objective, expected outputs, dependencies, capabilities, risk, budgets, acceptance criteria, and required gates. It does not output privileged shell commands or direct tool invocations. The Workflow Engine validates, merges, rejects, reorders, or pauses the plan before execution.

### 10.2 WorkingState and Context Lifecycle

The Workflow Engine is the only writer of authoritative WorkingState. Agents receive a bounded view and return proposals. Each committed checkpoint contains:

- immutable goal and approved requirement baseline;
- current phase, task, and prior checkpoint;
- confirmed facts with Evidence references;
- rejected hypotheses and their evidence;
- open questions, blockers, and next actions;
- completed and pending Task IDs;
- current budget use and termination ceilings;
- active capability grants and approval digests;
- ContextBundle and input digests;
- external action intents and their completion status.

Provider chat history is an optional input, not state. Context compilation selects, prioritizes, compresses, and truncates sources under an explicit token budget. Protected content such as the goal, acceptance criteria, safety constraints, active approvals, and unresolved blockers cannot be removed by compression. A stale source digest invalidates the ContextBundle before the next loop step.

### 10.3 Snapshot Contents

Every terminal or paused Iteration can emit a snapshot whose status is `completed`, `blocked`, or `aborted`. A completed snapshot contains the final commit, accepted artifact revisions, ExecutionPlan, adapter control profiles, Run outcomes, redacted trajectory and coverage summary, budget and latency summary, approvals, current evidence, closed Findings, unresolved non-blocking items, rejected hypotheses, and proposed or promoted ImprovementCandidates. All required Tasks must have `success`; a blocking Finding, stale mandatory evidence, incomplete external action, or non-success required Run prevents `completed` but can still produce a diagnostic `blocked` or `aborted` snapshot.

## 11. Command Surface

### 11.1 Orchestration Entry Commands

| Command | Complete behavior |
|---|---|
| `harness new <name> --intent <text>` | Create the project and Git repository, initialize the ledger and pack, then capture, plan, compile context, execute, verify, evaluate, repair, and snapshot |
| `harness adopt [path] --intent <text>` | Scan and approve a baseline, then capture, analyze, plan, compile context, execute, verify, evaluate, repair, and snapshot |
| `harness iterate <text>` | Run the same complete loop for a subsequent change |
| `harness resume <operation-id>` | Resume the paused orchestration from its last committed checkpoint |

### 11.2 Advanced Commands

| Command | Purpose |
|---|---|
| `harness impact [target]` | Generate or inspect an ImpactSet |
| `harness plan` | Generate or inspect a declarative ExecutionPlan from an approved ImpactSet |
| `harness run` | Execute planned tasks through an adapter; supports dry-run and resume |
| `harness verify` | Run three-layer gates and generate Evidence/Findings |
| `harness eval` | Evaluate task outcomes, safety, trajectories, efficiency, and correct failure behavior |
| `harness approve <id>` | Approve a baseline, Decision, ImpactSet, ImprovementCandidate promotion, or risky action |
| `harness snapshot` | Finalize artifacts, evidence, commits, and the iteration summary |
| `harness status` | Show state, adapter control level, evaluation coverage, blockers, stale evidence, approvals, and the next action |
| `harness doctor` | Diagnose environment, plugin, Git, schema, and cache problems |
| `harness audit` | Diagnose traceability, knowledge freshness, graph health, gate coverage, and unpromoted risk |
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
→ generate an ImpactSet and declarative ExecutionPlan
→ compile context
→ execute under LoopPolicy and Tool Registry controls
→ verify, evaluate, repair, and snapshot
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
→ impact, plan, compile context, execute, verify, evaluate, repair, and snapshot
```

The authority ledger is unchanged before baseline approval. Rejected staging data remains available for revision or explicit discard.

### 12.3 Subsequent Iteration

```text
Intent
→ Requirement and Constraint
→ Graph Sync
→ ImpactSet
→ Approval
→ Declarative ExecutionPlan
→ ContextBundle
→ Direct, Agent, or Manual Run
→ Gate/EvaluationCase, Finding, RCA, and targeted repair loop
→ reviewable ImprovementCandidate when reusable
→ Snapshot
```

## 13. Plugin Contracts

### 13.1 StackAdapter

- Detects the stack and returns confidence.
- Scans code artifacts, tests, and deterministic relationships.
- Provides default packs, gates, and projections.
- M1 includes Generic, Node, Python, and Java packs.

### 13.2 AgentAdapter

- Declares capabilities, limits, usage metering, provider configuration, and resume support.
- Receives one Task Envelope at a time.
- Returns a structured Run result, state proposals, change summary, tool activity summary, usage, termination reason, and evidence locators.
- M1 includes Manual Adapter and a generic Command Adapter with provider manifests for common coding agents.

Each adapter declares a control profile:

| Control level | Harness control | Eligibility |
|---|---|---|
| `managed` | Harness owns model turns, tool dispatch, policy checks, metering, and the complete trajectory | Eligible for unattended execution when all policy requirements pass |
| `delegated` | Harness governs the outer provider command, worktree, input, timeout, result, and any structured telemetry the provider exposes; the provider owns its internal loop | Supervised unless the manifest proves required metering, interception, and trajectory coverage |
| `manual` | A human performs the task and attaches evidence | Never unattended; budgets are informational except for Harness-run tools |

The manifest separately declares `trajectory_visibility` (`full`, `summarized`, or `external-only`), `usage_metering`, `side_effect_interception`, and `resume_semantics`. Harness never reports an opaque provider's internal tools as governed. A policy requiring full trajectory evidence, hard token enforcement, or side-effect interception rejects adapters that cannot provide it.

A Task Envelope is the executable NodeContract. It includes:

- task, plan, iteration, repository, and baseline IDs;
- objective, expected outputs, acceptance criteria, dependencies, and required gates;
- input node revisions, ContextBundle ID and digest, and protected context fields;
- allowed read paths, proposed write paths, state read fields, and state proposal fields;
- named Tool Registry capabilities with parameter and resource restrictions;
- risk, required approvals, external side-effect policy, and idempotency scope;
- LoopPolicy, baseline commit, input digests, and stale-input behavior.

Agents never receive a general permission to mutate WorkingState or the authority ledger. They return typed proposals; the Workflow Engine validates and commits accepted changes. Automated AgentAdapters must either report usage or enforce the Harness-provided token ceiling. A delegated adapter without enforceable usage metering or required interception is supervised and cannot run unattended.

### 13.3 LoopPolicy and Run Outcomes

LoopPolicy contains:

```yaml
max_steps: 30
max_tokens: 120000
max_duration_ms: 2700000
max_tool_retries: 2
repeat_detection:
  window: 6
  identical_action_limit: 2
termination:
  require_structured_signal: true
  require_external_verification: true
  budget_ceiling: hard
```

These values are the M1 Generic pack defaults, not universal constants. A pack or approved project policy may lower them without an additional approval. Raising a ceiling requires policy authorization, is bounded by an installation-level maximum, and records the effective policy digest on the Run.

The Loop Controller fingerprints tool name, normalized parameters, target resource, and relevant state digest. Repeated calls without state or evidence progress terminate the loop. A model cannot raise its limits or disable repeat detection.

Every terminal Run ends with one outcome: `success`, `correct_block`, `clarification_required`, `handoff`, `partial`, or `failed`. `termination_reason` separately records completion, gate failure, policy denial, budget ceiling, repeat detection, timeout, adapter failure, user cancellation, or manual stop. A model completion signal moves the Run to `verifying`; only current mandatory evidence can produce terminal `success`.

### 13.4 ContextBundle Contract

The Context Compiler assembles a bundle in this priority order:

1. immutable goal, approved acceptance criteria, hard constraints, and active approvals;
2. current Task, ImpactSet paths, WorkingState, blockers, and required gates;
3. affected architecture, specification, component, code, and test neighborhood;
4. applicable pack rules, project standards, examples, and approved L5 experience;
5. compressed prior observations needed for continuity.

Each source entry records node ID, revision, digest, knowledge layer, reason selected, priority, freshness, original size, included size, and compression method. The bundle records excluded sources and the reason for exclusion. Role- or task-specific budgets determine how much each layer receives. Compression cannot remove protected fields. ContextBundles are immutable; changed source digests require recompilation.

### 13.5 ToolProvider and Tool Registry

Every executable command, script, MCP capability, and external API is registered before use. A ToolProvider declares:

- stable name, version, description, and input/output JSON Schemas;
- allowed phases, resource patterns, and parameter constraints;
- risk, side-effect class, approval policy, and redaction policy;
- timeout, retry class, concurrency and rate limits, and cost metadata;
- idempotency support and reconciliation behavior for uncertain results.

Invocation has three enforced stages:

1. **Before**: verify registration, schema, declared task relevance, phase grant, resource scope, risk, approval, quota, and idempotency key.
2. **During**: apply timeout and quotas; capture normalized progress; convert implementation errors into structured tool errors.
3. **After**: validate the output schema, redact sensitive fields, record evidence and usage, reconcile side effects, and apply bounded retry or downgrade policy.

Before an external side effect, the Workflow Engine commits an action intent containing the tool, normalized request digest, target resource, approval, and idempotency key. It commits the completion or uncertain result afterward. Resume reconciles the action intent before retrying and never assumes that a timeout means the external action did not occur.

For a delegated AgentAdapter, the provider process itself is a ToolDefinition. Internal provider tools are governed only when the provider exposes enforceable callbacks or structured events declared by its manifest. Otherwise the outer command remains supervised, and pre/post repository inspection supplies evidence without being described as an operating-system containment boundary.

### 13.6 GateProvider

Gate Providers execute test, lint, build, security, and project-specific commands. They normalize exit codes, structured results, log summaries, and artifact hashes into Evidence and Findings. They do not decide whether policy permits release.

Gates have three layers:

1. Universal integrity, approval, and audit gates.
2. Stack profile gates.
3. Project-specific gates.

### 13.7 VCS and Projection

- M1 implements only Git VcsAdapter.
- Markdown ProjectionProvider renders PRD, architecture, specification, and plan views.
- Every projection carries source node IDs, revisions, and a generation digest.
- Provider instruction projections are generated from canonical packs, Task Envelopes, and ContextBundles. Provider-specific files are mirrors, not sources of truth, and are written only to managed locations unless the user approves a previewed integration with an existing provider directory.

### 13.8 Lifecycle Events

The kernel emits ordered, versioned events for `OperationStarted`, `PlanAccepted`, `BeforeContextCompile`, `ContextCompiled`, `BeforeToolCall`, `AfterToolCall`, `ApprovalRequired`, `CheckpointCommitted`, `GateCompleted`, `EvaluationCompleted`, `FindingCreated`, and `OperationCompleted`. Event payloads contain identifiers and redacted structured data, not secrets or raw provider transcripts.

M1 uses these events internally and exposes them through EventStreamPort. A public Hook SDK, third-party ordering, conflict resolution, rollback semantics, and destructive-hook policy require a separate M2 design.

## 14. Approval and Security

- Requirement baselines, architecture Decisions, ImpactSets, ImprovementCandidate promotions, destructive operations, external writes, and releases require approval by default.
- Routine implementation and verification may continue automatically within an approved Task Envelope.
- An Approval binds to object digest, impact paths, risk, and baseline commit. Any bound change invalidates it.
- Mandatory gates cannot be bypassed with `--force`.
- Harness authorizes and commits only declared paths, state proposal fields, registered capabilities, parameter bounds, resource scopes, phases, budgets, and approvals.
- Tool descriptions, retrieved documents, repository content, and provider output are untrusted context and cannot grant capabilities or alter policy.
- An agent cannot approve its own proposal, accept its own Evidence, promote its own ImprovementCandidate, or classify its own semantic judgment as a mandatory pass.
- Secrets come from the environment or a Secret Provider and never enter ledger files, events, projections, or logs.
- Evidence is structurally redacted before commit. Unsafe raw logs remain local and are referenced by locator and hash.
- Pack installation and upgrades verify content digests and display provenance.

Plugins execute in subprocesses with minimized environment and declared host capabilities. M1 does not claim that subprocess isolation, a worktree, or pre/post diff inspection is an operating-system security sandbox. Third-party and delegated provider binaries are trusted code, and new Command Adapter commands require explicit approval.

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
| Step, token, duration, or repeat-action ceiling | Stop the loop, persist a structured outcome and checkpoint, then block, hand off, or return a policy-permitted partial result |
| Unknown tool, invalid parameter, capability violation, or invalid tool output | Reject before authoritative mutation, append a redacted trace event, and apply only the declared retry or handoff policy |
| External action result is uncertain | Preserve the action intent, block blind retry, and reconcile through the ToolProvider or human review |
| Gate or evaluation failure | Create a Finding and provisional ImpactSet, schedule RCA, refresh impact after RCA, and rerun only affected tasks, gates, and evaluation cases |
| Context source becomes stale | Invalidate the ContextBundle, checkpoint, recompile context, and re-evaluate affected approval bindings |
| Git baseline drift | Pause and recalculate diff, impact, and approvals |
| Policy conflict | Block until policy changes or explicit approval is obtained |
| SQLite damage | Delete the cache and rebuild from the Git ledger |

### 15.3 Checkpoints and Evidence Freshness

- Every phase boundary, Task completion or failure, approval boundary, and external side-effect boundary records a checkpoint. Individual model turns append trace events but do not require a Git checkpoint unless policy requests one.
- Checkpoints serialize WorkingState through one trusted Workflow Engine writer. Adapter-local state is never an independent authority.
- Evidence binds to applicable artifact, code, ContextBundle, gate, EvaluationCase, and policy digests.
- Any input change marks evidence stale.
- Stale evidence cannot close a current Finding or satisfy a final snapshot.
- Resume starts from the latest valid checkpoint, validates repository and ContextBundle digests, reconciles incomplete external action intents, and then continues without replaying a completed Task or side effect.

## 16. Testing Strategy

- **Unit tests**: schemas, state machine, graph views, graph traversal, ImpactSet, ExecutionPlan, ContextBundle, WorkingState, LoopPolicy, Tool Registry, scorers, policy, and approval invalidation.
- **Property tests**: randomized graph determinism, dangling-edge prevention, cycle detection, task-merge invariants, context budget preservation, repeat fingerprints, and idempotency.
- **Contract tests**: every plugin passes a shared Conformance Kit.
- **Integration tests**: temporary Git repositories, branches, checkpoints, SQLite rebuilds, ledger commits, and projections.
- **End-to-end tests**: Node, Python, and Java fixtures run new/adopt/iterate loops.
- **Fault injection**: process interruption, concurrent writes, cache damage, Git drift, expired approval, budget exhaustion, repeated actions, uncertain external results, stale context, and partial gate failure.
- **Security tests**: path traversal, symlink escape, command injection, prompt-carried capability escalation, unsafe packs, secret redaction, Task Envelope violations, delegated-provider capability mismatch, and undeclared-write detection.
- **Golden tests**: fixed inputs produce stable graph views, ImpactSets, ExecutionPlans, ContextBundle manifests, RCA routing, and projections.

### 16.1 Agent Run Evaluation

Framework verification and Agent Run evaluation are separate. The first proves that Harness code behaves correctly; the second measures whether bounded agent behavior is reliable.

| Dimension | Priority | Examples |
|---|---|---|
| Outcome | P0 | acceptance criteria satisfied, required artifacts created, continuous success across repeated scenarios |
| Safety | P0 | denied action rate, risky action interception, secret leakage, unauthorized path or capability use |
| Trajectory | P1 | valid tool selection and parameters, plan adherence, evidence use, no unproductive repetition |
| Correct failure | P1 | clarification when information is missing, block on denied permission, handoff on unrecoverable tool failure |
| Efficiency | P2 | steps, tokens, duration, retries, tool calls, and cost per accepted outcome |

Deterministic scorers evaluate schemas, state changes, tool calls, paths, approvals, evidence, and termination. Semantic scorers may evaluate explanation or strategy quality and must return reason and confidence. Every evaluation reports coverage, including unavailable internal trajectory fields for delegated adapters. A policy can require a minimum coverage level. A semantic score cannot satisfy a mandatory M1 gate unless a project policy adds an explicit calibrated judge and human fallback.

The conformance fixtures include successful execution, insufficient requirements, denied permission, malformed tool parameters, repeated tool calls, tool failure, budget exhaustion, stale context, gate failure, feedback cascade, and resume after an uncertain external action. CI uses deterministic fake adapters and replay traces; opt-in live adapter suites measure repeated-run stability without making network access a release prerequisite.

### 16.2 Performance Baseline

On an `ubuntu-latest` CI generated dataset with 20,000 nodes and 100,000 edges:

- warm-cache Impact queries have p95 below two seconds;
- a full SQLite rebuild completes in under 30 seconds;
- identical inputs produce identical node IDs, edges, and normalized digests.

Exceeding either threshold blocks M1 release.

## 17. M1 Acceptance Criteria

1. One `harness new ... --intent ...` invocation can complete the first iteration, pausing only for mandatory input, approval, or external authorization.
2. One `harness adopt ... --intent ...` invocation can approve a baseline and complete the requested iteration under the same pause rules.
3. `harness iterate ...` runs the same complete loop for later changes.
4. Non-interactive pauses return a resumable operation ID, and resume creates no duplicate nodes, runs, evidence, commits, or external side effects.
5. Identical repositories and configurations produce identical repository-qualified scanned node IDs, edges, and digests.
6. Artifact Graph and Execution Graph queries materialize from one authority ledger and remain mutually traceable.
7. Known change scenarios produce correct ImpactSets without classifying unrelated artifacts as `must-change`.
8. Planning starts only from an approved ImpactSet, produces declarative Task specifications, and rejects commands or unauthorized capability expansion embedded in a plan proposal.
9. Simple fixtures select `direct` or `single-loop`; a `dag` fixture creates multiple Tasks only when each satisfies the independent-value rule.
10. Every Task receives an immutable ContextBundle, field-level state contract, capability grant, LoopPolicy, acceptance criteria, and input digests; its adapter control profile is visible before approval.
11. Context compilation preserves protected fields, obeys token allocation, records exclusions, and invalidates stale bundles.
12. Unknown Harness-managed tools, invalid parameters, disallowed resources, capability violations, and invalid outputs are blocked and traced before authoritative mutation; an opaque delegated provider is never presented as fully governed.
13. External action intents are durable and idempotent; resume reconciles uncertain actions instead of blindly replaying them.
14. Managed execution enforces step, token, duration, retry, and repeat-action ceilings without relying on model compliance; delegated adapters lacking equivalent controls are forced into supervised mode.
15. Every Run records one defined outcome and termination reason; correct-block, clarification, and handoff fixtures pass.
16. Mandatory gate or mandatory evaluation-threshold failure creates a Finding and prevents a completed snapshot.
17. A failed scenario produces structured RCA and ImpactSet routing; downstream phases cannot directly revise upstream artifacts.
18. A reusable failure can produce evaluation, knowledge, or engineering ImprovementCandidates, and none are promoted without approval.
19. Current repair evidence can close the Finding; stale evidence cannot.
20. Artifact, code, context source, gate, evaluation, or policy changes invalidate bound Approvals, ContextBundles, and Evidence as applicable.
21. Completed snapshots contain final commit, plan, adapter control profiles, outcomes, trajectory and coverage summary, budget use, approvals, current evidence, unresolved non-blocking items, and improvement status.
22. Deleting or corrupting SQLite is recoverable from the Git Ledger.
23. Manual and Command Agent Adapters pass contract, control-profile, behavioral evaluation, and end-to-end tests; insufficient control or visibility always prevents unattended selection.
24. Generic, Node, Python, and Java packs pass their fixtures.
25. Linux, macOS, and Windows CI pass.
26. Pack and CLI upgrades preserve project overrides and failed migrations roll back.
27. Performance baselines pass.
28. Repository content, package metadata, examples, fixtures, generated provider projections, and Git history remain standalone and contain no former project branding, paths, or business-domain examples.

## 18. M2–M4 Compatibility Ports

M1 freezes versioned interfaces for:

- `GraphQueryPort`: paginated nodes, edges, paths, ImpactSets, and neighborhoods.
- `EventStreamPort`: project, iteration, and sequence-based event reads.
- `ExecutionGraphPort`: plans, runs, checkpoints, outcomes, budgets, and feedback routes.
- `ContextAssemblyPort`: source selection, budgets, manifests, digests, and freshness.
- `TaskDagPort`: tasks, dependencies, states, capabilities, and checkpoints.
- `ToolRegistryPort`: versioned tool descriptors, policy inputs, quotas, invocation summaries, and idempotency state.
- `EvaluationPort`: cases, scorer results, trajectory summaries, RCA, and ImprovementCandidates.
- `PolicyDecisionPort`: allow, deny, and requires-approval decisions.
- `PluginCapabilityManifest`: plugin capabilities, versions, and resource needs.

M2 reads through GraphQueryPort, ExecutionGraphPort, EvaluationPort, and EventStreamPort. Its public Hook SDK, if approved in a separate design, consumes lifecycle events without owning checkpoint persistence. M3 synchronizes versioned ledger events and may activate repository-qualified execution without taking ownership of local source files. M4 allocates work through TaskDagPort and PolicyDecisionPort without bypassing approvals, mutating shared state directly, or writing directly to the ledger; parallel reads are allowed while accepted writes remain centralized.

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
- ContextBundle, LoopPolicy, Tool Registry, correct-failure, feedback-cascade, and idempotent-resume fixtures pass;
- design decisions, limitations, and future compatibility ports are documented;
- no unresolved P0/P1 defects, schema migration gaps, or approval bypasses remain;
- the complete vertical loop is demonstrated from one new command and one adopt command.
