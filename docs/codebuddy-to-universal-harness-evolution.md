# 从项目级 Harness 到 Universal Harness：工程管理方式的本质提升

Universal Harness 的核心提升不是“工作流更多了”，而是把 CodeBuddy 中依靠文档、角色约定和脚本维持的工程方法，升级成一个可执行、可证明、可恢复的工程控制平面。

> CodeBuddy Harness 主要回答“团队应该按什么流程做”；Universal Harness 进一步回答“系统如何强制按流程做、证明已经做过、失败后精确从哪里恢复”。

## 总体对比

| 维度 | CodeBuddy 手搓 Harness | Universal Harness 的提升 |
| --- | --- | --- |
| 核心形态 | 文档工作区 + Agent 角色 + Workflow + 校验脚本 | CLI + 类型化 Graph + Git-native Ledger + 状态机 + Policy Engine |
| 权威状态 | PRD、Architecture、Spec、Plan 等大文档及版本号 | Node、Edge、Event、Approval、Evidence 等类型化记录 |
| 文档关系 | 依靠版本联锁、Agent 理解和人工同步 | 关系显式进入 Graph，可查询、校验和传播 |
| 变更影响 | “PRD → 架构 → Spec/Plan/Test”级联规则 | Change Seed + 17 类传播关系 + 方向、风险、推理边规则 |
| Agent 管理 | 固定角色、提示词和交接协议 | Provider-neutral Adapter + Task Envelope + ContextBundle + Capability Grant |
| 门禁 | 文档评分、数量阈值、测试和脚本检查 | 通用、技术栈、项目三层 Gate，并绑定 Evidence freshness 与对象 digest |
| 批准 | 人工评审报告或阶段确认 | Approval 绑定对象 digest、影响路径、风险和基线；任何漂移自动失效 |
| 失败处理 | 输出评审报告，再人工判断修改哪些文档 | Finding → RCA → ImprovementCandidate → 新 ImpactSet，自动回流责任层 |
| 中断恢复 | 依赖执行记录、状态文件和人工续接 | Operation、Checkpoint、Intent Journal、幂等 Resume |
| 完成判断 | Agent、测试结果和工作流报告共同判断 | Run、Task、Iteration 三层完成真相，必须有新鲜 Evidence 和 Snapshot |
| 项目适配 | 深度绑定手机银行目录、角色和阈值 | Generic/Node/Python/Java Stack Pack，可新建或接管不同项目 |
| 可观测性 | 日会同报告、工作流执行记录 | Lifecycle Event + Observation Event + Dashboard + 可重建投影 |

## 1. 从“文档驱动”升级成“图驱动”

CodeBuddy 中 PRD、架构、规格、计划和测试虽然有联锁关系，但这些关系主要存在于文本、版本号和 Agent 的理解中。

Universal Harness 把这些对象变成类型化 Node，把关系变成 Edge：

```text
Intent → Requirement → Decision → Component → CodeArtifact
                           ↓
                      ImpactSet → Plan → Task → Run
                                             ↓
                                Evidence → Finding → RCA
```

因此系统不再只是“提醒你同步文档”，而是能够计算出为什么某个对象受影响、经过了哪些边、风险是多少。

这一变化使 PRD、Architecture、Specification、Plan 和 Snapshot 从彼此独立的大文档，转变为同一权威工程图的不同人类可读投影。文档仍然重要，但不再分别承担不可验证的状态真相。

## 2. 从“约定流程”升级成“可执行治理”

CodeBuddy 的 Agent 角色和 Workflow 已经很完整，但强制力主要来自提示词、角色契约和脚本。

Universal Harness 将这些约定下沉为 Runtime 约束：

- Agent 只能提交 Proposal，不能自我批准。
- Task 只能访问授权路径和工具。
- Context 按 Task 编译并受预算限制。
- Plan、Policy、Approval 或 Impact digest 漂移后，执行器不会启动。
- 实际 Diff 超出预测范围，会阻断完成并回到 Impact。
- 不可协商门禁不能被 `--force` 或 Agent 自述绕过。

正确流程不再依赖 Agent“记得遵守”。即使更换模型、Provider 或提示词，Harness 仍然在外部强制执行相同的治理边界。

## 3. 从“级联更新”升级成“可解释影响传播”

CodeBuddy 的三链路变更管理已经建立了反馈意识，但粒度主要是：

```text
PRD 变化 → 架构同步 → Spec / Plan / Test 更新
```

Universal Harness 将它细化为关系级传播：

- 哪个方向传播：`forward`、`inverse`、`both`；
- 默认风险：`low`、`medium`、`high`；
- 是否允许经过 proposed 或低置信度推理边；
- 到达对象的最短解释路径是什么；
- 结果属于 `must-change`、`inspect` 还是 `informational`。

这使影响分析从“Agent 给出一份分析报告”变成可复现的确定性计算。Agent 或语义索引仍可提出 `MAY_IMPACT` 候选，但候选不能自动升级为权威关系，必须经过人审。

## 4. 从“执行记录”升级成“可恢复的权威事件历史”

CodeBuddy 已有 workflow execution record 和 `state.json`，但它们更接近项目管理记录。

Universal Harness 用两条事件流明确区分：

- **Lifecycle Event**：已经提交的治理事实，进入 Git-native Ledger；
- **Observation Event**：心跳、阶段进度、预算、输出摘要等实时信号，进入可删除的 Live Spool。

配合 Checkpoint、幂等 Operation 和 Ledger Transaction，即使 Agent 崩溃、进程被杀、SQLite 损坏或 Git 漂移，也能够判断：

- 哪一步已经权威提交；
- 哪一步只是实时显示过；
- 哪些副作用需要对账；
- 应从 Impact、Plan 还是 Execute 恢复；
- 哪些 Run、Evidence 或 Approval 可以安全复用，哪些必须重新生成。

## 5. 从“Agent 交接”升级成“受控执行”

CodeBuddy 主要通过角色定义、提示词、工作流阶段和交接协议约束 Agent。

Universal Harness 在 Agent 外部增加确定性的执行边界：

- `ExecutionPlan` 只包含声明式任务，不允许嵌入特权命令；
- `Task Envelope` 固定目标、范围、风险、预算和验收条件；
- `ContextBundle` 只提供与当前任务相关的图邻域和资料；
- `Capability Grant` 只能收窄能力，不能由 Agent 扩张；
- `ExecutionAuthorization` 在 RunStarted 前校验全部绑定；
- Provider 通过 Adapter 接入，可以使用不同 Coding Agent，也可以退化为 Manual Adapter。

因此，Universal Harness 的 Provider-neutral 并不是简单兼容更多模型，而是让模型不再拥有工程治理权。

## 6. 从“脚本检查”升级成“证据化完成真相”

CodeBuddy 的文档评分、Specification/Plan 校验、测试脚本和验收门禁已经能够显著降低 AI 降级。

Universal Harness 在此基础上增加三层正式门禁：

1. **Harness 通用门禁**：Schema、Graph 完整性、批准、审计一致性；
2. **技术栈门禁**：Node、Python、Java 等 Stack Pack 声明的构建和测试；
3. **项目门禁**：具体仓库提交的测试命令和业务验收规则。

门禁结果必须形成 Evidence，并绑定精确对象、Run、Gate、EvaluationCase 和当前 digest。Evidence 过期、作用对象不匹配或仍是 provisional 时，不能作为完成依据。

完成真相被拆成三层：

- **Run 真相**：Provider 实际返回 `completed`、`partial`、`handoff` 或 `failed`；
- **Task 真相**：由逐断言 TaskVerdict 和证据决定；
- **Iteration 真相**：由全部 Task、Gate、Evaluation、Audit 和 Snapshot 决定。

Agent 说“已经完成”只是一条执行信息，不是最终工程事实。

## 7. 从“评审报告反馈”升级成“一等反馈子图”

CodeBuddy 的反馈闭环主要输出评审报告，再由 Agent 或人判断应修改 PRD、Architecture、Spec、Plan 还是 Test。

Universal Harness 将反馈变成一等图模型：

```text
Gate / Evaluation / Audit
          ↓
       Finding
          ↓ DIAGNOSED_BY
RootCauseAnalysis
          ↓ PRODUCES
ImprovementCandidate
          ↓ PROPOSES_CHANGE_TO
   上游权威对象
          ↓ TRIGGERS
      ImpactSet
```

下游阶段不能直接修改上游文档。Finding 必须经过 RCA 确定归属层，再由 ImprovementCandidate 提议修改目标，重新执行影响分析、批准和计划。

这把反馈闭环从“修问题”提升成“修正真正产生问题的工程事实”。

## 8. 从“项目经验”升级成“通用工程产品”

CodeBuddy Harness 更像一个高质量参考实现：它证明 PRD 流水线、SpecKit、多 Agent、三链路反馈和门禁体系能够工作。

Universal Harness 将这些经验产品化为：

```text
harness new / adopt
→ capture
→ graph sync
→ impact
→ plan
→ context
→ Agent execute
→ gate / evaluate
→ feedback
→ snapshot
```

并通过 Adapter、Stack Pack、Plugin SDK 和 Conformance Kit 支持不同项目，不再绑定手机银行的角色、路径、功能数量和文档结构。

主要泛化包括：

- 一个命令新建项目或接管已有仓库；
- Generic、Node、Python、Java 等技术栈包；
- Agent、VCS、Gate、Tool、Projection 等版本化端口；
- 无 AI Provider 时可使用 Manual Adapter；
- SQLite、Markdown 和 Dashboard 都是可替换、可重建的读取投影；
- 插件必须通过契约一致性测试，不能直接绕开 Runtime 治理。

## 9. 没有改变的核心方法论

Universal Harness 并不是对 CodeBuddy 方法论的否定。以下原则保持不变：

- Spec-driven design；
- 人负责目标、评审和关键决策；
- Agent 承担分析、设计、实现和验证工作；
- PRD、Architecture、Spec、Plan 和 Test 必须保持一致；
- 自动测试和门禁优先于主观完成判断；
- 失败应该反馈到上游，而不是只修补代码表象；
- 工程知识必须沉淀并进入下一次迭代。

Universal Harness 的作用，是把这些原则从项目约定提升为可以跨项目复用的执行协议。

## 10. 最终判断

Universal Harness 真正提升的不是 Agent 智力，也不一定是单次开发速度，而是以下四项工程属性：

- **确定性**：相同输入得到相同 Graph、Impact 路径和 Projection；
- **强制性**：Agent 不能依靠提示词绕过批准、范围和门禁；
- **可证明性**：完成状态必须由绑定当前 digest 的新鲜 Evidence 支撑；
- **可恢复性**：中断和失败后可以精确续接，不依赖人工回忆。

因此，两者最准确的定位是：

> CodeBuddy Harness 是“方法论 + 项目级自动化”；Universal Harness 是把这套方法论编译成“跨项目的工程治理运行时”。

## 相关文档

- [Harness Graph-native 驱动模型](graph-driven-harness-model.md)
- [Universal Harness M1 设计](superpowers/specs/2026-08-11-universal-harness-m1-design.md)
- [Universal Harness M2 设计](superpowers/specs/2026-08-16-universal-harness-m2-design.md)
- CodeBuddy 源工作区：`docs/superpowers/specs/2026-08-11-generalized-graph-harness-design.md`
