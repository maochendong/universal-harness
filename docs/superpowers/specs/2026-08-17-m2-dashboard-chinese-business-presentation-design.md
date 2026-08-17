# M2 Dashboard 中文业务展示层设计

日期：2026-08-17  
状态：待书面复核  
范围：M2 Dashboard 的 Graph、Impact、Iterations、Evidence、Findings、Live 与 Approval；不修改 Ledger Schema

## 1. 决策摘要

M2 Dashboard 增加一个确定性的中文业务展示层。Read API 在原始权威事实之外，返回按 `entity id + digest` 绑定的非权威 `BusinessPresentation`；UI 以中文业务名称、说明和关联信息为第一阅读层级，以英文技术类型、原始状态、ID、revision 和 digest 为第二层级。

本设计选择“业务优先分层”：digest 保留为审计与写操作绑定依据，默认显示短值并支持复制完整值，但不再占据标题或正文。展示文本完全从现有权威字段和版本化中文词典确定性派生，不调用模型、不访问网络、不写回 Ledger。

## 2. 背景与问题

当前 Dashboard 已提供 Overview、Graph、Impact、Iterations、Evidence、Findings、Live 和 Approval，但 Graph 节点、迭代档案、Evidence、Finding Group 与 Approval 详情大量直接展示 ID、revision 和 digest。它们对审计不可缺少，却无法回答用户最先关心的问题：

- 这条记录在业务上表示什么；
- 为什么与当前需求或任务有关；
- 当前状态对下一步意味着什么；
- 哪些关系、风险、门禁或证据值得关注。

Atlas MVP 的真实 Dashboard 数据已经证明 Ledger、任务和评估覆盖完整，但用户仍需从 `case_*`、`iteration_*`、`evidence_*` 和摘要值中反推含义。M2 应在不削弱审计真实性的前提下补齐这一阅读层。

## 3. 目标与非目标

### 3.1 目标

1. Graph、Impact、Iterations、Evidence、Findings、Live 和 Approval 使用同一套中文业务展示规则。
2. 中文业务名称和说明优先，英文技术类型与原始状态作为次级标签。
3. 原始 ID、revision 和 digest 始终可见或一键可得，完整 digest 可复制。
4. 相同原始事实生成字节一致的展示模型。
5. 缺少业务字段或遇到未知类型时，提供明确且可解释的中文回退，而不是空白或猜测。
6. 原始 API 事实、Ledger、Graph Cache、Approval Binding 与 Finding Group Binding 的语义保持不变。

### 3.2 非目标

- 不新增 `display_name_zh`、`description_zh` 等 Ledger 权威字段。
- 不修改 Core Schema、Graph Schema、协议版本或历史记录。
- 不调用 LLM 翻译或生成业务描述。
- 不做 Dashboard 全量国际化；导航、栏目标题和协议术语可继续使用现有英文。
- 不允许中文展示文本参与批准、恢复、Finding 处置或任何写操作绑定。
- 不改变 CLI、Projection Markdown 或其他客户端的输出格式；后续可复用展示投影，但不属于本次范围。

## 4. 架构与模块边界

新增 `packages/dashboard/src/presentation.ts`，作为无 I/O 的纯函数深模块。它只依赖 Read API 已经读取的记录，不访问文件、数据库、网络或时间源。

```text
Git Ledger / Graph Cache
        ↓ 原始记录
Dashboard Read API
        ├─ 原始事实：items / iteration / evidence / groups / approvals / events
        └─ 展示侧车：presentations[entity-id@digest]
                         ↓
Dashboard UI
        ├─ 中文业务实体卡
        └─ 原始 digest 复制与写操作绑定
```

UI 不自行维护第二套提取规则。Read API 负责生成展示侧车，UI 只负责组件组合、视觉层级和交互反馈。这样所有视图共享同一个词典、字段优先级、截断规则与回退语义。

## 5. 展示模型

```ts
interface BusinessPresentation {
  readonly presentation_version: "1";
  readonly entity_id: string;
  readonly binding_digest: string | null;
  readonly title_zh: string;
  readonly description_zh: string;
  readonly type_label_zh: string;
  readonly status_label_zh: string;
  readonly technical_type: string;
  readonly technical_status: string;
  readonly badges: readonly {
    readonly label_zh: string;
    readonly value: string;
    readonly tone: "neutral" | "positive" | "warning" | "critical";
  }[];
  readonly derived_from: readonly string[];
  readonly fallback: boolean;
}
```

`binding_digest` 对 Node、Iteration、Evidence、Finding Group 和 Approval 使用当前对象或集合摘要；没有权威对象摘要的瞬时 Live Event 或 Project Metric 使用 `null`。`binding_digest` 只说明展示侧车对应哪一版事实，不能替代原始响应中的 digest 参与写操作。

Read API 采用加法式兼容：保留现有原始字段与集合结构，并在响应信封增加：

```ts
interface PresentationSidecar {
  readonly presentations: Readonly<Record<string, BusinessPresentation>>;
}
```

键格式固定为 `${entity_id}@${binding_digest ?? "live"}`。原始记录不添加展示属性，避免让调用方误以为其 canonical digest 覆盖中文文本。

## 6. 确定性派生规则

### 6.1 字段提取

仅从允许的字符串键读取业务文本；对象键按字典序遍历，最大深度为 4，不解释任意自由结构。

标题优先级：

1. `display_name`
2. `title`
3. `name`
4. `summary`
5. `objective`
6. `${type_label_zh} · ${short(entity_id)}`

描述优先级：

1. `description`
2. 与标题来源不同的 `summary`
3. `objective`
4. `reason`
5. 按实体类型生成的固定中文回退说明

每个候选值先折叠连续空白并去除首尾空白。标题最多 80 个 Unicode 字符，描述最多 240 个，badge value 最多 48 个；超长值按字符边界截断并添加省略号。空字符串、纯 digest、纯技术 ID 和非字符串值不作为业务标题。

`derived_from` 记录实际采用的字段路径，例如 `extensions.harness.task.objective`，按标题、描述、badge 的使用顺序去重。它只用于调试和测试，不在默认卡片中展示。

### 6.2 版本化中文词典

词典随 `presentation_version` 固定并覆盖：

- Node 类型：Requirement、Decision、Component、Task、CodeArtifact、Run、Evidence、Finding、EvaluationCase 等；
- Edge 关系：IMPLEMENTS、VERIFIES、DEPENDS_ON、MAY_IMPACT、BLOCKS、PRODUCES 等；
- 状态：proposed、accepted、completed、blocked、superseded、stale、pending 等；
- 风险：low、medium、high、critical；
- 编排阶段：capture、impact、plan、context、execute、verify、evaluate、snapshot；
- Run outcome、Task verdict、Evidence freshness、Approval decision 和 Finding actionability。

未知值显示“未知类型 / `<原始值>`”或“未知状态 / `<原始值>`”，并设置 `fallback: true`。词典不得猜测项目领域含义。

### 6.3 业务 badge

badge 只呈现已有事实，优先包括：风险、关联任务、影响跳数、门禁结果、Evidence freshness、评估覆盖、Finding severity/actionability、Live phase/heartbeat 和 Approval object type。badge 不重新计算治理决策。

## 7. 视图应用

### 7.1 Graph

节点列表显示“中文类型 + 中文业务名称 + 中文状态”；选择节点后，详情区首先显示业务描述、关键关系与 badge，再显示原始 type/status、ID、revision 和 digest。Edge 关系使用中文关系标签并保留英文 relation type。

### 7.2 Impact

路径优先解释“哪个业务对象可能影响哪个对象、为什么、风险是什么”；edge id、path id 和 digest 进入审计栏。语义候选仍明确标注为 Proposal，不能因中文描述看起来确定而改变其非权威地位。

### 7.3 Iterations

列表标题为“迭代业务目标或摘要”；详情展示七阶段进度、任务完成度、评估覆盖、blocker 和 snapshot 结果。Iteration ID、revision、source commit、ledger commit 与 digest 保留在审计区。

### 7.4 Evidence

优先说明“证明了什么、适用于哪个对象、当前是否新鲜、由哪个 Gate/Evaluation 产生”；输入摘要和 Evidence digest 位于审计区。stale、provisional 或 failed 必须同时使用文字和视觉 tone 表达。

### 7.5 Findings

Finding Group 显示中文问题摘要、severity、actionability、作用范围、成员数量和样本；membership digest 位于审计栏。处置按钮仍提交原始 `expected_digest`，中文标题不得参与组身份计算。

### 7.6 Live 与 Approval

Live Event 用中文说明当前阶段、正在做什么、最近心跳、预算和输出摘要，同时保留 event/run id。Approval Card 先解释“批准什么、允许什么、风险与范围”，再展示 object type、actor、request id 和绑定 digest。approve/reject/defer 继续绑定原始对象摘要。

## 8. 统一业务实体卡

所有视图复用以下视觉层级：

1. 顶部元信息：中文类型 / 英文技术类型；中文状态 / 原始状态。
2. 主标题：中文业务名称。
3. 正文：一到两段中文业务说明。
4. 语义 badge：风险、关系、覆盖、门禁、freshness 或 actionability。
5. 审计栏：短 ID、revision、短 digest，以及复制完整 digest 的按钮。

列表态可压缩正文，但不得只显示 ID。详情态显示完整业务说明和全部审计字段。窄屏使用单列，审计栏允许换行；不隐藏风险、状态或 digest 入口。

英文技术标签使用次级色和较小字号，但必须满足对比度和键盘可读性。复制按钮提供具体 `aria-label`，成功后通过 `role=status` 报告，不仅依靠颜色提示。

## 9. 错误处理与降级

- 缺少标题：使用“类型中文名 · 短 ID”。
- 缺少描述：使用该类型的固定中文说明。
- 未知类型或状态：同时显示中文“未知”与原始值。
- 扩展字段结构异常、递归过深或文本超限：忽略异常候选并继续下一个优先级。
- 单个实体投影异常：为该实体生成 fallback，不使整个 Read API 失败。
- 响应没有 `presentations`：UI 回退到现有技术展示，保证新 UI 可连接旧 Server。
- 复制 API 不可用：完整 digest 仍可在可聚焦的审计详情中选择，不影响读取与治理操作。

任何降级都不能修改原始对象、吞掉原始状态或把未知值翻译成已知业务结论。

## 10. 安全与兼容性

- 展示文本使用 `textContent`/DOM node 构造，继续禁止 `innerHTML`、`eval` 和外部资源。
- 不引入模型、翻译服务、网络字体、浏览器持久化或项目外数据源。
- 文本在进入 UI 前应用长度限制；服务端问题响应继续保持现有脱敏与大小上限。
- 所有写 API 的请求体、CSRF、Origin、actor 和 expected digest 约束不变。
- 原始 API 字段保持兼容；`presentations` 是可忽略的加法式侧车。
- 不需要 Schema migration、Ledger replay migration 或 Graph Cache rebuild migration。

## 11. 测试策略

### 11.1 单元测试

新增 `packages/dashboard/test/presentation.test.ts`，覆盖：

- 标题与描述字段优先级；
- allowlist、深度与长度限制；
- 中文词典的已知和未知值；
- 每种实体的固定回退说明；
- `derived_from` 与 `fallback`；
- badge tone；
- 相同输入的深相等与 canonical JSON 一致；
- 输入对象未被修改。

### 11.2 Read API 测试

扩展 `packages/dashboard/test/server.test.ts`：

- 原始记录字段与 digest 保持不变；
- 每个 presentation key 精确绑定 `id + digest`；
- Graph、Impact、Iteration、Evidence、Finding、Live/Approval 响应具有适用的侧车；
- 单条异常数据只产生 fallback，不导致 500。

### 11.3 Assets 与 Playwright

扩展 `packages/dashboard/test/assets.test.ts` 和 Dashboard E2E：

- 七个视图都显示中文业务标题或确定性回退；
- 英文技术类型、原始状态与短 digest 可见；
- 完整 digest 可通过键盘复制，并有可访问反馈；
- 未提供侧车时 UI 使用旧展示路径；
- 继续禁止 `innerHTML`、外部资源和浏览器持久化；
- 390px 窄屏单列、焦点可见、reduced motion 通过。

## 12. 验收标准

1. Atlas MVP 的 Graph、Impact、Iterations、Evidence、Findings、Live 和 Approval 不再以 digest 或技术 ID 作为主标题。
2. 所有实体首先显示中文业务名称和说明，并保留英文技术类型与原始状态。
3. 缺少业务字段的记录显示确定性中文回退，不出现空标题或模型生成内容。
4. 完整 digest 可复制，所有写操作仍绑定原始 digest。
5. Read API 原始事实与既有响应字段保持兼容。
6. 相同输入生成一致的 `BusinessPresentation`。
7. 未知类型、异常 extension 和旧 Server 均可安全降级。
8. Dashboard 单元、API、Playwright、security、pack smoke、`pnpm verify` 与 `pnpm test:release` 全绿。

## 13. 实施边界

本次实现只修改 Dashboard presentation/read/API/assets/tests 和相关中文文档。若实现中发现必须修改 Core Schema、Ledger、Graph record、Approval binding 或 Finding membership digest，必须停止并重新审查设计，不能把展示需求升级为权威数据迁移。
