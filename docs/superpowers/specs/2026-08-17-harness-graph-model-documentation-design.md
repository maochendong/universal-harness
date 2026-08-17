# Harness Graph-native 驱动模型文档设计

日期：2026-08-17  
状态：已确认，待实施

## 1. 背景

Universal Harness 已在代码中定义完整的 Graph-native 工程模型，但 README 尚未用一套可快速理解、可与实现逐项核对的图示解释以下内容：

- 26 类 Node 如何共同表达项目、需求、设计、计划、执行、证据与反馈；
- 31 类 Edge 中，哪些关系参与变更影响传播，哪些关系只表达结构或审计事实；
- 17 条影响传播规则如何决定方向、默认风险与推理边许可；
- 15 类权威 Lifecycle Event 与 11 类实时 Observation Event 如何分别驱动 Ledger、Live Spool、Dashboard、恢复与快照；
- Harness 如何把需求录入、影响分析、计划、受控 Agent 执行、门禁、反馈修复和迭代快照闭合成一条可审计纵向链路。

直接把全部枚举画成密集网络会降低可读性，也容易在模型演进后与代码漂移。本设计采用“两层阅读 + 代码一致性测试”：README 解释主干，独立文档完整展开，代码仍是唯一权威来源。

## 2. 目标

1. 第一次接触项目的读者可在一分钟内从 README 理解 Harness 的驱动主干。
2. 工程师可在完整模型文档中核对每一种 Node、Edge、Event 和传播规则。
3. 中文业务解释优先，同时保留英文 Schema 枚举，便于定位实现。
4. 图示明确区分权威状态、实时观察和可重建查询缓存。
5. Schema 或传播策略变化而文档未同步时，自动测试必须失败并给出差异。

## 3. 非目标

- 文档不成为 Runtime 输入，不驱动 Impact、Plan、Gate 或 Ledger 写入。
- 不修改 Node、Edge、Event 或 Ledger Schema。
- 不改变现有影响传播、风险评分、批准、执行或反馈算法。
- 不为 Mermaid 引入新的生产依赖。
- 不在 README 中绘制 31 条跨越全部节点的独立连线网络。

## 4. 权威来源

文档只能解释下列代码，不得另建语义：

| 模型 | 唯一权威来源 |
| --- | --- |
| 26 类 Node | `packages/core/src/schema/node.ts` 的 `NODE_TYPES` |
| 31 类 Edge | `packages/core/src/schema/edge.ts` 的 `RELATION_TYPES` |
| Edge 合法端点 | `packages/graph/src/integrity.ts` 的 `RELATION_COMPATIBILITY` |
| 17 条传播规则 | `packages/graph/src/impact/propagation.ts` 的 `PROPAGATION_RULES` |
| 15 类 Lifecycle Event | `packages/core/src/schema/event.ts` 的 `EVENT_TYPES` |
| 11 类 Observation Event | `packages/core/src/schema/observation.ts` 的 `OBSERVATION_EVENT_TYPES` |
| 影响风险与分类 | `packages/graph/src/impact/scoring.ts` |

代码继续是唯一权威来源。Markdown 和 Mermaid 只提供人类可读的说明与投影。

## 5. 两层阅读架构

### 5.1 README 快速总览

`README.md` 在“核心设计思路”之前新增“Graph-native 驱动模型”部分，包含：

- 一张 GitHub 原生 Mermaid 总览图；
- 26 类 Node 的五个职责域及中文职责说明；
- Capture → Impact → Plan → Context → Execute → Verify → Evaluate → Snapshot 纵向闭环；
- Finding → RootCauseAnalysis → ImprovementCandidate → ImpactSet 反馈环；
- 17 条传播关系与 14 条结构关系的边界概念；
- Lifecycle Event、Observation Event、Ledger、Live Spool、SQLite 的权威边界；
- 指向完整模型文档的链接。

README 图不承担所有端点组合和全部规则参数的展示，以保证常规 GitHub 页面宽度下仍可阅读。

### 5.2 完整模型文档

新增 `docs/graph-driven-harness-model.md`，包含：

1. 完整 Graph-native Harness 模型总图；
2. 26 类 Node 的中文名称、职责域和业务说明；
3. 31 类 Edge 的中文含义、传播属性和作用说明；
4. 17 条影响传播规则精确表；
5. 合法端点兼容矩阵的阅读说明；
6. 15 类 Lifecycle Event 的分组、用途与权威性；
7. 11 类 Observation Event 的分组、用途与可删除性；
8. 一次变更从 Change Seed 到 Snapshot 的逐步示例；
9. 代码权威来源和文档防漂移约束。

## 6. Node 信息结构

26 类 Node 按职责分成五个域。每个域在图中同时展示“包含什么、负责什么、怎样驱动下一步”。

| 职责域 | Node | 中文说明 |
| --- | --- | --- |
| 权威上下文 | Project、Repository、Iteration | 确定在哪个项目、仓库和迭代中工作，是所有记录、授权和快照的归属根。 |
| 意图与设计 | Intent、Requirement、Constraint、Decision、Component、CodeArtifact | 把自然语言目标逐级变成可追踪的需求、约束、决策、组件和代码对象，形成“为什么改”的依据。 |
| 影响与治理 | ImpactSet、ExecutionPlan、Task、Policy、ApprovalRequest、Approval、ToolDefinition、ContextBundle | 计算改动波及范围，把已批准影响转为任务，并在执行前收窄策略、权限、工具和上下文。 |
| 执行与验证 | Run、Gate、Checkpoint、Evidence、Test、EvaluationCase | 在受控能力内执行任务，用门禁、测试和评估生成可审计证据；Agent 自述不能替代完成事实。 |
| 反馈修复 | Finding、RootCauseAnalysis、ImprovementCandidate | 把失败转为结构化问题，定位根因和归属层，再触发新的影响分析，禁止下游越层直接修改上游事实。 |

图中使用“中文业务名称 `EnglishEnum`”格式，例如“需求 `Requirement`”“影响集 `ImpactSet`”。

## 7. Edge 信息结构

### 7.1 17 条影响传播关系

Impact Engine 从 Change Seed 开始，不沿全部相邻边盲目扩散。每条传播规则固定三个参数：

- **方向**：站在当前被检查节点看，`forward` 只沿其发出的边，`inverse` 只沿指向它的边反向追溯，`both` 两侧均可；
- **默认风险**：关系对路径风险的最低贡献；路径经过 `high` 关系后，目标风险提升为 `high`；
- **允许推理边**：是否允许 proposed 或低置信度边进入候选路径。经过推理边的结果只能进入 `inspect`，不能自动成为确定性 `must-change`。

| 关系 | 中文含义 | 方向 | 默认风险 | 允许推理边 |
| --- | --- | --- | --- | --- |
| `REFUTES` | 反证 | forward → | high | 否 |
| `VIOLATES` | 违反 | forward → | high | 否 |
| `BLOCKS` | 阻塞 | forward → | high | 否 |
| `VERIFIES` | 验证 | both ↔ | medium | 是 |
| `ADDRESSES` | 回应需求 | inverse ← | medium | 是 |
| `SHAPES` | 塑造组件 | forward → | medium | 是 |
| `REALIZES` | 实现组件 | inverse ← | high | 是 |
| `IMPLEMENTS` | 实施需求或决策 | inverse ← | medium | 是 |
| `DECOMPOSES_TO` | 分解为 | forward → | medium | 否 |
| `CONSTRAINED_BY` | 受约束于 | both ↔ | high | 否 |
| `GOVERNED_BY` | 受策略治理 | both ↔ | high | 否 |
| `DEPENDS_ON` | 依赖 | both ↔ | low | 否 |
| `DERIVES_FROM` | 派生自 | inverse ← | medium | 否 |
| `SUPERSEDES` | 取代 | forward → | low | 否 |
| `DIAGNOSED_BY` | 由根因分析诊断 | forward → | low | 否 |
| `PROPOSES_CHANGE_TO` | 提议修改 | forward → | medium | 否 |
| `MAY_IMPACT` | 可能影响 | forward → | low | 是 |

传播采用按 ID 稳定排序的 BFS，记录到达每个节点的确定性最短解释路径；默认最大深度为 6，硬上限为 10。端点缺失由图完整性审计报告，Impact Engine 不把损坏边作为有效传播依据。

传播关系在说明中进一步分组：

- 失败与约束链：`REFUTES`、`VIOLATES`、`BLOCKS`；
- 需求—设计—实现链：`VERIFIES`、`ADDRESSES`、`SHAPES`、`REALIZES`、`IMPLEMENTS`、`DECOMPOSES_TO`；
- 治理与演化链：`CONSTRAINED_BY`、`GOVERNED_BY`、`DEPENDS_ON`、`DERIVES_FROM`、`SUPERSEDES`；
- 反馈修复链：`DIAGNOSED_BY`、`PROPOSES_CHANGE_TO`；
- 语义候选链：`MAY_IMPACT`。

### 7.2 14 条非传播结构关系

这些关系表达执行归属、产物来源、批准决议和证据链，但不表示内容变化必然传播。它们参加端点类型校验、状态过滤、图查询、Dashboard 邻域和审计追溯，不进入变更影响 BFS。

| 分组 | 关系 | 中文说明 |
| --- | --- | --- |
| 来源与恢复 | `GENERATED_BY`、`RESUMES` | 追踪谁生成节点，以及失败 Run 从哪次 Run 恢复。 |
| 执行绑定 | `EVALUATES`、`EXECUTES`、`INVOKES`、`USES_CONTEXT`、`CAPTURES` | 回答一次 Run 执行、评估、调用或使用了什么，并由哪个检查点捕获。 |
| 产物与证据 | `PRODUCES`、`SUPPORTS` | 构成 Run → Evidence → Test / Requirement / EvaluationCase 的审计链。 |
| 层级归属 | `CONTAINS` | 构建 Project、Repository、Iteration、ExecutionPlan 的包含视图，不代表内容依赖。 |
| 批准治理 | `REQUESTS_APPROVAL_FOR`、`RESOLVES`、`APPROVES` | 把请求、决议和精确对象 digest 绑定，防止批准漂移后被复用。 |
| 反馈入口 | `TRIGGERS` | 记录 Finding 或 ImprovementCandidate 触发了哪个 ImpactSet；传播从新 Change Seed 重新开始。 |

例如 Run `PRODUCES` Evidence 只说明证据由该次运行产生。Evidence 发生变化时，不能由此推断 Run 对应的 Task 定义必须修改。把此类边加入 BFS 会让运行历史、容器关系和批准记录造成无界扩散。

## 8. Event 信息结构

### 8.1 15 类 Lifecycle Event

Lifecycle Event 记录一次受治理操作已经发生的关键事实。每条记录绑定 project、iteration、workflow operation、ledger operation、单调 sequence、timestamp 和结构化 payload，并写入 append-only Git-native Ledger。

| 分组 | Event | 中文说明 |
| --- | --- | --- |
| 操作边界 | `OperationStarted`、`OperationCompleted` | 界定一次幂等工作流的开始与完成。 |
| 计划与上下文 | `PlanAccepted`、`BeforeContextCompile`、`ContextCompiled` | 证明执行使用了哪个批准计划和哪个受限上下文。 |
| 工具与批准 | `BeforeToolCall`、`AfterToolCall`、`ApprovalRequired` | 审计外部动作及需要人工决策的时点。 |
| 恢复与质量 | `CheckpointCommitted`、`GateCompleted`、`EvaluationCompleted` | 支持中断恢复，并确立门禁和评估完成事实。 |
| Finding 生命周期 | `FindingCreated`、`FindingAccepted`、`FindingClosed`、`FindingSuperseded` | 追加记录问题治理历史，不覆盖旧事实。 |

Dashboard、投影、恢复和审计逻辑可以重放 Lifecycle Event；同名实时通知不得替代已经提交的权威事件。

### 8.2 11 类 Observation Event

Observation Event 回答长运行过程“现在进行到哪里、是否仍有心跳、预算如何、为什么暂停”。每条记录绑定 stream、sequence、observation key、project、iteration 和 workflow operation，写入可删除的 Live Spool。

| 分组 | Event | 中文说明 |
| --- | --- | --- |
| 相位进度 | `PhaseStarted`、`PhaseCompleted`、`PhasePaused` | 驱动 Dashboard pipeline 的当前相位与暂停原因。 |
| 门禁进度 | `GateStarted`、`GateCompleted` | 实时显示门禁进度；最终权威结果仍由 Ledger 和 Evidence 确立。 |
| Agent Run | `RunStarted`、`RunHeartbeat`、`RunOutputSummary`、`RunTerminated` | 展示 Agent 活性、输出摘要和终止原因。 |
| 控制信号 | `BudgetUpdated`、`ApprovalRequired` | 展示预算变化和等待人工输入的状态。 |

`GateCompleted` 和 `ApprovalRequired` 在两条流中可能同名，但语义不同：Observation Event 是即时通知，Lifecycle Event 是已提交治理事实。读取层按 operation 和 sequence 关联展示，不把通知升级为权威状态。Live Spool 丢失只影响实时体验，不影响 Ledger 重放、SQLite 重建、审计结论或 Iteration Snapshot。

## 9. 数据流与完成真相

```text
Node + Edge
  定义系统当前知道什么，以及对象如何关联
        │
        ├── Change Seed + PROPAGATION_RULES ──→ ImpactSet
        │                                        │
        │                                        ↓
        │                                Plan → Context → Run
        │                                        │
        │                                        ↓
        └──────────────────────────── Gate → Evidence → Evaluation
                                                 │
                                                 ↓
                                   Finding → RCA → Improvement
                                                 │
                                                 └──→ 新 ImpactSet ↺

Lifecycle Event ──→ Git-native Ledger ──→ Projection / Audit / Snapshot
                                         └──→ 确定性重建 SQLite

Observation Event ──→ Live Spool ──读取时合并──→ Dashboard
```

Node / Edge 定义“系统当前知道什么以及怎样关联”；Lifecycle Event 证明“哪些治理事实已经发生”；Observation Event 展示“此刻正在发生什么”。三者共同驱动迭代，但只有 Ledger 中的权威记录能够决定完成状态。

## 10. 图示规则

- 中文业务名称在前，英文枚举以等宽文本保留。
- Mermaid 使用职责域 subgraph，避免 31 条关系全部跨域连线。
- 主干连线只表达闭环阶段与关键反馈方向，不伪装成完整兼容矩阵。
- 17 条传播关系和 14 条结构关系放在图内独立图例，并由紧邻表格精确展开。
- Lifecycle Event 使用实线黄色区域表示权威；Observation Event 使用蓝色虚线区域表示可删除实时流；SQLite 使用中性色表示可重建缓存。
- Mermaid 旁必须保留等价 Markdown 表格和中文解释，保证无图渲染环境仍可理解。

## 11. 防漂移与错误处理

新增 `tests/e2e/graph-model-documentation.test.ts`，从权威常量读取当前实现并检查 README 与完整文档：

1. 26 个 `NODE_TYPES` 全部出现且无重复；
2. 31 个 `RELATION_TYPES` 完整分成 17 个传播关系和 14 个非传播关系；
3. 17 条规则的方向、默认风险和推理许可与 `PROPAGATION_RULES` 完全一致；
4. 15 个 `EVENT_TYPES` 全部出现；
5. 11 个 `OBSERVATION_EVENT_TYPES` 全部出现；
6. README 包含 Graph-native 总览图和完整模型文档链接；
7. 完整文档包含权威来源、两类 Event 边界和 Mermaid 降级表格。

当枚举或传播规则变化但文档未同步时，测试必须列出缺失项、额外项或参数差异，并失败阻止合并。测试不得自动修改文档，避免 CI 产生隐式写入。

Mermaid 渲染问题不影响 Runtime；表格和文字是无图环境的可访问降级。实施时使用 GitHub 支持的基础 flowchart 语法，不增加生产依赖。

## 12. 测试策略

- **文档一致性测试**：验证枚举全集、传播/非传播集合划分和规则参数。
- **链接测试**：验证 README 指向的完整文档存在。
- **内容结构测试**：验证中文解释、权威边界和降级表格存在。
- **格式验证**：运行 Prettier 和既有 `format:check`。
- **回归验证**：运行新增定向测试以及完整 `pnpm test`；README 变更不得影响 Runtime 行为。
- **人工渲染检查**：在 GitHub Markdown 兼容环境中检查 Mermaid 可读性、窄屏换行和链接跳转。

## 13. 验收标准

1. README 新读者能从一张总览图理解完整纵向闭环和反馈环。
2. README 中每个职责域、关系区、事件流和存储边界都有中文职责说明。
3. 完整文档列出全部 26 类 Node、31 类 Edge、15 类 Lifecycle Event 和 11 类 Observation Event。
4. 17 条影响传播规则逐条展示方向、默认风险和推理边许可，数值与代码一致。
5. 14 条非传播关系按职责分组，并解释为何不进入 Impact BFS。
6. 文档明确区分 Ledger 权威事实、Live Spool 实时观察和 SQLite 可重建缓存。
7. 文档一致性测试能检测新增、删除、重复或参数漂移。
8. Mermaid 不可渲染时，Markdown 表格和文字仍提供完整语义。
9. `pnpm format:check`、新增定向测试和完整 `pnpm test` 通过。

## 14. 实施顺序

1. 先编写失败的文档一致性测试；
2. 新增完整模型文档及全部清单和规则表；
3. 在 README 加入精简总览图和链接；
4. 运行定向测试、格式检查和完整测试；
5. 在 GitHub Markdown 兼容环境中检查最终渲染。
