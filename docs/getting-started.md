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

## 迭代完成后你会看到什么

一次完成的迭代除了快照，还会在项目和 `.harness/` 里留下这些可读产物：

- **`harness status`**：除迭代状态与下一步动作外，还报告任务进度（`task_progress`，如 `2/3`）、blockers（需要修复的阻塞型 Finding）与 warnings（非阻塞缺口，如缺失的设计文档——不会卡住迭代，但保持可见）。
- **tasks.md 投影**：`.harness/projections/views/tasks.md`——从图 Task 节点生成的任务清单（T001 编号、复选框、依赖注记、`[P]` 并行标记），每次完成快照自动重生成；图是唯一事实源，手改会被识别为漂移并拒绝覆盖。
- **任务级质量记录**：`.harness/artifacts/quality/` 下每个 Task 一份结构化记录（门禁 verdict、每条验收断言的布尔判定与证明它的 evidence id）；门禁失败的行如实保留供人审核，且该迭代不会产出完成快照。
- **自动审计**：每次完成快照自动重跑图审计（无需手动 `harness audit`），缺口按 Finding → 人审核级联进入 status 的 blockers/warnings；工作区文档在每次迭代自动增量重扫入图，adopt 之后手写的文档同样能被审计看到。
- **卡死逃生口**：baseline 漂移等原因封死恢复路径时，`harness abort <workflow-operation-id>` 显式终止打开的编排并清理其待批准请求（详见 [运维与恢复](operations-and-recovery.md)）。

## 后续迭代：`harness iterate`

```bash
harness iterate "Implement the next change"
```

`iterate` 在同一个受管项目内运行与 `new` 完全相同的闭环（录入 → 影响分析 → 规划 → 编译 Context → 执行 → 门禁 → 评估 → 修复 → 快照），批准点与暂停规则一致。意图歧义时，迭代会在录入阶段以 `input_required` 挂起并返回带显式选项（含 `other` 逃逸项）的澄清问题；用更明确的意图重新发起即可，回答仍走需求基线批准门。较大的变更会被分解为多个带依赖的小任务（整个计划一次批准），逐任务执行与评估，中断恢复只重跑未完成的任务。

## 配置真实 Agent 与项目门禁

受管项目可以提交 `.harness/runtime.json`，把真实 Agent 后端、可读写边界和项目自己的测试命令绑定到同一条迭代链。下面的配置使用经版本探针校验的 dsh headless，并把一个仓库内脚本注册为强制项目门禁：

```json
{
  "runtime_config_version": 1,
  "agent": {
    "provider": "dsh",
    "expected_version": "0.1.0-rc.6",
    "allowed_read_paths": ["docs", "src", "tests"],
    "proposed_write_paths": ["src", "tests"]
  },
  "gates": [
    {
      "gate_id": "gate_project_test",
      "name": "Project tests",
      "mandatory": true,
      "subject_id": "test_project",
      "executable": "scripts/harness/project-test",
      "args": [],
      "timeout_ms": 120000
    }
  ]
}
```

- Agent 和 Gate 进程都以参数数组启动，不经过 shell；Gate 可执行文件必须是仓库内相对路径。
- `proposed_write_paths` 不能包含 `.git` 或 `.harness`；每个任务的 Capability Grant 只会进一步收窄该范围。
- dsh 凭据从显式环境变量白名单注入，不写入配置或 Ledger。当前默认需要 `DEEPSEEK_API_KEY`。
- 每次验证都会保存项目门禁日志的摘要和 SHA-256 Evidence；Agent transcript 与前后仓库摘要保存在 `.harness/raw-traces/`，不作为权威状态提交。
- dsh 版本、退出码和失败映射的实测契约见 [dsh headless 本机契约](dsh-headless-contract.md)。

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
| `harness abort <workflow-operation-id>` | 终止一个打开的编排（baseline 漂移封死恢复路径时的逃生口；待批准请求一并显式 reject） |
| `harness approve <request-id> --decision <approve\|reject\|defer>` | 解决一个待处理批准请求 |
| `harness finding <accept\|close\|supersede> <id>` | 处置一条 Finding（close 需 `--evidence` 提供当前通过的修复证据） |
| `harness impact [node-id]` | 只读预览某变更的 ImpactSet |
| `harness plan` | 查看最近提交的 ExecutionPlan |
| `harness run [--dry-run]` | 推进执行阶段（dry-run 只渲染计划任务） |
| `harness verify` / `harness eval` / `harness snapshot` | 分别推进门禁、评估与快照阶段 |
| `harness audit` | 审计可追溯性、freshness、图健康与文档/覆盖度缺口 |
| `harness status` / `harness doctor` | 状态总览 / 环境诊断 |
| `harness graph sync\|query\|check` | 重建 SQLite 缓存 / 查询图 / 校验 Ledger 完整性 |
| `harness graph propose-edge` / `approve-edge` | 人工补边：提议（带 digest）→ 批准落账 |

所有命令接受 `--json` 输出一条规范化 JSON 记录，便于脚本化。退出码契约：`0` 成功、`1` 操作失败、`2` 用法错误、`3` 未找到项目、`10` 阶段不可用、`11` 需要批准、`12` 阻塞待恢复。

## 下一步

- [接管已有项目](adopting-a-project.md)：`adopt` 的 staging、预览与批准细节。
- [运维与恢复](operations-and-recovery.md)：全部批准点、暂停/恢复行为与故障恢复手册。
- [插件契约](plugin-contracts.md)：Adapter、Tool Provider 与 Pack 的契约。
- [M1 验收报告](m1-acceptance-report.md)：28 条验收标准与证据的映射。
