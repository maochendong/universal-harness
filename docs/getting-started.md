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

这一条编排命令会创建项目目录、初始化 Git 仓库和 `.harness/` 控制平面（manifest、pack lockfile、Ledger、SQLite 查询缓存），并要求选择、确认 Lite / Standard / Governed，再开始首次迭代。Lite 适合先验证最小闭环；Standard/Governed 根据启用能力增加影响分析、设计、评估或严格 TDD。未启用的阶段不物化；必要输入、审批和外部授权仍会安全暂停。

非交互会话中，暂停以结构化 JSON 返回（`--json`，退出码 11 `approval_required`）：

```bash
cd my-project
harness approve <request-id> --decision approve --actor human:you
harness resume <workflow-operation-id>
```

批准次数不固定。以 final CapabilityPlan、风险和 Policy 实际产生的 ApprovalRequest 为准：需求接受、启用后的 ImpactSet/DesignSet、执行授权或 Policy 调整都可能需要批准。Lite 不为未启用的 Impact/Design 阶段产生空壳审批；任何档位都不能跳过必要授权。

按返回的 request-id 审批并 resume 后，编排继续执行当前项目实际启用的计划、Context、执行、Gate 和可选 Evaluation，最后落地锚定源码提交的 Iteration Snapshot：

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

`iterate` 在同一个受管项目内按 final CapabilityPlan 推进：Capture → [Impact] → [Design] → Plan → Context → Execute → Verify → [Evaluate] → Snapshot；方括号表示可选能力，失败按治理规则回流。意图歧义时在 Capture 暂停；优先使用返回的澄清会话与 resume 指令补充答案，不重复新建尚未结束的迭代。较大变更会被分解为带依赖的 Task；只有计划和对应授权有效时才执行，恢复不重复接受已完成结果。

执行 Agent 任务前还会出现 **ExecutionAuthorizationSpec** 批准点。它把 Plan、Impact coverage、每个 Task 的 ContextBundle 与 CapabilityGrant、Policy、基线提交和 Adapter Control Profile 封装成一个不可变 digest。批准后其中任一项变化，旧批准立即失效，必须重新分析或授权。

长运行命令不会保持静默：live spool 每 5 秒记录 heartbeat；受管 Agent 子进程产生 stdout/stderr 时，还会写入经过脱敏、节流和限长的 `RunOutputSummary`。终端每 30 秒最多显示一次 task、control profile、elapsed、最近 heartbeat 与预算 availability，Dashboard Live 页展示输出尾部、来源流、累计字节与截断状态。`harness status --json` 在 Run 活动期间包含 `active_run`；RunTerminated 后该字段消失。即使使用 `--json`，进度也只写 stderr，stdout 仍是一条最终 JSON。dsh headless 未提供可靠 token/step 时，两项保持 `unavailable`，Harness 不做估算；duration 仍由 Harness 测量和强制。

完成结果中的提交引用含义固定：`source_commit` 是 Gate、Evaluation 与 Snapshot 证明的源码树；`ledger_commit` 是首次包含完成 Ledger 与 Snapshot 的提交；`repository_head` 是命令返回瞬间的 HEAD。

## 配置真实 Agent 与项目门禁

配置后先运行 `harness doctor --json` 查看 Agent 的控制级别、轨迹可见性、用量可用性和受监督单槽位限制。此预检只读取配置与 Adapter 能力声明，不调用模型，也不把“配置存在”当作“Provider 已连通”。dsh 的受监督任务通过不能替代 M4 真实双槽并行验收；真实验证需要单独的调用授权与预算。

受管项目可以提交 `.harness/runtime.json`，把真实 Agent 后端、可读写边界和项目自己的测试命令绑定到同一条迭代链。下面的配置使用经版本探针校验的 dsh headless，并把一个仓库内脚本注册为强制项目门禁：

先准备并核对固定版本（此命令可能下载 npm 依赖，但只查询版本，不执行模型任务）：

```bash
npm exec --yes --package=@deepseek-ai/dsh@0.1.1-rc.2 -- dsh --version
```

```json
{
  "runtime_config_version": 1,
  "agent": {
    "provider": "dsh",
    "executable": "npx",
    "launcher_args": ["--no-install", "@deepseek-ai/dsh@0.1.1-rc.2"],
    "expected_version": "0.1.1-rc.2",
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
- 版本和模型要分别验证：不要只看环境变量名称就认定实际模型。一次 Task 可能包含多次模型请求；dsh 会话用量是事后观测，当前 Adapter 的 token/step 上限不是可强制执行的硬预算。
- 每次验证都会保存项目门禁日志的摘要和 SHA-256 Evidence；Agent transcript 与前后仓库摘要保存在 `.harness/raw-traces/`，不作为权威状态提交。
- Dashboard 的 `08 Approvals` 从已提交 ApprovalRequest/ApprovalDecision artifact 重建待审批队列；即使页面在审批事件之后才打开，也可按原始对象 digest 决策并恢复工作流。
- dsh 旧版本退出码和失败映射见 [历史 headless 本机契约](dsh-headless-contract.md)；`0.1.1-rc.2` 的单任务诊断见 [2026-09-08 实测](evidence/2026-09-08-supervised-provider-probe.json)，不等同于完整迭代/并行验收。

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
| `harness graph backfill-evaluations` | 将旧版本已提交的评估报告迁移为 EvaluationCase / Evidence 节点及完整 verdict 边链 |
| `harness graph project-tasks [--approve-overwrite]` | 从权威图重新生成 `views/tasks.md`；覆盖既有视图需要显式批准 |

所有命令接受 `--json` 输出一条规范化 JSON 记录，便于脚本化。退出码契约：`0` 成功、`1` 操作失败、`2` 用法错误、`3` 未找到项目、`10` 阶段不可用、`11` 需要批准、`12` 阻塞待恢复。

## 下一步

- [接管已有项目](adopting-a-project.md)：`adopt` 的 staging、预览与批准细节。
- [运维与恢复](operations-and-recovery.md)：全部批准点、暂停/恢复行为与故障恢复手册。
- [插件契约](plugin-contracts.md)：Adapter、Tool Provider 与 Pack 的契约。
- [Managed 模型调用层架构](model-invocation-architecture.md)：LLM 调用的受管路径、多 Provider 接入与失败语义。
- [M1 验收报告](m1-acceptance-report.md)：28 条验收标准与证据的映射。
