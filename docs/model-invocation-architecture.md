# Managed 模型调用层架构

**状态**：现行（provider 实现与 CLI 装配已落地；流水线改接在制）
**日期**：2026-08-21
**范围**：PG-2 起的 managed capture 模型调用层；不改 Core schema，不改既有相位编排

本文描述 harness 内所有 LLM 调用的唯一受管路径：从 prompt 契约编译到
provider 调用的完整链路，以及多 LLM API 的接入管理方式。设计前提一句话：
**模型调用是带状态机、带证据链的一等公民，provider 是可替换零件**——任何
DAG 节点的模型槽位都不直接持有端点或凭据，只持有一个经解析的
`ManagedModelProviderPort`。

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
OpenAI 兼容 Provider（openai-compat-provider.ts）/ 未来其他实现
  ▼
DeepSeek / 任意 chat-completions 兼容 HTTPS 端点
```

关键不变量：

- **只收编译产物**：Runner 只接受 `CompiledPrompt` + 持久化 binding +
  invocation identity，永远不接受裸 prompt 文本；binding 与编译产物 digest
  漂移即 `binding_drift` 拒绝。
- **原始输出不落盘**：store 只保存 digest 与 locator；replay 命中时调用方
  以 `force_fresh` 恰好重跑一次来取值。
- **输出契约在 Runner 端验证**：provider 只回文本，`validateModelOutput`
  按 plan 时钉住的 output schema digest 严格校验（必须是单一 JSON 文档，
  无散文无围栏）。因此 managed 调用**不发 `response_format`**——这是它与
  LLM Judge 路径的本质区别，官方 DeepSeek 端点即可使用。

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

429/5xx 有界重试 3 次、固定退避；其它失败立即返回，不重试。

## 3. 多 Provider 接入管理

### 3.1 Provider Registry（runtime）

`provider-registry.ts` 把注册项解析到槽位：每个槽位（或端口标识）至多被
一个注册项声明，重复声明直接抛 `ProviderRegistryError`；至多一个
`is_default` 兜底所有未列出槽位；无覆盖槽位解析为 `undefined`，Runner 维
持 `provider_required` fail closed——不存在「忘了配就静默走某个默认
provider」。

### 3.2 配置面（CLI，`.harness/runtime.json` v2）

```json
"model_providers": [
  {
    "provider_id": "deepseek",
    "endpoint": "https://api.deepseek.com/chat/completions",
    "model": "deepseek-v4-pro",
    "api_key_env": "DEEPSEEK_API_KEY",
    "env_allowlist": ["DEEPSEEK_API_KEY"],
    "timeout_ms": 60000,
    "slots": ["design_review", "grounded_synthesis"],
    "default": false
  }
]
```

严格解析（`project-runtime-config.ts`）：`provider_id`/`slots` 必须是标识
符、端点过 Judge 同款校验（仅 HTTPS、禁 URL credential/query/fragment）、
`api_key_env` 必须在 `env_allowlist` 内、超时 1–300000ms、`provider_id` 不
得重复、default 至多一个。v1 配置声明本节直接报错。凭据只存在于运行进
程的环境变量；与 agent-dsh 复用 `DEEPSEEK_API_KEY` 是合法且预期的用法。

### 3.3 装配（CLI `model-providers.ts`）

`assembleModelProviders(config)` 把配置变成 resolver：

- `provider_identity` 派生为 `provider_<provider_id>`；
- `config_digest` 只覆盖无密字段（endpoint origin、model、timeout、slots、
  is_default）——凭据材料永不参与 digest；
- `budget_profile` 固定 `managed-standard`，预算默认值见
  `capture-adapters.ts` 的 `DEFAULT_BUDGET`（60s / 256KiB）。

## 4. 与 LLM Judge 的边界

两者都是 OpenAI 兼容调用，但职责不同、不共享配置：Judge 是**验证相位的
门禁**（strict json_schema、pass/warn/fail、mandatory 需 Policy+Approval），
managed provider 是**各 DAG 节点的模型能力供给**（输出契约在 prompt 里、
Runner 端验证、槽位制解析）。安全姿态（端点校验、allowlist 凭据、SSRF
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
| capture/design/impact 流水线改接 model-backed 适配器 | **在制** | 生产流程仍走 legacy 适配器；resolver 尚未被流程消费 |
| 真实 Provider dogfood（带凭证端到端） | 待外部条件 | 需要有效 API key 与外网；模型 ID 以端点实际接受为准 |

「在制」项完成前，本文状态保持「现行（部分在制）」；改接落地后更新本表
并把状态改为「现行」。
