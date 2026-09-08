# Universal Harness 开发过程透明化与 SSE 呈现设计

日期：2026-09-05\
修订：2026-09-08，根据方案合理性与可行性评审修订\
状态：评审问题已修订；共享事件读取基础修复已落地，Protocol 1.4 与其余透明化能力待实施；本文件不表示完整验收已完成\
协议版本：Protocol 1.4（增量，development）\
核查基线：`2084617`\
范围：单机及已连接远程协作项目；保持既有治理状态、审批权限与事务原子性。

依据：

- [M1 完整纵向闭环设计](2026-08-11-universal-harness-m1-design.md)
- [M2–M3 范围决策](2026-08-15-m2-m3-scope-decisions.md)
- [M2 正式设计](2026-08-16-universal-harness-m2-design.md)
- [M3 远程协作正式设计](2026-08-29-universal-harness-m3-remote-collaboration-design.md)
- [M4 本地多 Agent 调度设计](2026-08-31-universal-harness-m4-local-multi-agent-scheduling-design.md)
- [本设计实施计划](../plans/2026-09-05-harness-transparency-sse-implementation-plan.md)

## 1. 结论与范围控制

现有 `FileEventStream`、`/events`、Live Spool、Dashboard 和 `harness watch` 已提供事件传输基础。
本次增强以三项用户结果为目标：可见状态流转、可见已提交决定、可打开对应版本的产出。
实现复用现有存储与读写入口；新增的内存索引和 Dashboard Hub 是内部模块，不是新的权威源。

原方案对既有读取正确性、产出正文读取面和兼容性作了过强假设。本修订将以下工作纳入六个任务：

1. 先修权威可见性、排序/游标和文件轮换处理，再做增量读取；
2. 完整注册 Protocol 1.4 的写入、事务 Reader pin 和读取能力；
3. 补齐本地与远程决定事件，明确 defer 与未作决定的区别；
4. 定义有界、可恢复、带过滤的共享 SSE 订阅；
5. 盘点并补齐产出正文读取、历史版本绑定、事件订阅与导航；
6. 通过机械校验和真实端到端样本证明七项验收标准。

不新增数据库、消息队列、WebSocket、workspace package 或公共插件 Port。不重构无关审批逻辑，
不显示模型隐藏推理；模型成果通过已有结构化记录及证据呈现。

## 2. 当前实现与已证实缺口

以下是 `2084617` 的事实，不是修订后能力声明。

| 事实                                                       | 代码锚点                                                         | 设计后果                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Ledger 分片先发布，manifest 最后提交                       | `packages/core/src/ledger/repository.ts` 的 `commit()`           | 文件存在不等于事务已提交                                 |
| FileEventStream 扫描全部事件文件并直接标记权威             | `packages/runtime/src/observability/event-stream.ts` 的 `read()` | 孤立分片可能被错误呈现为事实；必须按 manifest 验证可见性 |
| 排序使用 sequence，游标过滤只比较 timestamp/id             | 同文件 `compareItems()`、`followsCursor()`                       | 同时间戳分页和迟到事件可能漏读                           |
| Live Spool 通过临时文件 rename 保留窗口                    | `packages/runtime/src/observability/live-spool.ts`               | 文件变大不能一律当作追加；需要检测替换                   |
| 1.2+ 事务要求最高权威记录版本 pin，默认 Reader 为 1.3      | `packages/core/src/ledger/{transaction,event-store}.ts`          | 单加 1.4 事件会导致写入或后续读取失败                    |
| 本地决定没有对应成果事件；远程使用独立提交方法             | `packages/runtime/src/approval/service.ts`                       | 共享构建器，分别接入既有提交点                           |
| 交互式显式 defer 和 EOF/Ctrl-C 被折叠                      | `packages/runtime/src/approval/interaction.ts`                   | 保留“未作决定”的信息，避免伪造人工决定                   |
| `/api/v1/approvals` 只读 pending；图节点接口不覆盖所有正文 | `packages/dashboard/src/read-api.ts`                             | 需要最小的指定版本产出读取能力                           |
| 浏览器仅监听部分 Live 事件                                 | `packages/dashboard/assets/dashboard.js` 的 `startLive()`        | 仅加 presentation 不能使 Plan/TDD/Wave 成果可见          |

评审临时复现：相同时间戳的 12 条 Live 事件以 limit=1 分页只返回 9 条；逆字典序 id 的
同批 Ledger 事件漏掉后项；迟到的较早时间戳事件未返回；`shards.renamed` 故障后已提交事务为 0，
事件流仍返回权威事件。注册 1.4 后省略 pin 被拒绝，补 pin 后默认 1.3 Reader 被阻断。
这些结果是修复测试的输入，不作为本次交付已通过的 Evidence。

## 3. 权威与可见性

### 3.1 双通道不变

| 通道                   | 性质                                        | 可见条件                                                                           |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Ledger Lifecycle Event | 已提交事实的观测信号，`authoritative: true` | 有效 manifest 引用该 event shard，Reader 支持，分片 digest 和事件结构/绑定验证通过 |
| Live Spool Observation | 相位内观察，`authoritative: false`          | 已读到完整且合法的观察记录；允许保留窗口淘汰                                       |

ApprovalDecision、DesignSet、Evidence 等领域记录仍是领域状态依据。事件、Hub、SQLite、
缓存或网页中的卡片均不能替代它们授权、推进状态或宣告任务通过。

### 3.2 Ledger 读取规则

复用 core Ledger 的 manifest/分片校验，向 runtime 提供可复用的只读校验函数；不得另写一套
digest 或事务完整性规则。首次索引及源文件改变时验证，未改变的已验证内容可复用内存缓存。

- 未被有效已提交 manifest 引用的分片不进入权威流，包括中断留下的 orphan shard；
- manifest 及其 event shard 的完整校验成功后，整批事件才一起进入可见索引；
- 已提交清单引用的分片缺失、digest 不符、已知事件损坏或 operation 绑定不符，读取报错；
  不跳过坏数据假装追平，不提前推进 cursor；SSE 发 `stream_error` 并关闭；
- 成功恢复后由同一读取规则重建；manifest 删除、替换、既有历史撤回导致当前内存代际失效；
- 展示摘要或产出正文失败不回滚领域事务，也不影响已提交决定本身。

`unknown event type` 与损坏记录必须区分：仅当兼容包络、manifest 和 digest 已验证且 Reader
版本允许读取时，观察消费层可忽略不认识的事件类型。不能把“任何 Schema 校验失败”统称为可跳过。
Ledger 领域重放继续采用既有严格校验。
共享分片读取函数默认reject未知类型，事件观察调用可显式请求skip未知类型；两者共享manifest、digest、
基础包络和已知事件校验，skip不能吞掉其他错误。该选项不改变Ledger重放的默认行为。

## 4. Protocol 1.4 与兼容矩阵

`PROTOCOL_1_4_VERSION = "1.4.0"` 注册为 development。新成果事件使用 1.4；原领域记录
Schema、历史文件和历史 digest 不改写，Observation 类型及 `stream_version: 1` 不变。

携带 1.4 Artifact/Event 的事务必须通过现有 `transactionRequiredReaderVersion()` 归约，
写入 `required_reader_version: "1.4.0"`。本地、远程决定和条件性产出事件的提交点均适用；
不得只根据 ApprovalDecision 的 1.0/1.2 版本决定该事务的 Reader pin。

同步更新最新 Reader 默认值及显式固定为旧版本的生产入口；不要提升无关项目 Profile、领域记录
或 capability 定义版本。新代码能读旧项目，不代表旧代码能读新权威事务。

| 组合                                   | 保证                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| 1.4 Ledger Reader → 1.0–1.4 已提交记录 | 正常验证与读取                                                  |
| 旧 Ledger Reader → 要求 1.4 的事务     | `protocol_upgrade_required`，不静默降级                         |
| 旧浏览器 → 新 SSE 服务                 | 已知命名事件、heartbeat、reset/error 帧保持；未知命名事件可忽略 |
| 新客户端 → 旧项目/旧服务               | 既有呈现可用；导航扩展缺失时显示技术回退，不猜测链接            |
| 旧版 opaque cursor → 新服务            | 识别为旧代际，发 reset 后安全重建；不沿用错误分页行为           |

不承诺“所有版本 Reader 对所有新记录静默跳过”。Protocol 1.4 的登记、pin、校验、默认 Reader、
Schema 生成物与恢复测试是同一个可独立验收的 Task 3 交付。

## 5. ApprovalDecided 与审批状态

### 5.1 事件内容

事件与 Decision artifact 在各自既有 `commitCheckpoint()` 的同一事务中提交。
只有 schema-valid 且实际提交的决定产生事件；`decision_digest` 是 manifest 中该 Decision artifact
的字节 SHA-256，复用现有 artifact 序列化结果，不混用领域 semantic digest。

```json
{
  "request_id": "<请求 id>",
  "approval_id": "<决定 id>",
  "decision": "approve | reject | defer",
  "object_digest": "<请求绑定对象的领域 digest>",
  "decision_digest": "<决定 artifact 的字节 SHA-256>",
  "decided_at": "<决定记录的时间>"
}
```

为避免复制身份信息，本次事件 payload 不携带 raw actor。展示需要 actor 时，按 `decision_digest`
读取已脱敏的决定视图，显示 `actor_display`；CLI 和 Dashboard 使用同一 runtime 只读摘要函数。
“未展示身份”与“actor 不存在”必须区分。对该六字段 payload 增加明确的运行时结构与语义校验。

事件不发送 Live 预告，不需要 `observation_key`。不能先显示批准成功再等待 manifest 提交。

### 5.2 提交路径与幂等

- `resolveDecision()` 为 CLI 显式决定和 Dashboard 决定提供既有本地提交点；
- `resolveRemoteDecision()` 保留独立远程校验与幂等路径，同次提交同时包含
  `RemoteApprovalMaterialized` 和 `ApprovalDecided`，复用成果事件构建器；
- 远程重试返回已物化记录时不新增决定或事件；恢复重试不得重复提交同一 Decision；
- 唯一性为“每条已提交 Decision 恰好一条 ApprovalDecided”，不是每个 request 最多一次；
- drift、自审批、禁止的决定、提交前失败均不能生成已提交的成果事件。

### 5.3 defer 与未作决定

| 输入/动作                           | 是否提交 Decision/Event       | 请求是否仍 pending         |
| ----------------------------------- | ----------------------------- | -------------------------- |
| 显式 approve / reject               | 是                            | 否                         |
| 允许的显式 defer                    | 是                            | 是；展示“已暂缓，仍待处理” |
| EOF、Ctrl-C、断连、空输入、无法解析 | 否                            | 是；展示“等待人工决定”     |
| 远程 defer                          | 沿用 M3，不物化为本地终态证据 | 是                         |

交互解析新增带原因的内部结果；旧解析函数保留兼容包装。显式 defer 走决定提交点，未作决定
只执行现有阻塞/可恢复流程。同一请求允许 defer → defer → approve，各决定分别留痕。
卡片按 request_id 聚合、approval_id 去重，并保留暂缓后的批准/拒绝入口。

远程 `decided_at` 使用远程决定记录时间；事件 timestamp 表示本地物化提交时间，两者分别展示。
REST 中 pending 队列消失不能用来推断具体是谁、何时批准；历史决定通过指定版本读取恢复。

## 6. 读取顺序与恢复游标

### 6.1 分开显示时间和交付顺序

不再用 timestamp/id 的字典序判断“是否已交付”。初次建立内存索引时，使用完整、确定性的
总序：timestamp、source、source identity、numeric sequence、event id；后续发现的新可见记录
按批追加分配递增 position，不因其 timestamp 较早而插回已交付前缀。时间仅用于展示。

已提交事务内的事件按 numeric sequence 入列。相同时间戳的 1、2、…、12 以及逆字典序 id
必须能够逐条读全。迟到记录得到新的 position，历史时间不导致漏读。

### 6.2 v2 opaque cursor

cursor 仍是不透明字符串，SSE `id` 和 Last-Event-ID 继续透传。其内部使用版本、内存 generation
和 position；position 0 表示当前 generation 的起点。客户端不自行解码或比较。

新增内存 generation 在以下情况建立：进程/读取器重启、不可恢复的源替换、历史撤回或需要重建
索引。未知 generation、合法 v1 cursor、已淘汰且不能证明连续性的 cursor 返回 reset；格式损坏
仍为 `invalid_cursor`。恢复信息不持久化，重启后用 reset + REST 重新读取 + 历史重放恢复。

同 generation 的 position 不复用。Live 被同 `observation_key` 的 Ledger 事实取代时，旧 Live
条目退出当前展示集合，但它的位置仍可作恢复锚点，新 Ledger 版本得到新 position；不因正常
取代强制重置全流。删除/轮换导致无法保持该锚点时才 reset。

`read()` 保留现有 limit/filter/cursor/page 字段，允许以下内部向后兼容扩展：

```ts
interface EventStreamQueryExtensions {
  untilCursor?: string; // 同一 generation 的闭区间上界
}
interface EventStreamPageExtensions {
  itemCursors?: readonly string[]; // 与 items 逐项对应
  headCursor?: string; // 本次读取的最后可见 position，空流为 position 0
}
// 将字段附加到现有Query/Page；新FileEventStream成功读取时总是提供。
```

`cursor` 仍是最后返回项的 cursor；`nextCursor` 仅在该查询/上界内还有项时存在。过滤不改变全局
position；untilCursor 固定追平截止点，不追逐不断增长的历史。新旧代际混用返回 reset。
第一方读取器另提供内部 `refreshView(): Promise<EventStreamReadView>`；view带headCursor和无文件I/O的
`read(query)`，遇源generation改变返回reset。共享Hub每轮刷新一次，再让各客户端查询该view；
普通`read(query)`为refreshView后read的便捷包装。此扩展不注册为公共插件Port。
Hub 只对具备这组扩展的第一方读取器启用共享模式；注入的旧 EventStreamPort 继续走现有逐客户端
SSE 路径，不猜测缺失的游标字段。CLI watch 使用升级后的 read；subscribe 兼容入口按新语义运行。

### 6.3 可证明的交付保证

- 同一有效 generation、保留范围内，逐项恢复不会跳过未交付项；
- reconnect/reset 可以重放，UI 按 event id 幂等；Live/权威版本按 observation_key 更新同一行；
- reset 后重新读取权威视图并重放；旧 Live 窗口已淘汰则明确显示“实时历史存在缺口”，不伪造补齐；
- 不承诺网络传输 exactly-once、不承诺重启后保留原 cursor、不承诺恢复已删除的 Live 内容；
- 已提交 Ledger 记录必须可从权威源重建，刷新不能把已批准降回待批准。

## 7. 增量缓存与性能预算

### 7.1 缓存职责

内存索引包含：已验证 manifest/分片、按逻辑事实的当前条目、position 索引，以及 Live 文件读状态。
读取、合并、去重和分页逻辑集中在 FileEventStream 内；调用者不负责重复排序。

Ledger 分片不可变，按 manifest 与 digest 整文件验证后缓存；不把它当作可追加 Live 文件。
Live 状态至少包含文件身份（dev/ino 等可用信息）、size、mtime/ctime、已消费字节 offset、
未完成行 Buffer 和已解析记录身份。offset 是字节位置，跨 chunk 的 UTF-8 和未完成 JSON 行不得丢失。

| 文件变化                                             | 行为                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| 身份、size、mtime/ctime 均未变                       | 不重读内容、不重复解析；复用索引                  |
| 同身份且符合追加条件                                 | 从 offset 读增量，拼接尾部 Buffer，仅解析完整行   |
| 等长覆盖、身份改变、缩小、时间异常或追加连续性不成立 | 该文件失效并重新读取；必要时更新 generation/reset |
| rename 后文件更大                                    | 按替换处理，不能因 size 增大直接追读              |
| 枚举/打开期间删除或轮换                              | Live 重试/失效；已提交分片缺失报读取错误          |
| 完整但损坏的 Live 行                                 | 不产生条目；消费该行边界，后续合法行仍可见        |
| 未完成的尾行                                         | 暂存并等待追加，不能直接推进到不可恢复的位置      |

仅在仓库既有 append/atomic-rename 写入约定下保证追加检测；不把任意保留元数据的恶意改写视为
合法 writer。内存缓存不能代替冷启动或明确完整性检查的 digest 校验。

### 7.2 可实现的复杂度

首版保留可移植轮询：文件发现/stat 为 O(F)，F 是 manifest 与事件文件数；不声称 O(变化文件数)。
无变化时不再进行 O(E) 解析、重建全量数组或排序，E 为历史条目数。查询复用有序索引并按页返回；
新增条目处理成本随增量及索引维护增长，冷启动/重建仍须读取历史。内存允许 O(E)，并实测其上限。

fs.watch 本次不作为必做任务；未来只能作为唤醒提示，不能替代周期发现与恢复。

### 7.3 测量定义与通过阈值

固定数据生成器种子；预热 20 次、采样 200 次，单独运行 performance suite。记录 Node/OS、F/E、
fixture 布局、p50/p95、读取字节、解析次数和 RSS。布局必须同时包括：相同 F 的 1 千/10 万事件，
以及 1 千/1 万 manifest-shard 文件对的多文件历史；不能只用一个大 JSONL 证明所有场景。

| 指标                                    | 首版阈值                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| 预热后空轮询                            | 历史内容读取字节=0，历史 JSON parse/Schema 校验次数=0，不全量重排             |
| 相同 F，10 万事件空轮询 p95             | ≤ max(1 千事件 p95 × 2, 25ms)                                                 |
| 1 万文件对发现轮询 p95                  | ≤ 200ms；报告 F，不宣称文件数无关                                             |
| 同布局空轮询，4 个已追平客户端相对 1 个 | 共享源扫描次数相同，源读取工作量相同；不把 socket/presentation CPU 算作源读取 |
| 10 万事件索引 RSS 增量                  | ≤ 256 MiB，相对于同进程预热后的空索引测量                                     |
| 本地决定提交 → 浏览器决定呈现           | 已连接、已追平、非慢客户端下，30 样本 p95 < 1s、最大值 < 2s                   |

阈值是在设计中声明的预算，未经过实现验证；实施若无法达到，应报告失败并说明原因，不静默放宽。
冷启动、长历史首次追平和网络慢客户端单独报告，不混入稳态延迟，也不承诺其 <1s。

## 8. Dashboard EventStreamHub

### 8.1 内部订阅 Interface

每个 serve 实例、每个 projectRoot 一套 Hub；跨进程 serve/watch 不共享内存。底层每次轮询只刷新
一次源视图，客户端追平查询复用该轮视图，不各自再次扫描文件。

```ts
type HubDelivery =
  | { kind: "item"; item: EventStreamItem; cursor: string }
  | { kind: "reset"; reason: "cursor_evicted" }
  | { kind: "error"; code: "event_stream_unavailable" };

interface HubSubscriptionOptions {
  cursor?: string;
  iterationId?: string;
  workflowOperationId?: string;
  eventTypes?: EventStreamQuery["eventTypes"];
  signal: AbortSignal;
}

// dashboard 内部 Interface，不注册新的公共 Port。
interface EventStreamHubInterface {
  subscribeClient(options: HubSubscriptionOptions): AsyncIterable<HubDelivery>;
  close(): Promise<void>;
}
```

### 8.2 无空窗的追平交接

1. 在 Hub 的串行调度区登记客户端，先接入有界增量缓冲，再捕获共享源 headCursor 作为 H；
2. 按客户端过滤条件，从其 cursor 读取到固定 H（untilCursor=H），分页发送逐项 cursor；
3. 丢弃缓冲中已由追平覆盖的项目，按 position 发送 H 之后的增量；
4. 转入实时消费。登记、捕获 H、切换的交接由同一 Hub 执行，不允许 await 间隙绕过登记；
5. 追平过程中 generation 变化则终止该追平并发 reset，不拼接两个代际的数据。

首个客户端启动轮询；最后一个离开后停止。重连可以从同一内存 generation 继续，serve 重启走 reset。
heartbeat 由每条连接独立计时，不依赖收到数据；关闭连接、取消信号和 serve shutdown 都释放监听、
等待 drain 的回调和缓冲。单客户端断开不停止其他订阅。

### 8.3 背压与边界

每客户端待发送缓冲上限为 256 条或 1 MiB（先到者），drain 最长等待 10s。追平采用按页拉取并
受相同写出背压控制，不一次缓存整段历史。单客户端超限/超时关闭该连接，其他客户端继续；
socket 可写时可先发既有 stream_error，无法写出时直接关闭。客户端按最后接收的事件 id 重连，
不能把“入队”当成“已交付”。缓冲未容纳的内容由权威历史或保留 Live 窗口追平；不可追平则 reset。

保持 `text/event-stream`、命名事件、`id`、10s heartbeat、`stream_reset` 和 `stream_error` 帧结构。
第一方新游标属于不透明值升级，不能要求旧 cursor 字节及错误行为完全不变。

## 9. 产出引用与指定版本读取

### 9.1 覆盖盘点是实施前置

Task 5 的覆盖盘点先于其他任务编码执行，仍归 Task 5，不新增 Task 0/Task 7。产出表每行包含：
类别、权威记录/提交点、事件、事件导航字段、manifest 字节 digest、现有读取能力、正文读取缺口、
浏览器是否订阅、绑定 fixture/测试。不能把图节点摘要或一个列表页计为“正文可读”。

固定盘点范围：审批决定、PRD、DesignSet、Plan、Context Manifest、Run/输出摘要、Gate 结果、Evidence、
Evaluation、Snapshot、TDD Cycle 工件、Finding 组、调度 Wave 结果、IntegrationRecord、TaskLease。
Live 输出是有保留窗口的摘要，不承诺读取不存在的完整 transcript；候选记录不冒充已接受产出。

当前已确认需要补齐：指定 digest 的统一产出读取、历史决定读取，以及浏览器成果事件订阅；
现有 `nodes/evidence/approvals/model-invocations` 并未提供上述完整能力。

### 9.2 最小读取与导航 Interface

```ts
interface ArtifactRef {
  kind: string; // 由覆盖表落实为上述类别的固定枚举，不接受任意路径
  scope: "artifact" | "manifest";
  digest: string; // artifact为manifest接受的字节SHA-256；manifest为既有manifest.digest
}

interface ArtifactLink {
  label_zh: string;
  ref: ArtifactRef;
  href: string; // 服务端构造的同源只读 URL
}
```

Dashboard 的 BusinessPresentation 增加可选 `artifact_links`，旧客户端忽略未知字段。
扩展既有 DashboardReadApi，提供 `GET /api/v1/artifacts/:digest?kind=...&scope=...&cursor=...&limit=...`；
这是受控类型解析，不是任意文件下载。解析实现放在 runtime 的只读产出模块，供 CLI 和 Dashboard 复用。
Task 4先以`approval_decision`和artifact scope提供该入口，Task 5扩展其余类别，不另建一套历史决定接口。

响应含引用、提交来源和安全内容视图：artifact scope须manifest验证、artifact字节hash和类别匹配成功。
Finding组等没有独立根artifact的派生视图使用manifest scope：验证该manifest及截至其sequence的完整
已提交输入，响应列出输入引用，不使用当前最新图谱拼装历史视图。kind与scope组合按覆盖表白名单校验。
PRD/Design 等记录内的 semantic digest 单独保留，不与 URL digest 混淆。正文脱敏/分页后的字节不冒充
原 artifact；响应声明其为展示视图并保留原始 provenance。集合 limit=1..100、默认20；长文本按
8 KiB UTF-8 安全片段分页，禁止截断后冒充完整正文。单响应 ≤256 KiB。

不存在的已提交引用返回 404；不允许的 kind/参数返回 400；类别或 digest 不符、已提交文件损坏返回
类型化错误并停止展示。仅打开当前项目允许类别的已提交记录，路径/符号链接逃逸拒绝。旧历史缺少可解
引用时显示“该版本无可用正文引用”，不得自动改指最新版本或猜测文件路径。

### 9.3 提交事件覆盖

优先使用现有事件字段和所属 `ledger_operation_id` 的已提交 manifest 解析产出；同批 manifest 能
唯一定位的产出不必再复制一份引用。多个可能版本必须显示明确列表或补上精确引用，不能任意挑选。

仅在覆盖表证明某类新提交产出没有可定位的提交事件时，增加至多一种 `ArtifactAvailable`：
payload 为 `{ artifact_kind, record_digest, summary }`，summary ≤200 Unicode 字符；事件与产出
在同一现有事务中提交并遵守 1.4 pin。不得对旧历史补写事件。每个确需补缺的产出一条，非该范围内
的内部缓存/checkpoint 辅助文件不触发事件。零补缺结论也必须有覆盖表证据。

### 9.4 前端订阅和重建

浏览器监听所有已注册、需要呈现的 Ledger/Live 类型，包括 ApprovalDecided、PlanAccepted、
ContextCompiled、TDD、Wave、远程协作和条件性 ArtifactAvailable；服务端通过已认证的 session
读取响应提供 `event_types`，浏览器按该表注册命名监听；旧服务无此字段时使用既有静态回退表。

收到事件后按 id 幂等、按 observation_key 升级同一事实。审批卡片以指定 Decision 视图复核后更新；
导航点击真正请求指定版本正文。reset 后重新读取权威视图、清理旧代际展示并重放；旧决定重放不能覆盖
更新决定。缺失 capability、无法读取正文、Live 缺口分别有中文回退。复用已有页面、收件箱和调度视图。

## 10. 传输护栏与脱敏

序列化后的单 SSE 帧（含 id、event、data 和 presentations）硬上限 32 KiB；展示摘要 ≤200
Unicode 字符。对旧的大 payload 不能只增加一个“最大输入”单测就宣告有界。

- 在构造业务 payload 时校验新字段；在实际写 socket 前按 UTF-8 byteLength 做最终检查；
- 先压缩可派生 presentation 文案；仍超限则不发送该业务帧，发送有界 stream_error 并关闭，不把该项
  标成已交付。权威记录保留，UI 提示从 REST 查看并停止自动紧密重试同一错误；
- 同步降低已有 240 字符展示摘要上限到200，不能只约束新增类型；
- 通过已有 secret redactor 去除已解析 secret 值，但不能据此声称自动识别所有 PII；
- 事件不复制 raw actor、Token、平台响应、prompt、任意绝对路径；身份展示按固定规则生成不含邮箱/
  外部 subject 原文的稳定 actor_display，取项目id与actor规范编码后SHA-256前12位并加“审批者”前缀；
  其规则由共享runtime摘要模块持有，不作为认证标识或授权依据；
- 已知类型正文展示使用字段白名单与脱敏，无法提供安全正文时返回不可展示原因及安全元数据，不返回
  原始 bytes。CLI 与 Dashboard 的同引用输出必须遵守相同规则；
- 沿用 loopback、bootstrap/session、Origin 和既有写接口 CSRF 防护；导航 URL 只由服务端白名单生成。

超限/损坏均可观测为错误，不截断领域记录或改写历史。连接、Hub 轮询和 heartbeat 不新增 Ledger
事件；新增观测逻辑的失败不能生成伪造的成功决定。

## 11. 测试与验收映射

| ID       | 必须证明的结果                                                                                           | 责任任务     |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------ |
| HT-AC-01 | 每条已提交本地/远程 Decision 恰好一条绑定正确的成果事件；孤立/未提交事件不可见；远程重试不重复           | Task 1、3    |
| HT-AC-02 | approve/reject 为终态、defer 仍 pending、EOF/Ctrl-C 无伪造决定；CLI/Dashboard 身份与时间一致，刷新能恢复 | Task 3、4、5 |
| HT-AC-03 | 1.4 registry/pin/default Reader 完整；新读旧兼容、旧权威 Reader 明确升级阻断、未知类型与损坏分类正确     | Task 1、3    |
| HT-AC-04 | 固定类别覆盖表、实际事件订阅、指定版本导航、安全正文读取及32 KiB运行时护栏均有测试                       | Task 4、5    |
| HT-AC-05 | §7.3 全部性能预算通过；冷启动、发现成本、内存、源读取与扇出输出分开报告                                  | Task 1、2、6 |
| HT-AC-06 | 相同时间戳/逆序id/迟到项读全；交接无空窗；过滤与背压隔离；reset/重连可恢复且UI幂等，Live缺口明确         | Task 1、2、4 |
| HT-AC-07 | 仓库完整发布入口通过；旧客户端/旧项目兼容；HT验收机器报告绑定实现提交与不可变证据                        | Task 6       |

Task 1/2 即运行正确性、故障和性能目标测试；Task 3/4/5 各有对应集成与浏览器测试。
Task 6 聚合现有测试并做真实 dogfood，不把关键正确性第一次验证推迟到发布阶段。

测试区分 Vitest（read/Hub/真实HTTP恢复）与 Playwright（浏览器订阅、卡片、导航、reset）。
新增浏览器文件必须同时加入 Playwright testMatch 并从 Vitest 排除；Conformance 必须有实际测试入口。

发布调用仓库现有 `pnpm test:release`，包含 verify、standalone、M4 fault matrix、performance、
Dashboard、pack smoke 与既有报告；额外生成并校验独立 HT-AC 机器侧车。HT 侧车记录七项固定断言、
目标实现 SHA、命令、退出码、测试名、数据集和源证据 hash；Markdown 从侧车生成。缺项/失败/过期
或 dirty 实现不得通过；采用“实现提交 I → 仅证据提交 R”的绑定规则，避免报告哈希自引用。
现有M4报告提交校验只接受固定文件白名单；Task 6将HT侧车、HT Markdown和覆盖表三个精确路径加入
既有报告路径白名单，并保持“R紧邻I且不含实现改动”的校验。不得放开整个docs目录或豁免原M4证据检查。

## 12. 实施边界与复核结果

仍为六个任务。Task 5 盘点先行；Task 1 修复读取与缓存，之后 Task 2 Hub 和 Task 3 1.4/决定事件
可以并行；Task 4 呈现依赖两者，Task 5 导航完成后 Task 6 聚合验收。共享文件的呈现改动顺序合入。
不通过改变文件数、关闭异常测试或降低全量门禁来达成性能/兼容结论。

| 评审问题                     | 本次修订位置        |
| ---------------------------- | ------------------- |
| 1.4 事务/Reader升级缺口      | §4、HT-AC-03        |
| 未提交分片错误可见           | §3、HT-AC-01        |
| 游标排序与恢复丢失           | §6、HT-AC-06        |
| 缓存轮换/尾行与复杂度        | §7、HT-AC-05        |
| Hub交接/过滤/reset/背压      | §8、HT-AC-06        |
| defer终态、交互和远程路径    | §5、HT-AC-02        |
| 正文读取、历史绑定、订阅缺口 | §9、HT-AC-04        |
| 帧大小/脱敏与验收入口        | §10–11、HT-AC-04/07 |

完成定义：七项 HT-AC 均由当前目标实现的可校验证据证明，并通过完整发布入口。
本次仅修订文档；所有实现任务、性能数字的实测结果与完成复选框保持未完成。
