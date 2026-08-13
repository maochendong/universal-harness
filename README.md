# Universal Harness

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
