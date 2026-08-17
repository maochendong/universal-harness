# M2 Dashboard 中文业务展示层实施计划

日期：2026-08-17

状态：已完成

完成日期：2026-08-17

设计依据：[M2 Dashboard 中文业务展示层设计](../specs/2026-08-17-m2-dashboard-chinese-business-presentation-design.md)

## 1. 目标

在不修改 Ledger Schema、Graph Schema、权威记录和任何写操作绑定的前提下，为 Graph、Impact、Iterations、Evidence、Findings、Live 与 Approval 增加统一的中文业务展示层。

Read API 与 SSE 只增加按 `entity id + digest` 绑定的 `presentations` 侧车；UI 将中文业务名称、说明和关系作为第一阅读层级，将英文技术类型、原始状态、ID、revision 和 digest 保留为审计层。实现必须兼容没有侧车的旧 Dashboard Server。

## 2. 执行规则

1. 每个 Task 严格采用 Red → Green → Refactor：先写会失败的测试，再做最小实现。
2. 每个 Task 完成后运行聚焦测试与 Dashboard typecheck，并形成一个可回滚提交。
3. 展示投影必须是无 I/O、无时间源、无模型、无网络的纯函数；相同输入必须产生相同输出。
4. UI 不维护第二套字段优先级或中文词典；浏览器只消费服务端侧车并提供明确的旧 Server 回退。
5. 中文文本不得参与 Approval、Finding Group、Resume 等写请求；写操作继续使用原始响应中的 digest。
6. 不使用 `innerHTML`、浏览器持久化、外部资源或远程字体；所有动态文本使用 DOM 节点与 `textContent`。
7. 实施 UI 时使用 `frontend-design` 技能；新增或修改 Playwright 场景时使用 `playwright-best-practices` 技能。
8. 若实现要求修改 Core、Ledger、Graph record、Approval binding 或 Finding membership digest，立即停止并重新审查设计。

## 3. Task 1：确定性展示模型与中文词典

**新增文件**

- `packages/dashboard/src/presentation.ts`
- `packages/dashboard/test/presentation.test.ts`

**修改文件**

- `packages/dashboard/src/index.ts`

**测试先行**

- 标题严格按 `display_name → title → name → summary → objective → 类型 + 短 ID` 选择。
- 描述严格按 `description → 未用 summary → objective → reason → 类型固定回退` 选择。
- 仅读取 allowlist 字符串键；对象键按字典序遍历；超过四层、数组、非字符串和异常 extension 被安全忽略。
- 空字符串、纯 SHA-256 digest、纯 Harness 技术 ID 不会成为业务标题。
- 标题、描述和 badge value 分别按 80、240、48 个 Unicode 字符截断，不切断代理对。
- Node、Edge、Iteration、Evidence、Finding Group、Semantic Proposal、Live Event 与 Approval 的已知类型、关系、状态和 tone 使用固定中文词典。
- 未知 type/status 显示中文“未知”与原始值并设置 `fallback: true`。
- `derived_from` 顺序稳定且去重；`presentationKey(id, digest)` 固定输出 `id@digest` 或 `id@live`。
- 相同输入深相等且 canonical JSON 一致；输入对象不被修改。
- 单实体异常始终返回固定 fallback，不向上抛出并拖垮整页。

**实现**

- 定义并导出 `BusinessPresentation`、`PresentationMap` 与 `presentationKey`。
- 用版本化常量保存类型、关系、状态、风险、阶段、verdict、freshness、decision 与 actionability 词典。
- 实现受限字段提取、Unicode 截断、短 ID、badge tone 和确定性 fallback。
- 提供按实体种类划分的深接口，例如 `presentNode`、`presentEdge`、`presentFindingGroup`、`presentSemanticProposal`、`presentEvent` 与 `presentApproval`。
- 提供集合组合函数，隔离单实体异常并生成 `presentations` 映射。

**验证**

```text
pnpm vitest run packages/dashboard/test/presentation.test.ts
pnpm --filter @universal-harness-internal/dashboard typecheck
```

**提交**

```text
feat(dashboard): add deterministic Chinese presentations
```

## 4. Task 2：REST Read API 加法式侧车

**修改文件**

- `packages/dashboard/src/read-api.ts`
- `packages/dashboard/test/server.test.ts`

**测试先行**

- Node 与 Edge 分页在原有 `items`、`next_cursor` 外增加精确绑定的 `presentations`。
- Neighborhood 与 Path 为返回的全部 Node/Edge 生成侧车，原始路径顺序和 digest 不变。
- Iteration 详情为迭代、邻域和 evaluation 生成适用侧车，原始 dossier 字段不变。
- Evidence、Finding Group 与 Semantic Proposal 分页分别使用 record digest、membership digest 与 preview digest 绑定。
- 空页返回空 `presentations`；不删除或改名既有字段。
- 对加入侧车前后的原始对象做深相等断言，证明投影没有修改输入。
- 一条无法提取的实体只生成 `fallback: true`，响应仍为 200。
- 既有缓存损坏、分页边界、typed problem 行为保持不变。

**实现**

- 将 `DashboardPage<T>` 扩展为带只读 `presentations` 的加法式响应，不改变 `items` 结构。
- 在 `nodes`、`edges`、`neighborhood`、`path`、`iteration`、`evidence`、`findingGroups` 与 `semanticProposals` 的返回边界调用展示模块。
- 为复合响应集中收集实体，避免各路由自行拼接侧车。
- 保持 `router.ts` 的验证与 JSON 信封不变；只透传 Read API 新增字段。

**验证**

```text
pnpm vitest run packages/dashboard/test/presentation.test.ts packages/dashboard/test/server.test.ts
pnpm --filter @universal-harness-internal/dashboard typecheck
```

**提交**

```text
feat(dashboard): expose business presentation sidecars
```

## 5. Task 3：Live 与 Approval 的 SSE 展示侧车

**修改文件**

- `packages/dashboard/src/sse.ts`
- `packages/dashboard/test/sse.test.ts`

**测试先行**

- 每个 SSE data frame 保留原始 `EventStreamItem` 字段并增加 `presentations`。
- 普通 Live Event 使用事件 ID 与 `live` 绑定；重复读取同一事件产生相同侧车。
- `ApprovalRequired` 同时生成 Live Event 展示和按 `request_id + object_digest` 绑定的 Approval 展示。
- Approval 中文说明只读取 `object_type`、`reason`、`risk`、`allowed_decisions` 等既有 payload。
- SSE cursor、事件名、backpressure、heartbeat、reset、disconnect 与错误帧行为不变。
- presentation 生成失败时发出 fallback，不把健康事件转换为 `stream_error`。

**实现**

- 仅在 `eventFrame` 序列化边界附加侧车，不修改 EventStreamPort 或运行时事件。
- Approval 展示保留 `object_digest` 作为绑定信息，但不创建新的写操作数据源。
- 保持所有 SSE 安全头、cursor 和恢复语义不变。

**验证**

```text
pnpm vitest run packages/dashboard/test/sse.test.ts packages/dashboard/test/security.test.ts
pnpm --filter @universal-harness-internal/dashboard typecheck
```

**提交**

```text
feat(dashboard): describe live governance events in Chinese
```

## 6. Task 4：统一业务卡与审计交互基础

**修改文件**

- `packages/dashboard/assets/dashboard.html`
- `packages/dashboard/assets/dashboard.css`
- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/test/assets.test.ts`

**测试先行**

- 静态资源包含统一的业务标题、描述、badge、技术元信息和审计栏构造路径。
- lookup 仅通过 `entity id + digest` 查找侧车；缺失侧车时走旧技术展示，不出现空标题。
- digest 默认短显，完整值仍存在于可聚焦审计详情，并可由键盘触发复制。
- 复制按钮具有包含对象名称的 `aria-label`；成功或失败通过 `role=status` 文本报告。
- `navigator.clipboard` 不可用时显示完整可选择 digest，不阻塞页面。
- 继续禁止 `innerHTML`、`eval`、local/session storage 与外部资源。

**实现**

- 新增 `presentationFor`、`businessHeading`、`businessBadges`、`auditDetails` 与 `copyDigest` 等浏览器端展示组件。
- 浏览器端只负责查表和布局；中文词典、字段提取和业务推断均留在服务端。
- 增加统一 CSS token 与组件样式：中文主标题、英文次标签、语义 badge、折叠审计栏和 digest 复制反馈。
- 在页面中增加全局、可访问的复制反馈区域；保持现有深色 Observatory 视觉语言。

**验证**

```text
pnpm vitest run packages/dashboard/test/assets.test.ts packages/dashboard/test/security.test.ts
pnpm --filter @universal-harness-internal/dashboard typecheck
```

**提交**

```text
feat(dashboard): add business-first entity components
```

## 7. Task 5：迁移 Graph、Impact、Iterations、Evidence 与 Findings

**修改文件**

- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/assets/dashboard.css`
- `tests/e2e/dashboard-readonly.test.ts`

**测试先行**

- Graph 列表和 inspector 首先显示中文类型、业务标题与说明；原始 type/status、ID、revision 和 digest 位于审计层。
- Neighborhood 使用中文关系和邻居业务名称，同时保留英文 relation type。
- Impact 路径解释中文对象与关系；Path ID、edge ID 与 digest 可审计；Semantic Proposal 明确显示“候选/待批准”。
- Iteration 列表以业务目标或确定性回退为标题，详情显示阶段、任务/评估摘要和审计字段。
- Evidence 说明“证明什么、作用对象、freshness 与 verdict”，失败或 stale 同时使用文字和 tone。
- Finding Group 显示中文问题摘要、severity、actionability、scope、成员数与样本；membership digest 仍可复制。
- 模拟移除 `presentations` 的旧 Server 响应后，五个视图仍能显示原有技术信息。
- 分页、过滤、按需 neighborhood 请求、empty/error 状态保持可用。

**实现**

- 将五个只读视图迁移到统一业务组件，不复制展示规则。
- 对一次请求返回的 `presentations` 做局部传递，不建立浏览器持久缓存。
- 关系与 proposal 保持非权威/待批准视觉标识，不能因中文文案弱化治理状态。
- 保留现有按需加载与分页策略，不为展示层拉取全图。

**验证**

```text
pnpm vitest run packages/dashboard/test/assets.test.ts packages/dashboard/test/server.test.ts
pnpm test:e2e:dashboard -- tests/e2e/dashboard-readonly.test.ts
```

**提交**

```text
feat(dashboard): make read views business-first
```

## 8. Task 6：迁移 Live 与 Approval，证明写绑定不变

**修改文件**

- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/assets/dashboard.css`
- `tests/e2e/dashboard-live-approval.test.ts`

**测试先行**

- Live Event 首先显示中文阶段/动作/结果，英文 event type、source、event/run id 作为次级信息。
- Approval Card 首先解释“批准什么、为什么、风险和允许动作”，原始 object type、request id 与 digest 在审计层。
- approve/reject/defer 的请求体 `expected_digest` 与原始 `approval.object_digest` 完全相等，不从 presentation 读取。
- presentation title/description 被篡改也不会改变 POST URL、decision、actor 或 expected digest。
- 决策 Ledger readback、resume、409 refresh 与 15 秒 heartbeat unknown 行为保持不变。
- SSE 没有侧车时 Live 与 Approval 使用现有英文技术回退。

**实现**

- 使用 SSE 随帧侧车渲染 Live register 与 Approval Card。
- 保留原始 payload 作为 `decideApproval` 和 `resumeWorkflow` 的唯一写操作输入。
- 为风险、阶段、source 与状态提供文字 + tone，不依赖颜色表达。

**验证**

```text
pnpm vitest run packages/dashboard/test/sse.test.ts packages/dashboard/test/write-api.test.ts
pnpm test:e2e:dashboard -- tests/e2e/dashboard-live-approval.test.ts
```

**提交**

```text
feat(dashboard): make live approvals business-readable
```

## 9. Task 7：响应式、可访问性与完整门禁

**修改文件**

- `packages/dashboard/assets/dashboard.css`
- `packages/dashboard/test/assets.test.ts`
- `tests/e2e/dashboard-readonly.test.ts`
- `tests/e2e/dashboard-live-approval.test.ts`
- `docs/superpowers/plans/2026-08-17-m2-dashboard-chinese-business-presentation-implementation-plan.md`

**测试先行**

- 390px 宽度下业务卡单列，标题、badge 和审计栏不溢出；digest 入口不隐藏。
- 键盘可到达卡片、详情、审计栏与复制按钮；focus-visible 清晰。
- `prefers-reduced-motion` 下无非必要动画；状态变化仍有文字反馈。
- 中文主信息与英文次标签达到可读对比度，critical/warning/positive 不只靠颜色区分。
- 两条 Playwright 纵向旅程覆盖七个视图、旧 Server 回退、复制反馈和真实 digest-bound Approval。

**实现**

- 收敛响应式规则、可访问名称、焦点顺序、换行和视觉 tone。
- 对测试截图做人工检查，修复信息层级、截断或窄屏问题。
- 完成后把本计划状态改为“已完成”，记录完成日期、最终提交和门禁结果。

**聚焦验证**

```text
pnpm --filter @universal-harness-internal/dashboard test
pnpm --filter @universal-harness-internal/dashboard typecheck
pnpm test:e2e:dashboard
```

**完整验证**

```text
pnpm verify
pnpm test:release
```

**提交**

```text
test(dashboard): prove Chinese presentation compatibility
```

## 10. 完成判定

只有同时满足以下条件才可将计划标记为完成：

1. 七个视图均以中文业务名称和说明为主，digest/ID 不再作为主标题。
2. 所有未知或缺字段实体均有确定性中文 fallback。
3. REST 与 SSE 原始事实、事件、cursor 和 digest 未改变。
4. 旧 Server 缺少侧车时 UI 可安全回退。
5. Approval/Finding/Resume 写操作仍只绑定原始 digest，并有 E2E 实证。
6. Dashboard 聚焦测试、Playwright、`pnpm verify` 与 `pnpm test:release` 全绿。
7. `.superpowers/` 讨论临时文件未进入产品提交。

## 11. 完成记录

### 提交

- `5ea465b` `feat(dashboard): add deterministic Chinese presentations`
- `c99458c` `feat(dashboard): expose business presentation sidecars`
- `632301e` `feat(dashboard): describe live governance events in Chinese`
- `c436aa3` `feat(dashboard): add business-first entity components`
- `1660fa1` `feat(dashboard): make read views business-first`
- `efec3b9` `feat(dashboard): make live approvals business-readable`
- `test(dashboard): prove Chinese presentation compatibility`（本计划收尾提交）

### 验证证据

- Dashboard 包测试：6 个文件、31/31 测试通过。
- Dashboard Playwright：8/8 通过，覆盖七个视图、旧 Server 回退、390px 响应式、键盘复制反馈、剪贴板降级和 digest-bound Approval。
- `pnpm verify`：215/215 测试文件、1322/1322 测试通过；Standalone 扫描 695 个文件和 Git 历史通过。
- `pnpm test:release`：Security 67/67、Fault 78/78、Performance 12/12、跨栈 E2E 31/31、Dashboard E2E 8/8、离线 Pack smoke 全部通过；验收报告 M1 28/28、M2 13/13。
- 人工视觉检查：1440×900 的 Live/Approval 双栏与 390×844 的 Graph 单栏均无横向溢出；控制台无 warning/error。

### 实施中补强

- 补齐 `AdoptionBaseline`、`RequirementBaseline`、`ExecutionAuthorizationSpec` 与 `ImprovementCandidate` 等运行时审批对象的中文名称。
- 将 `.superpowers/` 纳入 Git 与 Prettier 忽略，防止讨论临时文件进入产品提交或破坏门禁。
- 将 Vitest 全仓并发上限设为 4，并为执行两套真实 Git 漂移场景的语义编辑集成测试设置 15 秒局部超时，消除资源竞争导致的非确定性门禁失败。
