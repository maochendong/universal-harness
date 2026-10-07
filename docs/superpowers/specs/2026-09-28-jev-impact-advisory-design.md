# Jev 可选影响辅助判断 Adapter 设计

状态：用户已于 2026-09-28 确认正式设计并选择子代理驱动实施；J1–J3 代码与 Mock 闭环已交付，2026-10-03 最终全量 442 files / 3,570 tests 通过，交叉复审问题关闭。2026-10-07 用户另行授权提交并推送，真实 Provider 仍未验证。聚合 verify 仍受既有技能文件格式项阻塞，不能宣称全部发布门禁通过。详见[本地验收记录](../../evidence/jev-impact-advisory-acceptance.md)。

日期：2026-09-28。核对基线：`fc14fc9ba4314b9ae3051f4d9eea72a3dee2ecdc`。

## 1. 决策与边界

新增可选 Jev 实现，复用 `ImpactAdvisoryPort` 和 `impact_advisory` 模型槽位。项目显式选择后，仅评估已给定候选、提出 `inspect` 增补；不默认修改任何项目配置。现有生成式 Adapter 保留，可通过配置切回，但不运行双模型串联或自动 fallback。

不改确定性 BFS、18 种关系传播规则、现有条目、风险下界和人工审批；不创建新的公共 phase、节点/边类型、模型槽位、候选检索系统或通用 Provider 插件框架。Jev 不负责生成代码、设计、新关系或开放式风险解释。`edge_candidates`、`risk_signals` 首版为空，这是能力收窄，不是原有生成式实现的等价替换。

实现仍受以下已有设计约束：

- [模型 Advisory 设计](2026-08-19-model-advisory-adapters-design.md)：结构化、additive-only、Profile 约束和受管调用。
- [Prompt Governance 增补](2026-08-20-prompt-governance-addendum-design.md)：绑定、编译、隔离、来源校验和调用恢复。

本轮探索验证的边界：19 次成功调用，17 个非重复探针与暂定参考标签吻合 15 个；2 例缺契约被判断为无关。标签不是人工金标准，也未验证生产候选召回。它支持继续接入试验，不支持自动裁剪确定性影响集合。

## 2. 接入位置与宿主配置

```text
确定性 ImpactSet + 当前图节点
  → 受控候选/业务字段投影
  → Jev 专用 PromptContract 编译
  → 现有 ManagedInvocationRunner → TypeSafe System One
  → 保存真实结构化判断 → 确定性映射/既有 merge 校验
  → 需补证则暂停；否则增补 inspect → 整体 ImpactSet 审批
```

宿主注册 `provider_ref: typesafe`、`provider_identity: provider_typesafe`，固定 HTTPS endpoint `https://api.typesafe.ai/v1/systemone`，仅允许读取 `TYPESAFE_API_KEY`，consumer 仅 `managed_model`。初版固定模型 `jev-1.13.0`，禁止 alias 漂移。仓库仍只提供 V3 引用配置，不可指定任意 URL、凭据文件或传输实现。

以下是**在现有 `model_providers` 数组中增补的条目**，不是完整项目配置：

```json
{
  "provider_ref": "typesafe",
  "model": "jev-1.13.0",
  "slots": ["impact_advisory"],
  "is_default": false,
  "timeout_ms": 30000
}
```

保留现有默认 Provider 和其他槽位。原 Provider 若显式占用 `impact_advisory`，只移除那一条映射；重复槽位仍报错。TypeSafe 初版不得作为 default、不得绑定其他槽位，不支持通过 V2 inline endpoint 启用；已有 V1/V2/其他 V3 Provider 行为不变。

唯一装配链仍为 `assembleModelProviders → createManagedProviderResolver`。接入前的工厂只支持 OpenAI chat，因此不能只换 URL。内存 Registration/Resolved 类型增加有限判别：

- `managed_prompt`：保留现有 `provider.invoke`；旧注册未提供 kind 时按此分支归一。
- `jev_impact`：提供 `bind(typedRequest)`，返回本次调用专属 `ManagedModelProviderPort`。无 dummy invoke，无共享历史。
- 两分支共享 `provider_config` 与 `budget`；仍由同一个 resolver 处理显式槽位优先、默认项和重复配置。非 Impact consumer 必须拒绝 `jev_impact` 分支。

CapabilityPlan 编译与运行装配使用同一个 Provider-kind→contract selector，不能一端绑定旧 `impact_advisory.v1`、另一端实际调用 Jev contract。Provider 配置摘要纳入传输、投影、映射与限制版本；不含 key 的值。

## 3. 首版候选与外发数据

### 3.1 不增加检索系统

候选来源固定为本次 `ImpactAdvisoryInput.nodes`，排除已经在 `deterministic_entries` 中的 ID；只接受状态为 `accepted` 的 `Requirement / Constraint / Decision / Component / CodeArtifact / Test / DesignArtifact`，按 node ID 确定性排序。`proposed / superseded / tombstoned` 及其他类型明确为本 Adapter 未评估范围，记录排除数量和原因，不代表无影响。

范围诊断在成功提议（含零候选）中随阶段产物保存：`candidate_count`、`excluded_count` 和 `excluded_by_reason`，三个互斥原因依次为 `already_deterministic`、`not_accepted`、`unsupported_type`。合计必须覆盖当前输入节点，不能重复计数；仅保存计数，不外发被排除节点正文，不改变领域摘要。失败或补证继续留原 typed 原因，不伪造一次成功评估。诊断复用已有本地 artifact，不新增公共 Schema、事件或 Invocation。

变更语义来自本次主种子节点的 Intent/Requirement 业务字段；不让 Jev 从 digest 猜需求，也不把当前快照冒称 Git 前后差异。当前 Port input 没有 seeds 字段，初版按现有单 Intent 种子的调用路径，从 `deterministic_entries` 定位唯一 `path.length === 0` 且类型为 Intent/Requirement 的条目，再按 ID 解析节点；不解析 reason 文本猜种子。零个、多个或其他类型的主种子属于本版不支持的输入，调用前拒绝，不能择一继续。引用必须能在当前输入按 ID 与 digest 解析；重复 ID、相互冲突的 revision/digest 同样拒绝。

使用以下确定性白名单；表中路径均位于节点 `extensions` 内。引用绑定原节点 ID/revision/digest，并记录实际采用的字段路径；不递归搜任意同名字段、不读取 locator 指向的本地文件、不整包发送 extensions 或源码。

| 节点/用途 | 首版业务投影 |
| --- | --- |
| Intent（主变更上下文，不作增补候选） | `harness.requirements.text` |
| Requirement | `harness.requirements.statement`；已存在的 legacy `harness.requirements.acceptance[].description/verification` |
| Constraint | `harness.requirements.statement/category/verification_intent`；legacy `harness.requirements.verification` |
| Test | `harness.requirements.observable_outcome/verification_intent/verifies`；legacy `harness.requirements.description/verification`。`verifies` 仅为关联引用，不能单独算作业务内容 |
| Decision | `harness.decision.summary`，兼容已有设计测试样例使用的扩展；不声明它已是全局强制 Schema |
| DesignArtifact | 验证 `harness.design.artifact` 符合现有 `design-artifact-content` 后，取 `artifact_kind/title/summary/assumptions/acceptance_implications`；API body 取 `protocol/operations/inputs/outputs/errors/compatibility`，数据 body 取 `entities/constraints/invariants/migrations/compatibility`，测试 body 取 `scenarios/test_levels/required_gates/required_evidence`，UI body 取 `user_flows/key_states/error_states/accessibility` |
| Component / CodeArtifact，或扫描生成而非需求生成的 Test | 当前未确认统一的业务内容字段；locator、`harness.scan` 的分类/语言/哈希/API 名称不能代替行为契约。首版标记 `unsupported_projection`，不据此推断 |

这意味着接管扫描生成的图不一定能直接用于 Jev 判断；仅注册 Provider 不等于具备足够上下文。本次不为填满字段而新增统一业务属性 Schema，也不从其他图节点借用未证实属于该候选的契约。遇到 `unsupported_projection` 时整次调用前阻塞、零网络调用：这是 Adapter 能力不支持，**本版不能靠补证恢复**，明确引导切回原生成式 Adapter 或等待后续投影版本，不显示循环补证入口。

只含 ID/digest/类型而没有业务内容的节点记为本地缺失原因 `missing_business_content`（不是新增 ModelPortFailure code）。发现这种结构性缺失时，调用前直接返回补证问题、零网络调用，不花费预算让模型猜测。字段非空只是结构完整，不能证明依赖契约充分；提示词仍必须允许 insufficient，调用结果也要保守处理。缺来源的判断不得通过补造引用进入结果。

### 3.2 有界、可审计

初版最多 20 个候选，完整 canonical UTF-8 state 最多 16 KiB；这属于本 Adapter 的工程限制，不是供应商能力上限。超过边界直接返回可见的预算/准备失败，**不静默截断、不按名称取前 20 个、不自动分批追加费用**。大图可能因此无法使用本实现，可在新配置绑定下切回原生成式 Adapter；这项可用性代价必须在 CLI/文档明示。

外发 state 仅包含脱敏主变更摘要、候选 ID/类型/业务描述、必要契约片段及来源引用，不包含 actor、时间戳、绝对路径、密钥、原始 transcript、原始日志或完整仓库。白名单投影后还须通过既有 source boundary；补充 TypeSafe key 格式识别，拒绝而不是清洗后冒充完整输入。

候选为空且主输入有效时，本地返回空增补、零网络调用；保留阶段级“无候选可评估”记录，不伪造模型 Invocation。缺少业务内容的候选不能当作空候选集合跳过。

## 4. 调用、原始判断与领域映射

### 4.1 一个受管请求

遵循 TypeSafe 当前 [API](https://docs.typesafe.ai/api) 与 [Choice](https://docs.typesafe.ai/primitives/choice)：单次 `POST /v1/systemone`，结构化 `state + questions`；每个候选一个独立 Choice，选项固定 `affected / unrelated / insufficient`。每个问题正文引用对应候选，不能依赖 question ID 向模型传递语义。

Jev 专用 alias `impact_advisory.jev.v1` 与 contract `harness:prompt:jev-impact-advisory@1.0.0` 注册在既有 `impact_advisory` scope。新增内部用途输出 Schema `jev-impact-judgments`，注册到当前输出 Schema registry；不改已有持久化记录形状，也不引入 Schema DI 框架。它是新增 registry 条目，不应宣称“完全没有 Schema 变化”。

Adapter 在每次 advise 中构造唯一 typed request，把同一请求的 canonical 内容及影响集/规则/候选绑定编入受控 input bundle，再创建捕获它的单次 Provider closure 交给已有 runner。权威指令、Profile/Policy 规则、完整问题及 criteria 均参与编译摘要；禁止藏在未绑定的模板中。closure 必须校验本次请求与编译绑定一致，禁止从展示 prompt 反解析输入，也禁止向 runner 传入另一份未绑定的 payload。

继续复用独立 invocation/conversation/run identity、预算、取消、source boundary、结果校验、缓存和恢复。HTTP 禁止重定向；不安装会自动重试的 SDK；本次 invocation 只有一次 HTTP 尝试，不自动改模型。timeout、429/5xx、认证失败、非法输出均归一为现有 typed failure；错误不带认证头或响应正文。

### 4.2 原始结果可回放

`jev-impact-judgments` 保存：固定 model、原始 answers（choice、完整 probabilities、供应商 confidence）、原始 input/output token 用量，以及本地附加的 request/candidate-set digest 与映射版本。标明哪些字段来自供应商，哪些由 Harness 添加；不伪造供应商推理文本。

Schema 和语义检查共同验证：模型版本、候选/问题集合完全匹配、每项唯一、选项合法、概率和供应商 confidence 均为 [0,1] 内的有限数、概率和与 1 的绝对差不超过 0.002、choice 属于最高概率项（允许并列）、用量为非负整数。0.002 是为响应小数舍入保留的本地验证容差，不重归一化或改写供应商分布。多出/缺失候选、未知模型或畸形分布使整个调用失败，不部分合并。

已有 runner 将该结构化结果写入不可变 `model-results` 并绑定 invocation。随后用纯函数映射为原有 `ImpactAdvisoryOutput`，再通过既有 schema 与 merge 校验才 consume。缓存回放使用原始已验证结果，映射版本变化必须失效旧 binding，不能复用旧结果解释为新规则。

### 4.3 显式映射与置信度限制

首版采用保守工程起点：所选项概率与供应商 confidence 均至少 0.8 才视作明确选择；该数值**未经生产校准**，不能宣称是影子样本证明的最优阈值，修改时须版本化并使 binding 失效。

| 情况 | 有效领域结果 |
| --- | --- |
| 缺业务内容/必要来源，或输出 insufficient，或未达到明确选择门槛 | missing_facts/questions，要求补证；不得当作 unrelated |
| 明确 affected，来源有效 | 仅产生引用完整的 inspect addition |
| 明确 unrelated，未发现结构性缺失 | 本次不增补该节点；原候选判断保留可复核，不删除任何已有节点、边或确定性 entry |

只要本次有需要补证的问题，阶段不部分合并其他 additions，也不发 ImpactSet ApprovalRequest。充分性不确定是领域补证问题，与网络失败分开显示。

新增项 risk 由本地已有风险顺序保守取本次确定性条目的最高风险；无可用基线则拒绝，不让 Jev 评风险。reason 使用固定中文模板与来源，不冒充模型生成的因果证明。`edge_candidates` 与 `risk_signals` 均为空。

现有 `ImpactCandidate.confidence` 会进入 ImpactSet 语义 digest，不能假称它是纯调用元数据。为保留该协议字段而不直接复制供应商 confidence，首版明确约定：新增 inspect 项的 confidence 是**离散的建议强度**，取 `min(0.9, floor(10 × p(affected)) / 10)`；不是校准后的工程正确率，不赋值给 Graph Node/Edge 的 confidence，不覆盖确定性条目的 confidence。模板及展示必须标明其来源，不能显示成“已证明影响概率”。

这个离散领域分数随 addition 进入语义 digest；完整概率、供应商 confidence、用量、延迟、调用身份只在调用结果留痕。领域分数改变需重新审批，纯调用元数据改变不应另行改变 ImpactSet。这里是兼容既有协议的显式取舍，并非声明“概率完全不影响领域结果”。

## 5. 失败、暂停与审批

当前 `impact-contributor.ts` 会把 failed/clarification-only 折回原 ImpactSet；missing_facts/questions-only 也会被忽略。它与既有 model slot 的 `failure_mode: block` 不一致，本次只修 Impact 结果传播，不改其他槽位。

- Lite 未激活/未装配 advisory：保持纯确定性、零模型调用。
- 已启用 advisory（包括 Lite 显式启用）：调用失败或 merge 校验失败必须在 impact 阶段阻塞并保留失败信息，不静默退回确定性成功路径。
- 需要补证：使用现有 missing_input/blocked 与 resume phase=impact，展示候选 ID、缺失内容和恢复入口；不新增澄清状态机、审批种类或按候选逐次审批。
- 输入形态或投影不支持：与可补证的缺字段分开显示，指向配置切换；不能提示在当前版本无限重试。
- 信息修订经现有 Capture/Graph 流程形成权威事实；若批准基线漂移，遵守现有失效/重开规则，不能直接编辑冻结产物后强行 resume。
- 同一输入上的成功结果复用；failed 或外部结果不明不能无痕重发。显式重试、输入/映射/配置变化时，创建可追溯的新 attempt 及 invocation/run/conversation identity；可由 attempt 与 binding digest 确定性派生，不能继续沿用仅按 workflow 固定的 conversation。绑定内容变化时重建 binding，保留旧记录，不在原 invocation 上修改 digest；不承诺供应商 exactly-once。
- 有效结果通过 merge 后，仍随整体 ImpactSet 审批；不得模型自批。现有 Dashboard/CLI 显示阻塞原因、Provider、用量和结果引用，本轮不增加独立 Jev 页面。

## 6. 验收与实施范围

测试只在以下公开入口/可替换接口开展，Mock HTTP 为默认；文档确认同时确认这些测试入口：

1. **配置与装配**：V3 显式 impact→Jev，其余槽位维持原 Provider；重复绑定/全局 default/越槽/V2 Jev 引用拒绝；旧配置兼容。
2. **Jev ImpactAdvisoryPort**：单主种子与不支持的种子形态、权威/legacy 字段投影、来源 digest、无内容、不可补证的投影类型、空候选、20/21 候选、16 KiB 边界；只发送同一个已编译绑定的请求。
3. **受管调用**：真实 System One request 形状、一次请求、多 Choice、取消/超时/认证失败/429/5xx、未知模型、缺多答案、NaN/错误概率、密钥和用户路径拒绝。
4. **结果映射与持久化**：原始分布不改写；明确 affected 只生成 inspect；unknown 不伪装 unrelated；离散分数与 risk 本地派生；越权、引用失效拒绝；成功缓存回放、失败后的新调用身份、映射版本失效与会话隔离。
5. **Impact 阶段**：已启用 Provider 失败/补证阻塞；未装配保持原路径；无未解决问题时才申请整体审批；确定性条目逐项不变；不增加额外人工批准次数。

重点增改位置：runtime 的 Jev Adapter/传输与现有 resolver；graph 的专用 prompt contract；core 的内部输出 schema 注册；CLI 的 host trust/装配、CapabilityPlan contract 选择；Impact contributor 的失败与补证传播。文档补配置与能力限制，不重构无关部分。

验收不以全部 Mock 通过宣称生产可用：还须验证真实图输入的候选规模/字段质量、与受管 runner 的小范围闭环。付费调用另按明确预算和脱敏范围执行；此前 1 美元是那一轮验证的上限，不能视作无限期生产授权。本次设计工作不调用付费 API，不提交或推送。

## 7. 未承诺与下一步

未承诺自动找全遗漏对象、优于 BFS、生产误报/漏报率、长期延迟 SLA，或支持复杂开放式关系/风险发现。全图候选超过上限、中文长契约、权威字段缺失都可能限制可用性；先把这些限制做成可见结果，不在首版追加检索、分批、多模型裁决等机制。

实施方式：按[实施计划](../plans/2026-09-28-jev-impact-advisory-implementation-plan.md)由子代理依次完成受管调用、领域映射、CLI/阶段接线三个纵向任务；每个任务先测试失败再实现，完成后独立复审和有界验证。原实施授权不包含付费调用、提交或推送；2026-10-07 已单独取得提交与推送授权，仍不含付费调用。
