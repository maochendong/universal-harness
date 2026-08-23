> **状态更新（2026-08-23，全量修复基线 `ee9d47a`）**：T1–T24 + PG-0–PG-9 的仓库内能力已从 `component_complete` 收敛到 `production_wired`；CapabilityPlan 生产 DAG、strict TDD execute 子图、FeedbackAnalysis 路由和三档 packaged CLI Ledger 证据均已补齐。Governed dogfood 产生 2 个 TDD cycle 及 Baseline/Red/Green Evidence。`evidence_proven` 仍必须按证据作用域理解：本地/hermetic 证据已完成，但当前真实 DeepSeek 调用未验证，AC25 同 commit Ubuntu/macOS/Windows 工件未齐，因此不能声明跨平台发布完成。
>
> - `component_complete`：组件/模块实现并有单测；
> - `production_wired`：生产编排实际遍历该路径（而非 Profile 硬编码或 legacy fallback）；
> - `evidence_proven`：有不可变实施证据（真实 Agent/Provider 的 Grant/Red/Green/Cycle/Gate/Snapshot 记录）。
>
> 完成矩阵、命令计数与残余风险见 `../../evidence/full-review-remediation-completion.md`。最终验收清单仍以两份实施计划末尾的 checkbox 为准；未勾选项是 Lite Capture UX 指标、当前真实 Provider dogfood 和同 commit 跨平台发布证据，不以历史自述销项。

历史记录：T1–T19 + PG-0–PG-9 组件实现止于 `9d0e3bf`。其后落地 Managed 模型 Provider 层（`77d0131`）、T20–T24 生产改接与引用保真修复，再由 `e860f45` / `0530cba` 定义的全量修复计划完成安全边界、DAG/TDD/Feedback 生产接线、三档证据和 façade 拆分。下图保留为历史实施依赖，不表示 T20 仍待开工。

````
```mermaid
flowchart TD
    DONE["已完成：T1–T7 + T8-A"] --> PG0["PG-0<br/>Prompt Schema / Registry / Binding 回补"]
    PG0 --> PG1["PG-1<br/>PromptCompiler"]
    PG1 --> PG2["PG-2<br/>Managed Runner + Capture 接线"]
    PG2 --> T8B["T8-B 完成"]

    T8B --> T9["T9<br/>Lite 最小纵向闭环"]
    T8B --> T10["T10 + PG-3<br/>Impact / Evaluation / Audit"]
    T10 --> T11["T11<br/>DesignSet Schema / Validator"]
    T11 --> T12["T12 + PG-4<br/>Design Proposal / Review / Approval"]
    T12 --> T13["T13 + PG-5<br/>Plan / Assertion / TDD Contract"]

    T13 --> T14["T14 + PG-6<br/>Context Enrichment / Preflight"]
    T13 --> T15["T15<br/>隔离工作区 / Patch / Grant"]
    T14 --> T16["T16<br/>TDD Controller / Evidence / Verdict"]
    T15 --> T16

    T10 --> T17["T17 + PG-7<br/>Feedback / Invalidation / Narrative"]
    T12 --> T17
    T16 --> T17

    T9 --> T18["T18 + PG-8<br/>CLI / Dashboard / Projection"]
    T17 --> T18
    T18 --> T19["T19 + PG-9<br/>三档 E2E / Dogfood / 发布验收"]
    T19 --> T20["T20<br/>流水线改接 model-backed 适配器"]
```
````

## 建议执行顺序

### 第一批：补完 T8 模型运行基础（已完成）

严格串行：

1. PG-0：Prompt Contract、Registry、Binding Schema 回补
2. PG-1：PromptCompiler、安全分区、Policy Overlay、Preparation Failure
3. PG-2：ManagedModelInvocationRunner、Invocation Evidence、T5/T7 接线

完成 PG-2 后，T8-B 才完成，所有后续模型 Port 才有统一运行底座。

### 第二批：先证明 Lite 最小闭环（已完成）

1. T9：Lite Kernel-only 完整纵向闭环

虽然 T9 与 T10 技术上都只依赖 T8，但建议先完成 T9。它负责证明：

- 未启用能力零节点、零工件、零 Prompt 编译；
- Capture → Plan → Context → Execute → Verify → Snapshot 可独立工作；
- 新的 Prompt Governance 没有把 Lite 重新变重。

### 第三批：建立 Impact → Design → Plan 主干（已完成）

1. T10 + PG-3：Impact Advisory、Evaluation、Audit contributors  
2. T11：DesignSet Schema、覆盖规则、纯 Validator  
3. T12 + PG-4：Design Proposal、独立 Review、人工批准、原子提交  
4. T13 + PG-5：Plan Proposal、Criterion→Assertion、TaskTddContract

这一段必须串行，因为：

```
冻结 ImpactSet
→ 才能设计 DesignSet
→ accepted DesignSet
→ 才能编译 Plan 和 TDD Contract
```

### 第四批：形成可证明执行（已完成）

T13 后出现唯一适合并行的分支：

1. T14 + PG-6：Context Enrichment、ExecutionPreflight  
2. T15：隔离工作区、测试补丁、Phase Grant

两者都完成后：

1. T16：Baseline → Red → Green → Refactor、Evidence、TaskVerdict

若单线程实施，建议按 `T14 → T15 → T16`；若并行开发，T14 和 T15 可以同时进行，但必须避免共同修改 execution-preflight/authorization 接口。

### 第五批：反馈闭环、产品入口和发布（已完成）

1. T17 + PG-7：FeedbackAnalysis、Finding 级联、失效、迁移、Iteration Narrative  
2. T18 + PG-8：CLI、Adapter、Read API、Dashboard、Prompt provenance  
3. T19 + PG-9：Lite/Standard/Governed E2E、真实 Provider dogfood、安全与发布门禁

### 第六批：流水线改接 model-backed 适配器（已完成）

1. T20：capture/design/impact 主流水线改接 model-backed 适配器

背景：PG-2 起 model-backed 适配器已建好但刻意不接生产流量（legacy 兼容期为一个 major，新旧同时配置 fail closed）。Managed Provider 层（`77d0131`）落地后，改接的前提已经具备。

任务卡：

1. **capture**：`runtime-service` 的 capture 流程按 `model_providers` 配置选择 model-backed 端口（PrdProposal/PrdReview/project discovery/approval brief）；Standard/Governed 的 required 槽位缺失直接 blocked，Lite 非模型路径保持零 Prompt 编译、零 Provider 调用。
2. **design/impact**：PG-3/PG-4 的 model-backed 适配器（impact advisory、design proposal/review）同样按槽位接线；legacy adapter 退为显式 opt-in。
3. **迁移语义**：无 `model_providers` 的既有项目维持 legacy 路径并输出弃用告警；声明了配置但槽位无覆盖时 fail closed，不设隐式优先级。
4. **验收**：三档 profile 各跑一遍真实 Provider dogfood（一并消掉 T19 留下的外部条件留白，需有效 API key 与外网）。

## 历史提交目标

```
feat(cli): route capture through model-backed adapters    # T20 切片 1（e7475ad，已完成）
feat(cli): route design/impact through model-backed ports # T20 切片 2（2ee8f84，已完成）
test(release): three-profile real provider dogfood        # T20 切片 3（已完成，证据 docs/evidence/t20-real-provider-dogfood.md）
```

切片 3 完成备注：三档真实 dogfood（deepseek-v4-pro）跑通，证据含
before/after 对照；dogfood 暴露并已修复三个缺口（`ef2d9e4`：output schema
嵌入编译提示词、invocation budget 贯通、capture memo）。同时产出三个
后续事项：

1. **T21 候选：design 端口输入保真**（已落地 `4aade1b`）。design 适配器新增
   `node_content` 解析，must-change 需求与 criterion/test 节点内容分项进入
   提示词；CLI 经物化图解析，缺失即 fail-closed。重跑后真实模型正常产出
   design 草案（consumed）。
2. **T21 候选：pipeline 端口输入编译保真与分项**（已落地 `4aade1b`）。
   advisory 整图单 item 改为摘要 + 每节点独立 item，governed 档尺寸合规。
3. **T22：prompt 契约的领域规则遵从度**（三轮迭代已落地，standard 档 design
   全链真实跑通：proposal/review 均 consumed，review 给出实质性
   revision_required；governed 到达 review，残余 review 引用保真
   unknown_affected_target）。后续每轮 prompt 迭代用
   `scripts/dogfood-real-provider.mjs` 回归。
3. **Capture-scope 槽位生产接线**（已完成）：prd_review /
   project_discovery / approval_brief 随 protocol-1.1 capture coordinator
   迁移落地——切片 1 生产装配（`managed-capture-coordinator.ts`），切片 2
   orchestrator 门控切换（有 profile + model_providers 的项目 capture 全程
   走 coordinator，approval 桥复用引擎决策账本；无配置/无 profile 保持
   legacy）。`criterion_test_pairs` 在 coordinator 路径下非空。

## T23：引用保真 prompt 迭代（已完成）

两类残余引用造假（`unknown_affected_target` / `citation_invalid`）经四轮
真实 dogfood 收敛；根因修复包括 synthesis-input 注入 `bundle_sources`
清单、grounded invocation id 保留 purpose、plan 端口 `node_content` 输入
保真。证据：`docs/evidence/t23-reference-fidelity-dogfood.md`。
