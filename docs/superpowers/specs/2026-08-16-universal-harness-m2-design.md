# Universal Harness M2 完整设计

日期：2026-08-16

状态：已批准

范围依据：[M2–M3 范围决策](2026-08-15-m2-m3-scope-decisions.md)

## 1. 结论

M2 采用“端口化内核 + 仓库内 Dashboard 包 + CLI 组合入口”的交付方式。在不改变 Git Ledger 权威地位、不提前提交相位状态、不允许模型自证通过的前提下，一次性交付以下四项能力：

1. M2-A：Finding 分组、可处置性分级、批量处置与 stale-knowledge 自动衰减。
2. M2-B：完整实现但运行时默认关闭、默认非阻断的第三方 LLM-judge Gate。
3. M2-C：可确定性重建、只产出建议且必须人审的语义检索种子。
4. M2-D：统一事件流、`harness serve`、SSE 实时视图与复用既有批准门的 Web 操作。

M2 完成的含义不是只有页面可打开，而是四项能力均有稳定端口、CLI 或 Web 入口、失败语义、审计记录、自动化测试、发布打包验证和端到端验收证据。

## 2. 目标与非目标

### 2.1 目标

- 让大型项目的 Finding 从逐条噪声变成可理解、可批量处置、可追溯的治理信号。
- 在确定性 Gate 之外提供可选语义评审，同时保持 Evidence freshness、Policy 和 Approval 约束。
- 用确定性符号相似度弥补结构图断边，但不让概率输出自动成为图事实。
- 在长时间迭代期间实时展示相位、Gate、Run、预算和批准点。
- 提供 Graph、Impact、Iteration、Evidence 四个本地探索视图及 Finding 治理视图。
- 保持旧项目、旧 Ledger、旧 runtime 配置与现有 `harness watch` 可迁移、可回放。

### 2.2 非目标

- 不实现 M3 的远程同步、团队身份、多人批准、分布式锁或跨机器并发。
- 不允许 Dashboard 绑定非 loopback 地址；M2 不是远程管理服务。
- 不引入外部 Vector Database，也不让相似度结果自动写入权威图。
- 不把 LLM-judge 设为默认 Gate，不把被评审 Agent 的自然语言自述当作 Evidence。
- 不开放任意命令、任意文件读取、Ledger 原始写入或通用 Hook SDK。
- Windows CI、`--light` onboarding、广泛 Provider 生态继续作为未分配项。
- Snapshot 全量投影的增量化不在 M2 内；M2 只建立基准并在达不到验收线时处理直接瓶颈。

## 3. 架构

```text
Git Ledger ────────────────┐
                           ├─ GraphQueryPort / ExecutionGraphPort
SQLite 可重建投影 ────────┤
                           ├─ EvaluationReadPort / FindingGroupQueryPort
非权威 live spool ────────┤
                           └─ EventStreamPort
                                      │
                         packages/dashboard
                         HTTP JSON API + SSE
                                      │
                              dashboard.html
            Graph / Impact / Iteration / Evidence / Findings / Live
                                      │
                ApprovalService / ResumeService / FindingGroupService
                                      │
                                 Git Ledger
```

采用该结构的原因：

- Dashboard 不解析 `.harness` 私有文件，不复制领域规则，只消费版本化端口。
- CLI 仍是组合根；`harness serve` 负责组装端口、HTTP 服务和静态资产。
- SQLite、语义索引和 live spool 都是可删除缓存；只有 Git Ledger 是权威状态。
- Web 写操作复用已有应用服务，不能绕过 digest、actor、Policy、Approval 或 Ledger transaction。

## 4. 包边界

| 包 | M2 职责 | 禁止承担的职责 |
| --- | --- | --- |
| `packages/core` | 新增持久化 Finding 生命周期事件、非持久化 Observation schema、必要的关系枚举 | HTTP、模型调用、页面状态 |
| `packages/graph` | 读端口、Finding 分组投影、语义索引与候选排序、SQLite 查询适配器 | Approval、HTTP、secret |
| `packages/plugin-sdk` | `SemanticSeedProvider` 版本化契约；沿用 Gate Provider 契约 | 具体 Provider 凭据和进程管理 |
| `packages/runtime` | Finding 生命周期/批处理/衰减、EventStream、观察事件发布、Judge Gate 归一化、应用服务 | 页面渲染 |
| `adapters/gate-llm-judge` | Review Bundle、OpenAI-compatible transport、结构化响应校验与 Gate adapter | Policy 决策、secret 持久化、直接写 Ledger |
| `packages/dashboard` | 本地 HTTP、SSE、静态单页、只读 API 与受控操作适配器 | 直接解析/修改 Ledger、执行任意命令 |
| `packages/cli` | `serve`、扩展后的 `watch`、Finding group、semantic impact、配置与组合 | 重复领域实现 |
| `packages/conformance` | Provider 契约、跨包端口和发布包一致性测试 | 项目私有规则 |

现有 orchestration 内已有写侧 `EvaluationPort`。为避免同名但不同语义，Dashboard 的读侧接口在代码中命名为 `EvaluationReadPort`；文档中的 M2 `EvaluationPort` 均指该读侧端口。

## 5. 共用数据原则

1. 权威记录继续使用 append-only Ledger；任何处置都追加记录，不覆盖历史。
2. 所有集合在 digest 前按稳定键排序；相同输入必须产生相同 id、digest、页面顺序和索引字节。
3. 所有 Web/CLI 变更请求绑定当前对象或集合 digest；成员漂移必须拒绝，不能在新集合上静默执行旧批准。
4. live 观察信号不参与完成判断；进程崩溃后可丢失，恢复只能从 Ledger 和 Checkpoint 推导。
5. 输出在进入 spool、Evidence 或 HTTP 前统一脱敏；不在 UI 层补救未脱敏数据。

## 6. M2-A：Finding 治理

### 6.1 规范化元数据

Finding producer 在 `harness.finding` extension 中增加以下字段：

```ts
interface FindingGovernanceMetadata {
  rule: string;
  scope_prefix: string;
  severity: "blocker" | "warning";
  actionability: "auto_close" | "human_review" | "upstream_change";
  subject_ids: readonly string[];
  subject_digests: readonly string[];
}
```

- `rule` 是稳定规则标识，不得使用 summary 自由文本。
- `scope_prefix` 由 producer 显式给出，不通过截断 Finding id 猜测。
- Audit 规则使用 `project/<repository-id>/<domain>`；例如 stale knowledge 使用 `.../knowledge`，设计缺失使用 `.../design`。
- Gate 使用 `project/<repository-id>/gate/<gate-id>`；Evaluation 使用 `project/<repository-id>/evaluation/<case-id>`。
- `severity` 从 producer 的 blocking 语义确定。
- `actionability` 由规则表确定；stale knowledge 为 `auto_close`，需要人工决策的缺口为 `human_review`，依赖外部变更的缺口为 `upstream_change`。

`auto_close` 表示可自动解除，不改变历史 Finding 的精确生命周期语义；stale-knowledge 的实际终态仍是 `superseded`，而不是伪造修复 Evidence 后标记 `closed`。

旧 Finding 没有这些字段时使用版本化 legacy adapter。adapter 只能按 origin、Audit kind、关联节点和既定规则表推导；无法可靠分类的 Finding 进入 `legacy/unknown` + `human_review`，不得用 summary 模糊匹配改变生命周期。

### 6.2 分组模型

组键固定为：

```text
group_key = rule + scope_prefix + severity + actionability
group_id  = "finding-group_" + sha256(group_key)[0..15]
```

成员 digest 固定为：

```text
membership_digest = sha256(sort(finding_id + revision + status + digest))
```

`FindingGroup` 是投影，不是新的权威 Node。输出字段包括 group id、四个分组维度、open/accepted 数量、成员总数、membership digest、最多五个稳定排序样本以及 first/last seen。

`ProjectStatus` 新增 `finding_groups`。既有 `blockers`、`warnings` JSON 字段保留用于兼容；终端默认只显示组计数和样本，不再平铺几十行 Finding。`--json` 同时提供原数组和结构化组。

### 6.3 批量处置

新增入口：

```text
harness finding group <accept|close|supersede> <group-id> \
  --digest <membership-digest> [--evidence <id>] [--actor <id>]
```

服务在单个 Ledger transaction 中完成：重新计算组成员、校验 digest、预校验所有转换、追加反馈记录和节点修订、退休相关活动边、追加生命周期事件。任何成员校验失败都整体失败，不允许部分成功。

- `accept`：全部 open 成员进入 accepted。
- `supersede`：全部 open/accepted 成员进入 superseded。
- `close`：要求 Evidence 对每个成员均通过、非 provisional、fresh 且适用；M2 接受一个可覆盖全组的 Evidence id，不满足时要求拆组处置。

组漂移返回 `finding_group_digest_mismatch`；已经全部处置且 digest 相同返回幂等 `noop`。

### 6.4 自动衰减

`FindingDecayService` 在新的知识源修订已经进入本次 Ledger transaction 后运行。它只处理规则表标记为 `auto_close` 的 Finding：

1. 对当前图重新执行对应确定性 Audit predicate。
2. predicate 不再复现，或 Finding 绑定的 subject digest 已被新 revision 替代且新 revision 通过该 predicate，追加 superseded 修订。
3. 同一 transaction 退休所有以该 Finding 为 source 或 target 的活动边。
4. 追加 `FindingSuperseded` LifecycleEvent，记录 cause、旧/新 subject digest 和 actor `workflow-engine`。

该服务在 capture/rescan、snapshot audit 和 graph reconcile 中调用。`graph sync` 仍是纯缓存重建，不能因读取动作提交新 Ledger 数据。

### 6.5 生命周期事件

持久化事件集合增加 `FindingAccepted`、`FindingClosed`、`FindingSuperseded`。payload 至少包含 finding id、from/to、actor、cause、evidence id（适用时）和 group id（批处理时）。历史记录不删除；第二次衰减不新增修订或事件。

## 7. M2-B：可选 LLM-judge Gate

### 7.1 启用与策略

M2 完整实现 Judge，但新旧项目默认不配置、不调用模型。runtime 配置 v2 增加 `judge_gates`；v1 继续可读并等价于空 Judge 配置。

每个 Judge Gate 声明 endpoint、model、prompt version、subject、timeout、环境变量白名单和 requested mandatory。effective mandatory 只有在以下条件全部成立时为 true：

1. 配置明确请求 mandatory。
2. 当前 accepted Policy 包含 `gates.<gate-id>.llm_judge_blocking = true`。
3. 该 Policy revision 有有效 Approval，且 Approval digest 仍匹配。

缺少任一条件时按 advisory 执行并输出配置诊断，不得偷偷升级为 blocking。

### 7.2 Review Bundle

模型只接收受约束、确定性生成的 Review Bundle：

- baseline/source commit；
- 排除 `.harness` 后的 code digest；
- 受控 diff 与变更路径；
- Task 验收标准；
- 与 subject 直接关联的 Requirement、Constraint、Decision、Policy 和 API contract；
- 已通过/失败的确定性 Gate 摘要。

字段按稳定顺序 canonicalize，并计算 `review_bundle_digest`。上限为 256 KiB；超限不得静默截断。advisory 产生 `bundle_too_large` warning Evidence，mandatory 产生失败 Evidence 和 blocker。

Prompt 由仓库内版本化模板 + JSON Schema 构成。diff、注释和文档始终作为不可信数据分隔，不能覆盖系统审查规则。temperature 固定为 0；Provider 支持 seed 时记录 seed。可重放表示能够重建完全相同的请求并核对响应 digest，不承诺第三方模型逐字确定性。

### 7.3 结构化结果

```ts
interface LlmJudgeResult {
  verdict: "pass" | "warn" | "fail";
  confidence: number;
  reasons: readonly {
    code: string;
    message: string;
    path?: string;
    line?: number;
  }[];
}
```

响应必须通过严格 schema；未知字段、无效路径、越界行号、空理由或无法解析均为失败状态，不能默认 pass。路径必须在 Review Bundle 的变更路径内。

### 7.4 Evidence 与 Finding

`adapters/gate-llm-judge` 提供普通 Gate adapter，并经 ToolRegistry 执行；runtime 只负责 Gate policy、Evidence 和 Finding 编排。Evidence 继续使用既有 Gate bindings，并在 `harness.llm-judge` extension 中增加：

- provider protocol、endpoint origin（不含凭据）、model、参数；
- prompt version/digest；
- review bundle digest；
- normalized response 与 response digest；
- replay descriptor；
- error kind 和重试次数。

只保存脱敏后的结构化响应，不保存 Authorization header 或未受控原始响应。失败的 advisory Gate 也创建 `blocking: false` Finding，使结果进入 M2-A 分组；这条规则推广到所有 advisory Gate。mandatory 失败沿用 blocker 语义。

timeout、429、5xx、网络失败、schema 失败分别归一化为 typed outcome。有限重试只针对 429/5xx/连接瞬断，最多两次、固定退避并记录；任何异常都不得作为通过。

### 7.5 Secret

API key 只能通过配置声明的 env allowlist 注入现有 Tool invocation。配置、Ledger、Evidence、spool、Dashboard API 和日志均不得出现 secret 值。endpoint 仅允许 `https:`；测试可显式启用 loopback HTTP fake server。

## 8. M2-C：语义检索种子

### 8.1 Provider 端口

`packages/plugin-sdk` 增加版本化端口：

```ts
interface SemanticSeedProvider {
  readonly name: string;
  readonly version: string;
  buildIndex(input: SemanticIndexInput): Promise<SemanticIndexDescriptor>;
  suggest(input: SemanticSeedRequest): Promise<readonly SemanticSeedSuggestion[]>;
}
```

请求只包含受控节点、locator、Git blob digest、变更 seed 和上限。结果包含 source node、candidate node、score、特征解释、provider/index digest；Provider 没有 Ledger 写权限。

### 8.2 内置确定性 Provider

M2 内置 symbol provider，不依赖网络或外部向量库。它从当前 Git 与最新图节点提取：

- locator 路径段和文件名；
- 声明/导出的 symbol；
- import/module 名；
- Markdown heading 和标识符；
- 节点类型与关联文档词项。

文本做 Unicode NFKC、camel/snake/path 拆分和小写规范化。相似度采用定点 weighted Jaccard：symbol 权重 8、import 5、path 3、文档词 1；分数以整数分子/分母计算，最终限制在 `(0, 0.99]`。默认阈值 0.35、top K 10，分数相同按 node id 排序。

索引写入 `.harness/cache/semantic/<provider-version>/<input-digest>`。input digest 绑定 Git commit、blob digest、图 source digest、extractor version 和配置。删除缓存后必须得到字节一致的索引与候选顺序。

### 8.3 建议进入人审通道

新增关系 `MAY_IMPACT`，允许 versionable node 指向 versionable node。其语义是“source 变化时应检查 target”，传播策略最高只能产生 `inspect`，不能单独形成 `must-change` 或授权写路径。

`harness impact <node-id> --semantic` 生成候选后，以一个 transaction 将候选写入现有 edge proposal artifact 通道；这不是活动图边。输出 edge id、score、reason、preview digest 和对应的 `approve-edge` 命令。只有执行：

```text
harness graph approve-edge <edge-id> --digest <preview-digest>
```

后，accepted `MAY_IMPACT` 才进入 Ledger 和后续结构传播。批准时重新验证 endpoint revision、provider/index digest、关系兼容性和 proposal digest；漂移必须重新生成建议。

Provider 超时、索引损坏或无候选只产生诊断，不阻断结构性 ImpactSet。语义候选不得直接加入已批准 ImpactSet；必须先批准边，再重新生成并批准 ImpactSet。

## 9. M2-D：实时可观测性

### 9.1 ObservationEvent

现有 `LifecycleEvent` 是 Ledger 内持久化事件。M2 新增独立、非权威的 `ObservationEvent`：

```ts
interface ObservationEvent {
  stream_version: 1;
  stream_id: string;
  sequence: number;
  observation_key: string;
  event_type:
    | "PhaseStarted" | "PhaseCompleted" | "PhasePaused"
    | "GateStarted" | "GateCompleted"
    | "RunStarted" | "RunHeartbeat" | "RunOutputSummary"
    | "BudgetUpdated" | "ApprovalRequired";
  project_id: string;
  iteration_id: string;
  workflow_operation_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
```

`stream_id` 绑定 workflow operation + attempt；`sequence` 在单流内严格递增。`observation_key` 由逻辑动作 id 派生，使 live `GateCompleted` 与随后提交的 Ledger `GateCompleted` 可去重；权威版本出现后覆盖观察版本。

### 9.2 EventStreamPort

```ts
interface EventStreamPort {
  read(query: EventStreamQuery): Promise<EventStreamPage>;
  subscribe(query: EventStreamQuery): AsyncIterable<EventStreamItem>;
}
```

端口合并已提交 LifecycleEvent 与 live ObservationEvent，返回 opaque cursor、稳定 event id、source=`ledger|live` 和 authoritative 标志。过滤支持 iteration、workflow、event type。`harness watch` 与 Dashboard 必须共用此端口，不能各自 tail 文件。

live spool 位于 `.harness/cache/event-stream/`，按 stream 分段，最多 10,000 条或 10 MiB，先到者触发轮转。记录在写入前完成 secret/path/output 脱敏。删除 spool 不影响 resume、status、snapshot 或 audit。

### 9.3 事件发布

- 相位进入前发布 `PhaseStarted`；原子提交成功后发布 `PhaseCompleted`。
- 进入批准等待发布 `PhasePaused` 和 `ApprovalRequired`。
- 每个 Gate 调用前后发布 Started/Completed；完成 Ledger event 绑定同一 observation key。
- 受管子进程启动后发布 `RunStarted`，至少每 5 秒发布 heartbeat。
- output summary 最快每 2 秒或每累计 8 KiB 发布一次，只保留脱敏后的最多 20 行/4 KiB 摘要和完整输出 digest。
- 预算发生变化时发布 `BudgetUpdated`。

heartbeat 超过 15 秒只把 live 状态标记为 `unknown`，不能伪造 failed/completed。进程恢复后的结论仍来自 Checkpoint/Ledger。

### 9.4 `harness serve`

命令默认监听 `127.0.0.1` 与随机可用端口。M2 拒绝非 loopback host。启动时生成 256-bit session token，打印一次带 token 的本地 URL；首次访问交换为 HttpOnly、SameSite=Strict cookie 后立即重定向移除 URL token。页面通过同源 `GET /api/v1/session` 获取与该 session 绑定、不可跨 session 复用的 CSRF token；CSRF token 不写入 URL 或持久化存储。

核心端点：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/session` | 当前 session 的 CSRF token 与过期时间 |
| `GET /api/v1/project` | 项目、状态、缓存健康摘要 |
| `GET /api/v1/graph/nodes`、`/edges` | 分页 Graph 查询 |
| `GET /api/v1/graph/neighborhood/:id` | 邻域 |
| `GET /api/v1/graph/path?from=&to=` | 最短路径/Impact path |
| `GET /api/v1/iterations/:id` | Iteration、Plan、Task、Run、Gate、预算时间线 |
| `GET /api/v1/evidence` | Evidence binding/freshness 查询 |
| `GET /api/v1/finding-groups` | Finding 分组与样本 |
| `GET /events` | SSE EventStream |
| `POST /api/v1/approvals/:id/decision` | approve/reject/defer |
| `POST /api/v1/workflows/:id/resume` | 复用 ResumeService |
| `POST /api/v1/finding-groups/:id/resolve` | digest 绑定的组处置 |

读请求设置数量、深度、时间范围和 payload 大小上限。所有写请求要求 session cookie、同源 `Origin`、CSRF header、expected digest 和 actor。冲突返回 409，不自动重试变更。

### 9.5 Dashboard 体验

静态单页不依赖 CDN，随发布包提供，包含：

1. Graph：Artifact/Execution 视图切换、类型/状态过滤、邻域展开、桥接边。
2. Impact：种子、传播分类、解释路径、风险与候选语义边。
3. Iteration：Plan→Context→Execute→Verify→Evaluate→Snapshot 泳道，Task/Run/Gate/预算时间线。
4. Evidence：subject、Gate、code/artifact/policy/context digest、freshness 与失效原因。
5. Findings：按 severity/actionability/rule/scope 分组、样本展开与批量操作。
6. Live：实时相位、Gate、Run heartbeat/output summary 和预算。
7. Approval card：显示对象摘要、风险、digest、请求 actor；支持 approve/reject/defer 与后续 resume。

键盘导航、焦点可见、语义化 label、颜色之外的状态标记和 reduced-motion 为发布验收项。小屏以列表替代大图，但不隐藏批准风险与 digest。

## 10. 读端口

`GraphQueryPort` 封装现有 pageNodes/pageEdges/neighborhood/shortestPath；`ExecutionGraphPort` 封装现有 execution view 与 bridges；`EvaluationReadPort` 返回 Run 五维 verdict、case、Evidence 与 coverage；`FindingGroupQueryPort` 返回纯投影。所有端口：

- 只能读取通过完整性检查的最新 SQLite 投影；
- 使用稳定 cursor 和最大 500 条页面限制；
- 不返回任意本地文件内容；
- 缓存 stale 时可在启动阶段重建，Ledger 损坏时不得回退到旧缓存伪装健康。

## 11. 安全模型

- 仅 loopback、随机 session、HttpOnly cookie、SameSite、Origin、CSRF、严格 CSP、`nosniff`、禁止 framing。
- 静态资产全部本地，CSP 不允许 `unsafe-eval`、远程脚本或远程字体。
- ID、cursor、路径和 query 使用 schema 校验；路径只能是 repo locator，不能解析绝对路径、`..` 或符号链接逃逸。
- API 错误使用 problem details；500 内容不包含 stack、命令、环境变量或原始输出。
- SSE 与 output summary 经过与 Tool invocation 相同的 redactor；测试覆盖跨 chunk secret、URL credential 和常见 token 格式。
- Web 层没有 shell API。可执行操作只限已列出的 Approval、Resume、Finding group 服务。
- Judge endpoint 防 SSRF：生产仅 HTTPS、禁止 credential URL、解析后拒绝 loopback/link-local/private address；测试注入 fake transport，不放宽生产校验。

## 12. 错误、恢复与一致性

| 场景 | 行为 |
| --- | --- |
| SQLite 缺失/旧版本 | 启动时确定性重建；期间返回 warming 状态 |
| Ledger 损坏 | 写操作禁用，相关 API 返回 503 + 稳定错误码 |
| SSE cursor 已被轮转 | 发送 `stream_reset`，客户端重新拉快照后续订 |
| Dashboard 重启 | 丢失 live 状态可接受；从 Ledger 恢复历史，运行中状态显示 unknown |
| Approval/Finding digest 漂移 | 409，强制刷新，不执行旧动作 |
| 子进程失联 | live unknown；不得写终态 Ledger |
| Judge 不可用/响应非法 | 失败 Evidence；advisory warning 或 mandatory blocker |
| Semantic index 损坏 | 删除并重建；失败时退回纯结构影响分析 |
| Provider 输出重复/乱序 | canonicalize、去重、稳定排序；仍不合规则拒绝整个 provider result |

HTTP 服务收到 SIGINT/SIGTERM 后停止接收写请求、关闭 SSE、等待当前 Ledger transaction 完成，再关闭数据库；不能在 transaction 中途退出后报告成功。

## 13. 兼容与迁移

1. runtime config reader 同时支持 v1/v2；v1 自动归一为无 Judge 的 v2 内存模型，不重写项目文件。
2. 新项目生成 v2；只有用户启用 Judge 时写 `judge_gates`。
3. 旧 Finding 通过 legacy adapter 分组；`graph reconcile` 可追加治理元数据修订，不改旧记录。
4. SQLite schema 升级并提供 migration；任何失败均可删除缓存后从 Ledger 重建。
5. Observation spool 无 migration，版本不兼容时删除重建。
6. `watch` 现有 ledger-only 输出继续可读；新类型为增量扩展，`--json` 保持每行一个对象。
7. `MAY_IMPACT` 是协议 1.x 的增量关系；新 runtime 可读全部旧 Ledger，旧 runtime 遇到未知关系必须明确失败，不能忽略。
8. Judge Evidence、Finding governance metadata 均为 extension 增量，不改变旧记录必填字段。

## 14. 测试策略

### 14.1 单元测试

- Finding 规范化、legacy fallback、组 id/digest、稳定顺序、分级和样本。
- 批量处置全成全败、digest 漂移、Evidence 适用性、幂等和所有活动边退休。
- stale-knowledge predicate、source refresh、显式 supersede event。
- Observation schema、sequence、去重、轮转、脱敏和 cursor。
- Review Bundle canonicalization/上限、Judge schema、Policy mandatory 计算、错误归一化。
- symbol 提取、定点分数、top K、索引 digest、确定性重建和 `MAY_IMPACT` 传播上限。
- 每个 HTTP handler 的 auth、CSRF、Origin、限制和 problem details。

### 14.2 契约与集成测试

- Graph/Execution/Evaluation/EventStream/Semantic Provider conformance。
- CLI `status`、Finding group、`impact --semantic`、`watch`、`serve`。
- fake OpenAI-compatible server 覆盖 pass/warn/fail/429/timeout/invalid JSON；测试不得访问公网。
- 从 Operation 运行到 SSE，再从 Web approval 进入现有 ApprovalService、resume、Ledger 的完整链路。
- SQLite 删除重建、spool 删除、服务重启、Last-Event-ID 和 stream reset。

### 14.3 浏览器与安全测试

- Playwright 覆盖六个视图、过滤/分页、实时泳道、Approval card、组处置、冲突刷新、键盘和窄屏。
- XSS payload、恶意 locator、伪造 Origin、缺失 CSRF、过期 session、SSE 注入、超大 query。
- CSP/响应头断言、无 CDN/远程资源扫描、静态资产 content type。

### 14.4 性能与发布测试

基准 fixture：10,000 nodes、30,000 edges、20,000 lifecycle events、1,000 open Findings。

- 缓存健康时 `harness serve` 首个 project response 小于 2 秒。
- 分页/邻域 API p95 小于 200 ms，SSE 本地端到端 p95 小于 500 ms。
- Finding 分组小于 500 ms，默认语义 top-K 小于 2 秒。
- 浏览器不一次性加载全图；所有大集合必须分页/按需展开。
- `pnpm verify`、standalone pack smoke、静态资产清单、无 workspace 路径/secret 扫描全部通过。

阈值在固定 CI fixture 上执行，不把开发机偶发时钟值作为发布证据。若 Snapshot 全量投影仍超标，记录为后续性能项；M2 不能用 Dashboard 旧数据规避它。

## 15. 验收矩阵

| 范围 | 必须证明的结果 | 权威证据 |
| --- | --- | --- |
| M2-A 聚合 | Atlas 类 53 条 warning 不再平铺，组数/计数/样本正确 | status CLI golden + Dashboard E2E |
| M2-A 衰减 | 知识源刷新后 stale group 清零，历史仍可追溯 | Ledger event/node/edge 集成测试 |
| M2-A 批处理 | digest 漂移零写入，同 digest 原子完成 | runtime transaction 测试 |
| M2-B 默认安全 | 未配置时零网络调用；配置后默认 advisory | fake transport + config 测试 |
| M2-B blocking | 仅 approved Policy opt-in 后阻断 | Policy/Approval/Evidence E2E |
| M2-B replay | prompt/bundle/model/response digest 完整 | Evidence schema/golden |
| M2-C 确定性 | 删除索引后候选及 digest 字节一致 | rebuild 测试 |
| M2-C 人审 | 未 approve 不进活动图，approve 后才影响 inspect | CLI/Ledger/Impact E2E |
| M2-D 事件 | Phase/Gate/Run/预算实时且脱敏，终态以 Ledger 为准 | EventStream 集成测试 |
| M2-D Server | `harness serve` 本地启动，Graph/Impact/Iteration/Evidence 可用 | packaged CLI + Playwright |
| M2-D Approval | Web 决策走原服务并绑定 digest/actor，可 resume | Ledger readback E2E |
| 安全 | 非 loopback、伪造 Origin/CSRF、SSRF、XSS 被拒绝 | security tests |
| 发布 | 安装后的 CLI 包含 server 与 assets，无源码工作区依赖 | standalone smoke |

任何一行缺少当前运行证据时，M2 都不能标记完成。

## 16. 实施切片与依赖顺序

1. **基础端口与 schema**：读端口、Observation/EventStream、LifecycleEvent 扩展、缓存版本。
2. **M2-A**：治理元数据、分组、status、批处理、衰减与事件。
3. **Dashboard 只读骨架**：新 package、HTTP、安全 session、Graph/Impact/Iteration/Evidence/Findings。
4. **M2-D live 与操作闭环**：runtime publisher、spool、watch 迁移、SSE、Approval/Finding UI。
5. **M2-C**：Provider port、symbol index、候选 proposal、`MAY_IMPACT` 与 CLI/UI。
6. **M2-B**：config v2、Review Bundle、Judge adapter、Policy、Evidence/Finding。
7. **硬化与发布**：浏览器/安全/性能、文档、pack smoke、完整验收矩阵。

每个切片遵循测试先行，合并前必须保持已有 M1 测试全绿。后续切片不得通过临时旁路修改前一切片的端口约束。

## 17. 完成定义

M2 只有在以下条件同时满足时完成：

- 本文 M2-A/B/C/D 的代码、CLI/Web 入口和文档全部存在。
- 所有单元、契约、集成、Playwright、安全、性能和 standalone 验证通过。
- 使用真实受管 fixture 跑通：需求/迭代执行 → live 观察 → Gate/Judge → Approval → resume → Evaluation → Snapshot。
- Finding 聚合与 stale 自动衰减在 Atlas 规模 fixture 上有可读、可审计证据。
- 语义建议未经批准不会改变图或 ImpactSet；批准后可解释地进入传播。
- 对照第 15 节逐项保存命令输出或测试证据，没有“由代码存在推断已完成”的项目。
- 工作树干净，提交已推送到唯一 `main`，README 与 M2 文档反映实际行为。
