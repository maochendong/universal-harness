# Managed 模型调用层架构

**状态**：现行受管调用架构；Jev 可选接入的实施与验证状态见[本地验收记录](evidence/jev-impact-advisory-acceptance.md)，不把既有 DeepSeek dogfood 算作 Jev 验证。
**日期**：2026-09-28
**范围**：PG-2 起的受管模型调用层，含可选 Jev Impact Adapter；Jev 新增内部输出 Schema 注册项，不改变已有持久化记录形状或公共相位。

本文描述 harness 内所有 LLM 调用的唯一受管路径：从 prompt 契约编译到
provider 调用的完整链路，以及多 LLM API 的接入管理方式。设计前提一句话：
**模型调用是带状态机、带证据链的一等公民，provider 是可替换零件**——任何
DAG 节点的模型槽位都不直接持有端点或凭据，只持有一个经解析的
Provider。普通槽位使用 `ManagedModelProviderPort`；Jev Impact 分支先绑定本次 typed request，再产生同一端口的单次调用实现。

## 1. 分层

```text
DAG 节点模型槽位（grounded_synthesis / design_review / impact_advisory / ...）
  │  ModelBackedAdapterDeps{ provider, provider_config }（装配时注入）
  ▼
Managed Runner（packages/runtime/src/model/managed-runner.ts）
  状态机 planned → started → completed → validated → consumed
                ↘ failed / invalidated（每个迁移先落库再走下一步）
  │  ManagedModelProviderRequest{ messages, output_schema_id, timeout_ms, max_output_bytes }
  ▼
ManagedModelProviderPort（端口，managed-runner.ts:42）
  │  按槽位经 Provider Registry 解析
  ▼
OpenAI 兼容 Provider / Jev typed request Provider
  ▼
宿主信任的 chat-completions 端点 / TypeSafe System One 固定端点
```

关键不变量：

- **只收编译产物**：Runner 只接受 `CompiledPrompt` + 持久化 binding +
  invocation identity，永远不接受裸 prompt 文本；binding 与编译产物 digest
  漂移即 `binding_drift` 拒绝。
- **原始输出不落盘、验证结果可重放**：provider 原始文本不落盘；Runner 只把
  通过钉住 Schema 的结构化值写入不可变 result artifact，store 保存其 digest
  与 locator。replay 必须读取并复核同一 artifact，调用方不能强制再次调用模型。
- **输出契约在 Runner 端验证**：provider 向 Runner 返回序列化结构化值，`validateModelOutput`
  按 plan 时钉住的 output schema digest 严格校验（必须是单一 JSON 文档，
  无散文无围栏）。OpenAI-compatible managed 调用**不发 `response_format`**；
  Jev 则使用 System One 的 `state + questions`，先校验 Choice 分布及用量，再由
  Runner 校验 `jev-impact-judgments`。不能把 System One 当作 chat-completions 换 URL 使用。

## 2. 失败语义

provider 实现把 transport 事实归一到协议固定的 `ModelPortFailure` 码
（`packages/core/src/schema/model-invocation.ts`），原始 prompt/输出文本
永远不进入 failure：

| 事实 | 码 | retryable |
| --- | --- | --- |
| 端点非 HTTPS / 含 credential / 私网地址 / DNS 私网解析 | `policy_denied` | 否 |
| key 未进 env_allowlist | `policy_denied` | 否 |
| key 缺失 | `provider_unavailable` | 否 |
| HTTP 4xx（非 429） | `provider_unavailable` | 否 |
| 429 / 5xx 重试耗尽、网络失败、DNS 失败 | `provider_unavailable` | 是 |
| 超时（AbortController，配合 Runner 侧 Promise.race 双保险） | `timeout` | 是 |
| 响应超字节上限 | `budget_exhausted` | 否 |
| 响应非 JSON / 无文本 content | `invalid_output` | 否 |
| 未配置 provider | `provider_required`（Runner 侧） | 否 |

上述 429/5xx 有界重试 3 次仅适用于原 OpenAI-compatible 实现。Jev 每次 invocation 只发送一次 HTTP 请求，禁止重定向、自动重试和自动换模型；外部结果不明时局部恢复 guard 阻塞，显式新 attempt 才允许新调用身份。成功结果按原始结果引用验证回放，缺失或损坏时不能以重新请求掩盖证据缺口。

## 3. 多 Provider 接入管理

### 3.1 Provider Registry（runtime）

`provider-registry.ts` 把注册项解析到槽位：每个槽位（或端口标识）至多被
一个注册项声明，重复声明直接抛 `ProviderRegistryError`；至多一个
`is_default` 兜底所有未列出槽位；无覆盖槽位解析为 `undefined`，Runner 维
持 `provider_required` fail closed——不存在「忘了配就静默走某个默认
provider」。

### 3.2 配置面（CLI，`.harness/runtime.json` v3）

```json
{
  "runtime_config_version": 3,
  "gates": [],
  "model_providers": [
    {
      "provider_ref": "deepseek",
      "model": "deepseek-v4-pro",
      "timeout_ms": 60000,
      "slots": [],
      "is_default": true
    },
    {
      "provider_ref": "typesafe",
      "model": "jev-1.13.0",
      "timeout_ms": 30000,
      "slots": ["impact_advisory"],
      "is_default": false
    }
  ]
}
```

仓库只提供引用；端点、Provider identity、环境变量白名单和 consumer 权限由宿主 trust registry 决定。v3 严格拒绝额外 endpoint/key 字段；v2 非 Jev inline 声明保留兼容，但必须精确匹配宿主策略。v1 不接受 `model_providers`。

TypeSafe 固定 `provider_typesafe`、`https://api.typesafe.ai/v1/systemone`、`TYPESAFE_API_KEY`，consumer 仅 `managed_model`；固定模型 `jev-1.13.0`，只允许 `impact_advisory`，不得作为 default 或经 v2 启用。项目不会被自动改配。回退是显式移除 Jev 槽位绑定并重新编译/审批，不是失败后的静默 fallback。

### 3.3 装配（CLI `model-providers.ts`）

`assembleModelProviders(config)` 把配置变成 resolver：

- `provider_identity` 来自宿主信任策略；
- `config_digest` 覆盖无密配置与信任策略摘要；仅 Jev 增加传输、投影、映射、限制版本，不轮换旧 Provider 摘要。凭据材料永不参与 digest；
- `budget_profile` 固定 `managed-standard`，预算默认值见
  `capture-adapters.ts` 的 `DEFAULT_BUDGET`（60s / 256KiB）。

resolver 使用有限判别联合：`managed_prompt` 保持旧 `provider.invoke`，省略 kind 的旧注册按此归一；`jev_impact` 提供 `bind(typedRequest)`。两者共享配置和预算，不增加第二套注册表或 dummy invoke。CapabilityPlan 编译与运行装配共用 kind→contract selector，非 Impact consumer 拒绝 Jev 分支。

### 3.4 Jev：给定候选的辅助判断

Jev 使用独立 alias `impact_advisory.jev.v1` 和输出 Schema `jev-impact-judgments`。请求及影响集/规则/候选摘要共同进入编译 input bundle；闭包校验同一绑定后只发送已批准范围的业务投影，不从展示 prompt 反解析。权威指令、Profile/Policy、问题与 criteria 均参与摘要。

最多 20 个候选、canonical UTF-8 state 最多 16 KiB；超限直接阻塞。Component/CodeArtifact/扫描 Test 的首版业务投影不支持，须切换 Provider，不能拿 locator 或文件哈希代替行为契约。支持类型缺业务字段则补证；空候选才可零调用并保留本地诊断。

成功提议的本地范围诊断（含零候选）记录候选数和排除原因计数，复用原阶段 artifact 提交；不添加公共事件或 Invocation，不把“未评估”解释为“无影响”，也不将排除节点内容加入外发 state。

原始 choice、完整概率、供应商 confidence、token 用量与 Harness 绑定元数据留存于不可变结果文件。明确 affected 只产生引用完整的 `inspect`，风险不低于确定性基线；unrelated 不删原条目；insufficient 或低置信结果阻塞，不部分合并。离散建议强度不是工程正确率；整体 ImpactSet 仍经人工审批。

失败/补证传播到原 impact 状态与恢复入口，不新增公共 phase 或审批类型。Dashboard 在 Live 展示项目级模型调用记录，不以不含 operation 关联的记录冒充当前迭代证据。详见[配置与恢复限制](operations.md#51-jev-适用范围与恢复)。

## 4. 与 LLM Judge 的边界

原 managed OpenAI-compatible 实现与 Judge 虽使用类似传输，但职责不同、不共享配置：Judge 是**验证相位的
门禁**（strict json_schema、pass/warn/fail、mandatory 需 Policy+Approval），
managed provider 是**各 DAG 节点的模型能力供给**（输出契约在 prompt 里、
Runner 端验证、槽位制解析；Jev 另走受限 System One 协议，不可装配为 Judge）。安全姿态（端点校验、allowlist 凭据、SSRF
防护）刻意保持一致；endpoint 校验逻辑目前在两处各有一份实现，是有意的
包间解耦（runtime 不依赖 adapter），变更时需同步审视。

## 5. 状态表

| 组件 | 状态 | 证据 |
| --- | --- | --- |
| Managed Runner 状态机与 invocation store | 已完成（PG-2） | `managed-runner.ts`；fault/security 套件 |
| Prompt 契约注册表与编译器 | 已完成（PG-0/1） | `prompt-registry.ts`；golden 矩阵 33 行 |
| Provider 端口 `ManagedModelProviderPort` | 已完成（PG-2） | `managed-runner.ts:42` |
| OpenAI 兼容 provider 实现 | 已完成（77d0131） | `openai-compat-provider.ts`；12 例单测 |
| 槽位 registry | 已完成（77d0131） | `provider-registry.ts`；5 例单测 |
| `model_providers` 配置解析与 CLI 装配 | 已完成（77d0131） | `project-runtime-config.ts`、`model-providers.ts`；8 例单测 |
| capture 改接（prd_proposal → managed 解释器） | 已完成（e7475ad） | `managed-interpret.ts`；8 例单测 |
| design/impact/enrichment/narrative 改接 | 已完成（2ee8f84） | `managed-pipeline-ports.ts`；3 例 runtime + 7 例 CLI 测试 |
| plan_proposal 改接 | 已完成（f62327e） | `model/plan-adapters.ts` + `managed-pipeline-ports.ts`；3 例 runtime + 1 例 CLI 测试 |
| capture 迁 protocol-1.1 coordinator | 已完成（切片 1 装配 + 切片 2 门控切换） | `managed-capture-coordinator.ts` + `orchestration/capture-coordinator.ts`；有 profile 且有 model_providers 的项目 capture 全程走 coordinator，approval 桥复用引擎决策账本，4 例集成测试 |
| feedback_analysis 生产接线 | 未开始 | 全仓无消费点（orchestrator/CLI 都不调用 `FeedbackAnalysisPort`）；随 T17 反馈回路建设落地 |
| prd_review / project_discovery / approval_brief 生产接线 | 已完成（随 coordinator 迁移） | 三槽位经 Capture-scope binding 由 coordinator 消费；`slot_unresolved` fail-closed |
| 真实 Provider dogfood（带凭证端到端） | 已完成（ef2d9e4 + 证据文档） | `docs/evidence/t20-real-provider-dogfood.md`；三档跑通 deepseek-v4-pro，产出 3 项修复与 T21 候选事项 |

改接落地后本表已更新；capture 的 protocol-1.1 coordinator 迁移完成后，三个
Capture-scope 槽位已接线生产，legacy 桥仅服务无 profile 记录的 pre-1.1 项目。
