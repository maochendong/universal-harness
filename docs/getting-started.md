# 快速开始

本文演示从安装 Universal Harness 到完成第一次完整迭代闭环的最短路径。所有命令示例都可以在 `examples/new-project/` 中找到对应的可执行版本。

## 前置条件

- Node.js >= 22.13.0（见 `.node-version`）
- Git（Harness 的权威存储是 Git 仓库）
- 支持的平台：Linux、macOS、Windows

## 安装

发布物是单一自包含的 npm 包 `universal-harness`，提供 `harness` binary，全部运行时依赖随包捆绑，安装过程不需要额外解析内部包：

```bash
npm install --global universal-harness
harness --version
harness doctor    # 诊断环境、Git 可用性与布局
```

从仓库源码工作时的等价命令：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm pack:smoke   # 打包、离线安装到干净临时环境并跑通 new/adopt 闭环
```

## 第一次迭代：`harness new`

```bash
harness new my-project --intent "Build the first capability"
```

这一条编排命令会创建项目目录、初始化 Git 仓库和 `.harness/` 控制平面（manifest、pack lockfile、Ledger、SQLite 查询缓存），然后开始首次迭代。迭代不会一口气跑完：Harness 在每个强制批准点安全暂停。

非交互会话中，暂停以结构化 JSON 返回（`--json`，退出码 11 `approval_required`）：

```bash
cd my-project
harness approve <request-id> --decision approve --actor human:you
harness resume <workflow-operation-id>
```

`new` 的完整闭环包含两个强制批准点：

1. **RequirementBaseline**——录入并冻结需求基线；
2. **ImpactSet**——冻结影响集，之后才能生成声明式 ExecutionPlan。

两次批准并 resume 之后，编排继续完成规划、Context 编译、执行、三层质量门禁、Run Evaluation，并落地锚定最终 commit 的 Iteration Snapshot：

```bash
harness snapshot --json   # 查看最近快照
harness status            # 项目状态、缓存健康与下一步动作
```

交互式终端中不需要手动执行 `approve`/`resume`：Harness 会在同一命令会话内展示预览并询问 decision（`approve`/`reject`/`defer`），`defer` 保留可恢复的提案。

## 后续迭代：`harness iterate`

```bash
harness iterate "Implement the next change"
```

`iterate` 在同一个受管项目内运行与 `new` 完全相同的闭环（录入 → 影响分析 → 规划 → 编译 Context → 执行 → 门禁 → 评估 → 修复 → 快照），批准点与暂停规则一致。

## 接管已有项目

```bash
harness adopt /path/to/project --intent "Introduce the requested change"
```

`adopt` 先把项目扫描进 staging 并生成带内容摘要的预览，未经批准不写入任何权威状态。详见 [接管已有项目](adopting-a-project.md)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `harness new <name> --intent <text>` | 创建受管项目并运行首次迭代 |
| `harness adopt [path] --intent <text>` | 接管现有项目并运行一次迭代 |
| `harness iterate <text>` | 运行后续变更的完整闭环 |
| `harness resume <workflow-operation-id>` | 从最近提交的 Checkpoint 恢复暂停的编排 |
| `harness approve <request-id> --decision <approve\|reject\|defer>` | 解决一个待处理批准请求 |
| `harness impact [node-id]` | 只读预览某变更的 ImpactSet |
| `harness plan` | 查看最近提交的 ExecutionPlan |
| `harness run [--dry-run]` | 推进执行阶段（dry-run 只渲染计划任务） |
| `harness verify` / `harness eval` / `harness snapshot` | 分别推进门禁、评估与快照阶段 |
| `harness audit` | 审计可追溯性、freshness 与图健康 |
| `harness status` / `harness doctor` | 状态总览 / 环境诊断 |
| `harness graph sync\|query\|check` | 重建 SQLite 缓存 / 查询图 / 校验 Ledger 完整性 |

所有命令接受 `--json` 输出一条规范化 JSON 记录，便于脚本化。退出码契约：`0` 成功、`1` 操作失败、`2` 用法错误、`3` 未找到项目、`10` 阶段不可用、`11` 需要批准、`12` 阻塞待恢复。

## 下一步

- [接管已有项目](adopting-a-project.md)：`adopt` 的 staging、预览与批准细节。
- [运维与恢复](operations-and-recovery.md)：全部批准点、暂停/恢复行为与故障恢复手册。
- [插件契约](plugin-contracts.md)：Adapter、Tool Provider 与 Pack 的契约。
- [M1 验收报告](m1-acceptance-report.md)：28 条验收标准与证据的映射。
