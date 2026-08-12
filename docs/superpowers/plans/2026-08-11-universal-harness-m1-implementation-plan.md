# Universal Harness M1 实施计划

**日期**：2026-08-11  
**状态**：实施中；Task 1 已完成  
**设计依据**：`docs/superpowers/specs/2026-08-11-universal-harness-m1-design.md`  
**目标里程碑**：M1 完整纵向闭环

## 1. 目的

本计划把已批准的 M1 设计转换为可执行、测试优先的交付顺序，覆盖从工作区初始化，到 `harness new`、`harness adopt`、受控执行、验证、评估、反馈、恢复和迭代快照的完整路径。

任何内部切片都不能单独作为 M1 发布。只有新建项目和接管项目两个独立夹具都跑通完整闭环，且设计中的 28 条验收标准全部通过，M1 才能被接受。

## 2. 实施决策

实施从以下默认决策开始。若变更会改变已批准的设计边界，必须先更新设计和本计划，再继续编码。

- 使用 TypeScript 严格模式，运行在受支持的 Node.js LTS 基线上。
- 使用由 Corepack 固定版本的 pnpm workspace，只有一份 lockfile，CI 安装必须可复现。
- 第一方 package 使用 ECMAScript modules；仅在适配器边界确有需要时兼容 CommonJS。
- JSON Schema 2020-12 是线协议。TypeBox 从同一来源定义 Schema 和 TypeScript 类型，Ajv 负责严格运行时校验。
- 使用规范化 JSON 和 SHA-256 生成内容摘要，使用 UUIDv5 生成带仓库限定的确定性节点 ID。
- Git 中的 JSON 工件和只追加事件是权威数据；SQLite 只是可丢弃的查询投影，并隐藏在驱动端口之后。
- Vitest 承担单元、集成和 golden tests；fast-check 承担属性测试。
- CLI 子进程必须使用参数数组和 `shell: false`；Shell 命令字符串不是核心执行原语。
- Release CI 在依赖安装后必须确定性、离线运行。真实 AgentAdapter 评估为可选项，不能成为 M1 发布前置条件。

Task 1 会在完成许可证、原生二进制和跨平台检查后选择并锁定依赖版本。不得从其他产品仓库复制实现。

## 3. 交付纪律

每个编号任务都遵循同一循环：

1. 添加能表达目标行为的最小失败测试或夹具。
2. 运行窄范围测试并确认它以预期原因失败。
3. 只实现足以使测试通过的生产代码。
4. 运行 package 测试，再运行受影响的集成测试。
5. 在不改变行为的前提下重构，并重新运行测试。
6. 在同一提交中更新公共契约、示例和可追溯元数据。

附加规则：

- 本计划批准后，从 `codex/m1-implementation` 开始实施。
- 公共导出必须显式声明；package 不得导入其他 package 的私有源码路径。
- 提交生成的 lockfile 和 schema；不提交缓存、原始轨迹、临时仓库或 Provider 镜像。
- 每个持久化写入都必须经过中断或幂等重放测试。
- 每个改变权威状态的操作都必须具有预览或类型化提案、策略决策和带证据的结果。
- 下游测试失败必须生成反馈工件，不能静默改写上游 Requirement 或 Decision。

## 4. 目标工作区

```text
universal-harness/
├── packages/
│   ├── cli/
│   ├── core/
│   ├── graph/
│   ├── runtime/
│   ├── eval/
│   ├── plugin-sdk/
│   └── conformance/
├── adapters/
│   ├── agent-manual/
│   ├── agent-command/
│   ├── vcs-git/
│   └── projection-markdown/
├── packs/{generic,node,python,java}/
├── fixtures/{generic-project,node-project,python-project,java-project}/
├── tests/{integration,e2e,fault,security,performance,golden}/
├── examples/
└── docs/
```

依赖方向如下：

```text
core ← graph
core ← runtime ← eval
core ← plugin-sdk ← adapters and packs
core + graph + runtime + eval + adapters ← cli
all public contracts ← conformance
```

`core` 不依赖任何其他 workspace package。架构测试会阻止循环依赖。

## 5. 切片一：Ledger 基础

### Task 1：初始化可复现工作区

**创建**：

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `.node-version`
- `.npmrc`
- `.gitignore`
- `tsconfig.base.json`
- `vitest.workspace.ts`
- `eslint.config.js`
- `.github/workflows/ci.yml`
- `scripts/check-standalone.mjs`
- `tests/architecture/workspace-boundaries.test.ts`
- `packages/{cli,core,graph,runtime,eval,plugin-sdk,conformance}/package.json`
- `packages/{cli,core,graph,runtime,eval,plugin-sdk,conformance}/src/index.ts`
- `adapters/{agent-manual,agent-command,vcs-git,projection-markdown}/package.json`
- `adapters/{agent-manual,agent-command,vcs-git,projection-markdown}/src/index.ts`
- `packs/{generic,node,python,java}/package.json`

**步骤**：

1. 先添加失败的架构测试：要求所有设计中的 workspace package 存在，并拒绝循环依赖和私有源码跨包导入。
2. 建立 package manifests、TypeScript project references、共享 lint、typecheck、test 和 build 配置。
3. 添加 Linux、macOS、Windows CI，执行安装、lint、类型检查、单元测试、构建和独立内容扫描。
4. 添加 workspace smoke test，验证每个 package 的初始公共导出；CLI binary 的打包冒烟测试在 Task 8 添加。

**验证**：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node scripts/check-standalone.mjs
```

**完成条件**：空工作区在三个 CI 操作系统上通过，且不包含其他产品品牌或用户绝对路径。

### Task 2：定义规范 Schema 和协议版本

**创建**：

- `packages/core/src/schema/{node,edge,event,operation,runtime,feedback,plugin,registry,index}.ts`
- `packages/core/src/version.ts`
- `packages/core/schemas/*.schema.json`
- `packages/core/test/schema/*.test.ts`
- `packages/core/test/golden/schema/*.json`

**步骤**：

1. 为所有节点类别、关系、来源、状态、Run outcome 和 termination reason 编写有效与无效夹具。
2. 实现拒绝未知字段的严格 Schema，只允许显式扩展命名空间。
3. 导出生成的 JSON Schema 和协议版本常量。
4. 添加兼容性测试：拒绝不支持的主版本，只在扩展字段中保留未来未知数据。

**验证**：`pnpm --filter @universal-harness-internal/core test`。

**完成条件**：所有持久化记录和插件契约都有唯一 Schema 来源与稳定序列化示例。

### Task 3：实现规范身份、摘要和 Locator

**创建**：

- `packages/core/src/identity/{canonical-json,digest,node-id,locator}.ts`
- `packages/core/test/identity/*.test.ts`
- `packages/core/test/identity/*.property.test.ts`

**步骤**：

1. 为仓库限定 Locator 和确定性 UUIDv5 节点 ID 添加 golden tests。
2. 添加键顺序无关、Unicode 规范化、路径分隔符规范化和摘要稳定性属性。
3. 实现规范化，且不得把 Locator 解析到仓库边界之外。
4. 拒绝绝对路径、遍历片段、歧义驱动器前缀和非法 symbol fragment。

**验证**：`pnpm --filter @universal-harness-internal/core test -- identity`。

**完成条件**：同一逻辑输入在 Linux、macOS、Windows 上生成相同 ID 与摘要。

### Task 4：实现 Git-native Ledger 事务协议

**创建**：

- `packages/core/src/ledger/{layout,lock,transaction,event-store,repository}.ts`
- `packages/core/test/ledger/*.test.ts`
- `tests/fault/ledger-interruption.test.ts`
- `tests/golden/ledger/*.json`

**步骤**：

1. 定义包含 operation ID、预期 baseline、待写工件、已接受边、事件和摘要的事务 manifest。
2. 测试原子成功、校验失败、并发写拒绝、提交前中断和已完成操作重放。
3. 实现 staging、同文件系统原子 rename、原子目录锁和只追加序列校验。
4. 恢复未完成 staging，但不得把它视为已接受权威数据。

**验证**：`pnpm test -- ledger-interruption` 及 core ledger 测试。

**完成条件**：任何故障点都不会暴露部分接受的事务，重放不会产生重复事件。

### Task 5：构建 SQLite 物化层和双 Graph View

**创建**：

- `packages/graph/src/sqlite/{schema.sql,database.ts}`
- `packages/graph/src/materializer.ts`
- `packages/graph/src/views/{artifact-graph,execution-graph}.ts`
- `packages/graph/src/query-port.ts`
- `packages/graph/test/{materializer,graph-views}.test.ts`
- `tests/golden/graph-views/*.json`

**步骤**：

1. 编写 golden query，证明 Artifact Graph 与 Execution Graph 共享 Ledger 身份且可相互追溯。
2. 实现 schema 创建、事件投影、版本替换和 cursor 元数据。
3. 实现具有确定性排序的分页节点、边、邻域和路径查询。
4. 证明删除数据库后重放 Ledger 会产生相同查询结果。

**验证**：`pnpm --filter @universal-harness-internal/graph test`。

**完成条件**：SQLite 不含独占权威状态，两个逻辑视图都可由 Git 记录确定性重建。

### Task 6：增加 Graph 完整性、迁移和恢复命令

**创建**：

- `packages/graph/src/{integrity,rebuild}.ts`
- `packages/graph/src/migrations/{registry,runner}.ts`
- `packages/graph/test/{integrity.property,migrations}.test.ts`
- `tests/fault/sqlite-corruption.test.ts`

**步骤**：

1. 添加悬空边拒绝、关系类型兼容、版本单调性和非法依赖环属性。
2. 实现前向迁移预览、备份、应用、校验和回滚。
3. 实现缓存损坏检测和完整重建。
4. 仅在权威迁移成功后记录迁移事件。

**验证**：graph tests 和 `pnpm test -- sqlite-corruption`。

**完成条件**：失败迁移可回滚，损坏或缺失的数据库可完全恢复。

### Task 7：实现 Git VCS Adapter

**创建**：

- `adapters/vcs-git/src/{adapter,commands,status,worktree}.ts`
- `adapters/vcs-git/test/*.test.ts`
- `packages/plugin-sdk/src/vcs.ts`

**步骤**：

1. 为仓库检测、clean/dirty 状态、baseline commit、建分支、提交、diff 摘要和 drift 检测添加契约测试。
2. 以固定 executable 和参数数组调用 Git，不把用户文本插入 Shell。
3. 保留用户修改，拒绝歧义性破坏恢复。
4. 将 Git 错误规范化为类型化 Adapter 结果。

**验证**：`pnpm --filter @universal-harness-internal/adapter-vcs-git test`。

**完成条件**：临时仓库覆盖所有支持操作，且不修改夹具根目录外文件。

### Task 8：创建 CLI 外壳和受管项目布局

**创建**：

- `packages/cli/src/{bin,router,io,errors}.ts`
- `packages/cli/src/commands/{new,adopt,iterate,resume,status,doctor}.ts`
- `packages/cli/src/commands/graph/{sync,query,check}.ts`
- `packages/cli/test/help.test.ts`
- `packages/core/src/project/{manifest,layout,lockfile}.ts`
- `fixtures/generic-project/`

**步骤**：

1. 为 help、结构化 JSON 输出、退出码和非交互错误添加 CLI snapshot tests。
2. 实现命令路由和依赖注入，命令处理器中不放业务逻辑。
3. 实现 `.harness` 布局、manifest、pack lock 校验、受管 `.gitignore` 和根边界检查。
4. 在后续任务完成前，未实现的编排命令必须返回明确阶段状态，不得伪报成功。

**验证**：`pnpm --filter universal-harness test` 和 `pnpm harness --help`。

**完成条件**：binary 可本地安装、退出码稳定、只初始化受管路径。

## 6. 切片二：受控执行

### Task 9：实现新建项目与接管 staging

**创建**：

- `packages/runtime/src/bootstrap/{new-project,adopt-project,scanner,staging}.ts`
- `packages/runtime/test/bootstrap/*.test.ts`
- `tests/integration/{new-bootstrap,adopt-preview}.test.ts`

**步骤**：

1. 测试新建项目、已有路径拒绝、stack 检测、初始 repository ID 和 Bootstrap Iteration。
2. 测试接管扫描只进入 staging、忽略缓存和 VCS 内部、报告冲突与未知项、批准前不改变权威数据。
3. 实现确定性文件、测试、组件扫描和语义边提案输入。
4. 仅在 Approval 绑定 preview digest 后原子提交 baseline。

**验证**：在临时仓库运行 bootstrap integration tests。

**完成条件**：两个流程都生成确定性 baseline；拒绝接管预览不会产生权威变更。

### Task 10：实现 Workflow 状态机和 Checkpoint

**创建**：

- `packages/runtime/src/workflow/{state-machine,operation,checkpoint,resume,working-state}.ts`
- `packages/runtime/test/workflow/*.test.ts`
- `tests/fault/workflow-resume.test.ts`

**步骤**：

1. 测试 created、awaiting input、awaiting approval、planned、running、verifying、repairing、completed、blocked、aborted 转换表。
2. 强制只有 Workflow Engine 能提交 WorkingState；Adapter 只能返回类型化提案。
3. 在权威提交、批准、Task、Gate、外部动作和 Snapshot 后持久化 checkpoint。
4. 校验 baseline、输入、策略、批准和 ContextBundle 摘要后，从最新有效 checkpoint 恢复。

**验证**：runtime workflow tests，以及每个 checkpoint 边界的中断测试。

**完成条件**：恢复不会重复节点、Run、Evidence、commit 或已完成步骤。

### Task 11：实现需求录入与 Approval 失效

**创建**：

- `packages/runtime/src/requirements/{capture,baseline}.ts`
- `packages/runtime/src/approval/{service,invalidation}.ts`
- `packages/runtime/test/{requirements,approval}/*.test.ts`

**步骤**：

1. 把 intent 输入转换为 Intent、Requirement、Constraint 和 acceptance Test 提案。
2. 缺少必填需求字段或可验证验收条件时必须要求澄清。
3. Approval 绑定 artifact、baseline、policy 和 preview digest。
4. 绑定摘要变化时使 Approval 失效；Agent 或 Tool 不得自我批准。

**验证**：requirements 和 approval 聚焦测试。

**完成条件**：不完整 intent 正确阻塞；已批准需求成为影响分析的不可变版本输入。

### Task 12：实现 ImpactSet 生成

**创建**：

- `packages/graph/src/impact/{seeds,propagation,scoring,impact-set}.ts`
- `packages/graph/test/impact/*.test.ts`
- `tests/golden/impact/*.json`

**步骤**：

1. 定义 feature、bugfix、refactor、security、maintenance 和 Finding 驱动的 golden scenarios。
2. 实现确定性 seed、关系感知传播、风险和置信度、最短解释路径及 `must-change`/`should-review` 分类。
3. 将概率语义建议隔离为带理由和置信度的 proposed edge。
4. 规划前必须批准精确的 ImpactSet digest。

**验证**：`pnpm --filter @universal-harness-internal/graph test -- impact`。

**完成条件**：已知场景包含必要工件，且不把无关工件标记为 `must-change`。

### Task 13：实现声明式 ExecutionPlan

**创建**：

- `packages/runtime/src/planning/{execution-plan,task,mode-selector,validator}.ts`
- `packages/runtime/test/planning/*.test.ts`
- `tests/golden/plans/*.json`

**步骤**：

1. 添加选择 `direct`、`single-loop` 和顺序 `dag` 的夹具。
2. 创建多个 Task 节点前强制执行独立价值规则。
3. 拒绝 planner proposal 中的命令、原始 Shell、未知 Tool、环、缺失 Gate 和能力扩张。
4. 每个 Task 绑定已批准 ImpactSet 路径、预期输出、验收条件、依赖、风险和必需 Gate。

**验证**：planning tests 与 golden plan snapshots。

**完成条件**：未批准 ImpactSet 时不能规划，输出只能是合法声明式计划。

### Task 14：实现 ContextBundle 编译

**创建**：

- `packages/runtime/src/context/{compiler,selector,budget,compression,freshness}.ts`
- `packages/runtime/test/context/*.test.ts`
- `packages/runtime/test/context/*.property.test.ts`

**步骤**：

1. 测试来源优先级、受保护字段、排除项、分层预算、压缩和不可变 manifest。
2. 实现确定性 Graph 邻域选择，并记录选择每个来源的原因。
3. 压缩可插拔；M1 确定性压缩器必须保留受保护内容并记录大小变化。
4. 任一来源、Requirement、Approval、Policy、Plan 或 baseline digest 改变时，使 bundle 失效。

**验证**：context tests，包括随机预算保持属性。

**完成条件**：每个 Task 获得最小、可追溯、摘要和排除项均可复现的 ContextBundle。

### Task 15：实现 Policy Decision 和 Capability Grant

**创建**：

- `packages/runtime/src/policy/{action,decision,evaluator,capability-grant,path-boundary}.ts`
- `packages/runtime/test/policy/*.test.ts`
- `tests/security/capability-escalation.test.ts`

**步骤**：

1. 测试 action、规范化参数、resource、phase、risk、approval 和 Adapter control profile 的决策。
2. 实现具有稳定理由的 allow、deny 和 requires-approval 结果。
3. 强制 read/write path scope、symlink-aware repository boundary、state field scope 和动态能力收窄。
4. 拒绝通过 prompt 请求修改策略、增加 Tool、新增路径、自我批准或自行接受证据。

**验证**：policy tests 和 capability security tests。

**完成条件**：Adapter 身份本身不能授权；每个被拒操作都留痕且不产生变更。

### Task 16：实现 Tool Registry 和幂等外部动作

**创建**：

- `packages/runtime/src/tools/{definition,registry,invocation,action-intent,reconciliation}.ts`
- `packages/runtime/test/tools/*.test.ts`
- `tests/fault/uncertain-external-action.test.ts`
- `tests/security/tool-validation.test.ts`

**步骤**：

1. 测试未知 Tool、非法输入/输出、错误 phase、禁止 resource、过期 approval、quota、retry、redaction 和 timeout。
2. 实现调用前、调用中、调用后校验及规范化 Evidence。
3. 调用前提交 external action intent，调用后提交 completed 或 uncertain 状态。
4. 恢复时先按 idempotency key 对账再重试；Provider 无法安全对账时必须人工处理。

**验证**：tool tests 和 uncertain-action fault test。

**完成条件**：超时副作用不会盲目重放，Opaque Provider 内部工具不会被宣称为受 Harness 治理。

### Task 17：实现 LoopPolicy 和 Managed Loop Control

**创建**：

- `packages/runtime/src/loop/{policy,controller,repeat-detector,outcome,task-envelope}.ts`
- `packages/runtime/test/loop/*.test.ts`
- `packages/runtime/test/loop/*.property.test.ts`

**步骤**：

1. 测试 step、token、duration、retry、repeat-action 和 installation-level ceiling。
2. 对规范化 tool call、相关 state 和 evidence progress 生成指纹。
3. 只接受类型化 state proposal，每步执行后收窄 grant。
4. Model completion 只能进入 `verifying`；只有当前外部证据可产生 `success`。
5. 所有退出路径都产生已定义 outcome 和独立 termination reason。

**验证**：使用 fake clock、fake usage meter 和 repeat trace 的 loop tests。

**完成条件**：Model 不能提高 ceiling、关闭重复检测、直接提交 state 或自报成功。

### Task 18：实现 Manual 和 Command AgentAdapter

**创建**：

- `adapters/agent-manual/src/adapter.ts`
- `adapters/agent-command/src/{adapter,manifest,process,telemetry}.ts`
- `adapters/agent-{manual,command}/test/*.test.ts`
- `packages/plugin-sdk/src/agent.ts`
- `tests/security/delegated-provider.test.ts`

**步骤**：

1. 为 managed、delegated、manual profile 和 trajectory visibility 添加共享契约夹具。
2. 实现 manual handoff、Evidence 附加和显式恢复。
3. 实现通用命令执行：固定 executable、参数模板、受限 worktree、timeout、输出上限、结构化结果解析和仓库前后检查。
4. Manifest 未证明必要的计量、拦截、恢复和轨迹覆盖时，强制 supervised mode。

**验证**：两个 Adapter tests 与 delegated-provider security tests。

**完成条件**：能力声明可测量，控制不足的 Provider 无法用于无人值守执行。

## 7. 切片三：质量反馈

### Task 19：实现 Gate Provider 和 Evidence Freshness

**创建**：

- `packages/runtime/src/gates/{provider,runner,evidence,freshness}.ts`
- `packages/runtime/test/gates/*.test.ts`
- `tests/integration/three-layer-gates.test.ts`

**步骤**：

1. 测试 universal、stack、project Gate 的规范化结果和 artifact hash。
2. Gate 命令必须通过 Tool Registry，不能直接启动子进程。
3. Evidence 绑定 artifact、code、ContextBundle、Gate、EvaluationCase 和 Policy digest。
4. 任一绑定 digest 改变时 Evidence 失效；stale Evidence 不能关闭 Finding 或完成 Snapshot。

**验证**：gate tests 和 three-layer integration fixture。

**完成条件**：mandatory Gate 失败生成 Finding 并阻止 `completed` 状态。

### Task 20：实现 Agent Run Evaluation

**创建**：

- `packages/eval/src/{case,scorer,coverage,evaluator}.ts`
- `packages/eval/src/deterministic/{outcome,safety,trajectory,correct-failure,efficiency}.ts`
- `packages/eval/test/*.test.ts`
- `tests/golden/evaluations/*.json`

**步骤**：

1. 构建 success、clarification、permission denial、malformed tool、repeat、failure、budget exhaustion 和 handoff 确定性场景。
2. 独立评分 outcome、safety、可见 trajectory、correct failure 和 efficiency。
3. 报告不可用 trajectory field，并按 Adapter visibility 计算 coverage。
4. Semantic scorer 保持可选、携带 confidence，默认不能通过 mandatory Gate。

**验证**：eval unit tests 和 golden reports。

**完成条件**：mandatory threshold 失败生成 Finding，每份报告披露其 Evidence coverage。

### Task 21：实现 Finding、RCA、Repair Routing 和 ImprovementCandidate

**创建**：

- `packages/eval/src/feedback/{finding,rca,router,improvement,promotion}.ts`
- `packages/eval/test/feedback/*.test.ts`
- `tests/integration/feedback-cascade.test.ts`
- `tests/golden/feedback/*.json`

**步骤**：

1. 添加 Gate 失败夹具，必须生成 Finding → RCA → ImpactSet → 上游 revision Task → repair Evidence。
2. 对 PRD、architecture、spec、plan、policy、tool、test、eval 目标强制确定性 owner-phase routing。
3. 禁止下游 writer 直接修改上游 artifact。
4. 创建可复现、带 verification method 的 evaluation、knowledge 或 engineering ImprovementCandidate。
5. Promotion 前必须批准，并把目标更新记录为普通 Ledger revision。

**验证**：feedback tests 和完整 cascade integration test。

**完成条件**：当前 Evidence 可关闭已修复 Finding，stale Evidence 不可；可复用经验在批准前保持 proposal。

### Task 22：实现 Projection、Audit、Doctor、Status 和 Snapshot

**创建**：

- `adapters/projection-markdown/src/{prd,architecture,spec,plan,snapshot}.ts`
- `packages/runtime/src/audit/auditor.ts`
- `packages/runtime/src/doctor/doctor.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/snapshot/builder.ts`
- `packages/runtime/test/{audit,doctor,status,snapshot}/*.test.ts`
- `tests/golden/projections/*.md`

**步骤**：

1. 生成带 source ID、revision 和 generation digest 的 Markdown view。
2. Audit 检查 traceability、stale knowledge、contradiction、orphan、missing verification、context health 和未提升高风险 improvement。
3. 以可执行类型化结果诊断 Git、Schema、Pack、Adapter、cache 和 environment 问题。
4. Status 显示 control level、evaluation coverage、blocker、stale Evidence、approval、budget 和 next action。
5. 构建 `completed`、`blocked`、`aborted` Snapshot；存在未完成 Task、blocking Finding、stale Evidence 或未解决外部动作时拒绝 completed。

**验证**：projection goldens 和 runtime utility tests。

**完成条件**：所有人类可读视图均为可复现投影，Snapshot 状态由 Evidence 而非 Agent 声明决定。

### Task 23：接通编排入口和高级命令

**修改**：

- `packages/cli/src/commands/*.ts`
- `packages/cli/src/commands/graph/*.ts`

**创建**：

- `packages/runtime/src/orchestration/{orchestrator,phases,lifecycle-events}.ts`
- `packages/runtime/test/orchestration/*.test.ts`
- `tests/e2e/generic-{new,adopt,iterate,resume}.test.ts`

**步骤**：

1. 先接通 graph sync/query/check、impact、plan、run、verify、eval、approve、snapshot、audit、doctor、status。
2. 让 `new`、`adopt`、`iterate` 通过同一个 phase orchestrator。
3. 交互批准在同一会话继续；非交互批准返回 resumable operation ID。
4. 在每个 committed phase 周围发出有序 lifecycle event，但不暴露公共 Hook SDK。
5. 添加中断点，证明 `resume` 不会重复 authority 或 side effect。

**验证**：使用确定性 fake/manual Adapter 的 generic E2E tests。

**完成条件**：一个入口命令可从需求录入运行至 Snapshot，只在强制输入、批准或外部授权时暂停。

## 8. 切片四：泛化与发布加固

### Task 24：完成 Plugin SDK 和 Conformance Kit

**创建或完成**：

- `packages/plugin-sdk/src/{manifest,stack,agent,tool,gate,vcs,projection}.ts`
- `packages/plugin-sdk/src/{compatibility,subprocess}.ts`
- `packages/conformance/src/{runner,fixtures,assertions}.ts`
- `packages/conformance/test/*.test.ts`
- `examples/plugin-minimal/`

**步骤**：

1. 固化设计中的 M1 versioned port 和 capability manifest。
2. Plugin 执行前校验协议版本、声明能力、resource need、output schema 和 control-profile claim。
3. 在最小化子进程环境中运行 Plugin，并限制输入输出、返回类型化错误。
4. 发布所有第一方 Adapter 和 Pack 共用的 conformance runner。

**验证**：Plugin SDK、conformance tests 和最小 Plugin 示例构建。

**完成条件**：不兼容或虚假 Manifest 在执行前失败，所有第一方 Plugin 通过同一契约。

### Task 25：实现 Generic、Node、Python 和 Java Pack

**创建**：

- `packs/generic/{pack.json,policies,gates,templates}/`
- `packs/{node,python,java}/{pack.json,scanner,gates,templates}/`
- `packs/*/test/*.test.ts`
- `packages/runtime/src/packs/{resolver,lockfile,upgrade,migration}.ts`
- `packages/runtime/test/packs/*.test.ts`

**步骤**：

1. 实现 Generic 默认值，包括已批准的 LoopPolicy ceiling。
2. 添加 Node、Python、Java 的确定性检测、扫描和默认 Gate。
3. Project override 与 upstream Pack 分离存储。
4. 实现 upgrade preview、digest-bound approval、transactional migration、rollback 和 lockfile update。

**验证**：每个 Pack 的 conformance fixture 与失败迁移测试。

**完成条件**：Pack upgrade 保留 override，四个 Pack 都提供有效 context、Gate、Policy 和 Projection。

### Task 26：构建独立的跨 Stack E2E Fixture

**创建**：

- `fixtures/{node-project,python-project,java-project}/`
- `tests/e2e/{node,python,java}-{new,adopt,iterate}.test.ts`
- `tests/e2e/complete-loop.assertions.ts`

**步骤**：

1. 创建原创、小型、无需网络且测试确定的 Fixture。
2. 对每个 Stack 运行 new、adopt 和后续 iterate。
3. 断言 Requirement、两个 Graph View、ImpactSet、ExecutionPlan、ContextBundle、Run、Gate、Evaluation、注入失败时的 feedback、Approval、Evidence 和 final Snapshot。
4. 从 clean clone 重跑每个 Fixture，并比较规范化 Ledger 和 Projection。

**验证**：在 Linux、macOS、Windows 上运行 `pnpm test:e2e`。

**完成条件**：每个 Stack 完成相同闭环，多次运行的确定性记录一致。

### Task 27：添加 Security、Fault、Property 和 Performance Release Gate

**创建**：

- `tests/security/{path-traversal,symlink-escape,command-injection,secret-redaction,undeclared-write}.test.ts`
- `tests/fault/{concurrent-write,process-kill,git-drift,expired-approval,budget-exhaustion,partial-gate}.test.ts`
- `tests/performance/{dataset,impact,sqlite-rebuild}.test.ts`
- `scripts/generate-performance-dataset.mjs`

**步骤**：

1. 完成设计中的 security 和 fault-injection 矩阵。
2. 为每个 durable operation 添加可重复 process-kill 边界。
3. 确定性生成 20,000 节点和 100,000 边。
4. 在 `ubuntu-latest` 测量 warm Impact p95 小于两秒、完整 SQLite rebuild 小于 30 秒。
5. 任何 approval bypass、authority divergence、unreconciled action、secret leak 或越过阈值的性能退化都阻止发布。

**验证**：`pnpm test:security`、`pnpm test:fault`、`pnpm test:performance`。

**完成条件**：全部加固 Gate 可确定性运行、保留摘要并达到发布阈值。

### Task 28：打包 CLI 并完成 M1 文档

**创建或修改**：

- `packages/cli/package.json`
- `packages/cli/src/public-api.ts`
- `README.md`
- `docs/{getting-started,adopting-a-project,operations-and-recovery,plugin-contracts,m1-acceptance-report}.md`
- `examples/{new-project,adopt-project,manual-adapter,command-adapter}/`

**步骤**：

1. 本地打包 `universal-harness` 并安装到干净临时环境。
2. 验证 `harness` binary、ESM exports、license、README、files list、provenance metadata，确保不包含 internal-only source。
3. 把所有文档示例作为测试运行。
4. 从测试和 benchmark 输出生成 M1 acceptance report，把每项标准映射到 Evidence。
5. 对文件、生成资产、package metadata、示例、Fixture 和 Git 历史运行独立内容扫描。

**验证**：

```bash
pnpm clean
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:smoke
pnpm test:e2e
pnpm test:release
```

**完成条件**：打包后的 CLI 完成两个必需纵向闭环演示，验收报告中没有未解决 P0/P1、迁移缺口或批准绕过。

## 9. 验收追溯

| 设计验收标准 | 主要实施任务 |
|---|---|
| AC1–AC4：new、adopt、iterate、可恢复单命令流程 | 8–11、23、26 |
| AC5–AC7：确定性身份、双 Graph 与 Impact 正确性 | 3–6、12 |
| AC8–AC9：已批准声明式计划和执行模式 | 12–13 |
| AC10–AC11：Task Envelope 与不可变受限 Context | 14、17 |
| AC12–AC14：Tool 治理、幂等外部动作、硬预算 | 15–18 |
| AC15：类型化 outcome 与 correct failure | 17、20 |
| AC16–AC20：Gate、RCA 级联、改进与 freshness | 19–21 |
| AC21：证据完备的 Snapshot | 22–23 |
| AC22：SQLite 恢复 | 5–6 |
| AC23：Adapter control profile 与行为评估 | 18、20、24 |
| AC24：Generic/Node/Python/Java Pack | 25–26 |
| AC25：跨平台 CI | 1、3、7、26–28 |
| AC26：安全升级与回滚 | 6、25 |
| AC27：性能基线 | 27 |
| AC28：独立仓库与历史 | 1、26、28 |

每项验收标准还必须出现在 `docs/m1-acceptance-report.md`，包含测试命令、Evidence artifact、结果和相关 commit。

## 10. 切片退出门禁

### Ledger 基础退出门禁

- Schema 和身份 Golden 在全部 CI 平台通过。
- 原子 Ledger 操作可承受中断和重放。
- 两个 Graph View 可从 Ledger 重建出完全相同结果。
- `new` 和 `adopt` 产生确定性、尚未执行的 baseline。

### 受控执行退出门禁

- 已批准 Requirement 产生 ImpactSet、ExecutionPlan、ContextBundle 和 Task Envelope。
- Managed Loop 无需依赖 Model 遵从即可强制预算与正确终止。
- Tool Policy、external action intent、Approval、Checkpoint 和 resume 都经过故障测试。
- Manual 和 Delegated Adapter 如实呈现 control 与 visibility level。

### 质量反馈退出门禁

- Gate 和 Evaluation 产生当前 Evidence 或 blocking Finding。
- 失败产生 RCA、ImpactSet routing、repair work 和可选 ImprovementCandidate。
- 下游 phase 不能静默修改上游 artifact。
- Generic 项目完成完整闭环并生成 Snapshot。

### M1 发布退出门禁

- 28 条验收标准全部具有通过证据。
- 四个 Pack 和三个 Stack Fixture 通过 conformance 和 E2E tests。
- 跨平台、安全、故障、迁移、独立内容、打包和性能 Gate 全部通过。
- 一次 `harness new` 和一次 `harness adopt` 演示完成整个纵向闭环。

## 11. 评审与变更控制

本计划已批准。实施按以下流程进行：

1. 将已批准的设计和中文计划提交推送到现有 GitHub 仓库。
2. 从已批准文档基线创建 `codex/m1-implementation`。
3. 按顺序执行 Task 1–28，每个 Task 或不可分割的 red/green 对应一个聚焦提交。
4. 实施证据与已批准架构边界冲突时停止编码并修订设计。
5. 每个 Task 和切片退出门禁完成时更新计划状态与验收报告。
