# M2–M3 范围决策

日期：2026-08-15
状态：范围已批准；各项详细设计与实施计划另行立项
依据：[M1 设计](2026-08-11-universal-harness-m1-design.md) 第 4 节与第 18 节；M1 dogfood（Atlas T1–T5）评审结论

## 背景

M1 设计第 4 节对 M2–M4 只有一句话定义。基于 M1 完成后的机制评审（治理内核 9+ 水准，短板集中在可用性、反馈质量与团队采用路径），对 M2/M3 范围做如下增补与明确。M4 范围不变。

## M2 范围（增补后）

原范围保留：**本地 Graph Dashboard**——经 `GraphQueryPort`、`ExecutionGraphPort`、`EvaluationPort`、`EventStreamPort` 只读消费的本地 Web View（Graph、Impact Path、Iteration、Evidence 探索）。

新增以下三项：

### M2-A Finding 治理（对抗 warning 疲劳）

问题：同质 finding 无聚合与衰减，长周期项目 status 信噪比持续恶化（Atlas 实测 52 条 stale-knowledge + 1 条 missing-design-artifact warning 平铺输出）。

范围：

- **聚合**：同 rule + 同 scope 前缀的 finding 折叠为可批量处置的组；status / dashboard 展示分组计数与代表样本。
- **衰减与自动关闭**：stale-knowledge 类 finding 在其指向的知识源刷新入图后自动 supersede，不再依赖人工逐条 close。
- **分级呈现**：blocker / warning 之下的二级分组（按可处置性：可自动关闭 / 需人工 / 需上游变更）。
- 兼容约束：不删除历史记录；自动 supersede 必须落账为显式 Finding 生命周期事件，保持审计链完整。

验收线索：Atlas 场景下 status 恢复可读（分组 + 计数，而非 53 行平铺）；知识刷新后 stale-knowledge 组自动清零且账本可追溯。

### M2-B 评估深度：LLM-judge Gate（可选）

问题：Run 五维评估的 outcome 主要由确定性 gate 驱动，语义质量（代码审查级）是盲区。

范围：

- 新增一种 **可选** 的 Gate Provider：以第三方模型对 diff / artifact 做结构化评审，输出 verdict + 逐条理由，作为普通 Gate 走既有 Evidence 链（digest 绑定、freshness 失效）。
- **默认非阻断**：LLM-judge 结果默认 warning 级；提升为 mandatory / blocking 需项目在 Policy 中显式 opt-in 并经批准门。
- 与 M1 约束的关系：M1 否决项是“将自然语言 Agent 判断当作通过 Gate 的 Evidence”（自证通过）。本项为第三方结构化判断、默认不阻断、阻断需人工授权，不违反该否决；详细设计需明确 prompt/版本/digest 的确定性记录方式，保证同输入可重放评审。
- Provider 配置与凭据沿用既有白名单注入机制，不新增持久化 secret。

### M2-C 语义检索种子（建议性）

问题：影响分析基于图边传播，纯结构性；结构性断边（改 A 忘 B）依赖人工 `propose-edge` 补救。

范围：

- 新增一路 **embedding / 符号级相似度** 候选生成器：对变更种子计算语义近邻，产出候选 ImpactSet 种子。
- **只建议、不落图**：候选种子进入与人审 `propose-edge` 相同的通道（proposal → digest 绑定 → 批准落账），不自动写权威图。
- 与 M1 约束的关系：M1 否决“Vector Database / 自动写入”指的是自动权威写入与未经评审的自我改进；本项为建议性种子 + 显式人审，合规。相似度索引必须可从 Git 权威状态确定性重建（缓存地位等同 SQLite）。
- Provider-neutral：相似度计算经版本化插件端口暴露，core 不绑定特定向量库或 embedding 服务。

### M2-D 实时可观测性（已批准，2026-08-15）

问题：迭代执行期间（plan→context→execute→verify→evaluate→snapshot 可持续数分钟到数十分钟）外部无可用观察手段——`--json` 整段缓冲至结束才输出、账本按相位原子提交导致正在执行的相位对读者不可见、门禁只有完成事件。T6 dogfood 实测只能靠进程存活探测与 `git status` 间接信号推断相位。

范围：

- **`harness watch` CLI 跟随模式**：实时打印当前迭代的相位进入/退出、门禁启动/完成、Run 与预算事件；复用 `EventStreamPort`，无 Web 依赖，优先落地。**已落地**（`e011096`：快照/NDJSON/`--follow` 轮询/SIGINT 优雅退出；配套 `26f31e6`：`--json` 模式相位事件经 stderr NDJSON 流式输出）。
- **事件粒度补齐**：新增 `PhaseStarted`、`GateStarted` 及受管子进程（dsh/Gate）的周期心跳或输出 tail 摘要事件；事件仍为有序、版本化、脱敏，不改变权威状态与相位原子提交语义。
- **Dashboard live 视图**（原 M2 增强项，本轮正式排入 M2 范围）：`harness serve` 起本地 HTTP 服务，`/events` 端点以 SSE（text/event-stream）转发 `EventStreamPort` 事件；静态单页 `dashboard.html` 经 EventSource 订阅，渲染当前迭代流水线实时状态（相位泳道、门禁结果、Run/预算）。完全复用既有事件流，无需改动 runtime。
- **批准点 UI 事件**（本轮新增，正式排入 M2 范围）：`phase_paused` / `ApprovalRequired` 事件在 live 视图中渲染为显式 UI 事件卡片，附批准/拒绝操作；批准动作 POST 至 `harness serve` 端点，走既有批准门落账（digest 绑定、actor 记录），不新增旁路写入路径。CLI 层等价物（`phase_paused` 事件 + stderr 流）已随 `26f31e6`/`e011096` 落地，本项补齐 Web 层。

兼容约束：事件流是进程内观测信号，不是权威状态；不得为实时性提前落账或拆分相位原子提交。Web 层批准入口必须复用既有批准门命令路径（同一校验、同一落账），SSE 仅转发不持久化。

## M3 范围（明确后）

原范围保留：**远程协作**——版本化 Ledger Event 同步、团队批准、冲突处理，并启用 Repository-qualified 跨仓库执行（不接管本地 Source File 所有权）。

针对 M1 遗留的并发缺口，明确以下四个必须定义的语义（此前未在 M1 一句话定义中点名）：

1. **分布式互斥**：M1 的 `locks/` 为本机目录。M3 必须定义跨机器的 Ledger 操作互斥如何协商——Ledger 分片可安全 Git merge 的承诺保留，但操作级互斥（同一 operation 分片的并发写入方）需要跨副本成立。
2. **多人 approve 语义**：批准主体身份（actor 模型：谁能批准什么）、批准 digest 绑定到哪个工作副本、副本漂移导致批准失效的判定必须在分布式场景下成立；Approval Request 的路由与可见性同步。
3. **多迭代并行**：同一项目多个 Iteration 由不同人/不同机器并发执行的隔离边界与合并顺序；与 M4 的分工——M3 定义同步与冲突语义，M4 才做基于 Lease 的调度。
4. **团队批准工作流**：批准权限的授权模型（per-project / per-policy-scope），以及批准动作本身作为 Ledger Event 的同步与追溯。

## 未分配项（显式记录，避免悬空）

以下评审项本轮未排期，保持待定，进入 M2/M3 详细设计时需重新评估或显式延期：

- Windows CI 回归矩阵（M1 遗留工程债）
- 快照相位全量投影性能（增量渲染 / 后台物化；与 M2 Dashboard 有工作重叠，建议 M2 设计时一并评估）
- Onboarding 减负（`--light` 渐进模式）
- Provider 生态（主流 coding agent / 原生 MCP 一等适配）——M1 非目标移出后尚无里程碑认领

## 端口兼容性

本决策不修改 M1 第 18 节固化端口。M2-A 主要扩展 audit/finding 生命周期与 status 投影；M2-B 以普通 Gate Provider 形态接入 `ToolRegistryPort`/gate 既有契约；M2-C 新增一个版本化建议端口（只读消费 + proposal 输出），不得绕过批准门写权威状态。M3 各项均在 `EventStreamPort` 版本化同步框架内设计。
