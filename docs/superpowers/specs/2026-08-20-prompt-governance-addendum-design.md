# Universal Harness Protocol 1.1 Prompt Governance 增补设计

日期：2026-08-20

状态：设计已确认，待文档复核

目标版本：Protocol 1.1.0

实施约束：现有 19-task 已进入 T8-A 开发；本增补不新增公共 Phase，不重开 T1–T7 业务逻辑，不增加 Task 20。

关联设计：

- [模型建议 Adapter 与 Grounded Synthesis](./2026-08-19-model-advisory-adapters-design.md)
- [Intent → 高质量 PRD Capture](./2026-08-18-intent-to-prd-capture-design.md)
- [Slim Profiles 与 Capability Kernel](./2026-08-18-harness-slim-profiles-design.md)
- [Protocol 1.1 统一实施计划](../plans/2026-08-18-protocol-1.1-unified-implementation-plan.md)

## 1. 摘要

Protocol 1.1 已经规定每个模型 Port/purpose 使用独立 prompt、Schema、budget、conversation、run identity 和 Evidence，并把 `prompt_version` 写入 Provider binding。但现有设计主要回答“Prompt 怎样隔离、绑定和审计”，尚未完整定义“每个 Prompt 必须怎样引导模型、怎样按 Profile 增加审查深度、怎样确定性编译，以及 Prompt 漂移怎样失效结果”。

本增补引入中心化 `PromptContractRegistry` 与内部 `PromptCompiler`。领域 Module 拥有版本化 Prompt Contract；Runner 只消费经过确定性编译和安全检查的 `CompiledPrompt`。Prompt 负责提高理解和输出质量，Schema 负责约束形状，领域 Validator/Compiler、Policy、Approval 和 Evidence 继续决定权威事实。

当前实施已经完成 T1–T7，T8-A 的 DAG Engine 与 Orchestrator 拆分正在工作区开发。本设计采用最小兼容回补：先扩展现有 Provider binding 与 Protocol 1.1 fixtures，再在 T8-B 落公共 Prompt 编译深模块，后续领域 Task 按原顺序注册各自 Prompt Contract。

## 2. 已确认决策

| 决策 | 结论 |
| --- | --- |
| 总体方案 | 中心化编译、领域模板注册 |
| 接入时机 | T1–T7 最小兼容补丁；公共运行时从 T8-B 接入 |
| Prompt 所有权 | 各领域 Module 拥有 Prompt Contract；Runner 不拥有领域语义 |
| 动态 Prompt | 禁止调用方提供任意 system prompt 或动态输出 Schema |
| Profile 差异 | 使用版本化 Lite/Standard/Governed Overlay，只增加深度，不弱化权威边界 |
| Policy 注入 | 只允许注册过的结构化 clause id/参数，不拼接原始 Policy 文本 |
| 项目内容 | README、源码、日志、PRD 和历史模型输出全部作为不可信数据区 |
| 版本绑定 | Binding 固定 contract id/version/digest 与 output Schema digest |
| 调用证明 | Invocation 固定 compiled prompt digest；Prompt provenance 不进入领域 semantic digest |
| 失败 | Prompt 准备失败是 Provider 调用前 typed blocker，不伪装成模型失败 |
| Lite | 未启用模型槽位时零 Prompt 编译、零 Invocation、零 Result、零模型 Evidence |
| 任务数量 | 嵌入现有 19-task，不增加 Task 20 |

## 3. 目标与非目标

### 3.1 目标

1. 为每个 LLM Port/purpose 提供针对性的角色、领域 rubric、Profile 深度和输出引导。
2. 使 Prompt 模板、Profile Overlay、Policy Overlay、Schema 和编译结果全部版本化、可摘要、可恢复、可审计。
3. 防止 Adapter 临时拼接 Prompt、跨 Port 复用隐藏历史或让项目文本覆盖 Harness 指令。
4. 在不打断 T8-A 的前提下，把公共 Prompt 编译能力放入 T8-B，并让后续领域 Task 自治注册模板。
5. 建立 Prompt 级 golden、攻击、漂移和真实模型回归测试。

### 3.2 非目标

- 不用 Prompt 代替 JSON Schema、领域 Validator、Graph 传播、Capability Compiler、Policy、Approval、Gate 或 Evidence。
- 不建立可在运行时上传任意 Prompt 的通用接口。
- 不允许项目仓库、Dashboard 或 Agent 修改权威 Prompt Contract。
- 不在 Protocol 1.1 首版引入外部 Prompt marketplace、远程 Prompt Pack、在线 A/B 自动发布或未经批准的自优化。
- 不为 Prompt 编译新增公共 Phase、Graph Node、固定审批点或 Task 20。

## 4. 总体架构

```text
Domain-owned PromptContract
          ↓ register
PromptContractRegistry
          ↓ resolve by port / purpose / version / digest
PromptCompiler
  + immutable Authority Boundary
  + Port Role
  + Domain Rubric
  + Profile Overlay
  + allowlisted Policy Overlay
  + Output Contract
  + Untrusted Typed Input Bundle
          ↓
CompiledPrompt + PromptBinding
          ↓
ManagedModelInvocationRunner
          ↓
Provider → Schema Validator → Boundary Validator → Domain Validator / Compiler
```

所有组件保持深模块边界：

- `PromptContractRegistry` 只管理静态、版本化合同，不读取 Ledger 或项目文件。
- `PromptCompiler` 只做确定性组合、摘要和安全边界检查，不调用模型。
- 领域 Module 决定 rubric、合法输入和结果消费方式。
- `ManagedModelInvocationRunner` 只处理调用生命周期、隔离、预算、重试、对账和 Evidence。
- Coordinator/Compiler 继续拥有状态迁移、Graph 物化、批准和失效。

## 5. 权威数据模型

### 5.1 PromptContract

```ts
export interface PromptContract {
  readonly contract_id: string;
  readonly port_id: string;
  readonly purpose?: string;
  readonly version: string;

  readonly authority_boundary: PromptSegment;
  readonly role_instruction: PromptSegment;
  readonly domain_rubric: PromptSegment;
  readonly profile_overlays: Readonly<Record<ProjectProfileId, PromptSegment>>;

  readonly output_schema_id: string;
  readonly output_schema_digest: string;
  readonly source_delimiter_version: string;
  readonly contract_digest: string;
}
```

`contract_digest` 由除自身外的 canonical contract 内容确定性派生。相同 `(contract_id, version)` 注册不同 digest 必须启动失败；不得把“版本号不变、内容已修改”解释为兼容更新。

`PromptSegment` 是 Harness 内部静态资源引用或已规范化文本，不接受运行时任意模板代码。Contract 与输出 Schema 使用 `additionalProperties: false` 的严格 Schema。

### 5.2 ModelProviderBinding 扩展

现有 Capture-scope 与 Operation-scope `ModelProviderBinding` 增加：

```ts
interface ModelProviderBinding {
  // existing fields
  readonly prompt_version: string;

  // Prompt Governance addendum
  readonly prompt_contract_id: string;
  readonly prompt_contract_digest: string;
  readonly output_schema_digest: string;
}
```

`prompt_version` 继续作为用户配置和人类可读版本。Profile/Capability Compiler 从内置 Registry 解析 contract/digest，用户不手填摘要。Capture-scope 与 Operation-scope binding 继续使用同一 Schema，并保持 slot/purpose 作用域互斥。

### 5.3 CompiledPrompt

```ts
export interface CompiledPrompt {
  readonly contract_id: string;
  readonly contract_digest: string;
  readonly profile_overlay_digest: string;
  readonly policy_overlay_digest: string;
  readonly input_bundle_digest: string;
  readonly output_schema_digest: string;
  readonly compiled_prompt_digest: string;
  readonly messages: readonly CompiledPromptMessage[];
}
```

`compiled_prompt_digest` 覆盖规范化后的全部消息、顺序、角色、分隔符版本与摘要绑定。原始敏感输入不复制进 Binding；受控编译产物按 Policy 保存为脱敏 artifact，Invocation 只持有 digest/locator。

### 5.4 PromptBinding 与 Invocation

`PromptBinding` 不是新的权威记录类型，而是现有 `ModelProviderBinding` 中的 Contract 字段与单次 Invocation 编译摘要形成的逻辑视图，避免出现第二套 Provider binding truth。

Provider 调用前，`ModelInvocationRecord` 至少绑定：

- port/purpose 与 prompt contract id/version/digest；
- Profile/Policy Overlay digest；
- input bundle、output Schema、model/config/budget digest；
- compiled prompt digest；
- conversation/run/invocation/attempt identity。

Prompt provenance 不进入 `ImpactAdvisoryRecord`、`DesignReviewRecord`、`PlanProposalRecord`、`FeedbackAnalysisRecord` 或 `GroundedSynthesisRecord` 的领域 semantic digest，但必须进入调用 provenance、cache key、恢复与失效计算。

## 6. PromptCompiler

### 6.1 固定编译顺序

```text
1. Authority Boundary
2. Port Role
3. Domain Rubric
4. Profile Overlay
5. allowlisted Policy Overlay
6. Output Contract
7. Untrusted Typed Input Bundle
```

顺序是协议不变量。Profile/Policy Overlay 不能删除、覆盖或后置重解释 Authority Boundary、Port Role 和 Output Contract。

### 6.2 不可信输入分区

编译产物使用等价于以下结构的明确边界：

```text
<authority-boundary>Harness 内置指令</authority-boundary>
<domain-rubric>版本化领域规则</domain-rubric>
<profile-overlay>Harness 注册内容</profile-overlay>
<policy-overlay>allowlisted 结构化条款</policy-overlay>
<output-contract digest="...">严格输出约束</output-contract>
<untrusted-input digest="...">项目内容</untrusted-input>
```

README、源码、日志、用户文本、PRD、Graph 摘要和历史模型输出只能进入 `untrusted-input`。其中出现的“忽略前述指令”“调用工具”“修改 Schema”“自动批准”等内容均按普通数据处理。

### 6.3 Policy Overlay

Policy 只能贡献已在 Registry 中注册的 clause id 与严格参数，例如：

- `require_security_negative_paths`；
- `require_migration_analysis`；
- `require_reviewer_segregation`；
- `require_compliance_traceability`。

未知 clause、超出参数边界、试图修改 Authority Boundary 或输出 Schema 的 clause 产生 typed blocker。原始 Policy Markdown 不直接成为 instruction。

### 6.4 Profile Overlay

- **Lite**：聚焦必要事实、主路径、最少澄清和最小输出，不生成未启用治理内容。
- **Standard**：增加关键失败路径、边界、兼容性、可维护性、接口和数据契约检查。
- **Governed**：增加安全、权限、合规、迁移、审计、不可逆操作、职责分离和负向场景。

Profile Overlay 只改变审查深度、预算建议和必查维度，不改变结果 Schema、模型权限或确定性风险下限。

## 7. 领域 Prompt Contract

| Port / Purpose | 领域引导重点 | 禁止事项 |
| --- | --- | --- |
| `PrdProposalPort` | 原子、可观察、可测试 Criterion；不确定时提出澄清问题 | 把模糊需求留给 Planner；直接 accepted |
| `PrdReviewPort` | 完整性、歧义、冲突、不可验证结果、边界和 test-first readiness | 读取 Proposal 隐藏历史；自我批准 |
| `project_discovery` | 区分事实、推断和未知；提出候选 Capability/Gate 并逐项引用 | 直接决定 Profile/CapabilityPlan 或写 Graph |
| `ImpactAdvisoryPort` | 寻找确定性传播遗漏对象、风险信号和缺失事实 | 删除 entry、降风险、改方向、激活禁止推理边 |
| `DesignProposalPort` | Requirement/Impact → Decision/Component/契约/test strategy，说明权衡和覆盖 | 自批；伪造结构边或执行事实 |
| `DesignReviewPort` | 独立批判覆盖缺口、错误边界、契约冲突、不可实现设计和残余风险 | 与 Proposal 共用会话；用 accept 建立批准事实 |
| `PlanProposalPort` | 分配已有 canonical Assertion，提出原子 Task、Cluster、DAG 和预算 | 创建/合并 Assertion、扩大路径、弱化 Gate/TDD |
| `context_enrichment` | 解释已选 Context 的术语、摘要和相关性 | 增加文件、删除 mandatory source、扩大权限 |
| `FeedbackAnalysisPort` | 对未分类/冲突 RCA 提出多假设、反证、confidence 和验证建议 | 覆盖确定性 RCA；决定 target layer 或 privileged route |
| `approval_brief` | 平衡呈现变化、风险、收益、权衡和待决问题 | 隐藏确定性字段；建议自动批准 |
| `iteration_narrative` | 区分已证明完成、失败、未验证和遗留风险 | 补造 Evidence；修改 Snapshot/Verdict |

每个 Port/purpose 独立 contract、prompt、Schema、budget、conversation、run identity 和 Evidence。允许共用模型或 executable，不允许共用隐藏 history。

## 8. 运行时调用链

```text
Coordinator 编译 Typed InputBundle
  → 解析 Capture-scope / Operation-scope ModelProviderBinding
  → Registry 解析 PromptContract
  → PromptCompiler 叠加 Profile / Policy Overlay
  → 确定性 Prompt 安全检查
  → 生成 CompiledPrompt
  → 提交 ModelInvocationPlanned
  → ManagedModelInvocationRunner 调用 Provider
  → 严格 JSON Schema 校验
  → Citation / Boundary Validator
  → Domain Validator / Compiler
  → Result Consumed 或 Invalidated
```

只有所有 digest、identity 和预算确定后才能提交 `ModelInvocationPlanned`。调用后合法 JSON 只说明结构合法；引用、边界和领域语义仍必须分别验证。

## 9. 失败、恢复与失效

### 9.1 PromptPreparationFailure

Prompt 准备失败发生在 Provider 调用前，使用独立 typed blocker：

```ts
export type PromptPreparationFailureCode =
  | "prompt_contract_required"
  | "prompt_contract_version_mismatch"
  | "prompt_contract_digest_mismatch"
  | "profile_overlay_missing"
  | "policy_overlay_invalid"
  | "output_schema_mismatch"
  | "untrusted_source_boundary_failed"
  | "prompt_size_exceeded";
```

失败时：

1. 追加 checkpoint blocker/Finding；
2. 不产生 `ModelInvocationStarted`；
3. 不消耗 Provider budget；
4. Standard/Governed 必需槽位保持 blocked；
5. 不静默切换 Manual、其他模型或其他 Prompt；
6. Registry/配置修复后从同一 checkpoint 恢复。

Provider 调用后的 timeout、budget、invalid output、citation missing 等继续使用 `ModelPortFailure`。

### 9.2 精确失效

以下任一变化使未消费 Result 失效并重新编译 Prompt：

- contract/version/digest；
- Profile 或 Policy Overlay；
- input bundle 或 baseline；
- output Schema；
- model/config/budget；
- port/purpose 或 conversation identity。

已完成历史保留原 Invocation/Result/Evidence，不原地改写。Protocol 1.0 不补造 Prompt Evidence。

## 10. Cache 与会话

Cache key 至少包含：

```text
port + purpose
+ prompt_contract_digest
+ profile_overlay_digest
+ policy_overlay_digest
+ input_bundle_digest
+ output_schema_digest
+ model/config/budget digest
```

Proposal/Review、不同 purpose、不同 Profile 或不同 Policy Overlay 不共享 cache/hidden history。Cache 命中仍需验证当前 Binding、baseline 和 Schema digest。

## 11. 安全与隐私

1. PromptCompiler 不读取项目目录；只接收 Harness 编译的 typed bundle。
2. Provider 继续在无项目工作区、Ledger、Evidence sink 和宿主 cwd 的环境运行。
3. Prompt、Bundle 和模型输出递归拒绝 command/tool/unknown field。
4. Secret、credential path、私钥、环境变量和未授权 realpath 不得进入 compiled prompt。
5. 原始 Prompt 默认不在 Dashboard 展示；只展示 contract/version/digest。
6. 脱敏编译产物按 Policy 作为受控 artifact 保存，Provider 无 Evidence sink 写权限。
7. Prompt 自述“已遵守规则”不成为安全 Evidence。

## 12. Dashboard 与可观察性

模型调用视图增加：

- Prompt contract id/version；
- contract、Profile Overlay、Policy Overlay 和 compiled prompt digest；
- output Schema digest；
- Prompt preparation 状态、typed blocker 和恢复入口；
- model、预算、用量、Result validation 和引用覆盖。

默认业务视图不展示完整 Prompt。审计展开仅访问已脱敏 artifact，并继续同时展示 Harness 确定性风险、范围、对象和 digest。

## 13. 实施兼容策略

### 13.1 T1–T7 最小回补

该回补使用新的、可独立回滚的增补提交，不 amend/rebase T1–T7 历史提交；它只演进尚未发布的 Protocol 1.1 当前 Schema、fixtures 与 Compiler contracts。

不重写已完成业务逻辑，只增加：

- `PromptContract`、`PromptPreparationFailure` 与扩展 Binding Schema；
- Registry 解析和 canonical/golden fixtures；
- Profile/Capability Compiler 的 contract digest 解析；
- Capture-scope binding 的 contract/output Schema digest；
- Proposal/Review/Discovery/Approval Brief 的 contract 注册信息。

`prompt_version` 配置继续可用。用户无需手工维护 digest。

### 13.2 T8-A 不受影响

当前 DAG contract、checkpoint、Kernel Coordinator 和 Orchestrator 拆分不依赖 Prompt 内容。增补不修改 T8-A 的公共接口；PromptCompiler、Preparation blocker 和 Runner 接线只进入 T8-B。

### 13.3 后续领域 Task

- T10 注册 Impact Advisory Contract；
- T12 注册 Design Proposal/Review Contract；
- T13 注册 Plan Proposal Contract；
- T14 注册 Context Enrichment Contract；
- T17 注册 Feedback Analysis/Iteration Narrative Contract；
- T18 展示 Prompt provenance 和恢复入口；
- T19 完成真实模型质量、安全和漂移回归。

## 14. 测试策略

### 14.1 Schema 与 canonical

- PromptContract、Binding 扩展、CompiledPrompt 和 Preparation failure 严格 Schema；
- unknown field、错误 enum、空 segment、错误 digest 被拒绝；
- 同一 canonical 输入产生同一 contract/compiled digest；
- 相同 id/version 不同内容启动失败；
- 输入排序变化不改变 digest，语义变化必须改变 digest。

### 14.2 编译不变量

- 七段固定顺序；
- Profile/Policy Overlay 不能删除或覆盖 Authority Boundary；
- 未注册 Policy clause 被拒绝；
- 项目文本始终位于 untrusted-input；
- output Schema 与 Binding 不一致时不启动 Provider；
- Lite 未启用槽位零 Prompt 编译。

### 14.3 领域 golden

每个 Port/purpose/Profile 至少一个 golden compiled prompt，验证：

- 角色和领域 rubric 正确；
- Lite/Standard/Governed 深度递增但权威边界一致；
- Proposal/Review contract、bundle 和 conversation 独立；
- Grounded 四 purpose 不串用指令或 Schema。

### 14.4 攻击与负向语义

- README/代码/日志内 Prompt injection；
- 伪造 system/developer/tool 指令；
- source delimiter 逃逸；
- 超尺寸、深度、Unicode 混淆和恶意日志；
- 合法 JSON 但尝试自动批准、降风险、扩大路径或补造 Evidence；
- 引用存在但语义结论错误，citation integrity 不得升级为业务 truth。

### 14.5 漂移、恢复与 E2E

- contract/Profile/Policy/input/Schema/model 任一漂移精确失效；
- prepare 失败零 Provider 调用/预算；
- crash/resume 不重复产生 invocation；
- Standard/Governed 缺 contract/provider fail closed；
- Lite 零模型工件；
- 真实模型覆盖全部 Port/purpose，记录修订率、越权拒绝率、citation coverage、invalid output 和 Prompt preparation blocker。

## 15. 完成定义

1. 所有模型 Port/purpose 都有独立、版本化 Prompt Contract 和领域 rubric。
2. Binding 固定 contract/version/digest 与 output Schema digest；Invocation 固定 compiled prompt digest。
3. 所有 Prompt 只经 `PromptCompiler` 生成，Adapter 无任意 system prompt 注入口。
4. Profile/Policy Overlay 不能弱化 Authority Boundary 或改变 Schema。
5. 项目内容始终作为不可信数据，Prompt injection 测试通过。
6. Prompt 准备失败在 Provider 调用前 fail closed、零预算、可恢复。
7. Prompt 漂移精确失效未消费 Result，历史 Invocation 不改写。
8. Lite 未启用模型槽位零 Prompt 编译和模型工件。
9. Dashboard 可审计 contract/version/digest、阻塞和恢复，不默认泄露完整 Prompt。
10. 真实 Standard/Governed E2E 证明每个 Port/purpose 的 Prompt、会话、Schema 和 Evidence 独立。
11. T1–T7 兼容补丁、T8-B 公共深模块和 T10–T19 领域接入均有 Red/Green 证据。
12. Protocol 1.0 历史与已完成事实保持不变。

## 16. 被否决方案

### 16.1 每个 Adapter 自由拼接 Prompt

实现快，但会重复版本、安全、Profile、Evidence 和测试逻辑，无法证明跨 Adapter 一致性，因此否决。

### 16.2 动态通用 Prompt + JSON Schema Port

会把领域不变量泄漏给调用方并形成 Prompt 转发器，与现有领域 Port 设计冲突，因此否决。

### 16.3 Protocol 1.1 首版使用外部 Prompt Pack

便于运营迭代，但会提前引入签名、远程来源、供应链、兼容矩阵和发布审批问题。首版使用仓库内版本化 Registry，外部 Pack 留待后续协议。

## 17. 实施边界

本增补通过一组插入式工作包嵌入现有 19-task：T1–T7 兼容补丁、T8-B 公共 Prompt Governance、T10–T17 领域 Contract、T18 Projection、T19 E2E。它不改变 T8-A DAG Engine 边界，不增加公共 Phase、Graph Node、固定审批点或 Task 20。
