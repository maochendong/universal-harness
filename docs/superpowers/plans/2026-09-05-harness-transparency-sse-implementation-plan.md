# Universal Harness 开发过程透明化与 SSE 呈现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已提交决定、状态流转和指定版本产出可靠可见，修复事件读取正确性并实现有界共享 SSE。

**进度说明（2026-09-08）：** 共享事件读取基础修复与产出盘点已在[运行优化计划](2026-09-08-operational-optimization-plan.md)中落实；原 Task 1 的完整规模/RSS 门槛和其余任务仍未完成。本计划复选框不因共享子集通过而整体勾选。

**Architecture:** Ledger manifest 决定权威可见性，Live Spool 承载实时观察；FileEventStream 复用 core 校验并维护内存 position 索引。Dashboard Hub 共享源刷新、分页追平和有界扇出；产出正文通过已有读接口的受控扩展提供。

**Tech Stack:** TypeScript 6、Node.js >=22.13.0、TypeBox/Ajv、Vitest、Playwright、pnpm workspace、Git-native Ledger。

**Spec:** [开发过程透明化与 SSE 呈现设计](../specs/2026-09-05-harness-transparency-sse-design.md)

**Status:** 2026-09-08 已按评审修订；实施未开始。用户授权本轮文档修订，不代表任务已经完成。

**Baseline:** `2084617`；原始两份文档未跟踪，`teach/` 为无关未跟踪目录。执行时先核对最新 Git 状态；已有变更不覆盖、不顺手提交。

## Global Constraints

- 保留六个任务；Task 5 的覆盖盘点提前执行，不增加 Task 0/Task 7。
- 不新增数据库、消息队列、WebSocket、workspace package 或公共插件 Port；不重构无关审批状态机。
- 权威可见必须通过 manifest、分片 digest、Schema/绑定和 Reader gate；不得直接信任事件目录里的文件。
- Protocol 1.4 为 development；携带1.4权威内容的事务 pin 为1.4，旧权威 Reader 按既有规则升级阻断。
- Observation 类型和 stream_version=1 不变；SSE命名事件、id、heartbeat、reset/error结构保持兼容。
- v2 opaque cursor 可以升级；合法旧 cursor 和失效 generation 走 reset，不固定已证实错误的分页行为。
- 允许重放，UI幂等；不承诺传输 exactly-once 或恢复已删除的 Live 历史。
- 每客户端缓冲最多256条或1 MiB，drain最多10s；慢客户端不能拖停其他订阅。
- 单SSE帧UTF-8序列化后≤32 KiB，展示摘要≤200 Unicode字符；正文集合limit=1..100，默认20，文本片段8 KiB，REST单响应≤256 KiB。
- ApprovalDecided 不携带raw actor；共享runtime读取模块生成稳定、脱敏的actor_display。defer仍pending，EOF/Ctrl-C不提交决定。
- 性能预算原样使用设计§7.3；承认O(F)文件发现成本；冷启动、内存和稳态分别报告。
- 保持原有正确行为的表征测试；已证实的bug必须先写RED，不要求其在旧实现上通过。
- 实施遵循Red→Green→Refactor；每个任务通过目标测试与独立评审后合入。当前文档修订不执行提交命令或编码步骤。

## File Map and Ownership

| 任务   | 实现/配置文件                                                                                                                                                                                                                    | 测试与证据文件                                                                                                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1 | `packages/core/src/ledger/event-store.ts`、`packages/core/src/ledger/index.ts`；`packages/runtime/src/observability/event-stream.ts`，内部辅助 `event-file-cache.ts`、`event-index.ts`；runtime导出入口；CLI `commands/watch.ts` | core `test/ledger/event-visibility.test.ts`；runtime `test/observability/event-stream{,-incremental}.test.ts`；CLI `test/watch.test.ts`；`tests/fault/event-stream-recovery.test.ts`；`tests/performance/event-stream-incremental.test.ts`；`scripts/generate-performance-dataset.mjs` |
| Task 2 | `packages/dashboard/src/event-hub.ts`、`server.ts`、`router.ts`、`sse.ts`                                                                                                                                                        | dashboard `test/event-hub.test.ts`、`test/sse.test.ts`；`tests/e2e/sse-reconnect.test.ts`；Task 1性能文件                                                                                                                                                                              |
| Task 3 | core `src/protocol.ts`、`src/ledger/event-store.ts`、`src/ledger/transaction.ts`、`src/schema/event.ts`、`src/schema/registry.ts`；runtime `src/orchestration/lifecycle-events.ts`、`src/approval/{interaction,service}.ts`      | core `test/protocol/protocol-1.4.test.ts`及现有注册表测试；runtime `test/approval/{interaction,service,approval-decided-event}.test.ts`；生成的core Schema                                                                                                                             |
| Task 4 | runtime `src/observability/approval-summary.ts`及导出；CLI `commands/watch.ts`；dashboard `src/{read-api,presentation,router,sse}.ts`、`assets/dashboard.js`                                                                     | runtime `test/observability/approval-summary.test.ts`；CLI `test/watch.test.ts`；dashboard `test/presentation.test.ts`；既有Playwright `tests/e2e/dashboard-live-approval.test.ts`                                                                                                     |
| Task 5 | runtime `src/observability/artifact-reader.ts`及导出；dashboard `src/{read-api,router,presentation,sse}.ts`、`assets/dashboard.js`；必要的产出提交点与生命周期构建器                                                             | `docs/evidence/artifact-reference-coverage.md`；runtime `test/observability/artifact-reader.test.ts`；dashboard读取/路由测试；`tests/security/dashboard-artifact-boundaries.test.ts`；Playwright `tests/e2e/dashboard-transparency.test.ts`；两套测试配置                              |
| Task 6 | `packages/conformance/src/event-stream.ts`及`index.ts`；`scripts/dogfood-transparency-sse.mjs`、`scripts/lib/transparency-evidence.mjs`、`scripts/verify-transparency-evidence.mjs`；`package.json`                              | conformance `test/event-stream.conformance.test.ts`；`tests/reporting/transparency-evidence.test.ts`；`docs/evidence/transparency-sse-completion.{json,md}`                                                                                                                            |

新增的辅助文件为实现内部拆分；不用它们建立新公共扩展体系。表中已有文件增补，新增文件创建前先核对是否已存在。
Task 1/3共享core event-store，按1→3合入；Task 4/5共享呈现文件，按4→5合入。Task 2/3可以并行。

## 前置盘点与提交规则

Task 5 Step 1 在其他任务编码前执行。它要确定正文读取缺口和每个条件性事件的实际提交点，不能只列名称。
覆盖表允许记录“现有缺口，由Task 5补齐”，但不允许把摘要列表计为正文可读或未验证项标为通过。

每次合入前执行以下检查；stage只包含该任务明确文件，尤其不要使用`git add .`：

```bash
git status --short
git diff --check
git diff --cached --check
git diff --cached --stat
```

实施期间记录RED与GREEN的测试名、命令、退出码及基线；证据必须绑定真实实现字节，不能仅凭计划复选框更改完成状态。

---

### Task 1: 权威事件可见性、正确恢复与增量读取

**Depends on:** Task 5 Step 1覆盖盘点完成；无其他代码依赖。\
**Files:** File Map的Task 1行。\
**AC:** HT-AC-01、03、05、06。

**Interfaces:**

- Consumes: 现有manifest解析、digest/Schema校验、EventStreamQuery/Page、FileLiveSpool。
- Produces: 正确的FileEventStream.read/subscribe；v2 cursor；runtime内部只读view供Task 2复用。
- core提取现有严格读取逻辑为 `readCommittedEventShard(harnessRoot, operation, options?): readonly LifecycleEvent[]`，由replay与增量读取共同调用；`options.unknownEventTypes`为`reject | skip`且默认reject。观察层可显式skip未知类型，但先验证manifest/digest/基础包络，其他错误继续拒绝；不复制digest算法。

```ts
interface EventStreamReadView {
  readonly headCursor: string;
  // 不访问文件系统；按捕获上界读取。源代际变化返回reset。
  read(query?: EventStreamQuery): EventStreamPage;
}

// 附加到现有类型，旧Port仍可实现原合同。
// EventStreamQuery: untilCursor?: string
// EventStreamPage: itemCursors?: readonly string[]; headCursor?: string
interface IncrementalEventReader extends EventStreamPort {
  refreshView(): Promise<EventStreamReadView>;
}
// 第一方FileEventStream实现此内部合同，不注册新公共Port。
```

`read(query)`为单消费者便捷入口：refreshView后read。Hub每轮只调用一次refreshView，再共享无I/O的view；
view旧代际失效可检测，不对外暴露position解码。缓存索引的并发更新由读取模块串行化。

- [ ] **Step 1: 表征测试与RED分开提交内容**

原正确行为：过滤、合法分页、limit=1..500、live→ledger事实取代、损坏Live行不生成终态。
新RED必须包含评审复现及完整尾行修复；测试用真实临时Ledger/Spool，不只mock数组。

```ts
const seen: number[] = [];
let cursor: string | undefined;
for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
  const page = await stream.read({ limit: 1, ...(cursor ? { cursor } : {}) });
  if (page.items.length === 0) break;
  seen.push(page.items[0]!.event.sequence);
  cursor = page.cursor;
}
expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
```

另加：同批sequence递增但id逆序、较早timestamp迟到、合法旧cursor reset、乱格式invalid_cursor、
process/reader重启generation失效，以及已淘汰Live显示缺口。旧实现应在这些新期望上FAIL。

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/observability/event-stream.test.ts tests/fault/event-stream-recovery.test.ts
```

- [ ] **Step 2: 用提交边界故障证明可见性，再实现共享校验**

```ts
const hooks = {
  atBoundary(boundary: string) {
    if (boundary === "shards.renamed") throw new Error("fault_before_manifest");
  },
};
// 将hooks注入真实LedgerRepository，在该边界中断已有makeInput事务。
await expect(repository.commit(input)).rejects.toThrow("fault_before_manifest");
expect(repository.operations()).toHaveLength(0);
expect(
  (await stream.read()).items.filter((item) => item.authoritative),
).toEqual([]);
```

成功提交后整批可见；重试只可见一次。验证manifest缺失、坏digest、已知坏Schema、跨operation事件；
已提交分片坏数据必须报错，orphan不可见。core helper复用`readShardRecords`的现有实现和错误类型。

- [ ] **Step 3: 实现v2 position索引与有界查询**

```ts
const view = await stream.refreshView();
const first = view.read({ limit: 1, untilCursor: view.headCursor });
expect(first.itemCursors?.[0]).toBe(first.cursor);
const rest = view.read({
  cursor: first.cursor,
  untilCursor: view.headCursor,
  limit: 500,
});
expect(rest.reset).toBeUndefined();
```

初次按设计§6总序建立position；新增可见批次追加，不以显示时间过滤；固定上界查询不会追逐后续新增。
Live取代保留旧cursor锚点并追加权威版本；同generation位置不复用。数组/Map索引支持按页查找，
空轮询不重新排序历史。CLI watch不自行解码cursor，遇reset明确提示并重读，JSON模式保留机器输出约定。

- [ ] **Step 4: 实现文件缓存，并逐个证明writer场景**

```ts
// 同一临时文件先写前半行、读取，再补齐后半行；只在第二次读取出现完整事件。
expect((await stream.read()).items).toHaveLength(0);
appendFileSync(livePath, remainderBytes);
expect((await stream.read()).items.map((item) => item.id)).toEqual([
  expectedId,
]);
```

覆盖等长rename、更大rename、同文件追加、缩小、删除、mtime异常、stat/open间轮换和UTF-8跨块。
Ledger immutable shard整体验证；Live byte offset与尾Buffer分离。core的来源验证不能被“缓存命中”绕过。
使用fs/校验探针统计真实读取与解析次数；不把stat次数记为内容读取字节。

- [ ] **Step 5: 现在执行性能测试，而非等Task 6**

扩展既有`generate-performance-dataset.mjs`，新增event-stream模式、固定seed、E/F布局和临时输出目录。
将设计§7.3的20次预热、200次采样、两类布局、RSS和p95阈值直接编码为断言；保存机器样本供Task 6使用。

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/ledger packages/runtime/test/observability packages/cli/test/watch.test.ts tests/fault/event-stream-recovery.test.ts
pnpm exec vitest run --config vitest.performance.ts tests/performance/event-stream-incremental.test.ts
```

Expected: 权威/恢复/缓存全部PASS；同F的p95≤max(小数据×2,25ms)，1万文件对p95≤200ms，10万事件RSS增量≤256MiB。
若预算失败，记录原因并停止该任务完成声明，不缩小fixture冒充原验收。

- [ ] **Step 6: 提交与评审**

```bash
git add packages/core/src/ledger/event-store.ts packages/core/src/ledger/index.ts packages/core/test/ledger/event-visibility.test.ts
git add packages/runtime/src/observability packages/runtime/test/observability packages/cli/src/commands/watch.ts packages/cli/test/watch.test.ts
git add tests/fault/event-stream-recovery.test.ts tests/performance/event-stream-incremental.test.ts scripts/generate-performance-dataset.mjs
git diff --cached --check
git commit -m "fix(event-stream): enforce committed visibility and resumable incremental reads"
```

导出入口若调整，按File Map显式stage。Task 1评审通过后才开始Task 2/3。

---

### Task 2: 有界共享Hub与SSE恢复

**Depends on:** Task 1。可与Task 3并行。\
**Files:** File Map的Task 2行。\
**AC:** HT-AC-05、06。

**Interfaces:**

- Consumes: Task 1的`refreshView()`、`EventStreamReadView.read()`、headCursor/itemCursors/untilCursor。
- Produces: 设计§8的`EventStreamHub.subscribeClient(options): AsyncIterable<HubDelivery>`与`close()`。
- sse接受HubDelivery，保留原EventStreamPort路径以兼容注入的旧Adapter；不伪造缺失的逐项cursor。

- [ ] **Step 1: 写交接、过滤、隔离RED**

为source refresh、客户端登记和追平完成设置可控屏障；在各屏障间追加事件，两个客户端使用不同
workflow/iteration过滤。确保read分页>500项仍追平，期间新事件不遗漏，直到H结束后再交付H之后。

```ts
const controller = new AbortController();
const client = hub.subscribeClient({
  workflowOperationId: "workflow_a",
  signal: controller.signal,
});
const next = await client[Symbol.asyncIterator]().next();
expect(next.value).toMatchObject({
  kind: "item",
  item: { event: { workflow_operation_id: "workflow_a" } },
});
controller.abort();
await hub.close();
```

测试同时断言filter不泄漏、client A断开不影响B、unknown generation发reset、底层失败发error、
冷历史追平不会使共享刷新次数按客户端翻倍。Run以下命令，应在Hub不存在或行为不满足处FAIL。

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/dashboard/test/event-hub.test.ts packages/dashboard/test/sse.test.ts
```

- [ ] **Step 2: 实现登记→上界→分页→缓冲交接**

```ts
type HubDelivery =
  | { kind: "item"; item: EventStreamItem; cursor: string }
  | { kind: "reset"; reason: "cursor_evicted" }
  | { kind: "error"; code: "event_stream_unavailable" };

const view = await source.refreshView();
// 客户端登记与捕获此view上界须在Hub串行区内；read无I/O。
const page = view.read({ ...query, untilCursor: view.headCursor, limit: 500 });
```

先登记缓冲再取H；逐页只追平到H，再去重排空H后的缓冲。refresh只在共享循环进行，客户端不能调用
source.read触发额外扫描。generation变化终止旧view并reset；无客户端停轮询，关闭Hub释放全部订阅。

- [ ] **Step 3: 实现并测试背压及线格式**

使用fake response使write返回false，控制drain；256条/1MiB/10s任何限制达到则关闭该客户端，
其他客户端继续。队列位置不是已交付游标；无需存服务端ack，重连以客户端Last-Event-ID为准。

```ts
expect(bufferedItems).toBeLessThanOrEqual(256);
expect(bufferedBytes).toBeLessThanOrEqual(1024 * 1024);
expect(fastClientEventIds).toContain(newestEventId);
expect(sourceRefreshCountWithFourClients).toBe(sourceRefreshCountWithOneClient);
```

逐字验证既有heartbeat/reset/error帧结构、逐项id；无数据时heartbeat仍发送，abort/drain等待能释放。
router维持已有过滤和认证，不因Hub共享而混合不同请求的过滤范围。

- [ ] **Step 4: 用真实HTTP验证重连并提交**

`tests/e2e/sse-reconnect.test.ts`明确使用Vitest+Node HTTP客户端：复用既有Dashboard认证fixture，
断开后带Last-Event-ID重连，验证所有目标id至少可达；同代际正常恢复不跳项，reset后允许重放。
浏览器幂等由Task 4/5 Playwright验证，不在Vitest中导入Playwright test。

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/dashboard/test tests/e2e/sse-reconnect.test.ts
pnpm exec vitest run --config vitest.performance.ts tests/performance/event-stream-incremental.test.ts
git add packages/dashboard/src/event-hub.ts packages/dashboard/src/server.ts packages/dashboard/src/router.ts packages/dashboard/src/sse.ts packages/dashboard/test
git add tests/e2e/sse-reconnect.test.ts tests/performance/event-stream-incremental.test.ts
git diff --cached --check
git commit -m "feat(dashboard): add bounded resumable event fanout"
```

Expected: PASS；4客户端源扫描/读取工作量与1客户端一致，输出开销单独报告。

---

### Task 3: 完整Protocol 1.4升级与真实决定事件

**Depends on:** Task 1，复用其core读取改动；可与Task 2并行。\
**Files:** File Map的Task 3行。\
**AC:** HT-AC-01、02、03。

**Interfaces:**

- Consumes: `transactionRequiredReaderVersion()`、`commitCheckpoint()`、ApprovalDecisionRecord与其artifact字节。
- Produces: `PROTOCOL_1_4_VERSION`、严格payload校验、`approvalDecidedEvent(record, artifactDigest)`；带原因的内部交互结果。

```ts
type ApprovalPromptOutcome =
  | { kind: "decision"; decision: "approve" | "reject" | "defer" }
  | { kind: "no_decision"; reason: "eof" | "interrupted" | "invalid_input" };

// 新内部函数：promptForApprovalOutcome(request, prompter): Promise<ApprovalPromptOutcome>
// 保留parseApprovalDecision/promptForApprovalDecision旧签名作为兼容包装。
```

- [ ] **Step 1: 写注册、事务pin与重启读取RED**

```ts
expect(assertKnownProtocol("1.4.0").status).toBe("development");
expect(transactionRequiredReaderVersion(transactionWithV14Event)).toBe("1.4.0");
expect(
  validateTransaction(transactionWithV14Event).map(
    (issue) => issue.instancePath,
  ),
).toContain("/required_reader_version");
expect(
  validateTransaction({
    ...transactionWithV14Event,
    required_reader_version: "1.4.0",
  }),
).toEqual([]);
```

测试1.0–1.4混合记录、1.4默认Reader重启、旧Reader显式阻断；保留历史golden字节不变。
不能通过仅删除EVENT_TYPES一项模拟所有旧版行为；至少用固定旧Schema及显式旧Reader各测其合同。

- [ ] **Step 2: 注册、pin、默认Reader及payload校验一起实现**

所有含新事件事务使用完整artifacts/events归约的最高版本；新增事件pin不可由1.0/1.2决定记录版本覆盖。
core最新Reader默认改1.4；检索生产显式Reader pin并区分“支持版本”与“特定领域记录版本”，不批量改历史。

```ts
const payload = {
  request_id: record.request_id,
  approval_id: record.approval_id,
  decision: record.decision,
  object_digest: record.object_digest,
  decision_digest: artifactDigest,
  decided_at: record.decided_at,
};
// 以TypeBox strictObject校验六字段；Decision enum、id、digest、timestamp复用core Schema。
const event = {
  eventType: "ApprovalDecided",
  protocolVersion: PROTOCOL_1_4_VERSION,
  payload,
};
```

在schema registry增加已知ApprovalDecided的payload语义校验与负向用例；不改变旧事件Schema容忍范围。
使用字节digest绑定Decision artifact，不重新发明canonical或semantic digest。

- [ ] **Step 3: 分别接入本地与远程既有提交点**

```ts
// 在原有artifacts同次提交中附加，不另开一次事务。
events: [approvalDecidedEvent(record, sha256Hex(artifact.content))];
// 远程分支保留原RemoteApprovalMaterialized，并附加上述同一构建器结果。
```

测试CLI显式approve/reject/defer、Dashboard命令路径和远程物化；每个Decision恰一事件，digest一致。
远程幂等重试不新增事件；提交前故障、drift、自审批、禁用决定不产生已提交成果。remote decided_at保持原值。

- [ ] **Step 4: 保留未作决定信息，证明defer不是终态**

```ts
expect(await promptForApprovalOutcome(request, eofPrompter)).toEqual({
  kind: "no_decision",
  reason: "eof",
});
expect(await promptForApprovalOutcome(request, explicitDeferPrompter)).toEqual({
  kind: "decision",
  decision: "defer",
});
```

显式defer走resolveDecision并保持pending；EOF/Ctrl-C/空输入/无效输入只阻塞等待，不写Decision。
验证同请求defer→defer→approve有三条决定/成果事件；远程defer保持既有拒绝物化语义。

- [ ] **Step 5: 生成Schema、目标门禁、提交**

```bash
pnpm --filter @universal-harness-internal/core schema:generate
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/protocol packages/core/test/ledger packages/runtime/test/approval tests/fault/remote-approval-materialization.test.ts
git add packages/core/src/protocol.ts packages/core/src/ledger packages/core/src/schema packages/core/schemas packages/core/test/protocol
git add packages/runtime/src/orchestration/lifecycle-events.ts packages/runtime/src/approval packages/runtime/test/approval
git diff --cached --check
git commit -m "feat(approval): register protocol 1.4 and commit truthful decision events"
```

Expected: PASS；批准提交成功且下一次读取/重启不因默认Reader过旧而失败。

---

### Task 4: 可恢复审批卡片、事件订阅与共享摘要

**Depends on:** Task 2、3。\
**Files:** File Map的Task 4行。\
**AC:** HT-AC-02、04、06。

**Interfaces:**

- Consumes: ApprovalDecided、已提交Decision摘要、Hub事件、原pending读取接口。
- Produces: `readApprovalSummary(projectRoot, decisionDigest)`，CLI/Dashboard共用；session可选`event_types`；浏览器幂等消费。

```ts
interface ApprovalSummary {
  request_id: string;
  approval_id: string;
  decision: "approve" | "reject" | "defer";
  actor_display: string;
  decided_at: string;
  decision_digest: string;
}
```

- [ ] **Step 1: 写摘要与卡片状态RED**

摘要读取仅接受已提交manifest验证的Decision，字节digest匹配；输出actor_display按设计§10生成，
不返回raw actor。测试同一引用在CLI和Dashboard显示相同决定/身份/时间；404不推断成功。

```ts
expect(summary.decision_digest).toBe(decisionDigest);
expect(JSON.stringify(summary)).not.toContain("reviewer@example.test");
expect(summary.decided_at).toBe(remoteDecision.decided_at);
```

- [ ] **Step 2: 实现共享摘要和完整命名事件注册**

```ts
// 已认证session响应增加字段；不改变既有csrf/expires_at。
const sessionExtension = {
  event_types: [...new Set([...EVENT_TYPES, ...OBSERVATION_EVENT_TYPES])],
};

// dashboard.js；eventTypes来自session，旧服务缺字段时用固定旧类型回退。
for (const type of eventTypes) source.addEventListener(type, receiveLive);
```

首次接入设计§9的同一个`/api/v1/artifacts/:digest?kind=approval_decision&scope=artifact`入口，返回
`{ ref, provenance, content: summary, safe_view: true }`；Task 5再扩展其他kind，不增设第二个历史决定接口。
runtime共享摘要按已提交manifest定位Decision并验证bytes；Task 5通用读取器落地后复用这一校验，
不得保留两套来源验证。actor_display使用项目作用域稳定hash的短标识，原actor不进入事件/SSE视图。
CLI不依赖dashboard package，presentation由同一摘要富化；同步遵守32KiB/200字符的最终护栏。

- [ ] **Step 3: 实现request聚合、幂等和reset恢复**

```ts
const requestStillPending = summary.decision === "defer";
// approval_id幂等；同request的顺序按已提交记录顺序，而非远程decided_at或到达顺序。
// 终态/较新决定不能被旧事件重放降回pending。
```

defer卡片显示“已暂缓，仍待处理”并保留后续操作；approve/reject显示终态。收到事件立即加载摘要，
pending列表用于待办状态复核，不推断actor/decided_at。reset时重新读取pending和已知决定摘要、按权威
提交顺序恢复，清理旧Live代际并提示缺口；观察更新本身不调用批准/resume写接口。

- [ ] **Step 4: Playwright证明真实浏览器更新，再提交**

扩展现有dashboard-live-approval（已在Playwright配置中），包括两浏览器/CLI异处决定、
defer→approve、远程时间、刷新、重复事件及stream_reset。打开页面后从另一命令路径决定，
不能只在点击批准按钮的本地回调中更新卡片来冒充SSE。

```ts
await expect(page.locator("#approval-queue")).toContainText("已暂缓");
await expect(
  page
    .locator("#approval-queue")
    .getByRole("button", { name: "批准", exact: true }),
).toBeEnabled();
```

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/observability/approval-summary.test.ts packages/cli/test/watch.test.ts packages/dashboard/test/presentation.test.ts
pnpm exec playwright test --config playwright.dashboard.config.ts dashboard-live-approval.test.ts
git add packages/runtime/src/observability/approval-summary.ts packages/runtime/test/observability/approval-summary.test.ts
git add packages/cli/src/commands/watch.ts packages/cli/test/watch.test.ts packages/dashboard/src packages/dashboard/assets/dashboard.js packages/dashboard/test/presentation.test.ts tests/e2e/dashboard-live-approval.test.ts
git diff --cached --check
git commit -m "feat(dashboard): present recoverable approval decisions from shared summaries"
```

Expected: PASS；此任务为功能证明，30样本真实延迟分布在Task 6汇总。补stage实际修改的runtime导出入口。

---

### Task 5: 产出覆盖盘点、指定版本读取与导航

**Depends on:** Step 1先于其他任务编码；Step 2之后在Task 4合入后执行，避免共享呈现文件冲突。\
**Files:** File Map的Task 5行。\
**AC:** HT-AC-02、04。

**Interfaces:**

- Consumes: manifest校验、artifact_digests、事件所属事务、Task 4事件注册/摘要。
- Produces: 固定ArtifactKind、`readArtifactView(projectRoot, query)`、BusinessPresentation可选artifact_links、受控REST读取与点击呈现。

```ts
type ArtifactKind =
  | "approval_decision"
  | "prd"
  | "design_set"
  | "plan"
  | "context_manifest"
  | "run_summary"
  | "gate_result"
  | "evidence"
  | "evaluation"
  | "snapshot"
  | "tdd_artifact"
  | "finding_group"
  | "wave_result"
  | "integration_record"
  | "task_lease";

interface ArtifactRef {
  kind: ArtifactKind;
  scope: "artifact" | "manifest";
  digest: string;
}
interface ArtifactLink {
  label_zh: string;
  ref: ArtifactRef;
  href: string;
}
interface ArtifactQuery extends ArtifactRef {
  cursor?: string;
  limit?: number;
}
interface ArtifactView {
  ref: ArtifactRef;
  provenance: {
    ledger_operation_id: string;
    manifest_digest: string;
    input_refs: ArtifactRef[];
  };
  content: unknown;
  safe_view: true;
  next_cursor?: string;
}
// readArtifactView(projectRoot, query): Promise<ArtifactView>
```

- [ ] **Step 1: 前置盘点，写出真实覆盖表**

```bash
rg -n 'phaseLifecycleEvents|commitCheckpoint|eventType:|artifact_digests' packages/runtime/src packages/core/src/ledger
rg -n '/api/v1/|event_types|addEventListener' packages/dashboard/src packages/dashboard/assets/dashboard.js
```

在`docs/evidence/artifact-reference-coverage.md`为15种kind逐项记录：实际权威文件与提交函数、
提交事件、payload导航字段或所属manifest、字节digest获取方式、已有读取路径、正文缺口、浏览器订阅、
fixture和目标测试。Finding组/Run摘要是派生视图时注明源记录及其完整绑定，不能冒称独立权威record。

先确定已有事件的manifest引用能否覆盖；只有无法定位的提交才列入ArtifactAvailable补缺清单，列明
具体提交函数和artifact类别。盘点表是前置交付，后续未通过的格子保持“未实现/未验证”，不能打勾。

- [ ] **Step 2: 为指定版本读取和安全边界写RED**

同对象提交两个版本，旧事件必须打开旧版本；修改/缺失已提交artifact要报错。测试未提交文件、
任意path、符号链接逃逸、kind伪装、secret/邮箱原文、超大正文、分页digest不变以及空结果。

```ts
const result = await readArtifactView(projectRoot, {
  kind: "plan",
  scope: "artifact",
  digest: oldArtifactDigest,
});
expect(result.ref.digest).toBe(oldArtifactDigest);
expect(result.content).toEqual(expectedOldSafeView);
expect(result.ref.digest).not.toBe(newArtifactDigest);
```

以真实Ledger fixture产生manifest/artifact；Read API不接受客户端提供路径，不能根据digest猜一个文件名。
摘要不足以代表正文；输出需要标记safe_view及原始digest来源，不能给脱敏结果冒用原始bytes hash。

- [ ] **Step 3: 实现最小解析、正文分页和导航数据**

```ts
// 服务端构造同源只读URL；digest先验证格式，kind使用固定枚举。
const href = `/api/v1/artifacts/${encodeURIComponent(ref.digest)}?kind=${encodeURIComponent(ref.kind)}&scope=${ref.scope}`;
const link: ArtifactLink = { label_zh: "查看对应版本产出", ref, href };
```

用manifest接受记录建立可重建的内存查找索引；每个kind在runtime只有一处白名单解析。复用Task 4的
Decision来源验证，旧事件正文不可解时明确回退，不能链接最新版本。派生Finding组/Wave视图必须绑定
完整已提交输入集合；有根artifact时用artifact scope，无独立根artifact时用manifest scope及其既有digest，
只读取截至该manifest.sequence的完整源记录并列出input_refs。两种digest沿用各自既有验证算法，不混用。

REST对集合按1..100分页、默认20；文本8KiB UTF-8安全分片；响应≤256KiB。字段白名单不能排除
理解结果所需的业务字段；不安全的原始日志仅返回安全摘要和不可展示原因，不能声称提供完整日志。

- [ ] **Step 4: 按前置清单补缺事件，落实实际socket护栏**

若清单非空，严格注册唯一ArtifactAvailable，payload为`artifact_kind/record_digest/summary`；
在已盘点的原子提交中加入，不新开第二条写入路径；包含它的事务pin1.4，补齐Schema生成物及测试。
若零补缺，在覆盖表记录每项已有事件/manifest解析证据。

```ts
if (Buffer.byteLength(frame, "utf8") > 32 * 1024) {
  // 不写业务frame、不推进该项交付；发送有界既有stream_error后关闭。
  throw new Error("event_frame_too_large");
}
```

把检查接在真正socket写出前；在sse错误处理映射为现有有界错误帧。先限制presentation摘要为200
Unicode字符，包含旧240字符路径。测试超大actor/既有payload、中文/emoji、多链接，验证无部分
业务帧写出、无无限自动重试。正文读取错误不改变领域事实或批准状态。

- [ ] **Step 5: 注册浏览器测试，验证实际订阅和点击**

新建Playwright `tests/e2e/dashboard-transparency.test.ts`，明确加入`playwright.dashboard.config.ts`
的testMatch，同时加入`vitest.workspace.ts` exclude。Node HTTP的sse-reconnect继续只由Vitest执行。

```ts
// 浏览器收到PlanAccepted后出现链接，而非测试直接调用presentation。
const artifactLink = page
  .getByRole("link", { name: "查看对应版本产出", exact: true })
  .first();
await expect(artifactLink).toBeVisible();
await artifactLink.click();
await expect(
  page.getByText(expectedOldPlanTitle, { exact: true }),
).toBeVisible();
```

对15种kind用fixture参数化验证链接或约定的安全视图；另测旧服务缺event_types、未知新类型、reset重放、
live→ledger更新同一行、点击伪造href拒绝。coverage表每行对应至少一个实际测试名。

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/observability/artifact-reader.test.ts packages/dashboard/test tests/security/dashboard-artifact-boundaries.test.ts
pnpm exec playwright test --config playwright.dashboard.config.ts dashboard-transparency.test.ts dashboard-live-approval.test.ts
```

- [ ] **Step 6: 提交并审核覆盖表**

```bash
git add docs/evidence/artifact-reference-coverage.md packages/runtime/src/observability packages/runtime/test/observability
git add packages/dashboard/src packages/dashboard/assets/dashboard.js packages/dashboard/test tests/security/dashboard-artifact-boundaries.test.ts tests/e2e/dashboard-transparency.test.ts playwright.dashboard.config.ts vitest.workspace.ts
git diff --cached --check
git commit -m "feat(transparency): resolve versioned artifacts and prove safe navigation"
```

若补缺事件产生core Schema、runtime提交点及导出入口修改，按前置覆盖表逐个显式stage并审核；
不能遗漏conditional文件后把“UI提交完成”当作整个Task 5完成。

---

### Task 6: Conformance、真实dogfood与可校验发布证据

**Depends on:** Task 1–5实现与目标测试全部完成。\
**Files:** File Map的Task 6行。\
**AC:** HT-AC-01～07。

**Interfaces:**

- Consumes: 每任务目标测试、设计§7.3样本、产出覆盖表、既有完整发布入口与报告提交验证方法。
- Produces: 可执行Conformance测试、30样本dogfood、固定七项HT验收JSON侧车及由其生成的中文Markdown。

- [ ] **Step 1: Conformance实际接入执行入口**

在`packages/conformance/src/event-stream.ts`定义具名case并从index导出；新建
`packages/conformance/test/event-stream.conformance.test.ts`调用现有`runConformanceSuite`。
现有runner是通用case执行器，不为所谓“注册”添加无意义分支。

覆盖：已提交可见性、不同版本Reader语义、未知类型/损坏区别、逐项cursor、过滤、reset、迟到项、
Hub交接、慢客户端隔离。runtime真实FileEventStream与旧Port回退Adapter分别证明自己的合同，
不能要求不支持v2的Adapter伪造v2字段。

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/conformance/test/event-stream.conformance.test.ts tests/e2e/sse-reconnect.test.ts
```

- [ ] **Step 2: 定义并测试HT报告的机械完成规则**

```ts
const expectedIds = [
  "HT-AC-01",
  "HT-AC-02",
  "HT-AC-03",
  "HT-AC-04",
  "HT-AC-05",
  "HT-AC-06",
  "HT-AC-07",
];
expect(report.results.map((result) => result.acceptance_id)).toEqual(
  expectedIds,
);
expect(report.implementation_commit).toBe(expectedImplementationCommit);
```

`scripts/lib/transparency-evidence.mjs`持有固定registry与验证逻辑；每项记录design锚点、任务、suite/
test名、命令、退出码、源证据路径/hash、implementation_commit。`verify-transparency-evidence.mjs`
验证缺项、失败、错误SHA、hash不符、dirty实现、人工改绿报告、重复id；失败必须非零退出。
Markdown从同一JSON生成，不接受人工填写“全部通过”。
同时修改`scripts/lib/m4-release-evidence.mjs`及`tests/reporting/m4-release-evidence.test.ts`：
既有REPORT_PATHS只新增`docs/evidence/transparency-sse-completion.json`、同名`.md`和
`docs/evidence/artifact-reference-coverage.md`三个精确路径。复用其实现I→报告R校验；新增源码混入R、
非白名单文档、错误父提交的负向测试，原M4报告检查不放宽。以上文件归Task 6所有。

`package.json`增加`verify:transparency`运行该验证器。报告生成命令为
`node scripts/verify-transparency-evidence.mjs --generate --implementation-commit`后接真实实现SHA；
生成也必须先验证源证据。Step 5通过Git读取实际值，不能用文字占位作为Evidence。

- [ ] **Step 3: 真实dogfood，分别测量稳态与追平**

`scripts/dogfood-transparency-sse.mjs`复用已有fixture生成器，在临时长历史项目启动真实serve和
Playwright浏览器；通过真实CLI/Dashboard决定路径完成至少30次决定，不mockSSE或直接注入成功帧。
测量边界为manifest已提交到浏览器呈现对应决定；记录同一主机时钟、采样起止、连接已追平条件。
补一组冷启动/首次追平与慢客户端场景，单独报告，不纳入稳态<1s断言。

```bash
node scripts/dogfood-transparency-sse.mjs --samples 30
```

输出`.reports/acceptance/transparency-dogfood.json`，含实现SHA、完整命令、各样本、p50/p95/max、
F/E布局、帧与Decision绑定。不得包含raw actor、secret或正文原始日志。

- [ ] **Step 4: 提交实现，再跑完整发布门禁**

先提交Task 6测试、脚本与package命令，使目标实现I是干净的已提交代码。完整门禁原样调用仓库
`pnpm test:release`，不要用手写子集代替；它包含standalone与M4 fault matrix。

```bash
git add packages/conformance/src/event-stream.ts packages/conformance/src/index.ts packages/conformance/test/event-stream.conformance.test.ts
git add scripts/dogfood-transparency-sse.mjs scripts/lib/transparency-evidence.mjs scripts/verify-transparency-evidence.mjs tests/reporting/transparency-evidence.test.ts package.json
git add scripts/lib/m4-release-evidence.mjs tests/reporting/m4-release-evidence.test.ts
git diff --cached --check
git commit -m "test(transparency): register conformance and verifiable release evidence"
pnpm test:release
node scripts/dogfood-transparency-sse.mjs --samples 30
```

完整发布入口会生成既有报告；保留其正常生成物，按既有“实现I→证据R”规则处理，不把报告变化当成
允许修改实现。任何业务源码变化都要重新提交实现并重新生成受影响证据。HT-AC-07必须引用完整
release命令成功记录，不能仅凭七项小测试通过。

- [ ] **Step 5: 生成、校验与提交发布证据**

实现SHA由`git rev-parse HEAD`读取后作为生成参数；验证器同时读取实际Git树和证据源，拒绝错绑。
`docs/evidence/transparency-sse-completion.json`是可校验侧车，md是其呈现；报告提交R只允许证据/
生成报告文件，implementation_commit保持I。验证器在I或紧邻的仅证据R上均能按树约束验证，不自引用R哈希。

```bash
transparency_impl_commit=$(git rev-parse HEAD)
node scripts/verify-transparency-evidence.mjs --generate --implementation-commit "$transparency_impl_commit"
pnpm verify:transparency
git diff --check
```

先按上述SHA运行生成命令，再运行验证命令；缺少源报告时验证器失败，不自动生成“passed”。
将HT侧车、完成文档、覆盖表最终结果以及release生成的既有报告按实际路径显式stage，审核仅证据差异后：

```bash
git diff --cached --check
git diff --cached --stat
git commit -m "docs(release): record verified transparency acceptance evidence"
pnpm verify:transparency
```

Expected: 七项HT均通过、hash与实现I一致、真实延迟/恢复/安全/性能及完整release全部有证据。

## Dependency Order and Review Gates

```text
Task 5 Step 1：覆盖盘点与补缺提交点冻结（前置，不新增任务）
                         ↓
Task 1：权威可见性 / 正确cursor / 缓存 / 目标性能
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
Task 2：Hub / 恢复 / 背压    Task 3：1.4 / Decision事件
              └──────────┬──────────┘
                         ↓
Task 4：订阅 / CLI摘要 / 审批卡片 / 浏览器恢复
                         ↓
Task 5 Step 2–6：正文解析 / 指定版本导航 / 护栏
                         ↓
Task 6：Conformance / dogfood / 完整release / HT证据
```

Task 2/3在独立工作区可并行；其余按共享文件与接口依赖顺序合入。每个任务合入前审核其源码、异常/
恢复测试和目标性能，不在Task 6首次测试关键保证。Task 1和Task 3共同更新core读取面，明确按1→3合入。

## Review Remediation Coverage

| 评审修订                     | Spec | 实施与验证                                        |
| ---------------------------- | ---- | ------------------------------------------------- |
| 1.4事务pin/default Reader    | §4   | Task 3 Step 1–2，HT-AC-03                         |
| manifest权威可见性           | §3   | Task 1 Step 2，HT-AC-01                           |
| 游标/迟到/reset              | §6   | Task 1 Step 1/3、Task 2 Step 4，HT-AC-06          |
| 缓存替换/尾行/复杂度         | §7   | Task 1 Step 4–5，HT-AC-05                         |
| Hub交接/过滤/背压            | §8   | Task 2全部步骤，HT-AC-06                          |
| defer/无决定/远程时间        | §5   | Task 3 Step 3–4、Task 4，HT-AC-02                 |
| 正文/旧版本/浏览器订阅       | §9   | Task 5前置盘点与Step 2–5、Task 4 Step 2，HT-AC-04 |
| 运行时帧限制/PII             | §10  | Task 4共享摘要、Task 5 Step 2/4，HT-AC-04         |
| 测试配置/机械HT证据/完整发布 | §11  | Task 5 Step 5、Task 6，HT-AC-07                   |

## Completion Rule

六个任务及其目标测试均通过，HT-AC-01～07绑定实现I和可验证源证据，完整release与真实dogfood成功，
才可宣告完成。文档修订、绿色局部单测、Agent自述、截图或未提交分支均不单独代表交付完成。
当前所有复选框保持未勾选；两份文档状态一致，后续由实际提交和证据更新。
