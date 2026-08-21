# T20 真实 Provider dogfood 证据

日期：2026-08-21
端点：`https://api.deepseek.com/chat/completions`（OpenAI 兼容）
模型：`deepseek-v4-pro`（经 `/models` 确认真实存在）
凭证：环境变量 `DEEPSEEK_API_KEY`（只有变量名进入配置，密钥不落地）
驱动：`scripts/dogfood-real-provider.mjs`（三档 profile 各建一个临时项目，自动批准、不配置执行器——执行层不在本次验收范围）

## Before / After

首轮（基线）三档全部在 capture 相位 fail-closed：`invalid_output`——编译后的
提示词只引用 output schema 的 id/digest，模型看不到 schema 本体，自由发挥了
字段名。dogfood 同时暴露两个工程缺口：Runner 内置 60s 预算先于配置的超时
生效；legacy orchestrator 在 resume 时重跑解释器，模型非纯函数导致
binding_drift 风险。三项修复随 `ef2d9e4` 落地（schema 全文嵌入 output_contract
分区、`timeout_ms` 贯通 invocation budget、capture memo 使 resume 重导出
确定性重放），下表为修复后的重跑结果。

## 修复后三档结果

| Profile | 受管调用（port / purpose → 最终状态） | 领域结果 |
| --- | --- | --- |
| lite | `prd_proposal` → consumed；`grounded_synthesis:context_enrichment` → validated | 第一轮（无模型）完整跑到 snapshot；第二轮 capture 由真实模型产出 schema 合法草案并被消费；enrichment 输出 schema 合法但引用 digest 与 bundle 源不匹配，citation_invalid fail-closed（投影层阻断，确定性 bundle 不受影响） |
| standard | `prd_proposal` → consumed；`design_proposal` → consumed；`impact_advisory` → validated | capture 由真实模型产出并被消费；impact advisory 输出未通过 merge 校验，确定性影响集照常推进（advisory 永不改写确定性结果）；design proposal 被真实模型消费后返回结构化澄清要求（见发现 2），相位按契约 typed block |
| governed | `prd_proposal` → consumed（重试） | 首轮 300s 超时为暂时性；重试后 capture 由真实模型产出并被消费。随后 impact advisory 在准备期 fail-closed：`prompt_size_exceeded`——governed 产出的节点更多，advisory 输入（整图节点 canonicalize 为单个 untrusted item）超过 32KB 单项预算（见发现 3） |

每条受管调用都有完整的 ModelInvocationRecord 状态链
（planned → started → completed → validated → consumed/failed）、独立
conversation/run 身份、prompt 契约 id@version 与全部 digest 绑定；原始记录由
脚本输出（`invocations` 字段），本文件不复制密钥与提示词原文。

## 发现与处置

1. **已修复（`ef2d9e4`）**：output schema 不进提示词；invocation budget 不随
   配置；resume 重导出漂移隐患。修复后真实模型输出在 lite/standard 两档被
   完整消费（schema 校验 + 引用校验 + 状态机闭环）。
2. **后续（T21 候选）**：design 端口的编译输入只带 digest/id，真实模型无法
   凭 digest 做设计——它正确地提出了澄清（要需求正文、影响集图内容、
   criterion/test 对内容）。需要 design input compiler 携带内容后重跑 design
   相位 dogfood。
3. **后续（T21 候选）**：流水线端口的输入编译需要保真且省量——
   enrichment 引用 digest 不匹配（citation_invalid）；governed 档 impact
   advisory 把整图节点打成单个 untrusted item 超过 32KB 预算
   （prompt_size_exceeded）。两者同源：给模型的输入既缺内容又缺分项/裁剪
   策略，随发现 2 的 input compiler 工作一并解决。

## governed 重试

首轮 capture 在 300s 配置上限超时（`provider call exceeded 300000ms`，单次
尝试即失败、不重试，符合 Runner 语义）；原样重试一次后 capture 正常完成并
被消费，确认为端点响应时间抖动而非系统性问题。重试随后暴露发现 3 的
advisory 尺寸问题。

## T21 第二轮：design/impact/review 真实输入保真

针对发现 2/3 的修复（`4aade1b`：advisory 整图分项、design 端口携带
must-change 需求与 criterion/test 节点的 canonical 内容）后，重跑
standard/governed 两档（lite 按 profile 定义不启用 design/impact 模块，零调用
即正确行为）：

| Profile | 端口表现 | 领域结果 |
| --- | --- | --- |
| standard | `prd_proposal` consumed；`impact_advisory` 编译/调用成功（分项后尺寸合规），输出 fail-closed（模型给 `risk_signals` 元素加了 schema 外字段）；`design_proposal` consumed | 设计草案通过 schema 与引用校验并被消费、落盘留痕；确定性设计校验 fail-closed：`applicability_gap`（模型未给每个 must-change 需求输出 TDD applicability 条目），相位 typed block，草案记录完整保留 |
| governed | `prd_proposal` consumed | capture 草案被消费后，capture 硬门禁 fail-closed：「requirement 5 has no acceptance criteria」（governed overlay 下模型漏了一条需求的验收准则）；未进入 design |

结论：design/impact 端口的模型接入层（编译、调用、schema 校验、merge/确定性
校验、状态机闭环、fail-closed 语义）在真实 provider 下全部按设计工作；剩余
差距是模型对严格领域规则的逐条遵守（applicability 全覆盖、每条需求必有验收
准则、不输出 schema 外字段），属于 prompt 契约迭代范畴，每一轮改进都可用
同一 dogfood 脚本回归验证。
