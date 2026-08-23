# Dashboard 权威审批队列与 dsh 输出流观测实施计划

## 原则

按纵向切片和 TDD 实施。每个行为先写失败测试，再写最小实现；不修改 Ledger Schema，不碰无关用户文件。

## Task 1：权威 pending approval 投影

涉及：

- `packages/dashboard/src/read-api.ts`
- `packages/dashboard/src/router.ts`
- `packages/dashboard/src/server.ts`
- `packages/dashboard/test/server.test.ts`

步骤：

1. 构造已提交 ApprovalRequest fixture，并先让 `GET /api/v1/approvals` 失败。
2. 从 Ledger operation/artifact allowlist 读取并验证所有 workflow 的 request/decision。
3. 过滤终态与 superseded request，稳定排序分页。
4. 使用 `presentApproval` 生成中文 sidecar。
5. 覆盖 defer 保持 pending、approve/reject 消失和非法查询。

## Task 2：独立 08 Approvals 用户旅程

涉及：

- `packages/dashboard/assets/dashboard.html`
- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/assets/dashboard.css`
- `tests/e2e/dashboard-live-approval.test.ts`

步骤：

1. 先写“审批已发生、浏览器随后打开”的 E2E 失败测试。
2. 增加导航、列表、计数、刷新与空状态。
3. 抽取可复用 approval card/decision/resume 行为，保留 Live station。
4. 决策或恢复后同时刷新 Approvals 与 Overview。
5. 验证移动端布局、键盘标签和 raw digest 绑定。

## Task 3：通用子进程增量输出 seam

涉及：

- `packages/plugin-sdk/src/subprocess.ts`
- `packages/plugin-sdk/test/subprocess.test.ts`
- `packages/plugin-sdk/src/agent.ts`
- `packages/runtime/src/orchestration/execution-binding.ts`

步骤：

1. 先测试 stdout/stderr chunk 回调、回调异常隔离、输出上限行为。
2. 给 subprocess options 增加可选 `on_output`，只传递已捕获范围内的 chunk。
3. 给 Agent/Executor 增加可选输出观察端口；旧 adapter/executor 保持结构兼容。

## Task 4：dsh 到 Live Spool 的纵向接线

涉及：

- `adapters/agent-dsh/src/adapter.ts`
- `adapters/agent-dsh/test/adapter.test.ts`
- `packages/cli/src/project-agent.ts`
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/test/observability/*`

步骤：

1. fake dsh 在 resolve 前发送多块 stdout/stderr，先断言当前没有 output observation。
2. 只在真实 task invocation 接线输出回调；version probe 不发布 run output。
3. Orchestrator 把 chunk 绑定当前 run id，交给 ObservationPublisher。
4. 运行结束 flush 最终 summary；避免同一最终内容无意义重复。
5. 保持 transcript、typed failure、unmetered token/step 与 duration 契约。

## Task 5：Live 输出可读性

涉及：

- `packages/runtime/src/observability/publisher.ts`
- `packages/runtime/test/observability/publisher.test.ts`
- `packages/dashboard/src/presentation.ts`
- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/assets/dashboard.css`
- `packages/dashboard/test/presentation.test.ts`

步骤：

1. 测试 stream/mixed/final、累计字节和跨 chunk secret。
2. 扩展 `RunOutputSummary` 载荷，不新增 event type。
3. Live register 对输出使用等宽 tail 区域，显示来源、累计字节、是否截断。
4. BudgetUpdated 对 unavailable token/step 给出明确中文状态。

## Task 6：验证与文档

1. 运行各包聚焦测试和 Dashboard Playwright E2E。
2. 运行静态检查、格式检查和全量 `pnpm test`。
3. 更新 Dashboard/运行观测文档，说明 Approvals 真相来源和 dsh 可观测边界。
4. 确认旧产品迁移说明文档未被暂存或修改。
