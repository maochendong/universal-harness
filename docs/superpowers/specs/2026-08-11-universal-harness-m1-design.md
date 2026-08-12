# Universal Harness M1：完整纵向闭环设计

**日期**：2026-08-11  
**状态**：已批准并进入实施  
**仓库**：`maochendong/universal-harness`  
**Package**：`universal-harness`  
**CLI binary**：`harness`  
**许可证**：Apache-2.0

## 1. 愿景

Universal Harness 是一个 Graph-native、Provider-neutral 的工程 Harness，用于新建或接管软件项目，并将意图持续推进为经过验证的证据和可复用的改进提案，使整个迭代过程可审计。

Harness 将 Requirement、Decision、Implementation、Test、Agent Run、Approval、Finding、RootCauseAnalysis 和 Evidence 视为同一套互联工程 Ledger，并提供两个逻辑视图：长期存在的 Artifact Graph 和限定于单次 Iteration 的 Execution Graph。Git 始终是权威存储；本地 SQLite Graph 只是用于快速影响分析、可替换的物化视图。

M1 面向常见软件项目，包括 Web 应用、API、命令行工具、Library 和 Agent 应用。技术栈相关行为由 Adapter 和 Project Pack 提供，不嵌入 Core。

核心治理原则是 **Agent 提案，Harness 决策**。Model 可以解释意图、提出关系或执行受限 Task；确定性路由、权限、预算、终止、Evidence 接受以及权威写入始终由 Harness 控制。

## 2. M1 产品承诺

M1 包含完整纵向闭环。用户通过一个编排入口命令启动：

```bash
harness new my-project --intent "Build the first capability"
harness adopt /path/to/project --intent "Introduce the requested change"
harness iterate "Implement the next change"
```

每个入口命令都编排以下流程：

```text
新建或接管项目
→ 录入 Requirement
→ 同步 Artifact Graph
→ 影响分析
→ 声明式执行规划
→ 编译 Context
→ 直接执行、受限 Agent Loop 或人工执行
→ 三层质量门禁和 Run Evaluation
→ Finding、RootCauseAnalysis（RCA）和定向修复
→ 存在可复用经验时生成可评审 ImprovementCandidate
→ Iteration Snapshot
```

“一个命令”表示一个编排入口，而不是完全不需要人工监督：

- 交互模式在同一命令会话中请求强制 Approval，批准后继续。
- 非交互模式在 Approval 或外部授权点安全暂停，并返回可恢复的 operation ID。
- Resume 从最后一个已提交 Checkpoint 继续，不重复节点、Run、Evidence、commit 或外部副作用。
- Mandatory Gate 失败会阻止生成 `completed` Snapshot。
- ImprovementCandidate 未经批准不得修改 Requirement、Architecture Decision、Specification、Policy、Tool 或 Evaluation 资产。

## 3. 目标

M1 必须：

1. 新建一个可立即开始首次迭代的项目。
2. 通过确定性扫描、语义增强、预览和批准接管现有 Git 仓库。
3. 将 feature、bugfix、refactor、security 和 maintenance 变更建模为可审计 Iteration。
4. 维护一套 Git-native Graph Ledger，在不制造两个权威源的前提下提供 Artifact Graph 和 Execution Graph。
5. 从变更或 Finding 生成可评审 ImpactSet。
6. 仅在 ImpactSet 获批后生成声明式 ExecutionPlan。
7. 默认使用受限单 Agent Loop；只有具备独立执行或验证价值时才创建多个 Task 节点。
8. 为每个 Agent Task 编译最小、可追溯 ContextBundle。
9. 将 Harness 调用的每个可执行能力路由到 Tool Registry 和基于动作的 Policy Decision。
10. 对 managed 执行独立于 Model 强制 step、token、duration、retry 和 repeat-action 上限；delegated Adapter 无法提供等价控制时不得无人值守运行。
11. 强制 universal、stack-specific 和 project-specific 三类 Gate。
12. 将失败转换为 Finding、结构化 RCA、Impact 路径和可评审 ImprovementCandidate。
13. 评估 outcome、safety、trajectory、efficiency 和 correct failure。
14. 从中断、cache 损坏、repository drift、Adapter 失败和重复外部动作中安全恢复。
15. 创建锚定最终 Git commit 的 Snapshot，其中包含执行结果、轨迹摘要、预算使用、Evidence、未解决事项和 ImprovementCandidate。

## 4. 范围与里程碑

完整产品通过四个可独立验收的里程碑交付：

1. **M1 — Core 纵向闭环**：CLI、双 Graph View、new/adopt/iterate、Context 编译、受限单 Agent Loop、Tool 治理、Policy、Approval、Recovery、Gate、Evaluation、Feedback 资产和 Snapshot。
2. **M2 — 本地 Graph Dashboard**：用于探索 Graph、Impact Path、Iteration 和 Evidence 的本地 Web View。
3. **M3 — 远程协作**：事件同步、团队批准和冲突处理。
4. **M4 — Multi-Agent 调度**：基于能力，使用 Task DAG、Lease 和 Policy Decision 进行并行调度。

本文详细定义 M1。M2–M4 在 M1 中获得版本化兼容端口，但各自需要独立设计和实施周期。四个里程碑全部验收后发布 1.0。

### 4.1 M1 非目标

- 远程账号、托管服务或实时团队协作。
- Web Dashboard。
- 分布式 Agent Lease、抢占或调度。
- 自主 Multi-Agent 执行、动态 Model 路由或 Agent 间协商。
- 公共第三方 Hook SDK；M1 仅向 Kernel 和版本化兼容端口发出有序 Lifecycle Event。
- 自动写入长期记忆、Vector Database 或未经评审的自我改进机制。
- 跨仓库执行；M1 为 M3 保留 repository-qualified identity，但只操作一个仓库。
- 使用 Graph Database 替代 Git。
- 强制依赖 Neo4j、RDF 或 OWL。
- 将自然语言 Agent 判断当作通过 Gate 的 Evidence。
- 在 Core 中嵌入特定业务领域、产品、API 或数据模型。

### 4.2 M1 内部交付切片

M1 始终是一个验收里程碑，但通过四个有序、可独立测试的切片实施：

1. **Ledger 基础**：Schema、单 Ledger 双 View 物化、repository-qualified identity、CLI 外壳、项目布局、事务和迁移。
2. **受控执行**：ImpactSet、声明式 ExecutionPlan、Context Compiler、WorkingState、Loop Controller、Tool Registry、Approval 和 Recovery。
3. **质量反馈**：Gate、Agent Run Evaluation、Finding/RCA 级联、ImprovementCandidate、Audit 和 Snapshot。
4. **泛化**：Manual/Command AgentAdapter、Generic/Node/Python/Java Pack、Provider Projection、Conformance Fixture 和跨平台 E2E 验证。

任何单一切片都不能作为 M1 发布。该拆分用于控制实施与评审规模，不削弱完整闭环验收标准。

## 5. 选定架构

M1 使用稳定 Kernel 加 Project Pack：

- 已安装 Kernel 负责 Schema、Graph Ledger 协议、State Machine、Impact Analysis、Approval、Plugin 执行和原子操作语义。
- Project Pack 负责技术栈约定、质量阈值、词汇、Template 和 Team Policy。
- Pack 使用语义版本和 lockfile；升级提供预览、迁移和回滚。
- Project Override 与 Upstream Pack 分开存储，CLI 升级不得覆盖。

### 5.1 架构原则

1. **Agent 提案，Harness 决策。** Agent 可返回语义提案和 Task Result，但不能批准自己的 Plan、扩展自己的 Capability、修改自己的 Budget、接受 Evidence 或直接提交到权威 Ledger。
2. **先确定性，后概率性。** 可测量的路由、Schema 校验、Permission、Budget、Retry、Termination Ceiling 和 Mandatory Gate 使用代码实现。Model Judgment 仅用于语义解释，并产生带 confidence 的 Proposal。
3. **一个 Ledger，两个 Graph View。** Artifact Graph 解释“是什么、为什么”；Execution Graph 解释“如何、何时、受哪些控制”。二者都是同一套 Git-native Ledger 的投影。
4. **默认单 Loop。** M1 使用 `direct`、`single-loop` 或 `dag` 执行模式。只有 Task 具有独立可评审输出、不同 Capability Boundary、Failure Isolation 需要或依赖关系时，才值得单独建节点。M1 使用单一 Adapter 顺序执行 DAG Task；M4 才可跨 Agent 并发调度。
5. **工件有明确所有权，反馈显式传递。** 下游 Task 或 Reviewer 不得编辑上游 Requirement、Decision 或 Specification，而应创建 blocking Finding，由 Workflow Engine 将 revision Task 路由回 owner phase。
6. **最小 Context 与 Capability。** 每个 Task 只获得相关 Graph 邻域、State、Tool、Path 和 Budget。授权依据 action、parameter、resource、phase、risk 和 approval，而非只依据 Agent 身份。
7. **客观 Evidence 优先于自我评估。** 自然语言声明可以解释结果，但没有确定性 Evidence 或显式人工批准时不能满足 Mandatory Gate。
8. **学习先提案，不自动写入。** 可复用经验成为 ImprovementCandidate。提升到 Policy、Knowledge、Tool、Test 或 Evaluation Asset 前需要批准，并创建正常 Graph Revision。

Provenance Model 借鉴 [W3C PROV](https://www.w3.org/TR/prov-o/) 的 Entity、Activity、Agent 和 derivation chain；Runtime Lineage Event 借鉴 [OpenLineage Object Model](https://openlineage.io/docs/next/spec/object-model/)。M1 采用这些原则，但不完整实现任一标准。

### 5.2 Kernel 模块

| 模块 | 职责 |
|---|---|
| Command Router | 面向用户的编排入口和高级子命令 |
| Workflow Engine | 声明式 Plan、执行模式、Phase 路由、依赖、Pause、Resume 和幂等 |
| Graph Ledger Engine | Node/Edge 校验、Event Commit、SQLite 物化和查询 |
| Impact Engine | Change Seed、传播 Policy、评分和 ImpactSet 生成 |
| Context Compiler | 面向 Role/Task 的 ContextBundle 组装、优先级、Freshness、压缩和摘要 |
| Loop Controller | WorkingState、Budget、动态 Capability 收窄、重复检测、终止和结构化 Outcome |
| Tool Registry | Tool Schema、Action Policy、Risk、Quota、幂等、调用校验和规范化结果 |
| Policy and Approval Engine | Risk Rule、Approval 失效、Mandatory Gate 和 Task Boundary |
| Evaluation and RCA Engine | 确定性/语义 Scorer、Trajectory Evaluation、RCA 路由和 ImprovementCandidate 生成 |
| Plugin Runtime | Capability Discovery、协议校验、最小化子进程调用和结果规范化 |
| Projection Engine | 人类可读 PRD、Architecture、Specification、Plan 和 JSON View |

### 5.3 已否决方案

| 方案 | 决策 |
|---|---|
| 一个不区分用途的 Graph View | 否决；长期工程语义和短期执行状态需要不同查询、Mutation、Retention 和 Context Policy |
| Artifact 与 Workflow 分离数据库 | 否决；两个权威源会产生同步与恢复歧义，M1 使用同一 Ledger 的两个 View |
| 每个变更都创建 Task DAG 和多个 Agent | 否决；简单工作成本更高且更难调试，M1 默认 `direct` 或 `single-loop`，Multi-Agent 调度留给 M4 |
| 每次纠错后自动写 Memory | 否决；未经评审的经验容易陈旧或冲突，可复用经验进入可评审 ImprovementCandidate |
| 仅靠 Prompt 实现 Gate 和 Evaluation | 对确定性条件予以否决；Prompt 可辅助语义评分，但不能替代 Schema、Script、Evidence 或 Approval |

## 6. 实施工作区

实现采用 TypeScript/Node.js workspace：

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

公共 npm package 为 `universal-harness`，提供 `harness` binary。内部 workspace package 保持 private，并使用 `@universal-harness-internal/*` 命名，直到单独设计公共 package 拆分。

## 7. 受管项目布局

`harness new` 创建、`harness adopt` 添加以下由项目拥有的控制平面：

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

Artifact、已接受 Edge、Operation Manifest、已脱敏结构化 Event、Checkpoint、Pack、Policy、View、Manifest 和 lockfile 提交到 Git。`.harness/.gitignore` 排除 `cache/`、`staging/`、`raw-traces/` 和生成的 Provider Mirror。生成 Mirror 可由 Canonical Pack、Graph Node 和 ContextBundle 复现；未经预览和批准，不得覆盖现有 Provider 配置。接管项目时无需修改其根 `.gitignore`。

## 8. Git-native Graph Ledger

### 8.1 权威数据

- Git 中的结构化 Artifact、已接受 Edge 和已提交 Event 是权威数据。
- SQLite 是可丢弃的物化查询 View。
- Markdown 是人类可读 Projection，不是独立关系存储。
- 人类叙述存储在 Artifact Field 或 Extension File 中，使重新生成不会静默丢失内容。
- Checkpoint Node 保存恢复所需、已提交的结构化 WorkingState；Provider Chat History 和 Raw Trace 永远不是权威 Task State。

### 8.2 Core Node

| 类别 | Node |
|---|---|
| Container | Project、Repository、Iteration |
| Intent | Intent、Requirement、Constraint |
| Design | Decision、Component |
| Delivery | ExecutionPlan、Task、CodeArtifact |
| Control | Policy、ToolDefinition |
| Verification | Test、EvaluationCase、Gate |
| Runtime | ContextBundle、Run、Checkpoint、Evidence、Approval |
| Feedback | Finding、RootCauseAnalysis、ImprovementCandidate、ImpactSet |

M1 每个 Project 只创建一个 Repository，但 Identity 带 `repository_id`，使 M3 可以在不改变 Locator 的情况下增加 Repository。Policy Node 物化 Canonical Policy File；ToolDefinition Node 物化已注册 Provider Manifest。领域概念作为 Pack Extension，不能重新定义 Core Node 语义。

### 8.3 Core Relation 与方向

| Family | Relation |
|---|---|
| Provenance | 新 Artifact `DERIVES_FROM` 旧 Artifact；新 Node `SUPERSEDES` 旧 Node；Artifact `GENERATED_BY` Run |
| Intent and implementation | Intent `DECOMPOSES_TO` Requirement；Decision `ADDRESSES` Requirement；受控 Node `CONSTRAINED_BY` Constraint 且 `GOVERNED_BY` Policy；Decision `SHAPES` Component；CodeArtifact `REALIZES` Component；Task `IMPLEMENTS` Requirement/Decision |
| Verification | Test `VERIFIES` Requirement/Constraint；EvaluationCase `EVALUATES` Task/Run；Run `EXECUTES` Task/Gate/EvaluationCase 且 `INVOKES` ToolDefinition；Run `PRODUCES` Evidence；Evidence `SUPPORTS`/`REFUTES` Test/Requirement/EvaluationCase；Finding `VIOLATES` Requirement/Constraint/Policy |
| Control | ExecutionPlan `CONTAINS` Task；Task `DEPENDS_ON` Task；Run `USES_CONTEXT` ContextBundle；Checkpoint `CAPTURES` Run/Iteration；Finding `BLOCKS` Task/Iteration；Approval `APPROVES` 受控 Node；Project/Repository/Iteration `CONTAINS` 子 Node |
| Feedback | Finding `DIAGNOSED_BY` RootCauseAnalysis；RootCauseAnalysis `PRODUCES` ImprovementCandidate；ImprovementCandidate `PROPOSES_CHANGE_TO` 任意可版本化 Requirement/Constraint/Decision/Component/ExecutionPlan/Task/CodeArtifact/Policy/ToolDefinition/Test/EvaluationCase/Gate；Finding/ImprovementCandidate `TRIGGERS` ImpactSet |

Schema Registry 为每种 Relation 定义有效 source type、target type、传播方向、默认 risk 以及是否允许 inference。

### 8.4 Identity 与 Provenance

每个 Node 和 Edge 包含：

- `id`、`type`、`revision` 和 `status`
- `source`：human、scanner、agent、workflow、tool、gate、evaluation、audit 或 migration
- `provenance`：iteration、run、actor 和 timestamp
- `confidence`：显式关系为 `1.0`，推断关系为 `0..1`
- `digest`：规范化内容摘要
- `locator`：带 `repository_id` 与相对路径的 repository-qualified URI，可进一步限定到 symbol、API 或 migration
- `extensions`：带命名空间的扩展字段

人类创建的 Node 使用带 type prefix 的 ULID；扫描 Node 使用 `UUIDv5(project_id, repository_id + type + canonical_locator)` 生成确定性 Identity。Rename 使用 Git rename 信息或内容摘要。Identity 不确定时，Scanner 创建新 Node 并以 `SUPERSEDES` 连接，而不复用不确定 ID。

### 8.5 Mutation Rule

- 权威非 Runtime Node 使用 Revision；每个 Revision 发出 Event。
- ContextBundle、Run、Checkpoint、Evidence 和 Approval 只追加。
- 删除产生 Tombstone。
- Agent 推断 Edge 初始为 `proposed`，需批准或通过确定性校验后才成为 `accepted`。
- ContextBundle Node 保存 source reference、priority、revision、freshness、exclusion、token allocation 和 digest。Policy 将内容判定为敏感时，组装后的原始 Context 可只保留在本地。
- 下游 Phase 不得直接修改上游 Artifact；它创建 Finding，由 Workflow Engine 创建归属上游 Phase 的 Revision Task。
- ImprovementCandidate 初始为 `proposed`；Promotion 需要批准，并创建目标 Artifact、Pack、Policy、Tool Manifest、Test 或 EvaluationCase 的正常 Revision。

### 8.6 逻辑 Graph View

两个 View 是查询与 Policy Boundary，不是独立数据库：

```text
Artifact Graph
Intent → Requirement → Decision → Component → CodeArtifact → Test → Evidence
                                     ↑                            │
                                     └──── approved feedback ─────┘

Execution Graph
ExecutionPlan → Task → ContextBundle → Run → Gate/EvaluationCase → Evidence
                    ↘ Approval/Checkpoint          ↘ Finding → RCA → ImprovementCandidate
```

- Artifact Graph Node 是长期存在、带 Revision 的工程知识。
- Execution Graph Node 限定于一个 Iteration，保存编排、Budget、Tool Activity Summary、Approval、Failure 和 Recovery Point。
- 不得仅为了让 Graph 更详细而拆分 Task。若合并两个 Task 不会损失独立输出、Capability Boundary、Failure Boundary 或 Dependency，Planner 必须合并。
- 确定性 Edge 驱动路由。Model 推断关系可以丰富 Context 或创建 `inspect` Impact Candidate，但不能单独授权 Route、Write 或 Release。

### 8.7 Knowledge Layer 与健康度

M1 不创建平行 Knowledge Store。现有 Node 具有用于 Context Selection 和 Audit 的 `knowledge_layer` 分类。Schema 提供下列 Node Type 默认值；Pack 只有在显式且校验通过时才能覆盖：

| Layer | 常见 Graph Ledger 表示 |
|---|---|
| L1 principles | Constraint 和 Policy |
| L2 architecture | Decision 和 Component |
| L3 standards | Pack 提供的 Policy、Constraint、ToolDefinition 和 Gate |
| L4 implementation | CodeArtifact、Test 和生成示例 |
| L5 experience | Finding、Evidence、RootCauseAnalysis 和已批准 ImprovementCandidate 的结果 |

`harness audit` 检查 traceability coverage、stale knowledge、互相冲突的已接受 Constraint、orphan Node、missing verification、未提升的高风险 Improvement 和 ContextBundle source health。Audit Finding 进入与 Test/Review Failure 相同的 Finding/ImpactSet 流程。

## 9. 影响分析

影响分析不会重写所有下游文档：

1. 从变化的 Node Digest、Git Diff Mapping、Finding、RootCauseAnalysis 或 ImprovementCandidate 开始。
2. 只遍历 Active Policy 允许的 Relation Type、Direction 和 Depth。
3. 使用 Path、Risk、Confidence、Revision 和 Evidence Freshness 对 Candidate 评分。
4. 将 Candidate 分类为 `must-change`、`inspect` 或 `informational`。
5. 在 ImpactSet 中记录 Path、Reason 和 Confidence。
6. Approval 后冻结 ImpactSet，并从中生成声明式 ExecutionPlan。

失败传播示例：

```text
Evidence REFUTES Test
→ Test VERIFIES Requirement
→ inverse traversal of Decision ADDRESSES Requirement
→ Decision SHAPES Component
→ inverse traversal of CodeArtifact REALIZES Component
→ related tasks and code enter the ImpactSet
```

Security 或 Compliance Failure 默认为 `must-change`。低 Confidence 推断 Edge 只能产生 `inspect`。Projection Drift 触发重新生成，但不修改 Definition Node。基于 Type、Risk、Confidence、Status、Freshness 或 Gate Result 的路由 Predicate 必须是确定性代码；Model 可以提出语义分类，但不能自行选择特权 Route。

### 9.1 Feedback Cascade

Test、Review、Audit、Runtime 和 Evaluation Failure 共享同一反馈协议：

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

## 10. Iteration 与 Git 生命周期

Iteration 是一个类型为 feature、bugfix、refactor、security 或 maintenance 的可审计变更集，可以包含多个 Requirement 和 Task。

每个 Iteration：

- 绑定一个 baseline commit；
- 按默认 `harness/<iteration-id>-<slug>` 约定创建专属 Branch；
- 可选创建 Worktree；
- 记录 final commit 和 merge target。

状态机：

```text
draft → planned → running → verifying → completed
  └──────────────→ blocked
  └──────────────→ aborted
```

`blocked` Resume 到之前的 Phase；`aborted` 为终态，并保留 History、Branch 和用户文件。

### 10.1 执行模式与声明式 Plan

每个已批准 ImpactSet 编译为一个 ExecutionPlan：

| Mode | 选择规则 | M1 行为 |
|---|---|---|
| `direct` | 全部工作均为确定性，不需要 Agent 语义动作 | Workflow Engine 直接调用已注册 Tool 和 Gate |
| `single-loop` | 一个受限目标只有一个独立可评审输出 | 一个 Task 通过一个 AgentAdapter 或 Manual Adapter 运行 |
| `dag` | 两个或更多 Task 具有独立输出、Capability Boundary、Failure Isolation 或 Dependency | Task 按依赖顺序逐个通过一个 Adapter 运行；M4 可并行化合格 Task |

Planner 输出声明式 Task Specification：objective、expected output、dependency、capability、risk、budget、acceptance criteria 和 required gate，不输出特权 Shell 命令或直接 Tool Invocation。Workflow Engine 在执行前校验、合并、拒绝、重排或暂停 Plan。

### 10.2 WorkingState 与 Context 生命周期

Workflow Engine 是权威 WorkingState 的唯一 Writer。Agent 获得受限 View 并返回 Proposal。每个已提交 Checkpoint 包含：

- 不可变 Goal 和已批准 Requirement Baseline；
- 当前 Phase、Task 和上一 Checkpoint；
- 带 Evidence Reference 的 confirmed fact；
- rejected hypothesis 及其 Evidence；
- open question、blocker 和 next action；
- completed/pending Task ID；
- 当前 Budget 使用和 Termination Ceiling；
- Active Capability Grant 和 Approval Digest；
- ContextBundle 与 Input Digest；
- External Action Intent 及其完成状态。

Provider Chat History 是可选输入，不是 State。Context 编译在显式 Token Budget 下选择、排序、压缩和截断 Source。Goal、Acceptance Criteria、Safety Constraint、Active Approval 和 unresolved blocker 等受保护内容不得被压缩移除。Source Digest 过期时，下一 Loop Step 前使 ContextBundle 失效。

### 10.3 Snapshot 内容

每个终止或暂停 Iteration 都可生成状态为 `completed`、`blocked` 或 `aborted` 的 Snapshot。Completed Snapshot 包含 final commit、已接受 Artifact Revision、ExecutionPlan、Adapter Control Profile、Run Outcome、已脱敏 Trajectory/Coverage Summary、Budget/Latency Summary、Approval、当前 Evidence、已关闭 Finding、未解决非阻塞项、rejected hypothesis 以及 proposed/promoted ImprovementCandidate。所有 Required Task 必须为 `success`；blocking Finding、stale Mandatory Evidence、未完成 External Action 或 Required Run 非成功都会阻止 `completed`，但仍可生成诊断性 `blocked` 或 `aborted` Snapshot。

## 11. 命令面

### 11.1 编排入口命令

| Command | 完整行为 |
|---|---|
| `harness new <name> --intent <text>` | 创建项目与 Git 仓库，初始化 Ledger 和 Pack，然后录入、规划、编译 Context、执行、验证、评估、修复并生成 Snapshot |
| `harness adopt [path] --intent <text>` | 扫描并批准 Baseline，然后录入、分析、规划、编译 Context、执行、验证、评估、修复并生成 Snapshot |
| `harness iterate <text>` | 为后续变更运行相同完整闭环 |
| `harness resume <operation-id>` | 从最后已提交 Checkpoint 恢复暂停编排 |

### 11.2 高级命令

| Command | 用途 |
|---|---|
| `harness impact [target]` | 生成或检查 ImpactSet |
| `harness plan` | 从已批准 ImpactSet 生成或检查声明式 ExecutionPlan |
| `harness run` | 通过 Adapter 执行已规划 Task，支持 dry-run 和 resume |
| `harness verify` | 运行三层 Gate 并生成 Evidence/Finding |
| `harness eval` | 评估 Task Outcome、Safety、Trajectory、Efficiency 和 Correct Failure |
| `harness approve <id>` | 批准 Baseline、Decision、ImpactSet、ImprovementCandidate Promotion 或 Risky Action |
| `harness snapshot` | 完成 Artifact、Evidence、Commit 和 Iteration Summary |
| `harness status` | 显示 State、Adapter Control Level、Evaluation Coverage、Blocker、Stale Evidence、Approval 和 Next Action |
| `harness doctor` | 诊断 Environment、Plugin、Git、Schema 和 Cache 问题 |
| `harness audit` | 诊断 Traceability、Knowledge Freshness、Graph Health、Gate Coverage 和 Unpromoted Risk |
| `harness graph sync/query/check` | 同步、查询和校验 Graph |

高级命令用于检查、自动化和恢复；正常使用集中在 new、adopt、iterate、resume 和 status。

## 12. 主流程

### 12.1 新建项目

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

### 12.2 接管现有项目

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

Baseline 批准前，Authority Ledger 不变。被拒 Staging Data 可继续用于修订或显式丢弃。

### 12.3 后续 Iteration

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

## 13. Plugin Contract

### 13.1 StackAdapter

- 检测技术栈并返回 Confidence。
- 扫描 CodeArtifact、Test 和确定性 Relation。
- 提供默认 Pack、Gate 和 Projection。
- M1 包含 Generic、Node、Python 和 Java Pack。

### 13.2 AgentAdapter

- 声明 Capability、Limit、Usage Metering、Provider Configuration 和 Resume Support。
- 每次接收一个 Task Envelope。
- 返回结构化 Run Result、State Proposal、Change Summary、Tool Activity Summary、Usage、Termination Reason 和 Evidence Locator。
- M1 包含 Manual Adapter，以及带常见 Coding Agent Provider Manifest 的通用 Command Adapter。

每个 Adapter 声明一个 Control Profile：

| Control level | Harness 控制 | 适用性 |
|---|---|---|
| `managed` | Harness 拥有 Model Turn、Tool Dispatch、Policy Check、Metering 和完整 Trajectory | 全部 Policy Requirement 通过时可无人值守 |
| `delegated` | Harness 治理外层 Provider Command、Worktree、Input、Timeout、Result 和 Provider 暴露的结构化 Telemetry；Provider 拥有内部 Loop | Manifest 证明必要 Metering、Interception 和 Trajectory Coverage 前只能监督运行 |
| `manual` | 人工执行 Task 并附加 Evidence | 永不无人值守；除 Harness 运行 Tool 外，Budget 仅供参考 |

Manifest 分别声明 `trajectory_visibility`（`full`、`summarized` 或 `external-only`）、`usage_metering`、`side_effect_interception` 和 `resume_semantics`。Harness 不会将 Opaque Provider 的内部 Tool 报告为已治理。需要完整 Trajectory Evidence、硬 Token Enforcement 或 Side-effect Interception 的 Policy 会拒绝不能提供相应能力的 Adapter。

Task Envelope 是可执行 NodeContract，包含：

- task、plan、iteration、repository 和 baseline ID；
- objective、expected output、acceptance criteria、dependency 和 required gate；
- input node revision、ContextBundle ID/digest 和 protected context field；
- allowed read path、proposed write path、state read field 和 state proposal field；
- 带 parameter/resource 限制的命名 Tool Registry Capability；
- risk、required approval、external side-effect policy 和 idempotency scope；
- LoopPolicy、baseline commit、input digest 和 stale-input behavior。

Agent 永远不会获得修改 WorkingState 或 Authority Ledger 的一般权限。它返回类型化 Proposal，由 Workflow Engine 校验并提交已接受变更。自动 AgentAdapter 必须报告 Usage 或强制 Harness 提供的 Token Ceiling。无法强制计量或拦截的 delegated Adapter 只能监督运行，不得无人值守。

### 13.3 LoopPolicy 与 Run Outcome

LoopPolicy 包含：

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

这些数值是 M1 Generic Pack 默认值，不是全局常量。Pack 或已批准 Project Policy 可无需额外批准而降低它们；提高 Ceiling 需要 Policy Authorization，受 Installation-level Maximum 约束，并将生效 Policy Digest 记录在 Run 中。

Loop Controller 对 Tool Name、规范化 Parameter、Target Resource 和相关 State Digest 生成指纹。Call 重复且 State/Evidence 没有进展时终止 Loop。Model 不能提高自己的 Limit 或关闭 Repeat Detection。

每个终止 Run 以一个 Outcome 结束：`success`、`correct_block`、`clarification_required`、`handoff`、`partial` 或 `failed`。`termination_reason` 单独记录 completion、gate failure、policy denial、budget ceiling、repeat detection、timeout、adapter failure、user cancellation 或 manual stop。Model Completion Signal 只能使 Run 进入 `verifying`；只有当前 Mandatory Evidence 能产生终态 `success`。

### 13.4 ContextBundle Contract

Context Compiler 按以下优先级组装 Bundle：

1. 不可变 Goal、已批准 Acceptance Criteria、Hard Constraint 和 Active Approval；
2. 当前 Task、ImpactSet Path、WorkingState、Blocker 和 Required Gate；
3. 受影响 Architecture、Specification、Component、Code 和 Test 邻域；
4. 适用 Pack Rule、Project Standard、Example 和已批准 L5 Experience；
5. 为保持连续性所需的压缩历史 Observation。

每个 Source Entry 记录 Node ID、Revision、Digest、Knowledge Layer、选择原因、Priority、Freshness、原始大小、包含大小和 Compression Method。Bundle 记录被排除 Source 及原因。按 Role 或 Task 的 Budget 决定每层分配。压缩不得移除 Protected Field。ContextBundle 不可变；Source Digest 改变后必须重新编译。

### 13.5 ToolProvider 与 Tool Registry

任何可执行命令、Script、MCP Capability 和 External API 在使用前都必须注册。ToolProvider 声明：

- 稳定 Name、Version、Description 和 Input/Output JSON Schema；
- Allowed Phase、Resource Pattern 和 Parameter Constraint；
- Risk、Side-effect Class、Approval Policy 和 Redaction Policy；
- Timeout、Retry Class、Concurrency/Rate Limit 和 Cost Metadata；
- Idempotency Support 及 Uncertain Result Reconciliation Behavior。

Invocation 强制经过三个阶段：

1. **Before**：校验 Registration、Schema、Task Relevance、Phase Grant、Resource Scope、Risk、Approval、Quota 和 Idempotency Key。
2. **During**：应用 Timeout 和 Quota；捕获规范化 Progress；将实现错误转换为结构化 Tool Error。
3. **After**：校验 Output Schema、脱敏敏感 Field、记录 Evidence/Usage、对账 Side Effect，并应用受限 Retry 或 Downgrade Policy。

外部副作用发生前，Workflow Engine 提交 Action Intent，其中包含 Tool、Normalized Request Digest、Target Resource、Approval 和 Idempotency Key；之后提交 Completed 或 Uncertain Result。Resume 在重试前对账 Action Intent，永远不能假设 Timeout 表示外部动作没有发生。

对于 delegated AgentAdapter，Provider Process 本身是 ToolDefinition。只有 Provider 暴露 Manifest 声明的可强制 Callback 或 Structured Event 时，内部 Tool 才受治理；否则外层 Command 保持监督运行，前后 Repository Inspection 仅提供 Evidence，不能被描述为 OS Containment Boundary。

### 13.6 GateProvider

GateProvider 执行 Test、Lint、Build、Security 和 Project-specific Command，将 Exit Code、Structured Result、Log Summary 和 Artifact Hash 规范化为 Evidence 与 Finding，不负责决定 Policy 是否允许发布。

Gate 分为三层：

1. Universal Integrity、Approval 和 Audit Gate。
2. Stack Profile Gate。
3. Project-specific Gate。

### 13.7 VCS 与 Projection

- M1 只实现 Git VcsAdapter。
- Markdown ProjectionProvider 渲染 PRD、Architecture、Specification 和 Plan View。
- 每个 Projection 都携带 Source Node ID、Revision 和 Generation Digest。
- Provider Instruction Projection 从 Canonical Pack、Task Envelope 和 ContextBundle 生成。Provider-specific File 是 Mirror，不是 Source of Truth；除非用户批准与现有 Provider Directory 集成的 Preview，否则只写入受管位置。

### 13.8 Lifecycle Event

Kernel 为 `OperationStarted`、`PlanAccepted`、`BeforeContextCompile`、`ContextCompiled`、`BeforeToolCall`、`AfterToolCall`、`ApprovalRequired`、`CheckpointCommitted`、`GateCompleted`、`EvaluationCompleted`、`FindingCreated` 和 `OperationCompleted` 发出有序、版本化 Event。Payload 包含 Identifier 和已脱敏结构化数据，不包含 Secret 或原始 Provider Transcript。

M1 在内部使用这些 Event，并通过 EventStreamPort 暴露。公共 Hook SDK、第三方 Ordering、Conflict Resolution、Rollback Semantics 和 Destructive Hook Policy 需要独立 M2 设计。

## 14. Approval 与安全

- Requirement Baseline、Architecture Decision、ImpactSet、ImprovementCandidate Promotion、Destructive Operation、External Write 和 Release 默认需要批准。
- 在已批准 Task Envelope 内，常规 Implementation 和 Verification 可自动继续。
- Approval 绑定 Object Digest、Impact Path、Risk 和 Baseline Commit；任一绑定项变化都会使其失效。
- Mandatory Gate 不能通过 `--force` 绕过。
- Harness 仅授权并提交已声明 Path、State Proposal Field、Registered Capability、Parameter Bound、Resource Scope、Phase、Budget 和 Approval。
- Tool Description、Retrieved Document、Repository Content 和 Provider Output 都是不可信 Context，不能授予 Capability 或改变 Policy。
- Agent 不能批准自己的 Proposal、接受自己的 Evidence、提升自己的 ImprovementCandidate，或将自己的语义判断归类为 Mandatory Pass。
- Secret 来自 Environment 或 Secret Provider，永不进入 Ledger File、Event、Projection 或 Log。
- Evidence 提交前结构化脱敏；不安全 Raw Log 保持本地，只通过 Locator 和 Hash 引用。
- Pack 安装与升级校验 Content Digest 并显示 Provenance。

Plugin 在最小化 Environment 和声明 Host Capability 的子进程中执行。M1 不声称 Subprocess Isolation、Worktree 或 Pre/Post Diff Inspection 是 OS Security Sandbox。第三方和 Delegated Provider Binary 被视为 Trusted Code，新增 Command Adapter Command 需要显式批准。

## 15. 原子性、错误与恢复

### 15.1 逻辑事务

- Write 在 `.harness/staging/<operation-id>/` 中准备。
- Commit 前校验 Schema、Reference、Policy 和 Baseline Revision。
- 先原子 rename Target File，再原子写最终 `ledger/operations/<operation-id>.json` Commit Manifest。
- Materialization 只读取具有有效 Manifest 且 File Digest 匹配的 Operation。
- Event 每个 Operation 使用单独 JSONL File，不并发追加到一个共享 File。
- Operation ID 使 Retry 幂等。
- M1 使用一个 Project-level Write Lock，同时允许并发 Read Query。

### 15.2 Error Policy

| Error | 默认处理 |
|---|---|
| Schema Violation、Dangling Edge、Invalid Relation 或 Task Cycle | 拒绝 Commit、保留 Staging 并报告精确位置 |
| 缺少 Environment 或 Plugin | 将 Iteration 标记为 blocked，并提供 Doctor 指引 |
| Agent Timeout 或 Crash | 保留 Run 和 Partial Output；Resume 或切换人工执行 |
| Step、Token、Duration 或 Repeat-action Ceiling | 停止 Loop，持久化结构化 Outcome 和 Checkpoint，然后 Block、Handoff 或返回 Policy 允许的 Partial Result |
| Unknown Tool、Invalid Parameter、Capability Violation 或 Invalid Tool Output | 权威变更前拒绝，追加已脱敏 Trace Event，只应用声明的 Retry/Handoff Policy |
| External Action Result 不确定 | 保留 Action Intent，阻止盲目 Retry，通过 ToolProvider 或人工评审对账 |
| Gate 或 Evaluation 失败 | 创建 Finding 和临时 ImpactSet，安排 RCA，RCA 后刷新 Impact，只重跑受影响 Task、Gate 和 EvaluationCase |
| Context Source 过期 | 使 ContextBundle 失效、Checkpoint、重新编译 Context 并重新评估受影响 Approval Binding |
| Git Baseline Drift | 暂停并重新计算 Diff、Impact 和 Approval |
| Policy Conflict | 阻塞直到 Policy 变化或获得显式 Approval |
| SQLite 损坏 | 删除 Cache，并从 Git Ledger 重建 |

### 15.3 Checkpoint 与 Evidence Freshness

- 每个 Phase Boundary、Task Completion/Failure、Approval Boundary 和 External Side-effect Boundary 都记录 Checkpoint。单个 Model Turn 追加 Trace Event，但除非 Policy 要求，不必创建 Git Checkpoint。
- Checkpoint 通过一个可信 Workflow Engine Writer 序列化 WorkingState。Adapter-local State 永远不是独立 Authority。
- Evidence 绑定适用 Artifact、Code、ContextBundle、Gate、EvaluationCase 和 Policy Digest。
- 任一 Input 变化使 Evidence 变为 Stale。
- Stale Evidence 不能关闭当前 Finding 或满足 Final Snapshot。
- Resume 从最新有效 Checkpoint 开始，校验 Repository/ContextBundle Digest，对账未完成 External Action Intent，然后继续，且不重放已完成 Task 或 Side Effect。

## 16. 测试策略

- **Unit Test**：Schema、State Machine、Graph View、Graph Traversal、ImpactSet、ExecutionPlan、ContextBundle、WorkingState、LoopPolicy、Tool Registry、Scorer、Policy 和 Approval Invalidation。
- **Property Test**：随机 Graph Determinism、Dangling-edge Prevention、Cycle Detection、Task-merge Invariant、Context Budget Preservation、Repeat Fingerprint 和 Idempotency。
- **Contract Test**：每个 Plugin 通过共享 Conformance Kit。
- **Integration Test**：临时 Git Repository、Branch、Checkpoint、SQLite Rebuild、Ledger Commit 和 Projection。
- **E2E Test**：Node、Python、Java Fixture 运行 new/adopt/iterate Loop。
- **Fault Injection**：Process Interruption、Concurrent Write、Cache Damage、Git Drift、Expired Approval、Budget Exhaustion、Repeated Action、Uncertain External Result、Stale Context 和 Partial Gate Failure。
- **Security Test**：Path Traversal、Symlink Escape、Command Injection、Prompt-carried Capability Escalation、Unsafe Pack、Secret Redaction、Task Envelope Violation、Delegated-provider Capability Mismatch 和 Undeclared-write Detection。
- **Golden Test**：固定 Input 产生稳定 Graph View、ImpactSet、ExecutionPlan、ContextBundle Manifest、RCA Routing 和 Projection。

### 16.1 Agent Run Evaluation

Framework Verification 与 Agent Run Evaluation 相互独立：前者证明 Harness Code 行为正确，后者衡量受限 Agent 行为是否可靠。

| Dimension | Priority | 示例 |
|---|---|---|
| Outcome | P0 | 满足 Acceptance Criteria、创建 Required Artifact、重复场景持续成功 |
| Safety | P0 | Denied Action Rate、Risky Action Interception、Secret Leakage、Unauthorized Path/Capability Use |
| Trajectory | P1 | 有效 Tool/Parameter、遵循 Plan、使用 Evidence、无无效重复 |
| Correct failure | P1 | 信息缺失时 Clarification、Permission Denied 时 Block、Tool Failure 无法恢复时 Handoff |
| Efficiency | P2 | 每个已接受 Outcome 的 Step、Token、Duration、Retry、Tool Call 和 Cost |

Deterministic Scorer 评估 Schema、State Change、Tool Call、Path、Approval、Evidence 和 Termination。Semantic Scorer 可评估 Explanation 或 Strategy Quality，但必须返回 Reason 与 Confidence。每次 Evaluation 都报告 Coverage，包括 delegated Adapter 不可用的内部 Trajectory Field。Policy 可要求最低 Coverage。除非 Project Policy 显式添加已校准 Judge 和 Human Fallback，Semantic Score 不能满足 Mandatory M1 Gate。

Conformance Fixture 包含 Successful Execution、Insufficient Requirement、Denied Permission、Malformed Tool Parameter、Repeated Tool Call、Tool Failure、Budget Exhaustion、Stale Context、Gate Failure、Feedback Cascade 和 Uncertain External Action 后 Resume。CI 使用确定性 Fake Adapter 和 Replay Trace；可选 Live Adapter Suite 衡量重复运行稳定性，但网络访问不是发布前置条件。

### 16.2 性能基线

在 `ubuntu-latest` CI 生成的 20,000 Node、100,000 Edge Dataset 上：

- Warm-cache Impact Query p95 小于两秒；
- 完整 SQLite Rebuild 小于 30 秒；
- 相同 Input 产生相同 Node ID、Edge 和规范化 Digest。

任一指标超限都会阻止 M1 发布。

## 17. M1 验收标准

1. 一次 `harness new ... --intent ...` 调用可以完成首次 Iteration，只在强制 Input、Approval 或 External Authorization 时暂停。
2. 一次 `harness adopt ... --intent ...` 调用可以批准 Baseline，并按相同暂停规则完成所请求 Iteration。
3. `harness iterate ...` 为后续变更运行相同完整闭环。
4. 非交互暂停返回可恢复 Operation ID；Resume 不产生重复 Node、Run、Evidence、Commit 或 External Side Effect。
5. 相同 Repository 和 Configuration 产生相同、带 Repository 限定的扫描 Node ID、Edge 和 Digest。
6. Artifact Graph 与 Execution Graph Query 从同一 Authority Ledger 物化，并保持相互可追溯。
7. 已知 Change Scenario 生成正确 ImpactSet，不把无关 Artifact 分类为 `must-change`。
8. Planning 只从已批准 ImpactSet 开始，生成声明式 Task Specification，并拒绝 Plan Proposal 中嵌入的 Command 或未授权 Capability Expansion。
9. 简单 Fixture 选择 `direct` 或 `single-loop`；`dag` Fixture 只在每个 Task 满足独立价值规则时创建多个 Task。
10. 每个 Task 获得不可变 ContextBundle、Field-level State Contract、Capability Grant、LoopPolicy、Acceptance Criteria 和 Input Digest；Approval 前可见 Adapter Control Profile。
11. Context Compilation 保留 Protected Field、遵循 Token Allocation、记录 Exclusion，并使 Stale Bundle 失效。
12. Unknown Harness-managed Tool、Invalid Parameter、Disallowed Resource、Capability Violation 和 Invalid Output 在权威变更前被阻止并留痕；Opaque Delegated Provider 永远不会被描述为完全受治理。
13. External Action Intent 持久且幂等；Resume 对账 Uncertain Action，而不是盲目重放。
14. Managed Execution 无需依赖 Model 遵从即可强制 Step、Token、Duration、Retry 和 Repeat-action Ceiling；缺少等价控制的 Delegated Adapter 被强制设为 Supervised Mode。
15. 每个 Run 记录一个已定义 Outcome 和 Termination Reason；Correct-block、Clarification 和 Handoff Fixture 通过。
16. Mandatory Gate 或 Mandatory Evaluation Threshold 失败会创建 Finding 并阻止 Completed Snapshot。
17. 失败场景生成结构化 RCA 和 ImpactSet Routing；下游 Phase 不能直接修改上游 Artifact。
18. 可复用失败可以产生 Evaluation、Knowledge 或 Engineering ImprovementCandidate；未经批准不得 Promotion。
19. 当前 Repair Evidence 可以关闭 Finding；Stale Evidence 不可以。
20. Artifact、Code、Context Source、Gate、Evaluation 或 Policy 变化会按适用范围使绑定 Approval、ContextBundle 和 Evidence 失效。
21. Completed Snapshot 包含 Final Commit、Plan、Adapter Control Profile、Outcome、Trajectory/Coverage Summary、Budget Use、Approval、Current Evidence、未解决非阻塞项和 Improvement Status。
22. SQLite 被删除或损坏后可从 Git Ledger 恢复。
23. Manual/Command AgentAdapter 通过 Contract、Control-profile、Behavioral Evaluation 和 E2E Test；控制或可见性不足时始终阻止无人值守选择。
24. Generic、Node、Python 和 Java Pack 通过各自 Fixture。
25. Linux、macOS 和 Windows CI 通过。
26. Pack/CLI Upgrade 保留 Project Override，失败 Migration 回滚。
27. Performance Baseline 通过。
28. Repository Content、Package Metadata、Example、Fixture、Generated Provider Projection 和 Git History 保持独立，不包含原产品品牌、路径或业务领域示例。

## 18. M2–M4 兼容端口

M1 固化以下版本化 Interface：

- `GraphQueryPort`：分页 Node、Edge、Path、ImpactSet 和 Neighborhood。
- `EventStreamPort`：按 Project、Iteration 和 Sequence 读取 Event。
- `ExecutionGraphPort`：Plan、Run、Checkpoint、Outcome、Budget 和 Feedback Route。
- `ContextAssemblyPort`：Source Selection、Budget、Manifest、Digest 和 Freshness。
- `TaskDagPort`：Task、Dependency、State、Capability 和 Checkpoint。
- `ToolRegistryPort`：版本化 Tool Descriptor、Policy Input、Quota、Invocation Summary 和 Idempotency State。
- `EvaluationPort`：Case、Scorer Result、Trajectory Summary、RCA 和 ImprovementCandidate。
- `PolicyDecisionPort`：allow、deny 和 requires-approval Decision。
- `PluginCapabilityManifest`：Plugin Capability、Version 和 Resource Need。

M2 通过 GraphQueryPort、ExecutionGraphPort、EvaluationPort 和 EventStreamPort 读取。其 Public Hook SDK 如在独立设计中获批，可以消费 Lifecycle Event，但不拥有 Checkpoint Persistence。M3 同步版本化 Ledger Event，并可启用 Repository-qualified Execution，但不接管本地 Source File 所有权。M4 通过 TaskDagPort 和 PolicyDecisionPort 分配工作，不得绕过 Approval、直接修改 Shared State 或直接写 Ledger；允许并行读取，但接受写入仍集中处理。

## 19. 独立仓库规则

- 仓库从全新 `main` 历史开始。
- 不从其他产品仓库导入 Commit、Path、Generated Asset、Example 或 Documentation。
- 初始历史只包含本设计、Project README 和 Apache-2.0 License。
- Standalone Content Scan 通过后才创建 Public Repository。
- 本书面设计经过评审且详细实施计划获批后才开始实现。

## 20. M1 完成定义

只有满足以下条件，M1 才算完成：

- 第 17 节全部 Acceptance Criteria 通过；
- CLI、Plugin SDK、Pack 和 Migration Behavior 有可执行示例；
- new/adopt 在独立 Fixture 上完成验证；
- ContextBundle、LoopPolicy、Tool Registry、Correct-failure、Feedback-cascade 和 Idempotent-resume Fixture 通过；
- Design Decision、Limitation 和 Future Compatibility Port 已记录；
- 没有未解决 P0/P1 Defect、Schema Migration Gap 或 Approval Bypass；
- 分别用一个 new Command 和一个 adopt Command 演示完整纵向闭环。



RootCauseAnalysis 记录 observed symptom、Evidence、responsible layer、responsible module、root-cause category、confidence 和 proposed verification。确定性规则先分配已知 Failure Pattern；语义分析处理未分类情况；高风险或低 Confidence 结论需要人工评审。

经验可复用时，RCA 还会生成一个或多个 ImprovementCandidate：`target_kind` 为 `evaluation`、`knowledge` 或 `engineering`，`target_layer` 为 `prd`、`architecture`、`spec`、`plan`、`policy`、`tool`、`test` 或 `eval`。Candidate 在 Promotion 前必须可复现、有明确期望行为、标识代表性 Failure Class、不含未批准敏感数据并给出 Verification Method。

Target Layer 解析到权威 Graph Node，而不是直接编辑 Markdown：

| Target layer | Owning Node |
|---|---|
| `prd` | Intent 和 Requirement |
| `architecture` | Decision 和 Component |
| `spec` | Requirement、Constraint 和 Acceptance Test |
| `plan` | ExecutionPlan 和 Task |
| `policy` | Policy 和 Pack 提供的 Constraint |
| `tool` | ToolDefinition 及其 Provider Manifest |
| `test` | Test |
| `eval` | EvaluationCase 和 Scorer Policy |

Feedback Cascade 不会盲目重写所有下游 Artifact。ImpactSet 标识 `must-change`、`inspect` 和 `informational` Node；Workflow Engine 将每个必须 Revision 路由到 Owner Phase；Projection 从已接受 Graph Revision 重新生成；只重跑受影响 Task、Gate 和 EvaluationCase。
