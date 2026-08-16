# dsh 执行后端对照设计与任务卡

**状态**：提议
**日期**：2026-08-14
**范围**：M1.x 增强；不改 Core schema，不改既有相位编排

本文把 DeepSeek 开源的 agent 运行时 deepseek-harness（下称 dsh，
<https://github.com/deepseek-ai/deepseek-harness>，master，MIT，developer
preview）接为 Universal Harness 的第一个真实执行后端，并给出五张可独立
提交的任务卡。分层主张一句话：**harness 是控制平面（需求图 / 审批门 /
证据链 / 审计），dsh 是可替换的执行零件**；Executor 是 port，dsh 是第一
个实现，kimi-code（`kimi -p --output-format stream-json`）是第二个候选
实现，用于实证"执行者可替换"。

参考资料：dsh 源码（master 分支 tarball），本文引用的 CLI 与事件形态以
其 `packages/bundle/headless/README.zh.md`、`docs/architecture.zh.md`、
`docs/subsystems/persistence.md` 为准。

## 当前强制约束

dsh 作为 `delegated / external-only / unmetered / no interception` Adapter 接入时永远不能 unattended。每次执行前必须由人批准 ExecutionAuthorizationSpec；tokens 与 steps 在 Run、Evaluation、status、Snapshot 中均投影为 `unavailable`，只有 Harness 实测 duration 并强制 timeout。

Harness 每 5 秒写一次 heartbeat，当前命令每 30 秒聚合显示一次；stdout 的最终 JSON 不夹杂进度。dsh 返回 `handoff` 时，RunTerminated 保持 `handoff`，后续 Gate/Evaluation 可以令 TaskVerdict 为 passed、Iteration 为 completed，但任何层都不得回写 Run 原始事实。

执行前后由 Git VCS Adapter 采集真实 DiffStat，包括 rename、未跟踪文本和 binary。实际路径或规模超出批准的 Impact Forecast 时生成 scope drift，阻止源码提交与完成 Snapshot，并回到 impact 重新同步图、分析、批准和计划。

## 1. 定位与边界

### 1.1 分层

```text
Universal Harness（控制平面）
  需求图 / ImpactSet / ExecutionPlan / 审批门 / Gate / Evidence / Audit
  │  Task Envelope（port：OrchestrationExecutor）
  ▼
dsh（执行运行时，可替换零件）
  agent loop / 工具注册表 / 沙箱与权限策略 / 会话事件日志
```

harness 的相位编排、批准点、证据链与审计完全不变：dsh 只在 execute 相位
收到一个 Task Envelope，返回一个结构化 Run 结果。run 的落成、门禁、评估、
快照、Finding 级联全部留在 harness 侧。

### 1.2 审批层级联：两层各管各的

- **harness 管"该不该做"**：RequirementBaseline / ImpactSet 批准门绑定
  精确 digest，漂移即失效；Capability Grant 只收窄不扩张。
- **dsh 管"安不安全"**：dsh-base 自带沙箱与权限策略（`fs-sandbox` 围栏
  写盘、shell 沙箱执行器、permission switcher 与 approval service；见
  `packages/bundle/base/README.md`）。headless profile 没有任何用户交互
  surface，因此 dsh 侧的审批策略必须以非交互方式预置（profile /
  `cordis.patch.yml` / permission presets），并在适配器 manifest 里如实
  声明 control profile——dsh 内部审批永远不应向 harness 用户弹出第二次
  询问；无法在 dsh 侧声明安全的动作应在 harness 侧就不被授予。

两层都不许静默放行：harness 拒绝未批准的执行，dsh 拒绝策略外的副作用。

### 1.3 薄集成原则（developer preview 对冲）

dsh 处于 developer preview，`SESSION_FORMAT_VERSION = 0` 明言不保证兼容
（`docs/subsystems/persistence.md`），master 随时有 breaking changes。
因此集成层必须薄：

- **只走 CLI 契约**：`dsh --profile headless "<task>"`（一次性运行，
  stdout 为最后一条非空 assistant 文本，`turn/end` 正常完成退出码 0、
  否则 1；error 结束时 code 与 message 落 stderr；不监听任何端口——见
  headless README）。禁止 import dsh 内部包 API。
- **会话日志按字节归档，不解析进协议**：headless 运行后 dsh 把会话事件
  持久化到 profile 内的项目/会话目录（JSONL 后端；`SessionPersistence
  .locate` 只给路径提示）。适配器把该 transcript 原样归档进 harness 的
  raw-traces（脱敏后），只从 stdout/stderr/退出码构造权威 Run 结果；
  解析 transcript 内容只做 best-effort 的遥测浓缩，永不作为权威依据。
- **版本钉住 + 契约探针**：适配器 manifest 声明实测过的 dsh 版本；启动
  时跑一次 cheap 探针（`--help`/短任务）验证 CLI 契约，不符则以类型化
  错误失败，绝不猜测。

## 2. 与既有架构的接点

| 接点 | 真实路径 | 说明 |
|---|---|---|
| Executor port | `packages/runtime/src/orchestration/orchestrator.ts` 的 `OrchestrationExecutor` / `deps.execute` | 一个 Task Envelope 进、一个 `AgentRunResult`（`packages/plugin-sdk`）出；throw = 进程级崩溃语义不变 |
| CLI 接线 | `packages/cli/src/runtime-service.ts` 的 `orchestratorDeps`（现状 `execute: options.execute ?? createDirectExecutor()`） | 按 adapter 选择注入 dsh/kimi 实现 |
| 既有命令适配器 | `adapters/agent-command/`（adapter/manifest/process/telemetry） | 通用命令包装器的进程管理与遥测模式可复用；dsh 适配器新建 `adapters/agent-dsh/` |
| 分解 port | `orchestrator.ts` 的 `PlanTasksPort`（T2） | 模型提议任务边界，`validatePlanProposal` 裁决 |
| 解析 port | `orchestrator.ts` 的 `IntentInterpreter` / `ClarificationOffer`（T4） | 模型结构化解析意图，歧义返回带选项澄清 |
| raw-traces / telemetry | `adapters/agent-command/src/telemetry.ts` 的模式；run 结果挂 `evidence[]` | 原始轨迹不入 Git，脱敏结构化事件全量保留 |
| Conformance | `packages/conformance/` + `examples/plugin-minimal/` | 新适配器 manifest 过契约验证 |
| dogfood 场景 | atlas-mvp 项目（既有 dogfood 仓库）的 T4 阶段任务 | 真实多任务迭代走 dsh 执行后端 |

## 3. 任务卡

实施顺序：D1 → D2 → D3 / D4（并列）→ D5（任意时刻）。理由：D1 用最小
成本钉死 CLI 契约，之后所有卡都引用它的记录；D2 是主菜，D3/D4 复用 D2
的调用封装（同一进程管理、超时、错误映射）；D5 是纯对照组，随时可做。

### D1 -- dsh-headless 环境 spike（先做）

- **目标**：本机跑通 `npx @deepseek-ai/dsh --profile headless "<task>"`
  的一次性运行，把 CLI 输入/输出/退出码/会话日志位置的实测形态文档化，
  不写任何 harness 代码。
- **触及文件**：新文档 `docs/dsh-headless-contract.md`（实测记录：
  命令行、stdout 形态、退出码矩阵、stderr 形态、transcript 落盘位置、
  模型/凭据前置条件）；不涉及代码。
- **验收断言**：
  - 文档记录一次 fixture 任务（如"在给定空目录创建一个 hello.txt"）的
    完整端到端：命令行、退出码 0、stdout 非空文本、stderr 为空。
  - 文档给出失败路径实测至少各一条：空任务被拒绝、dsh 未安装/模型不可
    达时的退出码与 stderr 形态。
  - 文档钉住实测 dsh 版本号与 transcript 文件的实际落盘路径（相对
    dsh home），作为 D2 的契约输入。
- **依赖**：无。**规模**：S。

### D2 -- Executor port 的 agent-dsh 适配器（主菜）

- **目标**：execute 相位把 Task Envelope 交给 dsh-headless 执行，Run 结
  果按 `AgentRunResult` 契约回账；dsh 会话 transcript 归档进
  raw-traces；dsh 不可用/失败走类型化失败与 Finding 级联（绝不 throw
  业务失败）。
- **触及文件**：新建 `adapters/agent-dsh/`（adapter、manifest、进程管
  理复用 `adapters/agent-command/src/process.ts` 的模式）；CLI 接线点
  `packages/cli/src/runtime-service.ts`（`--agent dsh` 或 pack 配置选择
  executor）；契约测试 `packages/conformance` 注册；e2e 用 fake dsh
  可执行文件（`tests/e2e/` 风格）注入。
- **验收断言**：
  - Envelope → CLI 映射确定：同一 envelope 产生同一命令行与任务文本
    （golden 断言），任务文本包含 objective / acceptance / 边界约束。
  - dsh 退出码 0 且 stdout 非空 → `outcome: "handoff"`、
    `completion_claimed: true`、summary 取自 stdout；非 0 → 类型化失败
    （`failed`/`partial`）且 `completion_claimed: false`，stderr 进
    summary；进程超时 → `failed`，run 终止原因为 `timeout`。
  - dsh 二进制缺失/探针失败 → 类型化 `adapter_failure`，迭代进入
    blocked Finding 级联（不 abort、不静默）。
  - transcript 文件以脱敏字节归档进 raw-traces 目录，Run 结果的
    `evidence[]` 引用其 digest；归档内容不含环境变量泄漏（脱敏测试）。
  - 崩溃对账不回归：executor 进程被 kill 后 resume 恰好一条
    RunInterrupted + 一条 successor（复用既有崩溃测试形态）。
- **依赖**：D1（契约记录）。**规模**：L。

### D3 -- PlanTasksPort 由 dsh 模型驱动

- **目标**：plan 相位的任务分解可由 dsh 模型提议（多任务、依赖标注），
  harness 用 `validatePlanProposal` 裁决；模型输出不可校验时回退确定性
  默认分解（每需求一任务）。
- **触及文件**：`adapters/agent-dsh/` 内新增分解提示与输出解析（复用
  D2 的调用封装）；`packages/cli/src/runtime-service.ts` 接线
  `planTasks`；runtime 侧零改动（port 已存在）。
- **验收断言**：
  - 模型返回的 3 任务 2 依赖 JSON 提案通过 `validatePlanProposal` 并逐
    任务执行（编排器测试，fake executor 记录拓扑序）。
  - 模型返回非法提案（缺字段/环依赖/越界路径）→ 以类型化 PlanningError
    拒绝，不进入执行。
  - 模型不可达 → 回退默认分解，迭代照常完成；回退事实记入 ledger 事件。
  - 同一意图 + 同一模型输出 → 同一 plan digest（确定性）。
- **依赖**：D2（调用封装）、T2（已落地）。**规模**：M。

### D4 -- IntentInterpreter 由 dsh 模型驱动

- **目标**：capture 相位用 dsh 模型把自由文本意图解析为结构化需求/
  约束；歧义时返回 `ClarificationOffer`（2-4 选项，harness 追加 `other`
  ——T4 已落地的形态）。
- **触及文件**：`adapters/agent-dsh/` 内解析提示与输出校验；CLI 接线
  `interpret`；runtime 侧零改动（port 已存在）。
- **验收断言**：
  - 明确意图 → 结构化 `requirements[]` 进入既有 capture/基线批准门
    （编排器测试断言 baseline digest 与纯函数路径一致可比）。
  - 歧义意图 → `input_required` 且每问 2-4 选项 + `other`（复用 T4 的
    规整与拒绝语义；模型给出畸形选项 → 配置错误而非静默）。
  - 模型输出不是合法 JSON/缺字段 → 回退 `createGenericInterpreter` 的
    无损转换，迭代不中断。
- **依赖**：D2（调用封装）、T4（已落地）。**规模**：M。

### D5 -- agent-kimi 对照适配器（可选）

- **目标**：用 `kimi -p --output-format stream-json` 实现同一
  `OrchestrationExecutor` port，与 dsh 互为对照，实证"执行者可替换"。
- **触及文件**：新建 `adapters/agent-kimi/`（结构镜像 agent-dsh）；
  CLI 接线同上（`--agent kimi`）。
- **验收断言**：
  - 同一 fixture 任务分别经 dsh 与 kimi 执行，两者都产出契约合法的
    `AgentRunResult`（同一套契约断言跑两遍）。
  - 切换适配器不改任何 runtime 代码（仅 CLI 接线差异），既有编排器测试
    全绿。
  - stream-json 事件流解析失败 → 类型化失败而非 throw（与 D2 同一失败
    语义）。
- **依赖**：D2（契约与测试形态参照）。**规模**：M。

## 4. 明确保留的 harness 差异点

- **审批不在执行器内**：dsh 的 permission/approval 只负责沙箱安全；要不
  要做、做什么、做到哪一步，永远由 harness 的批准门与 ExecutionPlan
  决定。执行器看不到批准过程，也不能自我批准。
- **证据链不回读模型输出**：Run 结果的权威字段（完成声明、变更摘要、
  工具活动）必须经门禁与评估验证；模型说"完成了"只是 claim，不是事实。
- **轨迹归档而非信任**：dsh transcript 是 raw trace（脱敏归档、可审
  计），不进入 Git 权威历史，也不作为任何判定的输入。
- **可替换性是可验证的**：D5 对照组的存在是架构断言，不是锦上添花——
  同一契约两套实现，换掉任何一个都不动控制平面。
