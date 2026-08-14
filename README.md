# Universal Harness

[![CI](https://github.com/maochendong/universal-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/maochendong/universal-harness/actions/workflows/ci.yml)

Universal Harness 是一个 Graph-native、Provider-neutral 的工程 Harness，用于驱动可审计的软件迭代。

M1 的目标是通过一个编排命令完成完整纵向闭环：

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

M1 已完成：Task 1–28 全部落地，28 条验收标准均有通过证据（见 [M1 验收报告](docs/m1-acceptance-report.md)）。从 [快速开始](docs/getting-started.md) 运行你的第一次闭环。

## 核心设计思路

- **Git 是唯一权威存储**：所有权威状态以原子事务写入 Git-native Ledger（append-only、可安全合并的分片）；SQLite 只是可随时删除并确定性重建的查询缓存。
- **确定性优先**：repository-qualified Locator、基于 UUIDv5 的扫描节点 ID、canonical JSON + SHA-256 摘要，保证同一逻辑输入在 Linux、macOS、Windows 上产生相同的 ID 与 digest，重放幂等。
- **Agent 提议，Harness 决策**：Agent 只能返回类型化 Proposal，永远不能自我批准、自我接受证据或直接写权威状态；计划、上下文、能力、预算、终止和恢复全部由 Harness 强制执行。
- **受限执行**：声明式 ExecutionPlan（拒绝嵌入命令与能力扩张）、按任务编译的 ContextBundle（预算、Freshness、敏感内容本地化）、Policy 字段级 merge operator 合并（冲突即 Block）、只收窄不扩张的 Capability Grant。
- **可审计、可恢复**：Approval 绑定精确 digest，漂移即失效；外部副作用以 Intent Journal 记录，结果不确定时对账而非盲目重试；Checkpoint + Resume 保证中断后不产生重复记录或副作用。
- **Provider-neutral 插件面**：VCS、Agent、Pack、Tool、Gate、Projection 均为版本化端口，第三方插件经 Capability Manifest 声明能力，并由 Conformance Kit 验证契约。

## M1 已支持的能力

- **完整迭代闭环**：`harness new` / `adopt` / `iterate` / `resume`，以及 `approve`、`impact`、`plan`、`run`、`verify`、`eval`、`snapshot`、`audit`、`status`、`doctor`、`graph` 等检查与编排命令；交互与非交互（`--json`）双模式，稳定退出码。
- **Stack Pack**：Generic、Node、Python、Java——栈检测、扫描、Stack 层 Gate 声明与 Pack 升级预览/批准。
- **Agent Adapter**：Manual Adapter（人工交接）与通用 Command Adapter（包装现有 Coding Agent CLI），按 Control Profile 决定能否无人值守；无法计量或拦截的 Provider 只能监督运行。
- **质量反馈**：universal / stack / project 三层 Gate、绑定漂移即失效的 Evidence Freshness、Run 五维评估（outcome / safety / trajectory / efficiency / correct failure）、Finding → 结构化 RCA → 归属上游 Phase 的修复路由、可评审 ImprovementCandidate。
- **知识投影**：PRD、架构、规格、计划与 Snapshot 的 Markdown 投影（受管写入、覆盖需批准、漂移自动重生成），以及面向 Provider 的确定性 Instruction Mirror。
- **发布工程**：Linux / macOS / Windows 三平台 CI；security / fault / property / performance 发布门禁；28 条验收标准自动追溯；自包含 npm 包（离线可安装）。

## 文档

- [快速开始](docs/getting-started.md)
- [接管已有项目](docs/adopting-a-project.md)
- [运维与恢复](docs/operations-and-recovery.md)
- [插件契约](docs/plugin-contracts.md)
- [M1 验收报告](docs/m1-acceptance-report.md)

## 设计文档

- [已批准的 M1 设计](docs/superpowers/specs/2026-08-11-universal-harness-m1-design.md)
- [已批准的 M1 实施计划](docs/superpowers/plans/2026-08-11-universal-harness-m1-implementation-plan.md)

## 许可证

采用 Apache-2.0 许可证，详见 [LICENSE](LICENSE)。
