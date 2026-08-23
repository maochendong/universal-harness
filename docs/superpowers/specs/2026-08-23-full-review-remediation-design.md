# Universal Harness 全量评审剩余问题修复设计

> 日期：2026-08-23  
> 状态：方案 A 已确认，书面设计待复核  
> 基线：`d829863909c971fc3e18efd6262bf4ee4e3f28d1` 及其上的既有未提交修复  
> 范围：全量评审遗留的 P0–P3，不改写已完成 Protocol 1.0 历史

## 1. 背景与目标

评审确认 T1–T19、模型 Advisory 和 Prompt Guidance 的多数领域组件已经存在，但部分能力仍停留在 `component_complete`，没有达到 `production_wired` 或 `evidence_proven`。当前工作树已经修复了 Capture 可恢复澄清、模型结果持久化、模型 Provider fail-close、默认 Planner Assertion、风险自适应审批以及缺少执行器时 fail-close 等问题；本设计保留并收口这些修改，完成剩余缺口。

最终目标不是让旧测试恢复绿色，而是使下列事实同时成立：

1. 不可信项目仓库不能决定向哪个网络端点发送哪个环境变量中的秘密。
2. 实现型 Task 缺少显式执行器时必须阻塞，不能用零变更 Direct Executor 伪造完成。
3. accepted `CapabilityPlan.operation_dag` 是 Capture 之后唯一的生产编排权威源。
4. `strict_tdd` 真正约束适用 Task，并生成可验证的 Baseline/Red/Green Evidence。
5. `FeedbackAnalysisPort` 有生产调用点，但模型建议不能覆盖确定性 RCA 或直接改变权威状态。
6. CI、验收报告和三档 dogfood 只根据真实、不可变的执行证据声明完成。
7. 大型协调器被拆成可独立理解、测试和替换的深模块，不产生第二套状态机。

## 2. 非目标

- 不引入远程多租户控制面、多人投票审批或分布式租约。
- 不把 Dashboard、Markdown、模型输出或 Agent 自述提升为权威源。
- 不自动改写已完成的 Protocol 1.0 Ledger、digest 或 Snapshot。
- 不在本轮扩展新的 Profile、模型 purpose 或全局生命周期 phase。
- 不把所有历史项目立即重写成 runtime config v3；旧格式保留一个 major 的受控兼容读取。

## 3. 全局不变量

### 3.1 权威性

- Ledger 与 typed records 保存权威状态；Graph 保存 accepted 工程事实；Dashboard/Markdown 只是 Projection。
- 只有 accepted final CapabilityPlan 可以授权 Plan、Context、Execute、Verify、Evaluate 与 Snapshot。
- 模型只能生成 Proposal、Review、解释和候选；确定性 Compiler、Gate、Evaluation、人工审批与 Evidence 决定权威结果。
- 所有继续执行都绑定 `operation_id`、对象 digest、CapabilityPlan digest 和最新有效 checkpoint。

### 3.2 安全性

- `.harness/runtime.json` 始终视为不可信项目输入。
- 项目配置可以选择已知 Provider 引用、模型、purpose/slot、预算与 Gate 口径，但不能定义 endpoint、密钥环境变量、网络放宽项或秘密 allowlist。
- Secret 只在最终 transport 边界读取；不得进入配置摘要明文、Ledger、Evidence、spool、日志或 Dashboard API。
- Provider/Judge 响应必须边读边执行字节上限；不得先完整缓冲再检查大小。

### 3.3 兼容性

- Protocol 1.0 已完成事实只读。
- runtime config v1/v2 的 inline endpoint/secret 字段只作为兼容断言：必须与宿主可信 Registry 的唯一条目逐字段匹配，运行时始终采用 Registry 值，并给出弃用告警；不匹配直接阻塞。
- 无 Profile 的历史项目继续走 Protocol 1.0 reader；有 Protocol 1.1 Profile/CapabilityPlan 的项目不得回退 legacy 固定流水线。

## 4. 修复工作包与依赖

```text
WP0 现有修复收口
  ├─→ WP1 可信 Provider/Judge Binding
  ├─→ WP2 CapabilityPlan 生产编排 + strict TDD
  │      └─→ WP3 Feedback Analysis 与证据闭环
  └─→ WP4 CI/验收报告/三档 dogfood
             └─→ WP5 协调器深模块拆分与最终审计
```

WP1 与 WP2 在 WP0 后可以独立推进；WP3 依赖真实 DAG 调用点；WP4 必须消费 WP1–WP3 的最终行为；WP5 只在行为门禁稳定后进行等价拆分。

## 5. WP0：收口现有未提交修复

保留当前工作树中已经实现的方向，并先修复测试语义漂移：

- Standard 低风险 Capture 可由批准策略自动接受，因此旧测试不能固定断言每次都有 `CapturePrdProposal` 人工批准。
- 缺少执行器的实现型 Task 返回 `executor_required`；只有显式注入的 deterministic workflow executor 才能用于测试或受控自动化。
- 默认 Planner 的 Assertion 测试必须显式注入执行器，避免在验证 Assertion identity 前被执行预检阻塞。

WP0 完成后，现有定向集合必须从 142/148 恢复到 148/148，同时保持新的负向断言：低风险审批次数可变、无执行器不能完成、Assertion identity 不因无关 Criterion 漂移。

## 6. WP1：可信 Provider/Judge Binding

### 6.1 公共接口

新增宿主拥有的窄接口：

```ts
export interface TrustedProviderRegistry {
  resolve(input: {
    provider_ref: string;
    consumer: "managed_model" | "llm_judge";
  }): ResolvedTrustedProvider;
}

export interface ResolvedTrustedProvider {
  provider_ref: string;
  provider_identity: string;
  endpoint: string;
  api_key_env: string;
  env_allowlist: readonly string[];
  allow_loopback_http: boolean;
  policy_digest: string;
}
```

Registry 由 CLI 宿主装配。内置 DeepSeek 条目属于发布物代码，不属于受管仓库；嵌入宿主可以注入自己的 Registry。测试 loopback 条目只能由测试/宿主注入，项目配置不能开启 `allow_loopback_http`。

### 6.2 runtime config v3

新项目写入 v3 引用形态：

```json
{
  "model_providers": [{
    "provider_ref": "deepseek",
    "model": "deepseek-v4-flash",
    "slots": ["prd_proposal"],
    "is_default": true,
    "timeout_ms": 60000
  }],
  "judge_gates": [{
    "gate_id": "gate_llm_review",
    "provider_ref": "deepseek",
    "model": "deepseek-v4-flash",
    "prompt_version": "judge.v1",
    "timeout_ms": 60000
  }]
}
```

endpoint、`api_key_env`、`env_allowlist` 和 loopback 权限不再出现在 v3 项目 Schema。v1/v2 兼容适配器把 inline 配置解析成 provider_ref 请求并要求与 Registry 唯一精确匹配；任何字段漂移均返回 typed configuration error。

### 6.3 Transport

- Managed Model 与 LLM Judge 共用 Registry 解析结果和 policy digest 规则。
- config/binding digest 覆盖完整 canonical endpoint、provider identity、模型、预算、用途和 trusted policy digest，而非只覆盖 origin。
- LLM Judge 使用流式 reader，累计超过 `MAX_PROVIDER_RESPONSE_BYTES` 时立即取消 body 并返回 `invalid_provider_response`。
- endpoint URL 必须与 Registry canonical URL 完全一致；仍执行协议、credential URL、私网/loopback 与 DNS 校验。

### 6.4 失败语义

未知引用、消费者不允许、旧配置不匹配、secret 缺失、endpoint 非法和响应超限全部 fail closed。Standard/Governed 的 required binding 缺失或 Provider 失败继续阻塞；Lite 只有未启用/optional slot 才能保持无调用。

## 7. WP2：CapabilityPlan 成为生产编排权威源

### 7.1 两段启动

Capture 必须先取得 accepted RequirementBaseline，CapabilityPlan 才能编译，因此运行分为两个受控阶段：

1. **Capture bootstrap**：先创建真实 workflow Operation，Capture Coordinator 只负责产生并批准 RequirementBaseline、Risk 和 Capture-scope binding。
2. **Graph execution**：立即编译 CapabilityPlan，并将已提交 Capture binding 导入为 DAG 的 `capture` checkpoint；从此所有后续推进只由 `WorkflowDagEngine` 按 `operation_dag` 执行。

bootstrap 不能执行 impact/design/plan 等任何后续 phase，因此不是第二套生产流水线。

### 7.2 Standard 两阶段 CapabilityPlan

- Lite/Governed 按既有 Compiler 规则直接生成 final plan。
- Standard 先生成 provisional plan，允许 DAG 运行到 Design checkpoint，但不得进入 Plan。
- accepted DesignSet、final CapabilityPlan、operation-scope bindings 与 design checkpoint 在同一 Ledger transaction 提交。
- DAG runner 返回 typed `plan_superseded`，外层重新加载 final revision；WorkflowDagEngine 按 node wiring 和输入 digest 重放有效前缀，从 Plan 继续。
- provisional、缺失、漂移或非 accepted final plan进入 Plan 时一律阻塞。

### 7.3 Runner Registry

现有领域逻辑不重写，只包装成公共 `DagNodeRunner`：

- Kernel：capture、capability_decision、plan、context、execute、verify、snapshot。
- Module：impact_analysis、design_governance、independent_evaluation、advanced_audit。
- Profile 名称只在 Compiler 输入出现；WorkflowDagEngine 与 runner registry 不写 Lite/Standard/Governed 分支。

旧 `resolveProfileModules()` 只服务 Protocol 1.0 reader，Protocol 1.1 生产运行完全读取 CapabilityPlan resolution 和 DAG。

### 7.4 strict TDD 子图

`strict_tdd` 仍是 execute 内部子图，不新增全局 phase。对 DesignSet 标为 required 的 Task：

```text
Baseline Guard
  → Test Authoring（只能写 test/test-config）
  → Red Verification（结构化失败命中目标 Assertion + FailureOracle）
  → Implementation（只有 accepted RedEvidence 才签发生产写 Grant）
  → Green Verification（同 patch/gate/selector/framework/environment）
  → Refactor Grant（只有 accepted GreenEvidence 才签发）
  → 完整 Gate / Evaluation
```

每一步复用现有 `TddController`、phase grants、隔离 workspace 和 typed Evidence。Task 级 `controlled_not_applicable` 必须绑定 accepted test strategy；它不是 `not_enabled_by_profile`。缺少 Red/Green 成对 Evidence 时，`TaskVerdict` 返回 TDD incomplete/invalid，不能完成 Snapshot。

### 7.5 执行器

新增/固化 `ExecutionBindingResolver` 公共缝：实现型 Task 只接受显式 Agent 或 deterministic workflow binding。Direct executor 不再是默认值；测试若需要它，必须在 fixture 中显式注入并证明预期 write set。

## 8. WP3：Feedback Analysis 生产接线

### 8.1 调用点

Evaluation、Gate、Audit 或运行时错误形成 Finding 后，先运行确定性 RCA。仅当 `shouldInvokeFeedbackAnalysis()` 为真时，由 `FeedbackAnalysisCoordinator` 调用绑定的 `FeedbackAnalysisPort`。

调用总是在 Feedback Router 选择影响层之前，且采用唯一时序规则：Verify/Evaluate 及运行时产生的 Finding 在当前 Snapshot 前完成分析；Snapshot 后的 `advanced_audit` Finding 在下一次 Capture 接受 change seed 前完成分析。它不插入新的全局 phase，也不允许同一 Finding 在两个位置重复调用。

### 8.2 权限边界

- 模型只返回 cited diagnosis、change seed candidates 和 verification suggestions。
- 确定性 RCA 永不被覆盖。
- 低置信度或高风险候选产生人工复核请求；未经复核不得进入 Router。
- Router 独占 target layer、invalidation scope、Capability/Profile 升级和 privileged route。
- Standard/Governed 的 `feedback_analysis` required binding 缺失或失败为可恢复阻塞；Lite optional 未配置时保持确定性路径。
- 每次调用使用独立 prompt、budget、conversation、run identity、result artifact 和 Evidence，不共享隐藏历史。

## 9. WP4：CI、验收报告与真实 dogfood

### 9.1 CI 可重复性

- 临时 Git 仓库 helper 必须写入仓库本地 `user.name`/`user.email`，不依赖 runner 全局身份。
- 恢复 `windows-latest`，调查并修复 fault/e2e 超时；不允许用删除平台来维持“跨平台通过”声明。
- Ubuntu、macOS、Windows 每个 verify job 生成结构化平台 Evidence 并作为 artifact 上传。

### 9.2 AC25

`generate-acceptance-report.mjs` 不得根据“本地 suite 全绿 + ci.yml 存在”推断跨平台成功。AC25 只消费当前 commit、workflow、platform、command、exit status 和 artifact digest 都匹配的 CI Evidence 集：

- 三个平台齐全且通过：`passed`。
- 任一失败：`failed`。
- 本地运行或证据缺失/漂移：`not_verified`，release gate 不通过。

删除旧产品品牌残留，`check-standalone` 必须在受跟踪文件和历史扫描口径下真实通过；不能通过缩小扫描范围掩盖命中。

### 9.3 三档真实纵向闭环

dogfood 对 Lite、Standard、Governed 各至少完成一个：

```text
new/adopt → Capture → CapabilityPlan/DAG → Impact/Design（按档位）
→ Plan → Context → 真实 Agent Execute → TDD（适用时）
→ Gate → Evaluation（启用时）→ Snapshot
```

必须包含真实 Provider、显式执行器、风险策略决定的人工审批、Gate/Evaluation、最终 Snapshot 和干净工作树。主动 abort、只验证模型调用、自动批准所有对象或没有执行器均不能作为闭环通过证据。脱敏证据进入 `docs/evidence/`，原始不可变记录留在 dogfood Ledger。

## 10. WP5：深模块拆分

在 WP0–WP4 全绿后做行为等价拆分：

- `kernel-coordinator.ts` 只保留 Operation/DAG facade 与 runner 装配；Capture、approval、execution/TDD、verify/evaluate、snapshot/recovery 分别进入拥有单一状态转换职责的模块。
- `runtime-service.ts` 只保留 CLI application service facade；配置装配、命令 DTO 映射、审批桥和 resume/input bridge 分离。
- 状态转换仍只有现有 Coordinator/Engine 一份；拆分模块不得复制 Ledger 写入规则或 Profile 分支。
- 每个新模块必须通过公开接口测试；原有 E2E、fault、security 和 digest golden 必须无行为漂移。

目标是让 facade 能在不阅读子模块内部的情况下理解，且任一子模块可独立替换。文件行数只作为审查信号，不作为唯一完成条件。

## 11. 已确认的 TDD 公共测试缝

只在以下公共边界写行为测试：

1. **Trusted Provider Binding seam**：项目 config + 宿主 Registry → resolved binding 或 typed failure。
2. **Execution Binding seam**：Task/Plan + 显式 binding → 可执行授权或 `executor_required`。
3. **CapabilityPlan → Workflow DAG seam**：accepted plan + runner registry + checkpoints → phase/node outcomes、resume 与 invalidation。
4. **Acceptance Evidence seam**：suite/CI/dogfood Evidence → AC/Task/Iteration verdict；不测试报告生成器内部步骤。
5. **Packaged CLI 三档 E2E seam**：用户命令/审批/澄清 → Ledger、Graph、Evidence、Snapshot 可观察结果。

单元测试可以覆盖 canonical/digest/Schema 纯函数，但不得通过 mock 私有方法证明生产接线。每个纵向切片遵循一个失败测试、最小实现、通过后再进入下一片。

## 12. 失败与恢复矩阵

| 失败 | 权威行为 | 恢复方式 |
| --- | --- | --- |
| Provider 引用未知或旧 inline 配置与 Registry 不符 | configuration blocked，零秘密读取/零网络调用 | 修复宿主 Registry 或项目引用后 resume |
| Provider 响应超限 | invocation failed，body 立即取消 | 按 retry/budget policy 重试 |
| 实现 Task 无执行器 | `executor_required`，不得生成完成 Run | 配置显式 Agent/workflow binding 后 resume |
| provisional/漂移 CapabilityPlan 进入 Plan | binding drift blocked | 重编/批准相应上游，加载 final plan |
| DAG runner 缺失或输出不匹配 | typed engine failure，不提交当前 checkpoint | 修复装配后从最后有效 checkpoint resume |
| RedEvidence 不成立 | TDD cycle blocked，生产写 Grant 不签发 | 修正测试/FailureOracle 后新 attempt |
| Feedback 模型缺失或失败 | 按 binding failure mode 阻塞或保持 Lite 确定性路径 | 配置 Provider/重试/人工复核 |
| CI 平台证据缺失 | AC25 `not_verified`，release 阻塞 | 对同一 commit 重跑缺失平台 |
| dogfood 中途 abort/无 Snapshot | evidence incomplete | 从 Ledger checkpoint 恢复并完成闭环 |

## 13. 完成定义

只有以下证据全部存在，本修复计划才能声明完成：

1. 当前既有修改和新增修改通过 format、typecheck、unit、E2E、fault、security、performance、pack smoke、release 检查。
2. Provider/Judge 安全负向测试证明项目仓库不能选择 endpoint 或任意 secret env；响应超限不会先完整缓冲。
3. Protocol 1.1 集成测试证明实际调用序列与 accepted CapabilityPlan DAG 一致，未启用节点零调用，finalization/resume/invalidation 正确。
4. strict TDD dogfood 留有 Baseline、Red、Green、Gate、Evaluation、TaskVerdict 的同链不可变 Evidence。
5. FeedbackAnalysis 在真实 Finding 上被调用，确定性 RCA、人工复核和 Router 权限边界均有负向测试。
6. AC25 对缺失平台为 `not_verified`，三平台同 commit Evidence 齐全才通过。
7. Lite/Standard/Governed 三个真实闭环均到达 completed Snapshot，且工作树结果与 Evidence 一致。
8. `check-standalone` 无旧产品品牌命中，文档状态不再把 component complete 写成 production/evidence complete。
9. 协调器拆分后不存在第二套状态机或 Profile 硬编码，完整回归无行为漂移。

## 14. 实施顺序

严格按 `WP0 → (WP1, WP2) → WP3 → WP4 → WP5 → 全量完成审计` 推进。每个工作包独立保留 Red/Green 命令和证据；任何上游失败不得通过放宽 Schema、删除平台、改低 mandatory、自动批准所有对象或回退 legacy 路径绕过。
