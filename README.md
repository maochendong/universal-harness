# Universal Harness

[![CI](https://github.com/maochendong/universal-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/maochendong/universal-harness/actions/workflows/ci.yml)

Universal Harness 是一个 Graph-native、Provider-neutral 的工程 Harness，用于驱动可审计的软件迭代。

一个编排命令可以完成完整纵向闭环：

```text
新建或接管项目
→ 录入需求
→ 同步 Artifact Graph
→ 执行影响分析
→ 创建声明式 ExecutionPlan
→ 编译受限 Context
→ 直接执行、通过受控 Agent Loop 执行或人工执行
→ 执行质量门禁并评估 Run
→ 必要时完成 RCA 与定向修复
→ 记录 ImprovementCandidate 和 Iteration Snapshot
```

本设计采用一套 Git-native Ledger，并提供 Artifact Graph 与 Execution Graph 两个逻辑视图。Agent 提出语义工作建议；Harness 控制计划、上下文、能力、预算、终止、证据、恢复和权威更新。

M1 与 M2 均已完成。M1 的 Task 1–28 和 28 条验收标准已有通过证据；M2 又交付了 Finding 治理、可选 LLM Judge、确定性语义建议、本地 Dashboard 与统一实时事件流。请从 [快速开始](docs/getting-started.md) 运行第一次闭环，并在 [M2 运维指南](docs/operations.md) 中查看新增能力。

## 核心设计思路

- **Git 是唯一权威存储**：所有权威状态以原子事务写入 Git-native Ledger（append-only、可安全合并的分片）；SQLite 只是可随时删除并确定性重建的查询缓存。
- **确定性优先**：repository-qualified Locator、基于 UUIDv5 的扫描节点 ID、canonical JSON + SHA-256 摘要，保证同一逻辑输入在 Linux、macOS、Windows 上产生相同的 ID 与 digest，重放幂等。
- **Agent 提议，Harness 决策**：Agent 只能返回类型化 Proposal，永远不能自我批准、自我接受证据或直接写权威状态；计划、上下文、能力、预算、终止和恢复全部由 Harness 强制执行。
- **受限执行**：声明式 ExecutionPlan（拒绝嵌入命令与能力扩张）、按任务编译的 ContextBundle（预算、Freshness、敏感内容本地化）、Policy 字段级 merge operator 合并（冲突即 Block）、只收窄不扩张的 Capability Grant。
- **可审计、可恢复**：Approval 绑定精确 digest，漂移即失效；外部副作用以 Intent Journal 记录，结果不确定时对账而非盲目重试；Checkpoint + Resume 保证中断后不产生重复记录或副作用。
- **Provider-neutral 插件面**：VCS、Agent、Pack、Tool、Gate、Projection 均为版本化端口，第三方插件经 Capability Manifest 声明能力，并由 Conformance Kit 验证契约。

## 已支持的能力

- **完整迭代闭环**：`harness new` / `adopt` / `iterate` / `resume` / `abort`，以及 `approve`、`finding`、`impact`、`plan`、`run`、`verify`、`eval`、`snapshot`、`audit`、`status`、`doctor`、`graph`（含 `propose-edge`/`approve-edge` 人工补边）等检查与编排命令；交互与非交互（`--json`）双模式，稳定退出码。意图歧义时录入相位产出带显式选项（含 `other` 逃逸）的澄清请求，回答经新一轮需求录入与批准门进入。
- **统一实时可观测性**：相位、Gate、Run heartbeat/output、预算和批准事件写入可删除的 live spool，并与权威 Ledger 生命周期事件合并；`harness watch [--follow]` 和 Dashboard SSE 使用同一 `EventStreamPort`，Ledger 终态会替代同 observation key 的 live 信号。
- **本地 Dashboard**：`harness serve [--port <port>]` 只监听 loopback，提供 Graph、Impact、Iteration、Evidence、Findings、Live 六个视图；随机一次性 URL token 交换为 HttpOnly session，写操作要求同源 Origin、session CSRF、actor 与 expected digest，并复用原有 Approval/Resume/Finding 服务。
- **Finding 治理**：按 rule、scope、severity、actionability 稳定分组，显示计数、样本与 membership digest；`harness finding group <accept|close|supersede> <group-id> --digest <digest>` 全成全败地批量处置，stale-knowledge 在知识源刷新后自动衰减但保留历史。
- **确定性语义建议**：`harness impact [node-id] --semantic` 使用本地 symbol/import/path/term 索引提出 top-K `MAY_IMPACT` 边；建议与索引、输入和 revision digest 绑定，未经 `harness graph approve-edge` 人审不会进入活动图，Provider 失败会退回结构影响分析。
- **可选 LLM Judge**：runtime config v2 可声明 OpenAI-compatible Judge Gate；默认不配置、零网络调用且默认 advisory。只有显式请求、accepted Policy 启用 blocking、且该 Policy revision 获得有效 Approval 三项同时成立时才可阻断。Review Bundle、请求/响应 digest、重试和错误类型进入脱敏 Evidence。
- **多任务计划与进度**：ExecutionPlan 可将一次迭代分解为多个带依赖的小任务（整个计划一次批准），逐任务执行与评估，崩溃恢复只重跑未完成任务；`harness status` 报告 `2/3` 式任务进度。
- **Stack Pack**：Generic、Node、Python、Java——栈检测、扫描、Stack 层 Gate 声明与 Pack 升级预览/批准。
- **Agent Adapter**：Manual Adapter（人工交接）与通用 Command Adapter（包装现有 Coding Agent CLI），按 Control Profile 决定能否无人值守；无法计量或拦截的 Provider 只能监督运行。
- **真实执行与项目门禁**：受管项目可通过提交 `.harness/runtime.json` 选择经版本探针校验的 dsh headless、声明任务读写边界，并把仓库内测试脚本注册为强制 Gate；执行 transcript、前后仓库摘要和门禁日志摘要统一回到账本 Evidence 链。
- **质量反馈**：universal / stack / project 三层 Gate、绑定漂移即失效的 Evidence Freshness、Run 五维评估（outcome / safety / trajectory / efficiency / correct failure）、Finding → 结构化 RCA → 归属上游 Phase 的修复路由、可评审 ImprovementCandidate；每次评估都会落地 `Run → Evidence → EvaluationCase → Run/Task` 图链，并可回填旧版本报告；每个 Task 的 verify 相位落地结构化质量记录（验收断言逐条布尔判定 + 证据 id），门禁不过不出完成快照。
- **主动审计**：快照相位自动重跑确定性图审计（可追溯性、freshness、图健康、设计/决策文档覆盖度、Task↔Requirement 挂接、合同条目覆盖、任务证据时效），缺口按内容派生 id 幂等落账为 Finding 并进入人审核级联；`harness status` 以 blockers / warnings 分级呈现；迭代自动增量重扫工作区文档入图。
- **知识投影**：PRD、架构、规格、计划、Snapshot 与 SpecKit 风格 tasks.md（编号/复选框/依赖/[P] 标记）的 Markdown 投影（受管写入、覆盖需批准、漂移自动重生成），以及面向 Provider 的确定性 Instruction Mirror。
- **发布工程**：Linux / macOS CI（Windows 暂时移出矩阵，超时 flake 待查）；security / fault / property / performance 发布门禁；28 条验收标准自动追溯；自包含 npm 包（离线可安装）。

## 文档

- [快速开始](docs/getting-started.md)
- [接管已有项目](docs/adopting-a-project.md)
- [运维与恢复](docs/operations-and-recovery.md)
- [M2 运维指南](docs/operations.md)
- [插件契约](docs/plugin-contracts.md)
- [dsh headless 本机契约](docs/dsh-headless-contract.md)
- [M1 验收报告](docs/m1-acceptance-report.md)
- [M2 验收报告](docs/m2-acceptance-report.md)

## 设计文档

- [已批准的 M1 设计](docs/superpowers/specs/2026-08-11-universal-harness-m1-design.md)
- [已批准的 M1 实施计划](docs/superpowers/plans/2026-08-11-universal-harness-m1-implementation-plan.md)
- [M2–M3 范围决策](docs/superpowers/specs/2026-08-15-m2-m3-scope-decisions.md)
- [已完成的 M2 设计](docs/superpowers/specs/2026-08-16-universal-harness-m2-design.md)
- [已完成的 M2 实施计划](docs/superpowers/plans/2026-08-16-universal-harness-m2-implementation-plan.md)
- [SpecKit 对照设计与任务卡](docs/speckit-comparative-design.md)
- [dsh 执行后端对照设计与任务卡](docs/dsh-execution-backend.md)

## 许可证

采用 Apache-2.0 许可证，详见 [LICENSE](LICENSE)。
