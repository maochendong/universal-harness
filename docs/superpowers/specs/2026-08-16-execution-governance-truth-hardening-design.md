# 执行治理、真相投影与纵向闭环加固设计

日期：2026-08-16  
状态：待规格复核  
范围：Universal Harness M1.x/M2 加固；保持 Protocol 1.x 历史数据可读

## 1. 结论

本轮采用“集中式执行治理预检 + 分层真相投影”的设计，新增两个深模块：

- `ExecutionPreflight` 在任何 Agent 或确定性执行开始前，统一验证执行类型、影响覆盖、风险、Adapter Control Profile、Task-local ContextBundle、CapabilityGrant、批准绑定与预算可执行性。
- `OutcomeProjection` 保留 Adapter 的原始 Run 事实，并分别派生 TaskVerdict、IterationStatus 与提交引用，禁止在 Snapshot 或 CLI 中重写事实语义。

历史 Ledger、Plan、Run、ContextBundle 与 Snapshot 继续可回放。任何缺少新治理绑定的旧开放迭代，在再次执行前自动回退到治理预检，重建 Plan、Task-local ContextBundle、Grant 和 ExecutionAuthorization；已经完成的历史迭代只做兼容投影，不改写原记录。

该设计修复 Atlas MVP T8 dogfood 暴露出的全部问题，并补充修复核查中发现的多任务 ContextBundle 复用缺陷。

## 2. 背景与实证

Atlas MVP T8 的一次真实 delegated Agent 迭代暴露出以下不一致：

1. ExecutionPlan 标记为 `direct`，理由是“无需 Agent loop”，实际却运行了约十九分钟的 DSH Agent。
2. DSH 声明 `delegated + external-only + unmetered + no interception`，但 Plan、Run、Snapshot 与 status 没有完整展示控制画像和不可用预算维度。
3. Run 以 `handoff + completion` 终止，Evaluation 将其描述成“失败正确”，Snapshot 又把 Task/Run 改写成 `success`。
4. ImpactSet 只覆盖 Intent、Requirement 和 Test，实际修改三十个文件；Impact 批准风险为 medium，Task 风险却降为 low。
5. Task 只有一条 omnibus 验收条件，无法逐项绑定既有测试与 Evidence。
6. CapabilityGrant 在执行前未持久化，执行完成后 checkpoint 只出现一个裸 digest。
7. RunResult 的 `insertions/deletions` 为零，与 Git 实际统计不符。
8. 已批准事项在后续 WorkingState checkpoint 中仍以 blocker 字符串存在。
9. EventStream 持续产生 heartbeat，但长运行命令只显示 phase，形成约十九分钟的终端静默窗口。
10. 一个 Task 同时承担注入防护、RAG 边界、脱敏、限流、熔断、重试与 trace，缺少规模估计和 DAG 拆分。
11. 持久化 ContextBundle 只有 source digests，丢失来源定位、选择理由、排除项和预算明细。
12. 完成 Snapshot 未保存 Adapter Control Profile，完成后的 status 显示 `control_level: none`。
13. 人只批准了 RequirementBaseline 与 ImpactSet，最终 ExecutionPlan、路径范围、Grant 和 Adapter 风险没有统一的运行前授权。
14. CLI 的 `final_commit` 表示 Ledger 提交，而 Snapshot 的同名字段表示被验证的源码提交。
15. 多 Task 计划当前只为第一个 Task 编译 ContextBundle，后续 Task 复用同一 Bundle，违反 Task-local Context 约束。

这些不是彼此独立的字段错误，而是执行授权、运行事实与完成判定缺少统一边界造成的系统性问题。

## 3. 目标与非目标

### 3.1 目标

- `direct`、`single-loop`、`dag` 成为可执行的不变量，不只是描述性标签。
- delegated、不可计量、不可拦截或 external-only Adapter 只能在监督模式和明确批准下运行。
- 影响覆盖、路径范围和风险在 Impact、Plan、Run、Diff、Snapshot 之间单调不下降。
- 每个 Task 在执行前拥有独立、可追溯的 ContextBundle 和完整 CapabilityGrant。
- Run 原始事实、Task 验证结论与 Iteration 完成状态分别持久化和展示。
- 每条验收断言能够一对一映射 Test、Gate、Evidence 和 verdict。
- Snapshot 和 CLI 使用无歧义的提交引用。
- blocker、预算与活动 Run 状态均由当前权威记录投影，不用零值或过期字符串伪装。
- Protocol 1.x 历史数据保持可读；旧开放迭代不能绕过新治理规则继续执行。

### 3.2 非目标

- 不让 Harness 接管 delegated Provider 的内部 loop 或伪造其内部 trajectory。
- 不把语义相似度建议自动提升为已批准图事实。
- 不在本轮实现远程团队审批、分布式执行或远程 Ledger。
- 不通过估算填充不可观测的 token/step 使用量；不可观测必须明确记录为 unavailable。
- 不重写历史 Ledger、历史 Snapshot 或既有 Git commit。
- 不承诺从任意自然语言中确定性推导完整验收标准；缺少可验证断言时必须请求补充或阻断执行。

## 4. 核心不变量

1. **执行类型不变量**：`direct` 只能绑定 Harness 注册的确定性 Workflow Tool/Gate，不能调用 AgentAdapter。
2. **监督不变量**：不能证明 metering、interception、trajectory 与 resume 的 delegated Adapter 不得 unattended。
3. **授权先行不变量**：CapabilityGrant 和 ExecutionAuthorization 必须在 RunStarted 之前持久化并绑定。
4. **风险单调不变量**：下游 Task、Run 和 Diff 的有效风险不得低于任何上游风险来源。
5. **范围闭合不变量**：实际变更超出批准的 ImpactForecast 时，不得生成完成源码提交或完成 Snapshot。
6. **Task-local 不变量**：每个 Task 使用独立 ContextBundle、Grant、Envelope、预算观察和 checkpoint 状态。
7. **事实保留不变量**：Adapter 的 Run outcome 永不被 Snapshot、Evaluation 或 CLI 改写。
8. **证据判定不变量**：只有当前、非 provisional、通过的必要 Evidence 才能产生 `TaskVerdict: passed`。
9. **可用性不变量**：未知或不可计量的值显示为 `unavailable`，不得显示为零。
10. **历史兼容不变量**：兼容读取可以推导 legacy projection，但不能赋予旧记录新的执行权限。

## 5. 总体架构

```text
RequirementBaseline
        │
        ▼
Graph Sync ──► ImpactSet ──► ImpactCoverage + ImpactForecast
                                  │
                                  ▼
                            ExecutionPlan
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             Task A Context              Task B Context
                    │                           │
                    ▼                           ▼
             ExecutionPreflight ───────► effective risk
                    │
                    ▼
           ExecutionAuthorization
                    │
                    ▼
             CapabilityGrant Record
                    │
                    ▼
        Workflow Tool 或 AgentAdapter
                    │
                    ▼
        Git DiffStat + ScopeDriftAssessment
                    │
          ┌─────────┴─────────┐
          │ drift             │ current
          ▼                   ▼
   Impact/批准级联       Gate + Evaluation
                              │
                              ▼
                     OutcomeProjection
                  RunFact / TaskVerdict /
                    IterationStatus
                              │
                              ▼
                     IterationSnapshot
```

现有 orchestration 仍保持 `capture → impact → plan → context → execute → verify → evaluate → snapshot` 的外部相位顺序。`ExecutionPreflight` 是 execute 相位入口处的深模块，不新增公共相位；它可以返回批准请求、迁移要求、影响覆盖阻塞或可执行授权。

## 6. ExecutionBinding 与模式选择

### 6.1 执行绑定

组合根不再只注入一个无元数据的 `execute` 函数，而是注入结构化绑定：

```ts
interface ExecutionBinding {
  kind: "workflow" | "agent";
  name: string;
  deterministic: boolean;
  adapter_profile?: AgentProviderManifest;
  execute: OrchestrationExecutor;
}
```

- `workflow` 表示只调用 ToolRegistry/GateRegistry 中已注册的确定性操作。
- `agent` 表示调用 AgentAdapter，包括 managed、delegated 和 manual。
- 为兼容测试与旧 host，旧的裸 `execute` 注入在读取时适配为 `agent + delegated + unproven`，因此不能获得 `direct` 或 unattended 权限。

现有只返回零变更 attestation 的 `createDirectExecutor` 不再作为实现型 Task 的默认执行器。它由 `WorkflowExecutor` 取代：逐项调用 Plan 声明且已注册的确定性 Tool。Task 声明需要产出实现变更、却没有任何确定性 Tool 时，preflight 必须拒绝 direct，不能用“无需 Agent semantics”的自述完成任务。

### 6.2 ExecutionPlan

ExecutionPlan 增加：

```ts
interface ExecutionClassification {
  execution_kind: "workflow" | "agent";
  mode: "direct" | "single-loop" | "dag";
  mode_reason: string;
  sizing: {
    acceptance_assertions: number;
    expected_outputs: number;
    impact_entries: number;
    path_scope: "exact" | "bounded" | "broad";
    complexity: "small" | "medium" | "large";
  };
}
```

选择规则：

- `workflow + deterministic + one task` 才能选择 `direct`。
- 任意 `agent + one task` 至少为 `single-loop`。
- 两个及以上具有独立输出和验收切片的 Task 为 `dag`。
- 单 Requirement 含多个独立 Test/输出簇，或复杂度为 large 时，默认 planner 必须拆成顺序 DAG；无法证明独立价值时阻断并请求更清晰的任务边界。

Plan validator 再次检查分类与 Task 内容，不能信任 planner 自报的模式、风险或规模。

## 7. ImpactCoverage、路径预测与风险

### 7.1 影响覆盖

新增纯函数 `assessImpactCoverage`，输入为批准的 ImpactSet、当前图、Requirement/Test 集合和项目路径画像，输出：

```ts
interface ImpactCoverageAssessment {
  status: "complete" | "partial" | "unknown";
  covered_layers: readonly (
    | "intent"
    | "requirement"
    | "test"
    | "architecture"
    | "implementation"
    | "path"
  )[];
  missing_layers: readonly string[];
  forecast_paths: readonly PathForecast[];
  diagnostics: readonly string[];
  risk: RiskLevel;
  digest: string;
}
```

对 Agent 编码任务，至少要求 Requirement、Test 以及 implementation/path 中的一层可追溯覆盖。只有 Intent/Requirement/Test 的 ImpactSet 为 `partial`，不能进入 Agent 执行。

图同步负责把可定位源码/模块扫描为 Artifact/Component 节点。确定性结构传播不足时，语义检索只能产出 proposed edge；必须先批准边、重新生成 ImpactSet，再批准新的精确 digest。

### 7.2 路径预测

`ImpactForecast` 将已批准图节点的 locators、Task expected outputs 和项目配置的 write scope 归一化为：

```ts
interface PathForecast {
  pattern: string;
  source: "graph" | "task-output" | "project-scope";
  confidence: number;
  risk: RiskLevel;
}
```

精确文件、有限目录和仓库级 broad scope 分别提高不同风险。`**`、仓库根或无法映射的 scope 为 unknown/broad，delegated Agent 默认至少 high risk。

### 7.3 风险单调性

新增纯函数 `deriveEffectiveRisk`：

```text
effective_risk = max(
  baseline approval risk,
  maximum Impact entry risk,
  ImpactCoverage risk,
  Task complexity risk,
  path scope risk,
  Adapter opacity risk,
  actual Diff risk
)
```

TaskSpecification 中的 planner risk 只作为候选输入。validator 将其提升到 effective risk；任何下调请求均拒绝并记录诊断。

## 8. ExecutionPreflight 与运行前授权

### 8.1 深模块接口

```ts
interface ExecutionPreflightInput {
  plan: ExecutionPlanContent;
  tasks: readonly TaskSpecification[];
  impact: ImpactCoverageAssessment;
  contexts: ReadonlyMap<string, ContextBundleRecord>;
  execution: ExecutionBinding;
  policy: EffectivePolicy;
  approvals: readonly ApprovalDecisionRecord[];
  proposed_grants: ReadonlyMap<string, CapabilityGrantSpec>;
}

type ExecutionPreflightDecision =
  | { status: "authorized"; authorization: ExecutionAuthorization }
  | { status: "approval_required"; request: ApprovalRequestInput }
  | { status: "migration_required"; restart_phase: "plan" }
  | { status: "impact_incomplete"; restart_phase: "impact"; diagnostics: readonly string[] }
  | { status: "denied"; diagnostics: readonly string[] };
```

该接口在首个 Task 启动前一次性检查整个 Plan，并封装所有运行前治理规则；orchestrator 不再自行拼接零散 if/else。DAG 中每个 Task 仍有独立 Context 和 Grant，但人只批准一次精确的 Plan 级授权。执行到每个 Task 时只重验其绑定是否仍与该授权一致，不重复请求相同批准。

### 8.2 ExecutionAuthorization

授权对象绑定以下 digest：

- ExecutionPlan 与全部 Task；
- Approved ImpactSet 与 ImpactCoverage；
- 全部 Task-local ContextBundle；
- Effective Policy；
- Adapter Control Profile；
- 每个 Task 的 CapabilityGrantSpec；
- baseline/source commit；
- 路径预测、预算可用性与 effective risk。

授权规则：

- 所有 AgentAdapter 都需要 ExecutionAuthorization。
- delegated、manual、medium 及以上风险必须由人批准。
- 低风险、完全确定性的 direct workflow 可由 Policy 明确配置为自动批准，但仍追加可审计授权记录。
- 任一绑定漂移都会使授权失效。

DSH 的画像固定为 `delegated + external-only + unmetered + no interception + no resume`，只能以 supervised 模式运行。

批准决策落地后生成：

```ts
interface ExecutionAuthorizationRecord {
  record_kind: "execution_authorization";
  authorization_id: string;
  iteration_id: string;
  plan_digest: string;
  task_digests: readonly string[];
  impact_set_digest: string;
  impact_coverage_digest: string;
  context_bundle_digests: readonly string[];
  grant_spec_digests: readonly string[];
  policy_digest: string;
  adapter_profile_digest?: string;
  baseline_commit: string;
  effective_risk: RiskLevel;
  approval_digest: string;
  digest: string;
}
```

数组按稳定键排序后参与 digest。该记录是 Run 使用的最终授权证明；ApprovalDecision 只证明人对其预览 digest 做出了决定。

## 9. CapabilityGrant 持久化

CapabilityGrant 从运行时临时对象提升为一等 Ledger artifact。为避免 Authorization 与 Grant digest 循环引用，先对不含授权字段的权限规格计算稳定 digest：

```ts
interface CapabilityGrantSpec extends CapabilityGrant {
  plan_digest: string;
  context_bundle_digest: string;
  policy_digest: string;
  adapter_profile_digest?: string;
  baseline_commit: string;
  spec_digest: string;
}
```

ExecutionAuthorization 绑定 `spec_digest`；批准完成后再产生 Grant Record：

```ts
interface CapabilityGrantRecord {
  record_kind: "capability_grant";
  iteration_id: string;
  spec: CapabilityGrantSpec;
  authorization_digest: string;
  issued_at: string;
  digest: string;
}
```

顺序固定为：

1. 为全部 Task 构造并验证 GrantSpec，计算各自 spec digest。
2. 产生/解析一次 Plan 级 ExecutionAuthorization。
3. 提交全部完整 Grant Record artifact。
4. checkpoint 写入 Authorization digest 和 Grant Record digests。
5. RunStarted 同时绑定 Authorization、GrantSpec 与 Grant Record digest。
6. 调用 executor。

RunResult、Evaluation、TaskVerdict 与 Snapshot 都必须能够沿绑定追溯到完整 Grant。只存在 spec/record digest 而找不到记录，或 Record 的 Authorization 不匹配时，执行和完成均阻断。

## 10. Task-local ContextBundle

orchestrator 的单值 `bundle` 改为 `Map<task_id, ContextBundleRecord>`。context 相位按 DAG 稳定顺序为每个 Task 独立编译：

- Requirement、Test、Impact entry、Plan 和直接依赖 Task 输出作为候选；
- 来源记录 node id、revision、digest、knowledge layer、locator、选择理由和敏感性；
- 排除项记录 node id/locator 与明确原因；
- 记录 token budget、tier allocation、原始/包含 token、压缩方式；
- 完整 manifest 写入 `extensions["harness.context"]`，顶层 `source_digests` 保持兼容索引；
- Bundle bindings 加入 ImpactCoverage digest 与 Task digest。

execute 相位必须按 task id 加载对应 Bundle。缺失、错绑或复用其他 Task Bundle 时，ExecutionPreflight 返回 binding drift。

## 11. 原子验收与 Evidence 绑定

Task acceptance 规范扩展为：

```ts
interface TaskAcceptanceAssertion {
  assertion_id: string;
  description: string;
  test_ids: readonly string[];
  required_gate_ids: readonly string[];
  evidence_requirements: readonly string[];
}
```

规则：

- 每个批准 Test 至少被一个 assertion 引用。
- 一个 assertion 只表达一个可判定行为；显著连接多个独立行为的 planner 输出必须拆分。
- `verification: "mandatory gate suite passes"` 仅可作为 legacy 输入，不能单独证明功能行为。
- verify 生成一条 assertion 对应一条质量记录，包含布尔 verdict 和 Evidence ids。
- TaskVerdict 只有在所有 required assertion 与 mandatory gate 均通过时为 passed。

默认 planner 按 Requirement/Test/expected output 聚类生成 Task。缺少 Test 或可执行验证映射时，Plan 保持 proposed 并返回输入缺口，不启动 Agent。

验收图链固定为：`Run EXECUTES Task`、`Run PRODUCES Evidence`、`Evidence SUPPORTS Test`、`EvaluationCase EVALUATES Run/Task`、`Test VERIFIES Requirement`。Evaluation coverage 分别报告 Run、Task、Test/assertion 三个分母；完成迭代不得出现 Run 已评估但 Test/assertion coverage 为零的假全绿状态。

## 12. Run、Task 与 Iteration 的真相模型

### 12.1 三层事实

```ts
interface RunFact {
  run_id: string;
  outcome: AgentRunOutcome;
  termination_reason: AgentTerminationReason;
  completion_claimed: boolean;
}

interface TaskVerdict {
  task_id: string;
  run_ids: readonly string[];
  verdict: "passed" | "failed" | "blocked";
  assertion_verdicts: readonly AssertionVerdict[];
  gate_evidence_ids: readonly string[];
  evaluation_evidence_ids: readonly string[];
  digest: string;
}

type IterationStatus = "running" | "blocked" | "completed" | "aborted";
```

- RunTerminated 是 Adapter 边界事实，`handoff` 始终保持 `handoff`。
- Evaluation 评价 RunFact 的安全性、轨迹与资源表现，不将正常 handoff 描述为失败。
- TaskVerdict 是 Harness 对当前 Evidence 的验证结论。
- Iteration 只有在所有必需 TaskVerdict 为 passed 且图审计允许完成时为 completed。

### 12.2 Snapshot

新 Snapshot 分别保存：

- `run_outcomes`：只包含真实 Run id 与 Adapter outcome；
- `task_verdicts`：Task id、passed/failed/blocked 与 verdict digest；
- `iteration_status`；
- `adapter_control_profiles`；
- `grant_digests`；
- `budget_observations`；
- `source_commit`，并保留 `final_commit` 兼容别名。

旧 Snapshot 将 Task id 混在 `run_outcomes` 中。兼容 reader 可推导 `legacy_inferred` TaskVerdict，但不能把该推导作为新 Run 的授权或 Evidence。

### 12.3 Correct failure

correct-failure scorer 只在 EvaluationCase 明确期待 failure-class outcome 时计分。`handoff + completion` 的文案为“运行完成交接，等待/已通过 Harness 验证”，不得出现“run failed correctly”。

## 13. 提交引用

命令与查询投影统一使用：

```ts
interface CommitRefs {
  source_commit: string;
  ledger_commit: string;
  repository_head: string;
}
```

- `source_commit`：Gate、Evaluation 与 Snapshot 证明的源码树。
- `ledger_commit`：包含完成 Ledger、Snapshot 与投影的提交。
- `repository_head`：命令返回时仓库当前 HEAD。

Snapshot 自身只持久化 `source_commit`，并保留 `final_commit` 作为 deprecated compatibility alias。它不能内嵌包含自身的 Ledger commit，否则会形成提交自引用。`ledger_commit` 由完成 Ledger 写入的 VCS 返回值获得；历史查询通过定位首次包含该 Snapshot artifact 的 Git commit 确定。`repository_head` 在命令返回时读取。CLI 使用三个明确字段，不再把 Ledger commit 命名为 `final_commit`。

## 14. Git DiffStat 与范围漂移

新增 VCS 端口：

```ts
interface DiffStat {
  files_changed: number;
  insertions: number;
  deletions: number;
  binary_files: readonly string[];
  renames: readonly { from: string; to: string }[];
  paths: readonly string[];
  digest: string;
}
```

Git adapter 使用 NUL 分隔的 `--numstat`/`--name-status` 结果，避免空格、rename 和特殊字符解析错误。未跟踪文本文件按内容统计；二进制文件单独列出，不用零行伪装普通文本。

Agent 执行前后各做一次 repository inspection。运行结果的 change summary 由 Harness DiffStat 覆盖或校验，不能信任 Provider 自报。

`assessScopeDrift` 比较实际路径、ImpactForecast、Grant write paths 和规模风险：

- 未声明路径仍是 policy/adapter failure。
- 已在 Grant 内、但不在已批准 Forecast 内的路径为 `scope_drift`。
- 变更规模越过风险阈值也为 `scope_drift`。
- scope drift 生成 blocked Snapshot，回到 impact，重新同步图、分析、批准和计划；不得生成完成源码提交。

## 15. 预算与 Adapter Control Profile

预算不再用裸数字表达所有维度：

```ts
interface BudgetObservation {
  dimension: "steps" | "tokens" | "duration_ms";
  availability: "measured" | "estimated" | "unavailable";
  used: number | null;
  limit: number;
  enforcement: "harness" | "provider" | "none";
}
```

对 DSH：

- duration 为 measured，limit 由 Harness timeout 强制；
- tokens 为 unavailable，enforcement 为 none；
- steps 为 unavailable，enforcement 为 none。

Adapter Control Profile 在 ExecutionAuthorization、Run、Evaluation、status 和 Snapshot 中保持同一 digest。完成后 status 从最近完成 Snapshot/Run 投影 control level，不再无条件返回 `none`。

## 16. Blocker 生命周期

新增纯投影 `reconcileLiveBlockers`，以 ApprovalRequest/Decision、Finding 生命周期、TaskVerdict、Run terminal record 和恢复记录为输入，输出当前 blocker 集合。

- blocker 具有稳定 kind、subject id 和 digest；WorkingState 的字符串数组只作为兼容展示。
- 每次 checkpoint commit 前重新计算 live blockers，而不是只追加字符串。
- Approval approve/reject、request supersede、Task passed、Finding close/supersede 都有明确清除规则；defer 保持 pending blocker，直到产生终态决策或请求被 supersede。
- 历史 checkpoint 保持 append-only；后续 checkpoint 与 Snapshot 不再携带已经解决的 blocker。
- status 使用同一个 projector，不再维护独立的正则表达式修补逻辑。

## 17. 长运行 CLI 可观测性

现有 EventStream、live spool 和 `harness watch` 保留。orchestrator 将 ObservationPublisher 的事件同时送入 CLI side-channel projector：

- phase start/completion/pause；
- RunStarted；
- 每三十秒聚合一次 heartbeat 展示，底层五秒 heartbeat 不变；
- 最近 RunOutputSummary；
- BudgetUpdated，明确 availability；
- RunTerminated 与最终 DiffStat。

普通终端输出示例：

```text
execute task_x · dsh delegated/external-only · elapsed 06:30 · heartbeat 2s ago
tokens unavailable · steps unavailable · duration 390000/2700000ms
```

`--json` 的 stdout 仍只输出一个最终 CommandResult；实时进度写 stderr。`harness status` 增加可选 `active_run`，从 live spool 投影 run id、task id、phase、elapsed、last heartbeat、control profile 和预算可用性。live 数据不参与完成判定。

## 18. 历史兼容与迁移策略 A

### 18.1 历史完成数据

- 继续读取 Protocol 1.x Plan、ContextBundle、Run 和 Snapshot。
- Legacy reader 推导缺失的 execution kind、TaskVerdict、Control Profile 与 commit refs，并显式标记 `legacy_inferred: true`。
- 不改写旧 artifact，不追加伪造 Evidence，不改变历史完成状态。

### 18.2 旧开放迭代

在 execute 入口发现以下任一情况时返回 `migration_required`：

- Plan 缺少 execution kind 或与当前 ExecutionBinding 冲突；
- Task 没有原子 acceptance bindings；
- 缺少 Task-local ContextBundle manifest；
- 缺少完整 CapabilityGrant；
- 缺少有效 ExecutionAuthorization；
- Impact coverage 无法证明。

orchestrator 将下一恢复点回退到 plan 或 impact，追加迁移诊断，自动重建下游 artifact，并要求新的 ExecutionAuthorization。旧批准不会被静默复用到新 digest。

### 18.3 新项目与新迭代

所有新写入直接使用加固后的结构和严格规则，没有 warn-only 模式，也没有按项目关闭安全不变量的开关。

## 19. 失败与恢复语义

| 状态 | 原因 | 恢复点 |
| --- | --- | --- |
| `migration_required` | 旧开放迭代缺少治理绑定 | plan 或 impact |
| `impact_incomplete` | 图/路径覆盖不足 | impact |
| `approval_required` | ExecutionAuthorization 未批准 | execute preflight |
| `scope_drift` | 实际 diff 超出预测范围或风险升级 | impact |
| `grant_missing` | digest 无对应完整 Grant | execute preflight |
| `binding_drift` | Plan/Context/Grant/Policy/Approval digest 变化 | 对应上游相位 |
| `gate/evaluation failure` | 当前证据不允许 Task passed | execute 或 verify |

Agent 已产生但尚未批准的 worktree 变化保持可见，不自动删除。它们不能被源码提交或完成 Snapshot 接受，直到新的 Impact/Plan/Authorization 明确覆盖并重新通过 Gate。

## 20. 公共测试接缝

实现前固定以下可直接单元测试的公共接缝：

1. `selectExecutionMode(input: ModeSelectionInput & { executionKind })`
2. `assessImpactCoverage(input): ImpactCoverageAssessment`
3. `deriveEffectiveRisk(input): RiskLevel`
4. `assessExecutionPreflight(input): ExecutionPreflightDecision`
5. `buildCapabilityGrantRecord(input): CapabilityGrantRecord`
6. `compileTaskContextBundles(input): ReadonlyMap<taskId, CompiledContextBundle>`
7. `parseGitDiffStat(input): DiffStat`
8. `assessScopeDrift(input): ScopeDriftDecision`
9. `deriveTaskVerdict(input): TaskVerdict`
10. `projectOutcomeTruth(input): OutcomeProjection`
11. `reconcileLiveBlockers(input): readonly Blocker[]`
12. `projectLiveRunStatus(input): ActiveRunProjection | undefined`

orchestrator、CLI 和 Snapshot builder 只编排这些接口，不复制其规则。

## 21. 测试策略

按 TDD 顺序实施：

1. **纯函数单元测试**：模式、覆盖、风险、预检、DiffStat、漂移、verdict、blocker 和 live projection。
2. **Golden 兼容测试**：旧 direct Plan、旧 ContextBundle、旧混合 run_outcomes Snapshot 和旧 CLI 结果可读，但不能授权新执行。
3. **Adapter conformance**：unmetered delegated unattended 必须拒绝；supervised 运行必须保留 Profile、不可用预算与真实 DiffStat。
4. **orchestration 集成测试**：授权和 Grant 先于 RunStarted；每 Task 独立 Bundle；scope drift 回到 impact；handoff 不被改写；源码/ledger commit 分离。
5. **CLI E2E**：长运行 fake Agent 持续输出 heartbeat/elapsed；`--json` stdout 保持单 JSON；status 显示 active/completed control profile。
6. **安全与 fault 测试**：未声明写入、rename、二进制、进程中断、批准失效、旧迭代迁移与恢复幂等。
7. **dogfood 验收**：用 Atlas 的 T8 形态 fixture 重放三十文件 delegated Agent 场景，断言模式、风险、范围、证据、快照和提交语义全部一致。

## 22. 验收标准

1. 配置 Agent executor 且 Plan 为 direct 时，preflight 在调用 executor 前拒绝。
2. DSH 永远不能 unattended，且运行前存在人工批准的 ExecutionAuthorization。
3. DSH 的 token/step 在 Run、Evaluation、status、Snapshot 中均为 unavailable，而不是零。
4. RunTerminated 保持 handoff；TaskVerdict 可为 passed；IterationStatus 可为 completed，三者无冲突。
5. Evaluation 不再把正常 handoff 描述为 correct failure。
6. Snapshot 与 CLI 明确输出 source、ledger、repository-head 三个 commit。
7. 只有 Requirement/Test 覆盖的 Agent 任务不能执行；补齐图/路径覆盖并重新批准后才能恢复。
8. Task risk 不得低于任何 Impact、范围或 Adapter 风险。
9. 实际 diff 超出批准 Forecast 时阻断完成并回到 impact。
10. 每个 acceptance assertion 有独立 verdict 和 Evidence ids。
11. CapabilityGrant 完整记录在 RunStarted 前提交，并绑定 Plan、Context、Approval、Run 与 Snapshot。
12. Git change summary 与 fixture 的真实 numstat 一致，支持 rename、未跟踪文本和二进制文件。
13. resolved/superseded approval 不出现在新的 WorkingState、Snapshot 或 status blocker 中。
14. 多 Task DAG 为每个 Task 产生不同且正确绑定的 ContextBundle。
15. Context manifest 包含 locators、选择理由、排除项和预算元数据。
16. 长运行 CLI 至少每三十秒显示一次活动摘要，且底层 heartbeat 仍保持五秒。
17. 旧完成数据可读且标记 legacy inference；旧开放迭代不能绕过新 preflight。
18. 完成迭代的 Run、Task、Test/assertion evaluation coverage 均为全量，不得再出现 `0/N`。
19. 全量 unit、integration、security、fault、performance、CLI E2E、Dashboard 与 release pack 门禁通过。

## 23. 实施切片

实施按依赖顺序拆为六个纵向切片，每个切片独立完成 red-green-refactor 和相关文档：

1. **执行分类与治理预检**：ExecutionBinding、mode、risk、ImpactCoverage、ExecutionAuthorization。
2. **Task-local authority**：多 Bundle、原子 acceptance、完整 Grant 及运行前绑定。
3. **真实运行观察**：Harness DiffStat、scope drift、Control Profile、预算 availability。
4. **分层完成真相**：RunFact、TaskVerdict、IterationStatus、Snapshot 与 commit refs。
5. **状态与 UX**：blocker reconciliation、live CLI/status projection、legacy readers。
6. **闭环验收**：迁移/fault/security/E2E、Atlas T8 形态 dogfood、验收报告和发布门禁。

每个切片必须先通过其窄测试，再运行 `pnpm verify`；最后运行 release 门禁并生成更新后的验收报告。

## 24. 风险与缓解

- **规则过度集中导致模块变浅**：ExecutionPreflight 只暴露一个高层决策接口，内部 owns 覆盖、风险和授权组合，调用方不需要理解实现细节。
- **Impact 覆盖导致旧项目无法继续**：历史完成数据只读兼容；旧开放迭代自动回退并给出精确缺口，不静默失败。
- **原子验收无法由自然语言稳定拆分**：优先使用已批准 Test 节点；无法证明时请求输入，不让模型自证原子性。
- **scope drift 发生在 opaque Agent 已写文件之后**：Harness 不声称能拦截 delegated 内部副作用，但阻止提交和完成，并保留可审计的 drift 记录。
- **CLI heartbeat 产生噪声**：底层五秒记录，终端三十秒聚合；状态变化和 terminal event 立即显示。
- **字段扩展破坏旧 reader**：Protocol 1.x 使用 extensions 和兼容 reader；删除/重命名仅发生在 CLI 新投影，历史 artifact 不修改。

## 25. 已确认决策

1. 采用仓库模板与可安装 CLI 结合的 Universal Harness 交付形态，本加固不改变交付方式。
2. 采用集中式 `ExecutionPreflight + OutcomeProjection`，不做分散字段补丁或 Protocol v2 重写。
3. 采用兼容策略 A：历史数据可读，所有新执行立即严格生效。
4. delegated、unmetered、external-only Adapter 必须 supervised 并经过运行前授权。
5. 反馈环继续采用 Graph Engineering：测试/评审、影响分析、PRD/Architecture/Spec/Plan 级联更新均通过权威图和批准 digest 驱动。
