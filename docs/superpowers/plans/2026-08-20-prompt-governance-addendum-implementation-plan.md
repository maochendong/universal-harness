# Universal Harness Protocol 1.1 Prompt Governance 增补实施计划

> 日期：2026-08-20
>
> 状态：已批准实施
>
> 设计输入：[Prompt Governance 增补设计](../specs/2026-08-20-prompt-governance-addendum-design.md)
>
> 主计划：[Protocol 1.1 统一实施计划](./2026-08-18-protocol-1.1-unified-implementation-plan.md)
>
> 约束：本计划只向现有 19-task 插入 Prompt Governance 工作包，不增加 Task 20，不重写 T1–T7 历史提交，不改变 T8-A 的 DAG/Coordinator 边界。

## 1. 目标

现有 19-task 已完成 T1–T7，T8-A 也已由 `dcecd50` 完成。本增补从 PG-0 接续主计划并交付以下能力：

1. 每个模型 Port/purpose 使用领域拥有、版本化且可摘要的 `PromptContract`。
2. Provider/Adapter 配置不再只绑定可读的 `prompt_version`，还绑定 contract、输出 Schema 和实际编译 Prompt 摘要。
3. 所有模型 Prompt 由内部 `PromptCompiler` 按固定七段顺序确定性生成。
4. Profile 与 allowlisted Policy 只能加深审查，不能弱化权威边界、修改 Schema 或把项目文本提升为指令。
5. Prompt 准备失败发生在 Provider 调用前，形成可恢复 blocker，零 Provider 调用、零预算消耗。
6. Prompt 漂移精确失效未消费 Result，已完成历史与 Protocol 1.0 不改写。
7. Dashboard 能审计 contract/version/digest、准备失败和恢复，但默认不泄露完整 Prompt。

本计划不实现远程 Prompt Pack、运行时上传任意 Prompt、在线 A/B 自动发布、模型自优化或 Prompt marketplace。

## 2. 当前基线与实施切入点

### 2.1 已完成事实

- T1–T7 已分别由 `b67f423`、`1799797`、`5274791`、`b31fd86`、`3740418`、`87d70b6`、`e21c97b` 落地。
- `ModelProviderBinding` 已有 slot/purpose、Provider、config、`prompt_version`、`schema_version`、budget 和 failure mode。
- Capture 已有 Proposal/Review Adapter Profile 的 `prompt_version_digest`。
- T5/T7 已有 `project_discovery`、`approval_brief` 的严格输入输出 Schema、citation validator 和 InMemory 契约。
- T8-A 的 DAG Engine、Kernel Coordinator、Module contributors 与兼容 facade 已由 `dcecd50` 提交；全量 `259/259` Test Files、`1726/1726` Tests 通过。

### 2.2 强制切入顺序

```text
T8-A dcecd50（已完成）
  → PG-0：T1–T7 additive compatibility patch（可开始）
  → PG-1：T8-B PromptCompiler 深模块
  → PG-2：T8-B Managed Runner + Capture 接线
  → T9 Lite 闭环
  → PG-3…PG-7 随 T10/T12/T13/T14/T17 领域任务落地
  → PG-8 随 T18 Dashboard
  → PG-9 随 T19 E2E/发布验收
```

PG-0 已具备开工前提，但不得修改 `dcecd50` 已交付的 orchestration/workflow 文件及其测试。当前图模型文档与 SVG 也保持独立提交，不能混入 Prompt Governance 代码提交。

## 3. 与现有 19-task 的映射

| 增补工作包 | 插入位置 | 所属现有 Task | 交付内容 |
| --- | --- | --- | --- |
| PG-0 | T8-A 提交后、T8-B 前 | T1–T7 兼容回补 | Prompt Schema/Registry、Binding 扩展、Capture 合同与 golden 迁移 |
| PG-1 | T8-B 第一子提交 | T8 | PromptCompiler、Policy clause、source boundary、cache key、Preparation blocker |
| PG-2 | T8-B 第二子提交 | T8 | Managed Runner Prompt 接线、Invocation provenance、T5/T7 模型路径 |
| PG-3 | T10 内 | T10 | Impact Advisory Prompt Contract 与领域负向校验 |
| PG-4 | T12 内 | T12 | Design Proposal/Review 独立 Prompt Contract |
| PG-5 | T13 内 | T13 | Plan Proposal Prompt Contract |
| PG-6 | T14 内 | T14 | Context Enrichment Prompt Contract |
| PG-7 | T17 内 | T17 | Feedback Analysis 与 Iteration Narrative Prompt Contract |
| PG-8 | T18 内 | T18 | Read API、CLI doctor 与 Dashboard Prompt provenance |
| PG-9 | T19 内 | T19 | 全合同 golden、安全/漂移/恢复、真实模型与发布验收 |

T9、T11、T15、T16 不新增 Prompt 工作包：T9 必须证明 Lite 未启用槽位零 Prompt 编译；T11 只交付纯 Design Schema/Validator；T15/T16 的 Grant、Gate 和 Evidence 不消费模型 Prompt 或模型自述。

## 4. Prompt Contract 清单与绑定载体

Protocol 1.1 最终包含 11 个独立 Contract：

| Contract id | 所有者 | 绑定载体 | 首次落地 |
| --- | --- | --- | --- |
| `harness:prompt:prd-proposal` | Capture Proposal | `CaptureProposalProfile` | PG-0/PG-2 |
| `harness:prompt:prd-review` | Capture Review | `CaptureReviewProfile` | PG-0/PG-2 |
| `harness:prompt:project-discovery` | Grounded Synthesis | Capture-scope `ModelProviderBinding` | PG-0/PG-2 |
| `harness:prompt:approval-brief` | Grounded Synthesis | 当前审批对象所属 scope 的 `ModelProviderBinding` | PG-0/PG-2，T12 复用 |
| `harness:prompt:impact-advisory` | Impact | Operation-scope `ModelProviderBinding` | PG-3 |
| `harness:prompt:design-proposal` | Design | `DesignProposalAdapterProfile` | PG-4 |
| `harness:prompt:design-review` | Design | Operation-scope `ModelProviderBinding` | PG-4 |
| `harness:prompt:plan-proposal` | Plan | Operation-scope `ModelProviderBinding` | PG-5 |
| `harness:prompt:context-enrichment` | Context | Operation-scope `ModelProviderBinding` | PG-6 |
| `harness:prompt:feedback-analysis` | Feedback | Operation-scope `ModelProviderBinding` | PG-7 |
| `harness:prompt:iteration-narrative` | Snapshot Projection | Operation-scope `ModelProviderBinding` | PG-7 |

`PrdProposalPort`、`PrdReviewPort`、`DesignProposalPort` 保留各自 Adapter Profile，不扩张模型建议设计已经冻结的五个 Model Slot。只有 model-backed 变体绑定 Prompt Contract 并经过 Managed Runner；Manual/InMemory 变体只使用既有 `adapter_profile_digest`，不绑定 Prompt Contract、不编译 Prompt，也不生成模型 Invocation。

每个 Contract 的 `version` 从 `1.0.0` 起步，`contract_id + version` 内容不可变。修改 Authority、rubric、Profile Overlay、Policy clause 支持、输出 Schema 或 delimiter 时必须递增版本；只改注释不进入 Contract 内容。

## 5. 通用测试与提交纪律

### 5.1 Red/Green

每个 PG 工作包必须先提交或记录目标测试的 Red 结果，再写最小实现并记录 Green：

```text
新增/修改测试
  → 运行精确测试并证明因缺少当前能力失败
  → 最小实现
  → 精确测试通过
  → 相关 package 测试/typecheck
  → pnpm verify
  → 独立提交
```

PG-0 至 PG-6 发生在 Harness Provable TDD 自身完成前，Red/Green 命令与摘要写入提交说明或任务 Evidence。T16 完成后的 PG-7 至 PG-9 必须同时生成 Harness dogfood 的 Baseline/Red/Green Evidence。

禁止用删除断言、放宽 Schema、snapshot 全量刷新或把失败路径改成 optional 来制造 Green。

### 5.2 每提交通用命令

```bash
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm verify
```

涉及 schema 的工作包先运行：

```bash
pnpm --filter @universal-harness-internal/core schema:generate
git diff --check
```

## 6. PG-0：Protocol/Binding 最小兼容回补

**插入点**：T8-A 独立提交后，T8-B 开始前。

**目标**：新增 Prompt Contract 权威模型并演进尚未发布的 Protocol 1.1 Schema；历史提交不 amend/rebase。

**新增主要文件**：

- `packages/core/src/schema/prompt.ts`
- `packages/core/src/prompt/contracts.ts`
- `packages/core/src/prompt/failure-mapping.ts`
- `packages/core/src/prompt/registry.ts`
- `packages/core/src/prompt/policy-clauses.ts`
- `packages/core/src/prompt/index.ts`
- `packages/core/src/proposal/prompt-contract.ts`
- `packages/core/src/review/prompt-contract.ts`
- `packages/core/src/synthesis/prompt-contracts.ts`
- `packages/core/test/prompt/contract-registry.test.ts`
- `packages/core/test/prompt/contracts.test.ts`
- `packages/core/test/prompt/failure-mapping.test.ts`
- `packages/core/test/golden/prompt/`

**修改主要文件**：

- `packages/core/src/schema/profile.ts`
- `packages/core/src/schema/registry.ts`
- `packages/core/src/schema/index.ts`
- `packages/core/src/profile/records.ts`
- `packages/core/src/capability/compiler.ts`
- `packages/core/src/proposal/port.ts`
- `packages/core/src/review/port.ts`
- `packages/core/src/index.ts`
- 相关 profile/capability/proposal/review/synthesis tests 与 golden fixtures

**先写失败测试**：

1. `PromptContract` unknown field、空 segment、错误 digest、未知 Profile、未知 Schema 被拒绝。
2. 相同 `(contract_id, version)` 注册不同内容时 Registry 启动失败。
3. Registry 只能按 port/purpose/`prompt_version` selector 精确解析；selector 必须唯一映射到 contract id/version/digest/output Schema，未知、歧义或 binding 不一致返回 `prompt_contract_version_mismatch`，不能只告警或按“最接近版本”猜测。
4. `ModelProviderBinding` 缺 `prompt_contract_id`、`prompt_contract_version`、`prompt_contract_digest` 或 `output_schema_digest` 时失败。
5. model-backed `CaptureProposalProfile`、`CaptureReviewProfile` 缺 `prompt_contract_id/version/digest` 或 `output_schema_digest` 时配置失败；Manual/InMemory 变体缺少这些字段仍合法，且产生零 Prompt 编译/Invocation。
6. Profile/Capability Compiler 从注入的 Registry 解析 digest；调用方提供摘要或摘要不匹配时 fail closed。
7. Capture/Operation scope overlap、Lite 零 binding 与现有 Provider closure 语义不变。
8. Schema canonical ordering、golden export 和 package export drift 被机械检测。
9. 既有 binding/schema golden digest 变化必须逐个列出并核对来源；测试或提交不得以无解释的批量 snapshot 刷新通过。
10. 每个 preparation、invocation 和 domain validation code 只有一个权威层级/载体；`GroundedSynthesisFailure` 只能投影已存在事实，未知 code fail closed。

**实现步骤**：

1. 定义严格 `PromptSegment`、`PromptContract`、`PromptPreparationFailure` Schema 与 canonical digest helper。
2. 实现只读 `PromptContractRegistry`；注册结束后冻结，不提供 runtime mutation API。
3. 定义 allowlisted Policy clause registry 的数据契约，但本工作包不编译 Prompt。
4. 建立固定 failure code→层级→权威载体映射；Grounded failure 只做 projection，未知 code fail closed。
5. 为 PRD Proposal/Review、project discovery、approval brief 注册领域拥有的首版 Contract。
6. 扩展 ModelProviderBinding，并把 Proposal/Review Adapter Profile 演进为 model-backed/non-model 判别联合；`prompt_version` 是 Registry selector/兼容 alias，model-backed binding 显式保存解析后的 `prompt_contract_version`，任何映射漂移均 fail closed。
7. 向 Profile/Capability Compiler 显式注入 `PromptContractResolver`，由 Compiler 解析并写入 digest；用户配置不接受手填 digest。
8. 更新全部 Protocol 1.1 fixtures 和 JSON Schema 导出；对每个变化的 binding/schema golden 逐项人工核对字段来源和 digest 轮换原因，并在提交说明中列出，禁止无解释批量刷新。Protocol 1.0 reader 与历史 fixture 不改写。

**目标测试命令**：

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/prompt packages/core/test/profile packages/core/test/capability packages/core/test/proposal packages/core/test/review packages/core/test/synthesis
pnpm --filter @universal-harness-internal/core schema:generate
pnpm --filter @universal-harness-internal/core typecheck
pnpm verify
```

**完成条件**：四个已落 Capture 合同可解析；所有新 binding digest 由 Registry 派生；PG-0 不修改 `dcecd50` 已交付的 `packages/runtime/src/orchestration/`、`packages/runtime/src/workflow/` 及对应 T8-A 测试文件；全部 golden digest 变化均有逐项审核说明。

## 7. PG-1：T8-B PromptCompiler 深模块

**依赖**：PG-0。

**目标**：实现无 Provider 副作用的确定性 Prompt 编译、安全分区和 preparation blocker。

**新增主要文件**：

- `packages/runtime/src/model/prompt-compiler.ts`
- `packages/runtime/src/model/prompt-policy.ts`
- `packages/runtime/src/model/source-boundary.ts`
- `packages/runtime/src/model/prompt-cache-key.ts`
- `packages/runtime/src/model/prompt-artifact.ts`
- `packages/runtime/src/model/index.ts`
- `packages/runtime/test/model/prompt-compiler.test.ts`
- `packages/runtime/test/model/prompt-policy.test.ts`
- `packages/runtime/test/model/source-boundary.test.ts`

**先写失败测试**：

1. 编译顺序严格为 Authority → Role → Rubric → Profile → Policy → Output → Untrusted Input。
2. 同 canonical 输入得到同 `compiled_prompt_digest`；集合乱序不改变摘要，语义变化必改变摘要。
3. Lite/Standard/Governed 只增加 rubric 深度，Authority 与输出 Schema digest 完全相同。
4. 未注册 Policy clause、非法参数、覆盖 Authority/Schema 的企图返回 `policy_overlay_invalid`。
5. README/源码/日志中的 system/developer/tool 指令只能进入 untrusted partition。
6. delimiter escape、Unicode 混淆、secret、path、超尺寸和深嵌套分别返回准确 failure code。
7. 准备失败不创建 `ModelInvocationPlanned/Started`，不调用 Provider，不消耗 budget。
8. Lite 未启用 slot 时 Compiler 根本不被调用。

**实现步骤**：

1. 固化七段消息模型、角色和 delimiter version；不支持调用方自定义 system prompt。
2. 实现 Profile Overlay 与结构化 Policy clause 编译；Overlay 只能追加，不能替换前段。
3. 接收 Harness 已编译的 typed bundle，不读取项目目录、Ledger 或环境变量。
4. 生成 `CompiledPrompt`、所有分段摘要和完整 cache key。
5. 脱敏 artifact 写入受控 sink；Invocation 只保存 digest/locator。
6. 将 preparation failure 映射为 workflow typed blocker/Finding 与同 checkpoint 恢复信息。

**目标测试命令**：

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/model
pnpm --filter @universal-harness-internal/runtime typecheck
pnpm test:security
pnpm verify
```

**完成条件**：Compiler 可独立测试且无 Provider/Coordinator 依赖；所有项目内容机械证明处于不可信数据区。

## 8. PG-2：T8-B Managed Runner 与 Capture 接线

**依赖**：PG-1、现有 T5/T7 消费契约。

**目标**：让受管模型调用只接收 `CompiledPrompt`，并完成 PRD Proposal/Review、project discovery、approval brief 的首批真实接线。

**主要落点**：

- `packages/runtime/src/model/managed-runner.ts`
- `packages/runtime/src/model/invocation-records.ts`
- `packages/runtime/src/model/invocation-store.ts`
- `packages/runtime/src/model/result-validation.ts`
- `packages/runtime/src/model/capture-adapters.ts`
- `packages/core/src/schema/` 中 T8 Model Invocation/Failure Schema
- `packages/runtime/test/model/managed-runner.test.ts`
- `packages/runtime/test/model/capture-adapters.test.ts`
- `tests/fault/` 中调用恢复/对账用例
- `tests/security/` 中 Provider 隔离与输出边界用例

**先写失败测试**：

1. Runner API 不接受 raw prompt/messages，只接受 `CompiledPrompt` 与已持久化 Binding/Invocation identity。
2. `ModelInvocationPlanned` 同时绑定 contract、Profile/Policy/input/output Schema/compiled prompt/model/config/budget digest。
3. Proposal/Review 的 contract、bundle、conversation、run、Evidence 完全不同；Grounded 四 purpose 不能共享 cache/history。
4. Prompt preparation failure 与 Provider `ModelPortFailure` 在 Schema、事件和恢复入口上严格区分。
5. crash 发生在 planned/started/completed/validated 各点均可对账恢复，不重复消费 Result。
6. contract/Profile/Policy/input/Schema/model drift 只失效未消费 Result，历史 record 不改写。
7. Manual/InMemory Capture 路径零 Provider invocation；Standard/Governed required Provider 缺失直接 blocked。
8. Citation 存在但结论错误时只通过 citation integrity，不能修改 PRD、风险或 ApprovalDecision。

**实现步骤**：

1. 扩展 T8-B `ModelInvocationRecord` 和 cache/recovery key，纳入全部 Prompt provenance。
2. 在 `ModelInvocationPlanned` 前完成 Contract 解析、编译和安全检查。
3. Runner 统一预算、隔离、重试、输出上限、对账和 Evidence；Adapter 不再拼接 system prompt。
4. 为四个 Capture 合同建立 model-backed adapter，复用现有 Domain Validator/Citation Validator。
5. 保持 Legacy/Manual/InMemory Adapter 走同一领域质量链，但不伪造模型 Evidence。

**目标测试命令**：

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/model packages/core/test/capture packages/core/test/proposal packages/core/test/review packages/core/test/synthesis tests/fault tests/security
pnpm test:fault
pnpm test:security
pnpm verify
```

**完成条件**：T8-B 的每个模型调用都能证明 Prompt 来源与编译摘要；T9 Lite 测试可以机械证明零 PromptCompiler 调用。

## 9. PG-3：T10 Impact Advisory Contract

**依赖**：PG-2、T10 确定性 Impact contributor。

**目标**：在 `propagate → advise → validate → approve` 中加入只能增补的领域 Prompt。

**主要落点**：`packages/graph/src/impact/` 的 prompt contract/input/result validator，`packages/runtime/src/orchestration/contributors/impact-contributor.ts`，对应 graph/runtime tests。

**Red/Green 重点**：

- Contract 强制模型区分确定性 entry、候选遗漏、风险信号、未知事实和问题。
- Prompt 明确禁止删 entry、降风险、改传播方向或激活禁止 inferred edge；领域 Validator 必须独立拒绝这些输出。
- 关系规则 registry version/digest、ImpactSet、Graph neighborhood、PRD/source refs 全部进入 input/compiled digest。
- 合法 citation 但错误结论不能改变权威 ImpactSet。

**完成条件**：Impact Prompt 提高遗漏发现质量，但移除模型仍不影响确定性传播和风险下限。

## 10. PG-4：T12 Design Proposal/Review 独立 Contract

**依赖**：PG-2、T11 Design Schema/Validator。

**目标**：为设计生成和独立评审提供两套完全隔离的 Prompt Contract。

**主要落点**：T12 新增的 `packages/core/src/design/`、`packages/runtime/src/design/` 及其 tests。

**Red/Green 重点**：

- `DesignProposalPort` 使用 `DesignProposalAdapterProfile` 绑定 contract/schema digest，不新增 Model Slot。
- Proposal Prompt 要求 Decision、Component、API/Data/UI 契约、test strategy、权衡与覆盖；不能伪造结构边、执行事实或批准。
- Review Prompt 只允许 `accept_recommended | revision_required | blocked` 和结构化 Findings。
- Proposal/Review 的 Contract、ContextBundle、conversation、run、Evidence、cache key 均不相同。
- Critical Finding 仍由纯 Validator 阻止 ApprovalRequest；模型的 accept 不能替代人工批准。
- DesignSet 审批复用 `approval_brief` Contract，但不把摘要写入对象 semantic digest。

**完成条件**：同一模型也无法通过隐藏历史形成自我评审；Plan 只消费人工批准的 accepted DesignSet。

## 11. PG-5：T13 Plan Proposal Contract

**依赖**：PG-4、T13 Criterion Assertion compiler。

**目标**：让模型只对 Harness 已编译的 canonical Assertions 提出 Task 分配与 DAG 候选。

**主要落点**：`packages/runtime/src/planning/` 的 contract/input/result validator、Plan compiler 接线与 tests。

**Red/Green 重点**：

- Prompt 只暴露 canonical Assertion descriptors、accepted PRD/Impact/Design/Capability bindings。
- 输出只能分配 Assertion、提出 Task/Cluster/DAG/预算和澄清问题。
- 创建/合并/遗漏 Assertion、扩大路径、弱化 Gate/TDD、跳过 Design/Impact 覆盖全部由 Compiler 拒绝。
- LegacyPlanTasksAdapter 不获得任意 Prompt 注入口，仍经过同一 Plan Validator。

**完成条件**：Prompt 改善分解质量，但 Assertion identity、Task id、路径、Gate、TDD Contract 和最终 DAG 始终由 Harness 编译。

## 12. PG-6：T14 Context Enrichment Contract

**依赖**：PG-5、T14 deterministic Context selector。

**目标**：只解释已选择的 Context，不改变选择或权限。

**主要落点**：`packages/runtime/src/context/` 的 contract、input compiler、enrichment merge/projection 与 tests。

**Red/Green 重点**：

- 固定执行 `select → enrich → compile`，Prompt 不得移除 mandatory source 或加入未授权 source。
- 每条术语、摘要和相关性说明引用当前 Context Bundle。
- Enrichment 不能改变 path set、token ceiling、ExecutionPreflight binding 或 CapabilityGrant。
- bundle/contract/Profile/Policy 漂移使未消费 enrichment 失效。

**完成条件**：Agent 获得更可读上下文，但最小性、范围和执行授权仍完全由确定性 Context/Preflight 控制。

## 13. PG-7：T17 Feedback Analysis 与 Iteration Narrative

**依赖**：PG-2、T10/T12/T16、T17 deterministic RCA。

**目标**：分别治理语义诊断和快照后中文叙事，二者不得影响权威完成事实。

**主要落点**：`packages/runtime/src/finding/`、`packages/runtime/src/snapshot/` 或 T17 新建 feedback 模块及 tests。

**Red/Green 重点**：

- deterministic RCA 命中时不编译 Feedback Prompt、不调用模型。
- Feedback Prompt 要求多假设、反证、confidence、source refs 和验证建议，禁止决定 target layer、升级或 privileged route。
- 低置信度/高风险候选未经人工复核不得被 router 消费。
- Snapshot 先权威提交，再编译 `iteration_narrative`；失败只创建可恢复 Projection Finding。
- Narrative 不能补造 Evidence、修改 Verdict 或反向阻塞 Snapshot。

**完成条件**：Feedback/Narrative 分别拥有独立 Contract/Invocation/Evidence；T16 后用 Harness dogfood 记录可证明 Red/Green。

## 14. PG-8：T18 Read API、CLI 与 Dashboard

**依赖**：PG-3 至 PG-7 的 record/projection contract。

**目标**：让用户看见 Prompt 版本与失败原因，而不是阅读原始 Prompt 或 digest 墙。

**主要落点**：

- `packages/dashboard/src/read-api.ts`
- `packages/dashboard/src/presentation.ts`
- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/assets/dashboard.css`
- `packages/cli/src/commands/doctor.ts`
- `packages/cli/src/project-runtime-config.ts`
- 对应 dashboard/cli tests 与 Playwright E2E

**Red/Green 重点**：

- 模型调用详情展示中文 Port/purpose、contract id/version、各 digest、Schema、Profile/Policy、用量、validation 和引用覆盖。
- Preparation blocker 与 Provider failure 使用不同中文说明和恢复动作。
- 默认不返回原始 Prompt；审计展开只访问 Policy 允许的脱敏 artifact。
- Lite inactive capability 返回稳定说明且零 Prompt 卡片。
- Dashboard 不能根据模型状态自行推断批准、风险、Verdict 或 Snapshot。
- CLI doctor 检查 Registry/binding/schema drift，但不修改 Ledger。

**完成条件**：业务视图可理解、审计视图可复验、敏感 Prompt 不泄露；SSE 删除后仍可从 Ledger 重建。

## 15. PG-9：T19 E2E、攻击、漂移与发布验收

**依赖**：PG-0 至 PG-8。

**目标**：用自动化和真实 Provider 证明 11 个 Contract、三档 Profile 与恢复/失效不变量。

**新增测试矩阵**：

1. 11 个 Contract × Lite/Standard/Governed 的 golden 编译；不适用 Lite 必须证明零编译。
2. 相同输入摘要稳定，contract/Profile/Policy/input/Schema/model 任一漂移精确失效。
3. 相同 id/version 不同内容、缺 Contract、缺 Overlay、Schema mismatch 全部启动或 preflight fail closed。
4. PRD Proposal/Review、Design Proposal/Review、Grounded 四 purpose 的 conversation/run/cache/Evidence 隔离。
5. README、源码、日志、Finding、旧模型输出中的 prompt injection、delimiter escape、Unicode 混淆、tool/command 伪造。
6. 超尺寸/深度/数组/字符串、secret/credential/path、redirect/network origin 和 malicious output。
7. Citation 合法但语义错误时，Impact/Design/Plan/Feedback/Approval/Snapshot 权威状态均不改变。
8. Provider 在 planned/started/completed/validated 后崩溃的恢复与对账。
9. Preparation failure 零 Provider 调用/预算；Provider failure 使用独立 `ModelPortFailure`。
10. Standard/Governed required Contract/Provider 缺失直接阻塞；Lite 不静默启用模型。
11. Protocol 1.0 historical reader 不补造 Prompt Evidence，开放 Operation 只按既有迁移规则处理。
12. Dashboard 默认无原始 Prompt 泄露，审计 artifact 受 Policy 控制。

**真实模型 dogfood 记录**：

- 每个适用 Port/purpose 的 contract/compiled prompt/input/schema/model/config/budget digest；
- Invocation/Result/Validation/Consumed/Invalidated ids；
- conversation/run/attempt identity；
- tokens、steps、时长、成本、重试、invalid output、越权拒绝与 citation coverage；
- Proposal/Review 修订率、Impact 增补接受率、Plan 重编率、Approval Brief 决策时间；
- Lite 零调用证明；Standard/Governed blocker 恢复证明。

**发布命令**：

```bash
pnpm verify
pnpm test:security
pnpm test:fault
pnpm test:performance
pnpm test:e2e
pnpm test:e2e:dashboard
pnpm pack:smoke
pnpm test:release
```

**完成条件**：中文验收报告把设计完成定义的每条不变量映射到自动测试、Ledger Evidence 与真实 dogfood 记录。

## 16. 失败与恢复统一矩阵

| 层级/失败发生点 | 权威表示 | Invocation 状态 | Provider/budget | 恢复方式 |
| --- | --- | --- | --- | --- |
| Contract 缺失、selector/version/digest 不匹配 | checkpoint blocker/Finding 中的 `PromptPreparationFailure` | 不创建 Planned/Started | 零调用、零预算 | 修复 Registry/配置后同 checkpoint resume |
| Profile Overlay、Policy clause、output Schema、untrusted boundary/size 失败 | checkpoint blocker/Finding 中的 `PromptPreparationFailure` | 不创建 Planned/Started | 零调用、零预算 | 修复 Overlay/Policy/Schema/bundle 后重编 |
| `provider_required`/`provider_unavailable` | `ModelInvocationRecord` + `ModelPortFailure` | Planned，可在 Started 前失败 | 零调用或未启动、零 Provider 用量 | 修复 Provider 后对账/resume |
| timeout/budget/invalid output/independence/version/policy/uncertain | `ModelInvocationRecord` + `ModelPortFailure` | Planned 且按实际 attempt 记录 Started/Completed/Failed | 按实际尝试记录用量 | 受控重试、对账；耗尽后 blocked |
| `binding_drift`/`bundle_stale`/`unknown_purpose` | owning Domain typed outcome/Validation/Finding | preflight 命中时不创建新 Invocation | 可零调用、零预算 | 刷新 binding/bundle/purpose 后 resume |
| `citation_missing`/`citation_invalid` | ModelResultRejected + owning Domain Validation/Finding | Completed 但不得 Consumed | 已调用并记录实际用量 | 预算内重提；耗尽后 blocked |
| contract/input/policy drift | Result invalidation | 历史 Invocation 不改写 | 不追加旧 attempt | 新 binding 下重新编译/调用 |
| iteration narrative 失败 | 按失败层记录底层事实，并投影 Projection Finding | 视底层失败点 | 视实际尝试 | Snapshot 保持完成，单独重试 Projection |

`GroundedSynthesisFailure` 只投影调用层或领域层的既有失败事实，不另建权威 record。PG-0/PG-2 必须提供 code→层级→载体映射测试，未知 code fail closed。

任何失败都不得静默换 Prompt、换 Provider、降级 Manual、跳过 required slot 或用模型自述标记完成。

## 17. 建议提交序列

现有 T8-A 提交保持原计划；其后增加以下可独立回滚提交，但逻辑 Task 总数仍为 19：

```text
feat(prompt): bind versioned prompt contracts
feat(prompt): compile governed model prompts
feat(runtime): prepare managed capture model invocations
feat(impact): govern advisory prompts
feat(design): govern proposal and review prompts
feat(plan): govern plan proposal prompts
feat(context): govern context enrichment prompts
feat(feedback): govern analysis and narrative prompts
feat(ui): expose prompt provenance and recovery
test(protocol): prove prompt governance end to end
```

一个提交只能包含对应 PG 工作包；Schema/golden 与消费它们的实现必须在同一提交保持 Green。不得把当前图文档、T8-A 未完成重构或无关格式化混入这些提交。

## 18. 最终验收清单

- [ ] 11 个 Port/purpose 都有领域拥有、版本化且不可静默修改的 Prompt Contract。
- [ ] 四个领域建议 Port 与 Grounded 四 purpose 使用 `ModelProviderBinding`；`PrdProposalPort`、`PrdReviewPort`、`DesignProposalPort` 保留判别式 Adapter Profile，不扩张五槽位模型。
- [ ] Binding/Profile 固定 contract/version/digest 与 output Schema digest；Invocation 固定 compiled prompt digest。
- [ ] `prompt_version` 只作为 Registry selector/兼容 alias，必须唯一解析到 binding 中的 contract id/version/digest/Schema；不一致时 fail closed。
- [ ] Adapter/调用方没有 raw system prompt、动态 Schema 或隐藏 history 注入口。
- [ ] PromptCompiler 固定七段顺序，项目内容永远只进入 untrusted partition。
- [ ] Lite/Standard/Governed Overlay 只增加深度，不能弱化 Authority、Schema、风险或审批。
- [ ] Policy 只通过 allowlisted clause id/参数注入，原始 Policy Markdown 不是指令。
- [ ] Preparation failure 在 Provider 前 fail closed、零调用、零预算且可恢复。
- [ ] Provider failure 与 Preparation failure 具有不同 Schema、事件、Dashboard 文案和恢复动作。
- [ ] preparation、invocation、domain validation 三层失败码具有唯一映射和权威载体；Grounded failure 不形成第二份 truth。
- [ ] Prompt/cache/conversation/run/Evidence 在 Port/purpose 与 Proposal/Review 间完全隔离。
- [ ] Prompt 漂移只失效未消费 Result，历史 Invocation 与 Protocol 1.0 不改写。
- [ ] Impact 不能降风险，Design accept 不能代替人工批准，Plan 不能改 Assertion/Grant，Feedback 不能覆盖确定性 RCA。
- [ ] Context Prompt 不扩大文件或权限，Narrative 不修改 Snapshot/Verdict 或补造 Evidence。
- [ ] Lite 未启用槽位零 Prompt 编译、Invocation、Result、Evidence 和 Dashboard 空壳。
- [ ] Dashboard 默认不泄露完整 Prompt，审计展开只读取脱敏受控 artifact。
- [ ] Prompt injection、越权输出、citation 语义错误、漂移、crash/resume 和 Provider 对账测试全部通过。
- [ ] Protocol 1.1 binding/schema golden 的每次 digest 轮换均有逐项人工审核说明，Protocol 1.0 fixture 不改写。
- [ ] `pnpm test:release`、三档真实 dogfood 和中文验收报告全部完成。

## 19. 明确不做

- 不增加公共 lifecycle Phase、Graph Node、Capability 或固定审批点。
- 不增加 Task 20，也不重新编号现有 19-task。
- 不 amend/rebase T1–T7，不让 PG-0 接触 T8-A 工作文件。
- 不提供通用动态 Prompt/Schema 转发 Port。
- 不允许 Dashboard、项目仓库或 Agent 直接修改 Registry。
- 不以 Prompt 遵循声明替代 Schema、Validator、Policy、Approval、Gate、Evidence 或 Verdict。
- 不在 Protocol 1.1 引入外部 Prompt Pack、远程签名分发或自动 Prompt 优化。
