# Universal Harness M3：远程协作正式设计

日期：2026-08-29  
状态：设计复核通过，已进入实施计划<br>
协议版本：Protocol 1.2  
范围：单仓库、单 Coordinator、远程协作；不包含 Multi-Agent 调度

依据：

- [M1 完整纵向闭环设计](2026-08-11-universal-harness-m1-design.md)
- [M2–M3 范围决策](2026-08-15-m2-m3-scope-decisions.md)
- [M2 正式设计](2026-08-16-universal-harness-m2-design.md)
- [Slim Profiles 与 Capability Kernel](2026-08-18-harness-slim-profiles-design.md)
- [Protocol 1.1 统一实施计划](../plans/2026-08-18-protocol-1.1-unified-implementation-plan.md)

## 1. 结论

M3 在现有单机 Git-native Harness 上增加一个可选的远程协作模式：
`remote_collaboration`。

启用后，多个 Harness Replica 可以围绕同一个远程 Git 仓库并行推进不同
Operation，通过一个单实例 `CollaborationCoordinator` 完成平台身份认证、仓库权限
校验、Operation Lease、远程人工批准、轮询同步和最终 Integration。

M3 不移动现有权威边界：

- Requirement、DesignSet、Plan、Evidence、ApprovalDecision、Snapshot 和目标 commit
  仍以 Git 项目内容与 Ledger 为权威；
- Coordinator 只决定远程主体是否具备当前写入资格，不决定候选内容是否满足
  Requirement、Policy、Gate 或 Evidence；
- SQLite 只是 Coordinator 的本地投影，不是权威源；
- Operation Branch 是候选工作，不是已接受的项目事实；
- 只有通过重新验证并以 compare-and-swap 更新目标分支的 Integration 才算接受。

## 2. 目标

M3 必须使团队能够：

1. 从现有 Git Remote 自动识别 GitHub、GitLab 或 Gitee，不要求项目手工绑定身份平台；
2. 使用平台 OAuth/OIDC 登录，并以当前仓库权限决定是否允许远程批准和集成；
3. 在同一仓库中并行推进多个相互隔离的 Operation；
4. 在网络分区、Coordinator 中断、Lease 过期、目标分支漂移和重复请求下 fail-closed；
5. 从 CLI 或 Dashboard 查看远程 Approval、连接状态和 Integration Conflict；
6. 保留完整、可重放、可验证的身份、批准、Lease 与集成证据；
7. 保持未启用 M3 的 M1、M2、Protocol 1.1 项目行为不变。

## 3. 非目标

M3 不实现：

- 跨仓库 Operation 或跨仓库原子提交；
- 多 Coordinator、高可用、自动选主或自动接管；
- Webhook；远程状态只通过 Git 轮询发现；
- 多人投票、固定批准次数或 quorum；
- Multi-Agent Lease、能力匹配、抢占或并行 Task 调度；
- 模型自动解决文本或语义合并冲突；
- 用 GitHub/GitLab/Gitee PR 规则替代 Harness Approval；
- 新的 Artifact Graph Node、Edge 或关系传播规则；
- Coordinator 自建账户、角色数据库或长期凭据仓库；
- Coordinator 自建共识协议、分布式数据库或消息队列。

M1 已有的 repository-qualified identity 继续保留，但 M3 验收不宣称跨仓库能力。

本设计取代 2026-08-15 范围决策中“在 M3 启用跨仓库执行”的表述。跨仓库能力没有被
隐式移动到 M4，也没有获得新的里程碑归属；需要时必须另行设计和批准。

本设计同时取代 M1 §18 中把 M3 描述为 repository-qualified 跨仓库执行的表述，并在
Protocol 1.2 Port Registry 中仅新增 `CollaborationCoordinatorPort`。不增加跨仓库 Port、
消息总线或新的分布式协调层。

## 4. 已确认的产品决策

| 决策 | 选择 |
|---|---|
| 部署模型 | 薄 Coordinator + Git-native Ledger |
| Coordinator 发现 | connect 显式提供 canonical HTTPS origin；不引入服务发现 |
| 离线语义 | 可离线准备；权威写入 fail-closed |
| 身份来源 | 自动发现 GitHub/GitLab/Gitee Remote，使用平台 OAuth/OIDC 与仓库权限 |
| 项目平台绑定 | 无人工绑定；每次会话从已批准 Git Remote 解析 |
| 批准语义 | 一个具备权限的非请求提出者作出终态 Decision |
| 默认批准权限 | `maintain/admin`；经批准 Policy 可按对象范围下调 |
| 数据通道 | Git 传输权威内容；Coordinator 处理控制命令 |
| 远程发现 | Git polling，不使用 Webhook |
| 并行模型 | 每个 Operation 独立 Branch，最终 Integration 串行 CAS |
| Coordinator 状态 | 协调事实写 Git Control Ref；本地 SQLite 保存非权威投影 |
| Coordinator 数量 | 单实例，无自动接管 |
| 协议 | Protocol 1.2 增量兼容 |
| Profile | `remote_collaboration` 与 Lite/Standard/Governed 正交 |

## 5. 架构

```text
┌─────────────────────┐
│ Harness Replica A   │
│ CLI / Dashboard     │
│ Local Kernel        │
│ Operation Branch A  │
└──────────┬──────────┘
           │ authenticated command/query
           ▼
┌────────────────────────────────────────────┐
│ CollaborationCoordinator                   │
│                                            │
│ OAuth principal + repository permission    │
│ Operation Lease + fencing token            │
│ Remote Approval                            │
│ Git polling + SQLite projection            │
│ Integration preflight + target CAS         │
└──────────┬──────────────────────┬──────────┘
           │                      │
           ▼                      ▼
┌─────────────────────┐  ┌─────────────────────┐
│ Git Remote          │  │ GitHub/GitLab/Gitee │
│ Target Branch       │  │ OAuth / permission  │
│ Operation Branches  │  │ provider authority  │
│ Control Ref         │  └─────────────────────┘
└─────────────────────┘
           ▲
           │ authenticated command/query
┌──────────┴──────────┐
│ Harness Replica B   │
│ CLI / Dashboard     │
│ Local Kernel        │
│ Operation Branch B  │
└─────────────────────┘
```

### 5.1 权威边界

| 数据 | 权威源 | 说明 |
|---|---|---|
| Requirement、DesignSet、Plan、Evidence、ApprovalDecision、Snapshot | 项目 Git/Ledger | 继续遵守现有生命周期与 digest 规则 |
| Target commit | 目标分支 | CAS 成功是 Integration 被接受的最终事实 |
| Operation 工作 | Operation Branch | 仅为候选；必须重新验证后才能进入 Target |
| CollaborationConnectionRecord | 项目 Git/Ledger | 记录已验证 Remote 的启用或停用；与 CapabilityPlan 正交 |
| Principal、Lease、Remote Approval 协调记录 | Git Control Ref | 由单 Coordinator 以 fast-forward CAS 更新 |
| IntegrationRecord | 候选 merge commit；CAS 后进入项目 Ledger | 只有 Target 可达历史中的记录才是已接受事实 |
| OAuth Token | 不持久化 | 只在受控认证会话中短暂使用 |
| polling cursor、heartbeat、连接和通知投递 | SQLite | 可删除、可重建、不得反向覆盖 Git |

### 5.2 Fail-closed 原则

以下任何条件不确定时不得执行远程权威写入：

- 无法验证 Git Remote 或平台身份；
- 平台权限快照缺失或过期；
- Coordinator、Git Remote 或 Control Ref 不可用；
- Lease 无效、过期或 fencing token 落后；
- baseline、object digest、policy digest 或 required Evidence 漂移；
- 目标分支不能以预期旧 OID 做 CAS；
- Control Ref Schema、sequence 或 digest 不合法。

失败不得降级为未治理的直接 push、自由文本 actor 或本地默认批准。

## 6. 深模块与 Interface

M3 的外部 seam 是一个深模块：`CollaborationCoordinatorPort`。CLI、Dashboard 和
Local Kernel 不直接理解 OAuth 差异、平台角色、Git CAS、fencing 或 SQLite 重建。

```ts
interface CollaborationCoordinatorPort {
  execute(
    command: CollaborationCommand,
    session: CollaborationSession,
  ): Promise<CollaborationOutcome>;

  query(
    query: CollaborationQuery,
    session: CollaborationSession,
  ): Promise<CollaborationView>;
}
```

`CollaborationCommand` 至少覆盖：

- `connect`；
- `disconnect`；
- `acquire_operation_lease`、`renew_operation_lease`、`release_operation_lease`；
- `publish_operation_candidate`；
- `submit_remote_approval`；
- `prepare_integration`、`accept_integration`；
- `sync_now`。

`CollaborationQuery` 至少覆盖：

- `connection_status`；
- `operations`；
- `approval_inbox`；
- `integration_conflicts`。

命令和结果使用带版本号的判别式联合类型。错误必须是类型化结果，不用异常文本承担
协议语义。

### 6.1 内部 Adapter seam

Coordinator 内部只保留已有真实变化的 seam：

1. `PlatformIdentityPort`
   - GitHub Adapter；
   - GitLab Adapter；
   - Gitee Adapter；
   - 测试用 In-memory Adapter。
2. `GitControlStorePort`
   - 生产 Git Adapter；
   - 测试用 In-memory Adapter。
3. `CoordinatorProjectionPort`
   - SQLite Adapter；
   - 测试用 In-memory Adapter。

平台 Adapter 只能输出统一 Principal 和权限，不得把平台专有角色字符串扩散到 Kernel。

现有 `EventStreamPort` 继续作为已接受 Lifecycle Event 的读取与观测 Interface，不承担 Lease、
Approval 或 Integration 命令。Control Ref 中的 Lease、远程 Approval 和候选 Integration 状态
通过 `CollaborationCoordinatorPort.query` 与 Dashboard Read Model 呈现；只有连接记录进入
项目 Ledger、Remote Decision 被 Local Kernel 物化，或 Integration 被 Target CAS 接受后，
才生成项目 Lifecycle Event 并由 `EventStreamPort` 投影。这细化并取代早期范围决策中把 M3
笼统描述为“在 EventStreamPort 框架内同步”的表述。

## 7. Profile 与远程协作模式

`remote_collaboration` 是与 Profile 正交的可选产品能力，但不是 Protocol 1.1 的
`CapabilityId`，也不进入 CapabilityPlan：

```text
Lite      + remote_collaboration?
Standard  + remote_collaboration?
Governed  + remote_collaboration?
```

Profile 继续决定 Capture、Impact、Design、TDD、Evaluation 等治理深度；M3 只改变协作和
同步拓扑。

Profile、ProfileDefinition 和 CapabilityPlan 的 Schema、digest 与 Operation DAG 均保持不变。
远程协作只由项目 Ledger 中最新有效的 `CollaborationConnectionRecord` 激活：

```ts
interface CollaborationConnectionRecord {
  protocol_version: "1.2.0";
  record_kind: "collaboration_connection";
  connection_id: string;
  project_id: string;
  revision: number;
  status: "active" | "disconnected";
  provider: "github" | "gitlab" | "gitee";
  repository_id: string;
  canonical_remote: string;
  canonical_remote_digest: string;
  coordinator_origin: string;
  target_ref: string;
  control_ref: string;
  policy_digest: string;
  actor_principal_id: string;
  principal_snapshot_digest: string;
  command_id: string;
  effective_at: string;
  supersedes_digest?: string;
  record_digest: string;
}
```

启用规则：

- 只有显式 `harness connect --coordinator <https-url>` 且 Remote、权限与 Control Ref 安全检查
  全部通过后，才追加 `active` revision；
- `harness disconnect` 追加 `disconnected` revision，不改写历史；
- 相同输入的重复命令返回现有 revision，不生成重复事实；
- 未启用时不创建 Control Ref、不调用 Coordinator、不查询平台权限，也不生成远程占位记录；
- Governed 可以通过现有 Policy 要求更高平台权限，但不新增 Profile 分支或 CapabilityPlan 输入。

## 8. Git Remote 自动发现

`harness connect` 从当前已批准仓库配置读取不含 credential/userinfo 的 canonical Remote 与
当前目标分支，并从必填参数读取 canonical Coordinator HTTPS origin：

1. 规范化并验证 Coordinator origin；非 HTTPS 或带 userinfo/query/fragment 时拒绝；
2. 规范化 SSH/HTTPS Remote；
3. 识别 host；
4. 由 Adapter Registry 选择 GitHub、GitLab 或 Gitee Adapter；
5. 解析当前单仓库 identity；
6. 进行 OAuth/OIDC；
7. 查询主体对当前仓库的权限；
8. 在内存中生成 `PrincipalSnapshot` 候选；
9. 按 §17.3 完成 Control Ref 安全检查；
10. 以 Control Ref CAS 持久化 PrincipalSnapshot；
11. 向项目 Ledger 追加 `active` CollaborationConnectionRecord。

不支持的 host、歧义 Remote、Remote 漂移或权限不足均阻止连接。项目不保存人工选择的
平台绑定；每次会话都从当前批准 Remote 解析，解析结果及其 digest 进入本次命令 provenance。

## 9. 身份与权限

### 9.1 统一权限

三平台角色规范化为：

```text
read < write < maintain < admin
```

Adapter 必须显式维护平台角色到统一权限的映射，并通过 Conformance Kit。未知角色或 API
返回不完整时 fail-closed。

默认只有 `maintain` 或 `admin` 可以作出远程终态 Approval 或执行 Integration。Project
Policy 可以对明确的对象范围下调到 `write`；该 Policy 变更本身必须由 `maintain/admin`
批准并绑定 policy digest。

### 9.2 PrincipalSnapshot

Protocol 1.2 新增 `PrincipalSnapshot`：

```ts
interface PrincipalSnapshot {
  protocol_version: "1.2.0";
  record_kind: "principal_snapshot";
  control_sequence: number;
  previous_control_record_digest?: string;
  snapshot_id: string;
  principal_id: string;
  provider: "github" | "gitlab" | "gitee";
  host: string;
  subject_id: string;
  repository_id: string;
  permission: "read" | "write" | "maintain" | "admin";
  observed_at: string;
  expires_at: string;
  source_response_digest: string;
  record_digest: string;
}
```

规则：

- `principal_id` 由 provider、canonical host 和平台稳定 subject id 确定性派生；
- display name、email 或用户名不能作为稳定身份；M3 不要求持久化这些字段；
- OAuth Token 和平台原始响应不得进入记录；只保留脱敏事实和响应摘要；
- 权限快照默认最多使用 5 分钟；创建远程命令或 Decision 时必须仍在有效期内；
- 合法写入的 RemoteApprovalDecision 是“决定发生时具备权限”的不可变证据；snapshot 后续到期
  不会单独使该 Decision 失效，也不要求人类重复批准；
- Remote、Policy、主体或权限在 Decision 写入前变化会阻止写入；写入后的有效性由既有
  ApprovalRequest 领域绑定与 Policy freshness 决定。

### 9.3 自批禁止

Protocol 1.2 在既有 ApprovalRequest 上增加两个可选的一等字段：

```ts
requester_principal_id?: string;
requester_principal_snapshot_digest?: string;
```

已连接项目中新建或因绑定漂移而重发的远程 ApprovalRequest 必须同时包含二者。请求提出者与
批准者通过稳定 `principal_id` 比较，相同主体不能批准自己的请求。旧 Request 和未连接项目
继续使用既有本地 `proposed_by` 语义；缺少上述 Principal 绑定的旧 Request 不得远程批准，必须
在当前连接与 PrincipalSnapshot 下重发，不能在物化时补写不可变 Request。

## 10. Git Control Ref

每个已连接项目使用一个受保护的 Control Ref。实现应选择目标 Git 平台能可靠保护和轮询的
branch/ref 形态；其逻辑 identity 固定为该项目的唯一 Control Ref。

Control Ref 只保存三类 Protocol 1.2 记录：

1. `PrincipalSnapshot`；
2. `LeaseRecord`；
3. `RemoteApprovalDecision`。

`IntegrationRecord` 属于项目 Ledger，并随候选 merge commit 进入 Target；它不在 Control Ref
中维护第二份状态。

每次更新必须：

- 基于已读取的 Control Ref OID；
- 生成 canonical JSON；
- 校验 Schema、sequence、previous digest 和 record digest；
- 使用 fast-forward CAS；
- CAS 失败后重新读取并重新判定，不盲目重试旧命令；
- 由 `command_id` 与领域 identity 保证幂等。

Control Ref 复用现有 EventStore 的 append-only envelope、sequence、previous digest 与 manifest
校验规则。Protocol 1.2 只新增五类必要的权威记录：项目 Ledger 中的
`CollaborationConnectionRecord` 和 `IntegrationRecord`，以及 Control Ref 中的上述三类记录；
不为派生状态另设记录。Record 是事件引用的不可变事实；状态变化必须追加新 Record，不能覆盖
旧 Record。

Control Ref 不保存 heartbeat、连接、通知投递或每轮 polling cursor。

Lease 只在 grant、实际延长到期时间和 release/expiry 状态变化时追加记录；heartbeat 与 polling
不得产生记录。M3 不引入压缩协议，实施门禁至少证明 10,000 条 Control Ref 记录仍可完整校验和
重建 SQLite，再根据 dogfood 数据决定后续是否需要 checkpoint。

### 10.1 Coordinator 启动

Coordinator 为单实例。启动时必须：

1. 读取并验证 Control Ref；
2. 重建 SQLite 投影；
3. 使上一次进程未明确释放的 Lease 失效；
4. 为后续新 Lease 分配更高 fencing token；
5. Control Ref 不可读取或不可安全更新时保持只读阻塞状态。

M3 不设计自动接管。Coordinator 停止期间，所有权威远程写入暂停。

## 11. Operation Branch 与 Lease

每个远程 Operation 使用独立 Branch：

```text
target branch
  ├─ operation/<operation-a>
  └─ operation/<operation-b>
```

不同 Operation 可以并行。Operation Branch 只是候选传输和恢复点；即使被推送到 Git Remote，
也不能直接改变目标分支或满足 completed Snapshot。

Replica 可以离线生成本地 candidate commit，但只有持有有效 Operation Lease 时才能通过
`publish_operation_candidate` 请求 Coordinator 以 expected Operation Ref OID 做 CAS。Coordinator
必须同时验证 operation id、fencing token 与 candidate commit；CAS 漂移返回
`operation_ref_drift`。用户或旧 Replica 的直接 push 仍只是不可信候选输入，不形成受管 Lease
进展，也不能绕过最终 Integration 重验证。

### 11.1 LeaseRecord

```ts
interface LeaseRecord {
  protocol_version: "1.2.0";
  record_kind: "lease";
  control_sequence: number;
  previous_control_record_digest?: string;
  lease_record_id: string;
  lease_id: string;
  previous_lease_record_digest?: string;
  resource_kind: "operation" | "integration";
  resource_id: string;
  holder_principal_snapshot_digest: string;
  client_instance_id: string;
  fencing_token: number;
  issued_at: string;
  expires_at: string;
  state: "granted" | "renewed" | "released" | "expired" | "revoked";
  command_id: string;
  record_digest: string;
}
```

规则：

- fencing token 对同一 resource 严格递增；
- grant、renew、release、expire 和 revoke 各自追加新的 `lease_record_id`，并通过
  `previous_lease_record_digest` 形成单链；
- 每个状态变化都通过 Control Ref CAS 落地，不能改写旧 LeaseRecord；
- SQLite 可以缓存 Lease 视图，但不能延长 Git 中的 `expires_at`；
- Coordinator 重启后旧 Lease 不恢复为有效；
- 失联 Replica 可以继续本地准备，但不能使用过期 token 推进受管 Operation 或 Integration；
- 旧 token 的延迟请求始终返回 `lease_fenced`。

M3 只定义 Operation 与最终 Integration 两类 Lease，不定义文件级、Task 级或 Agent 级 Lease。

## 12. Git 轮询与 SQLite

Coordinator 轮询：

- Target Branch head；
- Control Ref head；
- 活动 Operation Branch heads。

轮询只是变化提示。每次发现 ref 变化后仍必须 fetch 并验证 commit、Schema、sequence 和 digest。
不信任缓存的 ref 名或客户端报告。

SQLite 保存：

- 最近观察到的 ref OID；
- polling cursor 与下一次轮询时间；
- 当前连接和 OAuth session 的非秘密元数据；
- Approval Inbox 投影；
- Lease 与 Integration 状态投影；
- 通知投递状态。

SQLite 数据可以删除并从 Git 重建。OAuth access token 只允许存在于受控进程内存，不得进入
SQLite。SQLite Schema 迁移失败必须阻止 Coordinator 启动写模式，不得创建第二套真相。

## 13. 远程 Approval

M3 保持 M1 的单人终态 Decision 语义，不引入 quorum。

```text
ApprovalRequest 出现在活动 Operation
→ Coordinator polling 投影到 Approval Inbox
→ 用户 OAuth 登录
→ 查询并冻结 PrincipalSnapshot
→ 校验权限、Request 的请求者 Principal、自批禁止、object/policy/baseline digest
→ Control Ref CAS 写 RemoteApprovalDecision
→ Local Kernel 同步并验证
→ 物化既有 ApprovalDecision
→ Operation 恢复
```

### 13.1 RemoteApprovalDecision

```ts
interface RemoteApprovalDecision {
  protocol_version: "1.2.0";
  record_kind: "remote_approval_decision";
  control_sequence: number;
  previous_control_record_digest?: string;
  remote_decision_id: string;
  request_id: string;
  operation_id: string;
  object_id: string;
  object_digest: string;
  policy_digest: string;
  decision: "approve" | "reject" | "defer";
  principal_snapshot_digest: string;
  required_permission: "write" | "maintain" | "admin";
  decided_at: string;
  command_id: string;
  record_digest: string;
}
```

第一个通过 CAS 写入的合法非 `defer` Decision 成为终态；后续竞争请求返回现有结果。`defer`
不终结请求。

Local Kernel 只有在重新验证以下绑定后才物化现有 `ApprovalDecision`：

- request、object、operation；
- object、policy 和 baseline digest；
- Decision 创建时使用的 PrincipalSnapshot 在 `decided_at` 有效；
- 该 snapshot 中的 permission 满足 required permission；
- ApprovalRequest 含一等 requester Principal 绑定，且批准者不是请求提出者。

物化后的既有 ApprovalDecision 通过 Protocol 1.2 extension 绑定 RemoteDecision digest。原
snapshot 在 Decision 写入后到期不属于漂移；object、policy、baseline、requester identity 或其他
既有 Approval binding 漂移时才使 Decision stale。

领域绑定或请求者身份漂移时，Remote Decision 保留为历史事实但状态变为 stale，必须生成绑定
新 digest 的 ApprovalRequest。

## 14. Integration

完成的 Operation 不能直接 push 目标分支。Integration 分为 prepare 与 accept：

### 14.1 Prepare

1. 获取短期 Integration Lease；
2. 冻结 `expected_target_commit` 与 `operation_commit`；
3. 执行三方合并；
4. 文本冲突时返回 `integration_conflict`，不得由模型自动裁决；
5. 无文本冲突时执行 §14.2 的 Ledger sequence 重排；
6. 只生成候选 merge commit；
7. 在候选 commit 上重新运行：
   - Graph reconcile；
   - Impact；
   - Evidence freshness；
   - Mandatory Gate；
   - 受 baseline 影响的 Approval 失效检查。

### 14.2 Ledger sequence 重排

项目 Ledger 的 `LedgerOperation.sequence` 保持全局线性语义；Protocol 1.2 不改变现有 Reader、
EventStream 或 append-only 规则。两个 Operation Branch 从同一 Target 创建时允许带有重复的候选
sequence，但重复 sequence 不能直接进入 Target。

prepare 必须在候选 merge tree 中完成确定性重排：

1. 识别 Operation Branch 新增且 Target 中不存在的 LedgerOperation；相同
   `ledger_operation_id` 但 digest 不同仍按冲突拒绝；
2. 按原 sequence、再按 `ledger_operation_id` 排序；
3. 从 Target 当前最大 LedgerOperation sequence 加一开始连续编号；
4. 只重写候选 tree 中这些 manifest 的 sequence 与 manifest digest；Operation Branch 历史不变；
5. Artifact、Edge、Event shard 内容未变化时保留原字节和 shard digest。LifecycleEvent sequence
   仍按 `workflow_operation_id` 排序，不随 LedgerOperation sequence 重排；
6. 在最终候选 LedgerOperation 中写入 IntegrationRecord，并再次执行完整 Ledger replay 与
   append-only 校验。

重排不是对已接受 Ledger 的改写：原候选 manifest 仍可从 Operation Branch 历史审计，Target
只接受重排后的 manifest。任何无法确定性解释的 operation id、digest、shard 或 sequence 关系
返回 `ledger_resequence_failed`，不得降级为普通 Git 合并。

### 14.3 IntegrationRecord

候选 merge commit 必须在 `.harness/artifacts/integrations/<integration_id>.json` 包含一份
canonical `IntegrationRecord`：

```ts
interface IntegrationRecord {
  protocol_version: "1.2.0";
  record_kind: "integration";
  integration_id: string;
  operation_id: string;
  expected_target_commit: string;
  operation_commit: string;
  lease_fencing_token: number;
  ledger_sequence_rewrites: readonly {
    ledger_operation_id: string;
    old_sequence: number;
    old_manifest_digest: string;
    new_sequence: number;
    new_manifest_digest: string;
  }[];
  evidence_digests: readonly string[];
  approval_decision_digests: readonly string[];
  command_id: string;
  record_digest: string;
}
```

该记录描述“准备接受的候选及其证明”，不自行宣称 accepted。只有包含该记录的 candidate
commit 被 Target Ref CAS 接受后，记录才成为 Target 历史中的已接受事实。冲突、stale 和
Gate failure 继续使用既有 Finding 与 Lifecycle Event，不为失败候选创建第二套 Integration
状态真相。

`IntegrationRecord` 不保存 `candidate_commit`：记录自身位于该 commit 的 tree 中，嵌入自身 OID
会形成递归哈希。candidate identity 由外层命令结果返回，并由以下规则确定性验证：candidate
必须是双亲 merge commit，第一 parent 等于 `expected_target_commit`，第二 parent 等于
`operation_commit`；其 tree 必须等于确定性三方合并、上述 Ledger 重排以及固定路径
IntegrationRecord 共同产生的 tree。

### 14.4 Accept

Coordinator 在 accept 前再次验证：

- Integration Lease 与 fencing token 仍有效；
- Target head 仍等于 `expected_target_commit`；
- candidate commit 的双亲、tree 与 IntegrationRecord 满足 §14.3 的确定性规则；
- required Evidence、Gate 和 Approval 都 fresh 且通过；
- IntegrationRecord Schema 与 digest 有效。

全部通过后才以 expected target OID 做 Target CAS。CAS 成功是最终接受事实。

如果 CAS 已成功但响应丢失，重试必须从 Target 历史中匹配 `integration_id`、`command_id` 和
IntegrationRecord digest，幂等恢复 `accepted`，不得生成第二个合并提交。Control Ref 不重复
记录 Integration 接受状态。

## 15. 冲突与失效

### 15.1 Target 漂移

- 无文本冲突：重新生成候选 commit，并重新执行第 14.1 节全部检查；
- 有文本冲突：`integration_conflict`，人工在 Operation Branch 解决后重新 prepare；
- 任何重验证失败：`blocked` 或 `stale`，不得 Target CAS。

### 15.2 权限漂移

PrincipalSnapshot 过期或平台权限下降后：

- 新 Approval 与 Integration 阻塞；
- 已合法写入但尚未物化的 Remote Decision 仍按 §13.1 校验其决定时权限和领域绑定；snapshot
  后续到期不单独使它失效；
- 已物化 Decision 是否继续有效由既有 Approval binding 与 Policy freshness 规则决定；
- 权限恢复后必须生成新的 PrincipalSnapshot，不复用旧 snapshot。

### 15.3 Remote 漂移

canonical Remote host 或 repository identity 改变会停用当前远程会话。用户必须重新执行
`harness connect`；旧 Control Ref 不自动迁移或合并。

## 16. 错误与恢复

M3 至少提供以下类型化错误：

| 错误 | 行为 |
|---|---|
| `coordinator_unavailable` | 远程写阻塞；本地准备可继续 |
| `git_remote_unavailable` | 不更新 Control、Operation 或 Target Ref |
| `unsupported_remote` | connect 阻塞，不猜测 Provider |
| `invalid_coordinator_origin` | connect 阻塞，改用无 userinfo/query/fragment 的 HTTPS origin |
| `authentication_required` | 要求重新 OAuth |
| `permission_denied` | 不创建 Decision 或 Integration |
| `permission_snapshot_stale` | 重新查询平台权限 |
| `approval_binding_mismatch` | 不物化 Decision；按当前绑定重发 Request |
| `approval_self_approval` | 拒绝 Decision，改由其他有权限主体处理 |
| `lease_unavailable` | 等待、defer 或缩小 Operation；不抢写 |
| `lease_expired` | 本地结果保持候选，重新申请 Lease |
| `lease_fenced` | 永久拒绝旧 token 请求 |
| `operation_ref_drift` | 重新读取 Operation Branch，保留本地 candidate 并重新发布 |
| `control_ref_invalid` | Coordinator 进入只读阻塞，人工修复 |
| `control_ref_unprotected` | connect 阻塞，修复平台 Ref 保护后重试 |
| `remote_identity_drift` | 停用远程会话，重新执行 connect |
| `baseline_drift` | 重新 prepare 和重验证 |
| `integration_conflict` | 人工解决文本冲突 |
| `ledger_resequence_failed` | 保留候选分支，修复 Ledger 冲突或损坏后重新 prepare |
| `integration_gate_failed` | 修复后重新运行 Gate |
| `target_cas_failed` | 重新读取 Target，不重放旧 accept |
| `projection_rebuild_required` | 从 Git 重建 SQLite |
| `protocol_upgrade_required` | 使用支持项目权威记录版本的 Reader 重试 |

Coordinator、终端和 Dashboard 必须使用同一错误码及恢复建议。

## 17. 安全

### 17.1 传输与会话

- 远程 Coordinator 只允许 HTTPS；
- CLI 与 Dashboard 使用同一 OAuth Session 和授权模块；
- Dashboard mutation 继续要求 Origin/CSRF 防护；
- session cookie 必须为 Secure、HttpOnly、SameSite；
- OAuth state、PKCE 和回调 URI 必须严格校验；
- access token 不写 Git、SQLite、日志、Event、Evidence 或错误文本。

### 17.2 Git 凭据

Coordinator 对 Git 的 fetch/push 凭据通过现有受信 host secret 注入机制获得。项目配置只能
引用 credential identity，不能保存 secret value。凭据必须最小化到当前仓库和所需 ref。

### 17.3 Ref 保护

- connect 必须通过平台 Adapter 读取并验证 Control Ref 保护规则：只有 Coordinator credential
  identity 可以更新，普通 Replica 不能直接写入、force push 或删除；
- Adapter 无法证明平台规则可强制执行时返回 `control_ref_unprotected` 并拒绝连接；不得以本地
  约定或文档声明代替平台保护；
- Coordinator 每次读取都验证 Control Ref fast-forward ancestry、Schema、sequence 与 digest；
  非预期回退或非法记录使 Coordinator 进入 `control_ref_invalid` 只读状态；
- Target Ref 的最终 Integration 必须使用 CAS；
- 直接的人类 Target push 仍可能发生，但会造成 baseline drift 并使正在 prepare 的
  Integration 失效；
- Operation Branch 永远按候选输入验证，不能因为来自受信 Remote 就跳过 Schema、digest、
  Gate 或 Approval。

### 17.4 数据最小化

M3 不要求持久化用户 email、头像、display name 或平台 Token。审计只保存稳定 subject id、
规范化权限、时间、来源摘要和关联 digest。

## 18. CLI 与 Dashboard

### 18.1 CLI

M3 在现有命令面上增加或扩展：

- `harness connect --coordinator <https-url>`：发现 Remote、OAuth、验证权限并启用远程协作模式；
- `harness disconnect`：阻止新 Lease，释放或等待现有 Lease 过期，并追加 disconnected 连接记录；
- `harness sync`：立即轮询和重建远程投影；
- `harness status`：增加连接、Operation、Approval 和 Integration 摘要；
- 既有 `approve/reject/defer`：在远程会话中通过 Coordinator 执行；
- 既有 `iterate/resume`：在已连接项目中使用 Operation Branch 与 Lease；
- Integration 命令：prepare 与 accept 必须保持两个显式步骤，不提供绕过重验证的一键 push。

具体命令拼写和参数属于实施计划，但不得改变上述语义。

### 18.2 Dashboard

Dashboard 只增加三个必要入口：

1. Connection Status；
2. Approval Inbox；
3. Integration Conflict。

它们与 CLI 共用 `CollaborationCoordinatorPort`，不得复制 OAuth、权限、Approval 或恢复逻辑。
Dashboard 展示远程状态时必须区分 Git 权威事实与 SQLite 投影时间。

## 19. Protocol 1.2 兼容与迁移

### 19.1 Reader

- Protocol 1.2 Reader 必须读取 1.0/1.1；
- 旧字符串 actor 投影为 `legacy_local`；
- `legacy_local` 可以满足本地历史审计，但不能满足新的远程 Approval；
- 承载任一 Protocol 1.2 权威 Artifact/Event 的 LedgerOperation 必须写
  `required_reader_version: "1.2.0"`；普通 1.0/1.1 transaction 不写该字段；
- 1.0/1.1 Reader 遇到会影响权威投影的 1.2 记录时必须 fail-closed，返回类型化
  `protocol_upgrade_required`，不得静默跳过；
- 已发布且不认识该字段的旧严格 Schema 至少会拒绝该 manifest，不会把 1.2 Artifact 静默投影为
  1.1 完成事实；
- Control Ref 不属于未连接项目的本地读取路径，旧 Reader 不需要解析其记录；
- 1.2 Writer 不改写历史记录，只追加新事实。

### 19.2 启用与停用

连接是显式、可审计的协作模式变更。停用 M3：

- 先阻止新 Lease；
- 释放或使活动 Lease 过期；
- 向项目 Ledger 追加 `disconnected` CollaborationConnectionRecord；
- 保留 Control Ref 历史；
- 删除 SQLite 不影响审计；
- 已存在的 Operation Branch 保留为普通候选分支，不能自动集成。

### 19.3 零物化

未启用 M3 的项目：

- 不创建 Control Ref；
- 不读取平台身份；
- 不生成 CollaborationConnection、Principal、Lease、Remote Approval 或 Integration Record；
- 不新增 Dashboard 远程状态请求；
- 不改变本地 Approval 与 Iterate 行为。

## 20. 可观测性

M3 复用现有 Dashboard Read API，但明确区分两条观测通道：

- `CollaborationCoordinatorPort.query` 投影连接、Lease、Remote Approval 与候选 Integration
  状态；这些是 Control Ref 或 SQLite 投影，不伪装成项目 Lifecycle Event；
- `EventStreamPort` 只投影项目 Ledger 中已接受的 `RemoteConnected`、
  `RemoteDisconnected`、`RemoteApprovalMaterialized` 与 `IntegrationAccepted`。

`LeaseGranted/Released/Expired`、`IntegrationPrepared/Blocked` 只作为协作 Read Model 状态变化，
不进入项目 Ledger Event。两条通道都不得包含 OAuth Token、平台原始响应或未脱敏 PII；heartbeat
与每次 polling 不生成记录或 Event，避免观测噪声。

## 21. 测试策略

### 21.1 纯逻辑

覆盖：

- Remote 规范化和 Provider 选择；
- 三平台权限映射；
- canonical JSON、digest 和 deterministic identity；
- Lease 状态、fencing 比较和 command idempotency；
- Approval binding、自批禁止和权限 freshness；
- Ledger sequence 确定性重排及重排映射；
- Integration 状态与新旧 Reader 的 fail-closed 兼容行为。

### 21.2 Interface Conformance

同一套 Kit 验证：

- GitHub、GitLab、Gitee `PlatformIdentityPort` Adapter；
- Git 与 In-memory `GitControlStorePort` Adapter；
- SQLite 与 In-memory `CoordinatorProjectionPort` Adapter。

测试只通过模块 Interface 断言可观察结果，不依赖 Adapter 内部字段。三个平台的 Kit 都必须证明
Control Ref 保护可被查询并强制执行；不具备该能力的 Adapter 只能返回
`control_ref_unprotected`，不能通过生产 Conformance。

### 21.3 双 Clone 集成测试

使用本地 bare Git remote、两个 clone、假平台身份 Adapter 和可控时钟证明：

- 不同 Operation 并行；
- 两个分支从同一 Ledger sequence 起点推进、Git 无文本冲突时，后集成分支被确定性重排且
  Target Ledger 可完整 replay；
- 同一 Operation Lease 互斥；
- 旧 fencing token 被拒绝；
- 网络断开只允许离线准备；
- Remote Approval 正确物化与失效；
- Remote Approval 后离线超过 snapshot 有效期，只要决定时权限与领域绑定有效，就无需重复人工批准；
- Target 漂移触发重验证；
- 文本冲突、Gate 失败和权限撤销阻止 CAS；
- SQLite 删除后可重建；
- CAS 成功但响应丢失时幂等恢复；
- disconnect 后不再发放 Lease，历史 Control Ref 与候选 Operation Branch 保留。

### 21.4 真实平台 E2E

M3 正式完成前，GitHub、GitLab、Gitee 各保存一次脱敏 dogfood 证据，至少覆盖：

```text
OAuth → 权限查询 → Operation Lease → Remote Approval
→ clean Integration / Ledger sequence 重排 → Target CAS → Snapshot/Control Ref 审计
```

真实 Token、用户名、email 和 Remote credential 不进入仓库证据。

### 21.5 回归

现有 M1、M2、Protocol 1.1 的 test、security、fault、performance、E2E、Dashboard 和 pack
smoke 必须全部通过。未启用 M3 的三档 Profile dogfood 必须证明零远程调用。

## 22. M3 验收标准

| ID | 必须证明的结果 |
|---|---|
| M3-AC-01 | 从批准 Git Remote 自动识别 GitHub/GitLab/Gitee，无人工平台绑定 |
| M3-AC-02 | OAuth 主体形成稳定 Principal，Token 不进入任何持久化或日志 |
| M3-AC-03 | 两个 Replica 可并行推进不同 Operation，互不覆盖 |
| M3-AC-04 | 同一 Operation 的旧 fencing token 在 Lease 过期后不能受管写入 |
| M3-AC-05 | 断网允许本地准备，但不能更新 Control、Operation 受管状态或 Target |
| M3-AC-06 | 有权限非提出者可批准；越权、自批、主体漂移和错误 digest 被拒绝；决定时有效的 snapshot 后续到期不单独使 Decision 失效 |
| M3-AC-07 | clean merge 后确定性解决 Ledger sequence 分叉，并重新执行 Graph、Impact、Freshness、Gate 与 Approval 校验 |
| M3-AC-08 | 文本冲突、Gate 失败、权限撤销或 Target 漂移阻止错误 CAS |
| M3-AC-09 | Target CAS 成功但响应丢失时，重试不产生第二个 Integration |
| M3-AC-10 | SQLite 可从 Git 重建，旧 Lease 不复活 |
| M3-AC-11 | Protocol 1.2 向后读取 1.0/1.1；旧 Reader 对权威 1.2 记录类型化拒绝；未启用 M3 时零远程副作用 |
| M3-AC-12 | CLI 与 Dashboard 对连接、Approval 和 Conflict 呈现一致 |
| M3-AC-13 | 三平台 Adapter 通过身份、权限与 Control Ref 保护 Conformance，且各有一次脱敏真实 dogfood |
| M3-AC-14 | M1、M2、Protocol 1.1 全量发布门禁无回归 |

## 23. 完成定义

M3 只有在以下条件全部满足时才可声明完成：

1. Protocol 1.2 Schema、canonical、digest、Reader 和 migration 已冻结；
2. `CollaborationCoordinatorPort` 与三个内部 Adapter seam 通过 Conformance；
3. CollaborationConnectionRecord、单 Coordinator、Git Control Ref 和 SQLite 重建闭环通过；
4. 双 Clone 并行、Ledger sequence 重排、Lease、远程 Approval、Integration 和故障恢复通过；
5. GitHub、GitLab、Gitee 真实 dogfood 证据齐全；
6. M3-AC-01 至 M3-AC-14 均绑定当前 commit 的测试与 Evidence；
7. 未启用 M3 的本地流程及三档 Profile 无行为回归；
8. 文档不把 Operation Branch、SQLite 投影或 Agent 自述误报为权威完成证据。

## 24. 后续计划边界

实施计划应把 M3 拆成少量可独立验收的纵向切片，而不是按文件或平台横向堆任务：

1. Protocol 1.2、CollaborationConnectionRecord 与 Coordinator Interface；
2. Git Control Ref、Lease 与 SQLite 重建；
3. OAuth 身份、权限映射与远程 Approval；
4. Operation Branch、Ledger sequence 重排、Integration 与冲突恢复；
5. CLI/Dashboard、三平台 Conformance、真实 dogfood 与发布证据。

任务数量、提交边界和实施顺序由后续 `writing-plans` 阶段确定。本设计不授权开始编码。
