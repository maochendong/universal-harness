# T24 capture 迁 protocol-1.1 coordinator dogfood 证据

日期：2026-08-21
端点：`https://api.deepseek.com/chat/completions`（OpenAI 兼容）
模型：`deepseek-v4-pro`
凭证：仓库根 `.env`（gitignored）的 `DEEPSEEK_API_KEY`
驱动：`scripts/dogfood-real-provider.mjs`（三档、两轮迭代、自动批准、不配置执行器）

## 迁移内容

capture 主流水线从 legacy 适配器桥切到 protocol-1.1 capture coordinator：
切片 1 生产装配（`managed-capture-coordinator.ts`，Capture-scope binding 编译
提交 + 七阶段真实 handler 组装）；切片 2 门控切换（`OrchestratorDependencies
.capture` seam：有 profile 记录且有 `model_providers` 的项目 capture 全程走
coordinator；无配置/无 profile 保持 legacy；缺槽位 fail-closed）。approval 桥
复用引擎决策账本（单一决策面、双侧幂等回放）；baseline digest 在批准前经
`expectedCaptureAcceptanceBaseline` 纯函数预推导，提交后重载比对，不等即
`binding_drift`。集成测试证明：Test 种子节点携带
`acceptance_criterion_id`/`criterion_semantic_digest`/`verifies`，design 阶段
`criterion_test_pairs` 非空（legacy 路径恒为空的缺陷随之消除）。

## 五轮 dogfood 排障（coordinator 路径首次真实运行）

coordinator 的确定性记录校验远严于 legacy 桥，每轮暴露一个「模型要逐字复制
的东西在 prompt 里不可见」的系统性缺口，修复方法统一为「可见化 + rubric
写死」：

| 轮次 | 暴露的关卡 | 修复 |
| --- | --- | --- |
| R1 | `intent_mismatch`：draft schema 要求 intent digest，prompt 只有 intent 正文 | prompt 注入 session-binding 项（intent_digest）；rubric 补逐字重述规则 |
| R2 | `invalid_source_binding`：bundle 源 digest 不可见、绑定规则未声明；`review dimension is not part of the rubric`：维度注册表不可见，契约散文误导 | session-binding 扩为完整绑定清单（intent + bundle 源 locator/digest）；review prompt 注入 rubric 全文项；prd-review 契约散文改写为「dimension_id 逐字来自 rubric 输入」 |
| R3 | `atomic_criterion`：复合验收准则被验收门禁拦下 | rubric 补原子性规则 |
| R4 | 原子性仍犯（模型用分号/换行写复合 outcome） | 规则精确化到校验器实际切分符（禁分号/换行/'以及'/'并且'/'and then'） |
| R5 | lite/standard 为暂时性 provider 故障（非 JSON 响应、300s 超时）；governed 到达验收门禁 | — |

## 终态

- capture 全链（proposal → validate → review → risk → acceptance 门禁）由真实
  模型驱动跑通：proposal/review 多次 consumed；验收门禁给出实质性领域判定
  （准则原子性拆分、blocking 开放问题须人类先答）。
- **剩余阻断全部是设计行为或暂时性故障**：blocking open question 与人工输入
  等待点是 coordinator 的核心价值（legacy 桥会静默放过）；seam 目前把这类
  等待点 fail-closed 为错误而非 input_required 表面，属后续切片（人工输入
  回路）。governed 档的原子性遵从与间歇超时属 prompt 迭代与端点抖动，用同
  一脚本可持续回归。
- legacy 面零变更：无 profile/无配置项目路径不动，全部既有 e2e 原样通过。
