# Dashboard 权威审批队列与 dsh 输出流观测设计

## 1. 背景与问题

Dashboard 已能在 `Live` 页处理 `ApprovalRequired`，但审批卡片依赖浏览器在线时收到实时事件。用户在审批事件发生后才打开 Dashboard 时，只能在 Overview 看到待审批数量，看不到待处理对象、风险、原因和操作入口。

dsh 执行后端目前由 Harness 记录 5 秒心跳，并在运行结束后把最终 stdout 作为 `RunOutputSummary`。子进程运行期间已经产生的 stdout/stderr 没有增量进入 Live Spool，失败时 Dashboard 只能看到心跳和最终错误摘要。dsh headless 也不提供稳定的 token/step 数据，现有系统正确地把它们表示为 `unavailable`，不能用估算值伪装成真实计量。

## 2. 目标

本次改进同时交付两条可独立验证的纵向切片：

1. 新增 `08 Approvals` 独立视图，从 Ledger 已提交的 ApprovalRequest/ApprovalDecision 记录重建当前待审批队列；即使 Live 事件已错过，仍可查看、批准、拒绝、暂缓并恢复工作流。
2. 为受管 dsh 子进程增加 stdout/stderr 增量回调，把有输出时的脱敏、节流、限长尾部摘要发布为 `RunOutputSummary` Observation；Live 页按运行展示最新输出、字节数、来源流和预算可用性。

## 3. 非目标

- 不自动批准，不支持批量或通配审批。
- 不改变 Ledger Schema、ApprovalRequest/ApprovalDecision Schema。
- 不把 Live Spool 提升为权威完成证据，也不把原始 stdout/stderr 写入 Ledger。
- 不解析不稳定的 dsh 私有 session 格式，不估算 token 或 step。
- 不移除现有 Live 页的即时审批卡片。

## 4. 权威审批读取模型

### 4.1 真相来源

读取层重放已提交 Ledger operation，并使用 operation artifact allowlist 验证：

- `artifacts/approval-requests/*.json` 中的 ApprovalRequest；
- `artifacts/approvals/*.json` 中的 ApprovalDecision；
- request 的 `preview_digest` 必须校验通过；
- approve/reject 为终态，defer 保持 pending；
- 被新 request supersede 的旧 request 不再显示。

Dashboard 不从 EventSource 缓存推断待审批状态。Live 事件只负责即时提醒。

### 4.2 Read API

新增：

```text
GET /api/v1/approvals?cursor=<request-id>&limit=<1..500>
```

返回稳定分页的 pending ApprovalRequest 原始权威字段，以及现有 `BusinessPresentation` sidecar。原始 `object_digest` 是写操作绑定值；展示层 digest 永远不能覆盖它。

排序为 `created_at`，相同时间按 `request_id`。cursor 使用 request id，仅作为稳定页界，不改变权威记录。

### 4.3 UI 行为

`08 Approvals` 包含：

- 当前待审批数量和刷新按钮；
- 每个 request 的中文标题、原因、风险、允许决策、对象类型、创建时间；
- 可展开的 request/object/workflow/impact path/digest 审计字段；
- 每条 request 独立 actor 输入和 approve/reject/defer；
- approve 成功后展示绑定 workflow digest 的 Resume 按钮；
- 写入或恢复后重新读取权威队列和 Overview；
- 无待审批时显示明确空状态，解释工作流会在治理边界暂停。

Live 页继续保留即时 Approval station，并复用相同决策逻辑。

## 5. dsh 输出流观测模型

### 5.1 数据路径

```text
dsh child stdout/stderr chunk
  -> PluginSubprocess onOutput 回调
  -> dsh Adapter / OrchestrationExecutor 进度端口
  -> ObservationPublisher.runOutput
  -> 跨 chunk 脱敏 + 2 秒/8 KiB 节流 + 20 行/4 KiB 尾部
  -> FileLiveSpool
  -> Dashboard SSE / Live
```

子进程仍完整受 `max_output_bytes` 与 timeout 约束。回调是 best-effort side channel；回调抛错不得改变进程结果。超过输出上限仍终止子进程，并以类型化 adapter failure 结束。

### 5.2 事件载荷

沿用 `RunOutputSummary`，不新增 Schema 类型。载荷补充：

- `summary`：脱敏后的有限尾部；
- `output_digest`：到当前为止所见输出的 SHA-256；
- `bytes_observed`：累计观察字节数；
- `truncated`：摘要是否截断；
- `stream`：`stdout`、`stderr` 或 `mixed`；
- `final`：运行结束 flush 时为 true。

stdout 与 stderr 共享同一运行摘要窗口，来源集合超过一种时标记 `mixed`。原始 transcript 继续写入 `.harness/raw-traces/agent-dsh/`，不进入 Git 和 Ledger。

### 5.3 token / step 语义

dsh 0.1.0-rc.6 headless 契约没有稳定 token/step 计量。因此：

- RunStarted 和 BudgetUpdated 继续返回 `availability: unavailable`、`used: null`、`enforcement: none`；
- Dashboard 明确显示“Token 未计量 / Step 未计量”；
- duration 由 Harness 实测并受上限强制；
- 不从字符数、行数或 transcript 事件数推算 token/step。

## 6. 安全与可靠性

- 增量输出必须经过现有 secret value、URL credential、Bearer token 和常见 provider token 脱敏。
- 跨 chunk secret 前缀保留在有限窗口，下一 chunk 到达后整体脱敏；非 flush 摘要不能泄露边界前缀。
- Live Spool 可删除、可截断、可丢失，不影响 Ledger 重放、审批绑定、恢复或完成判断。
- Dashboard 写接口保持同源、session、CSRF、expected digest 和 actor 校验。
- 回调与 SSE 失败不得令 Agent run 失败；权威执行结果仍只来自退出码、stdout/stderr、仓库差异与门禁。

## 7. 验收标准

1. 审批事件发生后再启动 Dashboard，`08 Approvals` 仍显示该 request。
2. approve/reject/defer 使用 request 原始 `object_digest`，不信任 presentation digest。
3. approve 后可恢复工作流，队列刷新到下一条权威 pending request。
4. 已终态决策和 superseded request 不出现在列表；defer 仍在列表。
5. fake dsh 分块写 stdout/stderr 时，运行结束前产生 `RunOutputSummary`。
6. 输出摘要有节流、限长、累计字节、digest、stream 信息，且跨 chunk secret 不泄露。
7. dsh token/step 仍明确 unavailable，duration 正常计量。
8. 既有 Live 审批旅程、Dashboard 安全测试、Adapter 契约和全量测试继续通过。

