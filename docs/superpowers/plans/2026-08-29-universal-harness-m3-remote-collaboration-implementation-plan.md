# Universal Harness M3 Remote Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有 Profile/CapabilityPlan 和本地纵向闭环的前提下，为单仓库增加可审计、可恢复、可远程批准并通过 CAS 集成的协作闭环。

**Architecture:** `CollaborationCoordinatorPort` 是 CLI、Dashboard 与 Local Kernel 的唯一远程协作 Interface；实现内部仅保留 `PlatformIdentityPort`、`GitControlStorePort` 与 `CoordinatorProjectionPort` 三个 Adapter seam。项目 Git/Ledger 保存连接与最终 Integration，受保护 Control Ref 保存 Principal、Lease 与 Remote Approval，SQLite 只保存可重建投影；Operation Branch 始终是不可信候选。

**Tech Stack:** TypeScript 6、Node.js 22（`node:https`、`node:sqlite`）、TypeBox/Ajv、Vitest、Playwright、pnpm workspace、Git CLI、Git-native Ledger/Graph。

**Spec:** `docs/superpowers/specs/2026-08-29-universal-harness-m3-remote-collaboration-design.md`

**Status:** 设计已复核，计划待批准实施。

## Global Constraints

- Node.js 必须满足仓库现有 `>=22.13.0`，不得增加数据库、消息队列、服务发现或新的 workspace package。
- Protocol 1.2 Reader 必须向后读取 1.0/1.1；旧 Reader 遇到权威 1.2 记录必须返回 `protocol_upgrade_required`，不得静默跳过。
- `remote_collaboration` 不是 `CapabilityId`；不得修改五项 `CAPABILITY_IDS`、三档 ProfileDefinition 或 CapabilityPlan DAG/digest。
- Control Ref 固定使用受保护分支 `harness/control`；Operation Branch 使用 `operation/<operation-id>`；Target Ref 从 connect 时的当前批准分支冻结。
- Coordinator origin 必须是无 userinfo、query、fragment 的 canonical HTTPS origin；Dashboard 仍保持 loopback-only。
- OAuth access token 只能存在于受控进程内存；不得写入项目、Control Ref、SQLite、日志、Event、Evidence 或错误文本。
- Git Remote 必须去除 credential/userinfo 后才可进入 CollaborationConnectionRecord；项目不保存人工选择的平台绑定。
- GitHub、GitLab、Gitee 权限未知、响应缺字段或 Control Ref 保护不可证明时必须 fail-closed。
- LedgerOperation 继续使用全局线性 sequence；只允许在候选 merge tree 中重排未接受 manifest，不修改 Operation Branch 或已接受 Target 历史。
- Approval、Gate、Evidence、Graph、Impact 与 Snapshot 继续使用现有权威链；Coordinator 不得自行判定候选满足需求。
- 每个任务遵循 Red → Green → Refactor，提交前运行该任务列出的目标测试；不得提交现有未跟踪的 `teach/`。

## File Map

- `packages/core/src/schema/collaboration.ts`：Protocol 1.2 五类领域记录及 Control Ref envelope Schema。
- `packages/core/src/collaboration/records.ts`：确定性 identity、seal、语义不变量和 Reader 版本判定。
- `packages/runtime/src/collaboration/port.ts`：唯一外部 Interface 与三个内部 Adapter seam。
- `packages/runtime/src/collaboration/coordinator.ts`：命令路由、幂等、连接状态与 fail-closed 编排。
- `packages/runtime/src/collaboration/lease.ts`：Lease/fencing 纯状态机。
- `packages/runtime/src/collaboration/approval.ts`：Remote Decision 校验与本地 ApprovalDecision 物化。
- `packages/runtime/src/collaboration/ledger-resequence.ts`：候选 LedgerOperation 确定性重排。
- `packages/runtime/src/collaboration/integration.ts`：prepare/accept、重验证与 CAS 恢复。
- `packages/runtime/src/collaboration/platform-adapters.ts`：GitHub/GitLab/Gitee OAuth、权限与 Ref 保护映射。
- `packages/runtime/src/collaboration/sqlite-projection.ts`：可删除、可重建的 Coordinator SQLite 投影。
- `adapters/vcs-git/src/control-store.ts`：Control Ref、Operation Branch、候选 merge 与 Target CAS 的 Git Adapter。
- `packages/runtime/src/collaboration/http-client.ts`、`http-server.ts`：HTTPS transport Adapter；不承载领域规则。
- `packages/cli/src/commands/{connect,disconnect,sync,integrate,coordinator}.ts`：薄 CLI 路由。
- `packages/dashboard/src/collaboration-api.ts` 与现有 assets：Connection、Approval Inbox、Integration Conflict 展示。
- `packages/conformance/src/collaboration.ts`：三个内部 Adapter seam 的共享 Conformance cases。
- `tests/e2e/m3-remote-collaboration.test.ts`：双 Clone 完整闭环。

---

### Task 1: Freeze Protocol 1.2 Records and Compatibility

**Files:**
- Create: `packages/core/src/schema/collaboration.ts`
- Create: `packages/core/src/collaboration/records.ts`
- Create: `packages/core/src/collaboration/index.ts`
- Create: `packages/core/test/collaboration/records.test.ts`
- Create: `packages/core/test/protocol/protocol-1.2.test.ts`
- Modify: `packages/core/src/protocol.ts`
- Modify: `packages/core/src/schema/envelope.ts`
- Modify: `packages/core/src/schema/runtime.ts`
- Modify: `packages/core/src/schema/event.ts`
- Modify: `packages/core/src/schema/operation.ts`
- Modify: `packages/core/src/schema/registry.ts`
- Modify: `packages/core/src/ledger/transaction.ts`
- Modify: `packages/core/src/ledger/event-store.ts`
- Modify: `packages/core/src/schema/index.ts`
- Modify: `packages/core/src/index.ts`
- Generate: `packages/core/schemas/{collaboration-connection,principal-snapshot,lease,remote-approval-decision,integration}.schema.json`
- Generate: `packages/core/schemas/runtime.schema.json`
- Generate: `packages/core/schemas/event.schema.json`
- Generate: `packages/core/schemas/{ledger-operation,operation}.schema.json`

**Interfaces:**
- Consumes: `createDomainSchemaRegistry()`, `recordDigestOf()`, `sealRecordEnvelope()`, `contentDigest()`.
- Produces: `PROTOCOL_1_2_VERSION`, `PROTOCOL_1_2_SCHEMA_REGISTRY`, five record types, `CONTROL_RECORD_KINDS`, `assertProtocolReaderCanProject()`.

- [ ] **Step 1: Write failing Protocol 1.2 registry and envelope tests**

```ts
expect(assertKnownProtocol("1.2.0")).toMatchObject({ status: "development" });
expect(PROTOCOL_1_2_SCHEMA_REGISTRY.keys).toEqual([
  "collaboration-connection",
  "principal-snapshot",
  "lease",
  "remote-approval-decision",
  "integration",
]);
expect(recordEnvelopeSchemaFor("1.2.0", "principal_snapshot", {}).properties.protocol_version)
  .toEqual({ const: "1.2.0", type: "string" });
```

Also assert that a 1.1 registry rejects a 1.2 record and that `assertProtocolReaderCanProject({ readerVersion: "1.1.0", recordVersion: "1.2.0", authoritative: true })` throws `protocol_upgrade_required`.

Add a manifest test proving an M3 transaction without `required_reader_version: "1.2.0"` is rejected, while every existing 1.0/1.1 fixture remains valid without the field.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/core/test/protocol/protocol-1.2.test.ts \
  packages/core/test/collaboration/records.test.ts
```

Expected: FAIL because Protocol 1.2 and collaboration schemas do not exist.

- [ ] **Step 2: Generalize the record envelope without changing Protocol 1.1 output**

Add this compatible constructor and keep `recordEnvelopeSchema()` as the 1.1 wrapper:

```ts
export function recordEnvelopeSchemaFor<
  const V extends string,
  T extends TProperties,
>(protocolVersion: V, recordKind: string, properties: T) {
  return strictObject({
    protocol_version: Type.Literal(protocolVersion),
    record_kind: Type.Literal(recordKind),
    ...properties,
    record_digest: DigestSchema,
  });
}

export function recordEnvelopeSchema<T extends TProperties>(recordKind: string, properties: T) {
  return recordEnvelopeSchemaFor(PROTOCOL_1_1_VERSION, recordKind, properties);
}
```

Run existing envelope and domain-registry tests. Expected: all existing 1.1 JSON Schema snapshots and digests remain unchanged.

- [ ] **Step 3: Define the five strict Protocol 1.2 schemas**

Use `recordEnvelopeSchemaFor(PROTOCOL_1_2_VERSION, ...)`. The three Control Ref records share these fields directly, not through a sixth domain record:

```ts
const ControlRecordFields = {
  control_sequence: Type.Integer({ minimum: 1 }),
  previous_control_record_digest: Type.Optional(DigestSchema),
};
```

The first record requires no previous digest; every later record requires the exact prior `record_digest` via `assertControlChain()`. `LeaseRecord` additionally keeps `previous_lease_record_digest` for its per-resource chain. Use strict enums for provider, permission, status, lease state and decision; use the exact fields frozen in the spec.

- [ ] **Step 4: Add requester Principal fields and accepted M3 Lifecycle Events**

Extend `ApprovalRequestRecordSchema` with:

```ts
requester_principal_id: Type.Optional(IdentifierSchema),
requester_principal_snapshot_digest: Type.Optional(DigestSchema),
```

Add a schema invariant that both fields are present or absent together. Runtime semantic validation in Task 5 will require them for remote approval. Add only these authoritative Event types:

```ts
"RemoteConnected",
"RemoteDisconnected",
"RemoteApprovalMaterialized",
"IntegrationAccepted",
```

Do not add Lease or candidate Integration event types.

- [ ] **Step 5: Implement deterministic record builders and reader errors**

Export builders that always seal the envelope and never accept caller-filled digests:

```ts
export function buildCollaborationRecord<T extends CollaborationRecordDraft>(
  draft: T,
): T & { readonly record_digest: string } {
  return sealRecordEnvelope({ ...draft, protocol_version: PROTOCOL_1_2_VERSION });
}

export class ProtocolProjectionError extends Error {
  readonly kind = "protocol_upgrade_required" as const;
}
```

`assertProtocolReaderCanProject()` must permit 1.2 readers to project 1.0/1.1, permit equal versions, and reject an older reader only when the newer record is authoritative.

Extend LedgerOperation with optional `required_reader_version`. `LedgerRepository.commit()` receives the field only for a transaction containing a 1.2 Artifact/Event; validation requires exactly `"1.2.0"` for those transactions. `parseManifest()` must inspect the raw field before domain replay and throw `ProtocolProjectionError` when the active reader version is too old, instead of silently ignoring the artifact.

- [ ] **Step 6: Register and generate JSON Schemas**

Create `PROTOCOL_1_2_SCHEMA_REGISTRY`, merge its documents into `SCHEMA_EXPORT_DOCUMENTS`, then run:

```bash
pnpm --filter @universal-harness-internal/core schema:generate
pnpm exec prettier --check packages/core/src packages/core/test packages/core/schemas
pnpm --filter @universal-harness-internal/core typecheck
pnpm exec vitest run --config vitest.workspace.ts packages/core/test
```

Expected: all core tests pass; generated schemas contain `$id` namespace `/1.2/`; existing 1.1 schemas do not drift except the intentional `runtime.schema.json`, `event.schema.json` and LedgerOperation reader-version additions.

- [ ] **Step 7: Commit the protocol slice**

```bash
git add packages/core/src packages/core/test packages/core/schemas
git diff --cached --check
git commit -m "feat(core): define protocol 1.2 collaboration records"
```

### Task 2: Build the Coordinator Interface and Connection Vertical Slice

**Files:**
- Create: `packages/runtime/src/collaboration/port.ts`
- Create: `packages/runtime/src/collaboration/errors.ts`
- Create: `packages/runtime/src/collaboration/connection.ts`
- Create: `packages/runtime/src/collaboration/coordinator.ts`
- Create: `packages/runtime/src/collaboration/index.ts`
- Create: `packages/runtime/test/collaboration/coordinator.test.ts`
- Create: `packages/runtime/test/collaboration/connection.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: Protocol 1.2 records from Task 1.
- Produces: `CollaborationCoordinatorPort`, command/query unions, `PlatformIdentityPort`, `GitControlStorePort`, `CoordinatorProjectionPort`, `createCollaborationCoordinator()`.

- [ ] **Step 1: Write failing public-Interface tests**

Use only the external port in tests:

```ts
const outcome = await coordinator.execute({
  kind: "connect",
  command_id: "command_connect_1",
  project_id: "project_demo",
  canonical_remote: "https://github.com/acme/demo.git",
  target_ref: "refs/heads/main",
  coordinator_origin: "https://harness.example.com",
  policy_digest: digest("1"),
}, session("principal_alice"));

expect(outcome).toMatchObject({ status: "connected", connection: { revision: 1 } });
expect(await coordinator.query({ kind: "connection_status", project_id: "project_demo" }, session("principal_alice")))
  .toMatchObject({ kind: "connection_status", status: "active" });
```

Cover invalid HTTP origin, origin with query/userinfo, unsupported Remote, idempotent repeated `command_id`, disconnect revision, and a regression proving no CapabilityPlan/Profile file is read or written.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/collaboration/{coordinator,connection}.test.ts
```

Expected: FAIL because the collaboration module is absent.

- [ ] **Step 2: Freeze the single external Interface and discriminated unions**

Define the external Interface exactly once:

```ts
export interface CollaborationCoordinatorPort {
  execute(command: CollaborationCommand, session: CollaborationSession): Promise<CollaborationOutcome>;
  query(query: CollaborationQuery, session: CollaborationSession): Promise<CollaborationView>;
}

export type CollaborationCommand =
  | ConnectCommand | DisconnectCommand
  | AcquireLeaseCommand | RenewLeaseCommand | ReleaseLeaseCommand
  | PublishOperationCandidateCommand
  | SubmitRemoteApprovalCommand
  | PrepareIntegrationCommand | AcceptIntegrationCommand
  | SyncNowCommand;

export type CollaborationQuery =
  | ConnectionStatusQuery | OperationsQuery | ApprovalInboxQuery | IntegrationConflictsQuery;
```

All outcomes are typed values. Domain failures use `CollaborationFailure` with only the error codes frozen in spec §16; transport code must not parse exception messages.

- [ ] **Step 3: Define only the three internal Adapter seams**

```ts
export interface PlatformIdentityPort {
  discover(remote: string): Promise<RemoteIdentityResult>;
  authenticate(input: OAuthRequest): Promise<PrincipalSnapshotDraftResult>;
  inspectControlRefProtection(input: ControlRefProtectionRequest): Promise<ProtectionResult>;
}

export interface GitControlStorePort {
  readControl(input: ReadControlInput): Promise<ControlSnapshotResult>;
  appendControl(input: AppendControlInput): Promise<ControlAppendResult>;
  appendProjectRecord(input: AppendProjectRecordInput): Promise<ProjectRecordCommitResult>;
  listOperationHeads(input: ListOperationHeadsInput): Promise<OperationHeadsResult>;
  compareAndSwapOperation(input: OperationCasInput): Promise<OperationCasResult>;
  prepareCandidate(input: PrepareGitCandidateInput): Promise<PreparedGitCandidateResult>;
  compareAndSwapTarget(input: TargetCasInput): Promise<TargetCasResult>;
}

export interface CoordinatorProjectionPort {
  rebuild(input: ProjectionRebuildInput): Promise<void>;
  apply(record: CollaborationProjectionRecord): Promise<void>;
  query(query: CollaborationQuery): Promise<CollaborationView>;
}
```

Do not create provider-specific public Interfaces or a separate connection store seam.

- [ ] **Step 4: Implement canonical connect/disconnect state transitions**

`connect` must normalize the Coordinator origin, ask `PlatformIdentityPort` to discover/authenticate/check protection, append the PrincipalSnapshot to Control Ref, then append the active CollaborationConnectionRecord to Target. `disconnect` must refuse while a live Lease exists, otherwise append a disconnected revision. Build records only through Task 1 builders.

Use deterministic identity and idempotency:

```ts
const connectionId = `connection_${contentDigest({ project_id, repository_id }).slice(0, 24)}`;
if (latest?.command_id === command.command_id) return existingOutcome(latest);
if (latest?.status === "active" && semanticConnectionEqual(latest, command)) return existingOutcome(latest);
```

- [ ] **Step 5: Implement fail-closed command dispatch and projection updates**

The coordinator must execute a command in this order: validate command → load authoritative Git state → authorize → append via CAS → update SQLite projection. If projection update fails after Git succeeds, return the authoritative outcome with `projection_rebuild_required`; never retry the Git append blindly.

- [ ] **Step 6: Run the connection slice and public export checks**

```bash
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/collaboration/{coordinator,connection}.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
pnpm build
```

Expected: tests and workspace exports pass; zero changes under Capability/Profile modules.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/collaboration packages/runtime/test/collaboration packages/runtime/src/index.ts
git diff --cached --check
git commit -m "feat(runtime): add remote collaboration coordinator interface"
```

### Task 3: Persist Control Ref, Lease State and SQLite Projection

**Files:**
- Create: `adapters/vcs-git/src/control-store.ts`
- Create: `adapters/vcs-git/test/control-store.test.ts`
- Create: `packages/runtime/src/collaboration/lease.ts`
- Create: `packages/runtime/src/collaboration/sqlite-projection.ts`
- Create: `packages/runtime/test/collaboration/lease.test.ts`
- Create: `packages/runtime/test/collaboration/sqlite-projection.test.ts`
- Modify: `adapters/vcs-git/src/index.ts`
- Modify: `packages/runtime/src/collaboration/coordinator.ts`
- Modify: `packages/runtime/src/collaboration/index.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: `GitControlStorePort`, `CoordinatorProjectionPort`, Protocol 1.2 Control records.
- Produces: `createGitControlStoreAdapter()`, `SqliteCoordinatorProjection`, `transitionLease()` and Coordinator lease commands.

- [ ] **Step 1: Write failing Git Control Ref and Lease tests**

Create a bare remote plus two clones. Prove one append succeeds and the stale expected OID loses:

```ts
const first = await store.appendControl({
  remote: remoteUrl,
  control_ref: "refs/heads/harness/control",
  expected_oid: null,
  record: principalSnapshot({ control_sequence: 1 }),
});
expect(first).toMatchObject({ ok: true });

const stale = await store.appendControl({
  remote: remoteUrl,
  control_ref: "refs/heads/harness/control",
  expected_oid: null,
  record: leaseRecord({ control_sequence: 2 }),
});
expect(stale).toMatchObject({ ok: false, error: { code: "control_ref_cas_failed" } });
```

Lease tests must cover grant, renew, release, expiry, monotonic fencing, repeated command id and permanent rejection of an old token. Add a publish test proving only the current fencing token can CAS `refs/heads/operation/<operation-id>` and a stale expected OID returns `operation_ref_drift` without losing the local candidate.

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  adapters/vcs-git/test/control-store.test.ts \
  packages/runtime/test/collaboration/lease.test.ts
```

Expected: FAIL because both modules are absent.

- [ ] **Step 2: Implement append-only Control Ref Git storage**

Use `execFile` through the existing `GitRunner`; never invoke a shell. Each append creates one commit whose tree adds a canonical file:

```text
records/000000000001-principal_snapshot-<record-id>.json
records/000000000002-lease-<record-id>.json
```

Validate before push:

```ts
assertControlChain(records); // contiguous sequence and exact previous digest
if (expectedOid !== null) {
  await requireAncestor(expectedOid, candidateOid); // Control Ref updates are fast-forward only
}
await run("updateControlRef", mirrorRoot, [
  "push", remote, `${candidateOid}:${controlRef}`,
  `--force-with-lease=${controlRef}:${expectedOid ?? ""}`,
]);
```

Map a rejected lease to typed `control_ref_cas_failed`; the coordinator must re-read and re-decide, not reuse the old candidate commit.

- [ ] **Step 3: Implement the pure Lease/fencing state machine**

```ts
export function transitionLease(
  current: LeaseRecord | undefined,
  command: AcquireLeaseCommand | RenewLeaseCommand | ReleaseLeaseCommand,
  now: string,
): LeaseTransition {
  if (current !== undefined && current.command_id === command.command_id)
    return { kind: "existing", record: current };
  if (command.kind === "renew_operation_lease" && command.fencing_token !== current?.fencing_token)
    return { kind: "rejected", code: "lease_fenced" };
  // Return a draft; only appendControl makes it authoritative.
  return nextLeaseDraft(current, command, now);
}
```

The next fencing token is `max(resource history) + 1`; Coordinator restart never revives a Lease whose `expires_at <= now`.

- [ ] **Step 4: Write failing SQLite rebuild and corruption tests**

```ts
const projection = new SqliteCoordinatorProjection(":memory:");
await projection.rebuild({ connection, control_records: records, operation_heads: [] });
expect(await projection.query({ kind: "connection_status", project_id: connection.project_id }))
  .toMatchObject({ status: "active", control_sequence: records.length });
```

Also create an on-disk DB with a newer schema version and expect `projection_rebuild_required`; deleting the DB and rebuilding from Git must produce the same projection digest.

- [ ] **Step 5: Implement the disposable SQLite projection**

Use `DatabaseSync` from `node:sqlite`. Keep a small embedded DDL with `meta`, `connection`, `control_records`, `leases`, `approvals`, `operation_heads` and `integration_conflicts`. Store no OAuth token or raw provider response. Apply records inside one SQL transaction and update `last_control_sequence` only after all rows succeed.

- [ ] **Step 6: Wire lease commands through the Coordinator**

For acquire/renew/release: read Control Ref → project current Lease → run `transitionLease()` → append with expected OID → update projection. A CAS loss loops once through a fresh read and semantic re-decision; a second loss returns `lease_unavailable`.

Wire `publish_operation_candidate` through the same Lease projection: validate resource ID and fencing token, verify the candidate commit exists and descends from the Operation baseline, then call `compareAndSwapOperation()` with the expected Operation Ref OID. Do not treat a direct/manual branch push as managed progress.

- [ ] **Step 7: Prove 10,000-record rebuild and run targeted checks**

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  adapters/vcs-git/test/control-store.test.ts \
  packages/runtime/test/collaboration/{lease,sqlite-projection}.test.ts
pnpm --filter @universal-harness-internal/adapter-vcs-git typecheck
pnpm --filter @universal-harness-internal/runtime typecheck
```

Expected: 10,000 canonical records validate and rebuild without truncation; tests do not assert an arbitrary wall-clock threshold.

- [ ] **Step 8: Commit**

```bash
git add adapters/vcs-git/src adapters/vcs-git/test packages/runtime/src/collaboration packages/runtime/test/collaboration
git diff --cached --check
git commit -m "feat(collaboration): persist leases through git control ref"
```

### Task 4: Add GitHub, GitLab and Gitee Identity/Protection Adapters

**Files:**
- Create: `packages/runtime/src/collaboration/remote-discovery.ts`
- Create: `packages/runtime/src/collaboration/platform-adapters.ts`
- Create: `packages/runtime/src/collaboration/oauth-session.ts`
- Create: `packages/runtime/test/collaboration/remote-discovery.test.ts`
- Create: `packages/runtime/test/collaboration/platform-adapters.test.ts`
- Create: `packages/runtime/test/collaboration/oauth-session.test.ts`
- Modify: `packages/runtime/src/collaboration/index.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: `PlatformIdentityPort`, injectable `fetch`, in-memory OAuth session state.
- Produces: `normalizeGitRemote()`, `createPlatformIdentityRegistry()`, GitHub/GitLab/Gitee Adapter implementations.

- [ ] **Step 1: Write failing Remote normalization and provider selection tests**

```ts
expect(normalizeGitRemote("git@github.com:Acme/Demo.git")).toEqual({
  provider: "github",
  host: "github.com",
  repository_path: "Acme/Demo",
  canonical_remote: "ssh://git@github.com/Acme/Demo.git",
});
expect(() => normalizeGitRemote("https://token@github.com/acme/demo.git"))
  .toThrowErrorMatchingObject({ code: "remote_contains_credentials" });
```

Cover GitLab subgroups, Gitee owner/repo, mixed-case host normalization, unsupported host and Remote identity drift.

- [ ] **Step 2: Write failing role and fail-closed response tests**

Use fake `fetch` fixtures and assert exact normalized permissions:

```ts
expect(githubPermission({ permissions: { admin: false, maintain: true, push: true, pull: true } }))
  .toBe("maintain");
expect(gitlabPermission({ permissions: { project_access: { access_level: 30 } } }))
  .toBe("write");
expect(() => giteePermission({ permission: "unknown" }))
  .toThrowErrorMatchingObject({ code: "permission_denied" });
```

Missing stable subject id, repository id, permission or protection fields must return a typed failure, never a guessed role.

- [ ] **Step 3: Implement in-memory OAuth state/PKCE sessions**

```ts
export interface OAuthSession {
  readonly state: string;
  readonly code_verifier: string;
  readonly redirect_uri: string;
  readonly expires_at: string;
}
```

Generate state and verifier with `randomBytes`; consume each state once; require exact callback origin and redirect URI. Hold access tokens only in the returned `AuthenticatedPlatformSession` object and redact every transport error.

- [ ] **Step 4: Implement the three provider Adapters behind one registry**

The host supplies client id, OAuth URLs, API base URL and Coordinator credential identity; project files supply none of them. Use official provider endpoints through injected configuration. Keep provider JSON parsing private and return only:

```ts
interface RemoteIdentity {
  provider: "github" | "gitlab" | "gitee";
  host: string;
  subject_id: string;
  repository_id: string;
  permission: "read" | "write" | "maintain" | "admin";
  source_response_digest: string;
}
```

Reference during implementation:

- GitHub branch protection: `https://docs.github.com/en/rest/branches/branch-protection`
- GitLab protected branches: `https://docs.gitlab.com/api/protected_branches/`
- Gitee v5 repository/branch protection surface: `https://gitee.com/sdk/gitee5j/blob/main/docs/RepositoriesApi.md`

- [ ] **Step 5: Enforce Control Ref protection as a connect prerequisite**

`inspectControlRefProtection()` returns protected only when the platform response proves all three facts: Coordinator identity can push, ordinary repository writers cannot push, and force-push/deletion are disabled. GitLab/Gitee editions that cannot express or expose exclusive writer rules return `control_ref_unprotected`; do not weaken Conformance based on product tier.

- [ ] **Step 6: Run security-focused tests**

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/runtime/test/collaboration/{remote-discovery,platform-adapters,oauth-session}.test.ts \
  tests/security/secret-redaction.test.ts \
  tests/security/command-injection.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
```

Expected: provider fixtures pass; unknown fields fail closed; test logs contain no fixture token.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/collaboration packages/runtime/test/collaboration
git diff --cached --check
git commit -m "feat(collaboration): verify platform identity and ref protection"
```

### Task 5: Complete the Remote Approval Vertical Loop

**Files:**
- Create: `packages/runtime/src/collaboration/approval.ts`
- Create: `packages/runtime/test/collaboration/remote-approval.test.ts`
- Modify: `packages/runtime/src/approval/request.ts`
- Modify: `packages/runtime/src/approval/service.ts`
- Modify: `packages/runtime/src/collaboration/coordinator.ts`
- Modify: `packages/runtime/src/orchestration/lifecycle-events.ts`
- Modify: `packages/runtime/test/approval/{request,service}.test.ts`
- Create: `tests/fault/remote-approval-materialization.test.ts`

**Interfaces:**
- Consumes: existing `ApprovalService`, Protocol 1.2 requester fields, PrincipalSnapshot and RemoteApprovalDecision.
- Produces: `validateRemoteApprovalDecision()`, `materializeRemoteApprovalDecision()` and `submit_remote_approval` command support.

- [ ] **Step 1: Write failing requester-binding and self-approval tests**

```ts
const request = buildApprovalRequest({
  ...baseRequest,
  proposedBy: "principal_alice",
  requesterPrincipal: {
    principal_id: "principal_alice",
    principal_snapshot_digest: digest("a"),
  },
});
expect(request.requester_principal_id).toBe("principal_alice");

await expect(submitRemoteApproval({ request, approver: snapshot("principal_alice") }))
  .rejects.toMatchObject({ code: "approval_self_approval" });
```

Also prove that a legacy Request without requester Principal cannot enter remote approval and must be reissued, while local string-actor approval behavior remains green.

- [ ] **Step 2: Extend builders without breaking local Approval**

Add an optional `requesterPrincipal` object to `ApprovalRequestSpec`; write the two first-class fields only when present. Keep the existing `harness.approval.proposed_by` extension for Protocol 1.0/1.1 local compatibility. Preview digest must include the new fields when present.

When `requesterPrincipal` is present, the builder emits `protocol_version: PROTOCOL_1_2_VERSION`; otherwise it preserves the existing local protocol version. New M3 Lifecycle Events likewise emit 1.2 while existing Event builders retain their current version.

- [ ] **Step 3: Implement Remote Decision validation and first-terminal-wins**

```ts
export function validateRemoteApprovalDecision(input: {
  request: ApprovalRequestRecord;
  snapshot: PrincipalSnapshot;
  decision: RemoteApprovalDecisionDraft;
  now: string;
}): RemoteApprovalValidation {
  if (input.request.requester_principal_id === undefined)
    return blocked("approval_binding_mismatch");
  if (input.snapshot.principal_id === input.request.requester_principal_id)
    return blocked("approval_self_approval");
  if (!(input.snapshot.observed_at <= input.decision.decided_at && input.decision.decided_at < input.snapshot.expires_at))
    return blocked("permission_snapshot_stale");
  return validateRequestDigestsAndPermission(input);
}
```

After a legal non-`defer` Decision wins the Control Ref CAS, later competitors return that Decision. `defer` remains non-terminal.

- [ ] **Step 4: Materialize through the existing ApprovalService**

Local Kernel must re-read the committed request and Control Ref, validate exact request/object/operation/baseline/policy digests, then call the existing ApprovalService. The resulting ApprovalDecision extension contains only `remote_decision_digest`; original snapshot expiry after `decided_at` does not invalidate the Decision.

Emit `RemoteApprovalMaterialized` only after the ApprovalDecision Ledger commit succeeds. Control Ref-only changes remain in the collaboration Read Model.

- [ ] **Step 5: Add crash and delayed-materialization tests**

Inject failures at: Control CAS before response, Control CAS success before SQLite update, and ApprovalDecision commit before response. Retry must find the same `remote_decision_id`/`command_id`. Advance the clock beyond five minutes before materialization and prove no repeated human approval is required when domain bindings are unchanged.

- [ ] **Step 6: Run approval regression and fault tests**

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/runtime/test/approval/{request,service}.test.ts \
  packages/runtime/test/collaboration/remote-approval.test.ts \
  tests/fault/remote-approval-materialization.test.ts \
  tests/fault/approval-cascade-invalidation.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
```

Expected: remote and existing local approval suites pass.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src packages/runtime/test tests/fault/remote-approval-materialization.test.ts
git diff --cached --check
git commit -m "feat(collaboration): materialize remote approvals safely"
```

### Task 6: Prepare, Re-sequence and Accept Integration Candidates

**Files:**
- Create: `packages/runtime/src/collaboration/ledger-resequence.ts`
- Create: `packages/runtime/src/collaboration/integration.ts`
- Create: `packages/runtime/test/collaboration/ledger-resequence.test.ts`
- Create: `packages/runtime/test/collaboration/integration.test.ts`
- Modify: `packages/runtime/src/collaboration/coordinator.ts`
- Modify: `packages/runtime/src/collaboration/index.ts`
- Modify: `adapters/vcs-git/src/control-store.ts`
- Modify: `adapters/vcs-git/test/control-store.test.ts`
- Create: `tests/fault/integration-cas-recovery.test.ts`
- Create: `tests/integration/m3-ledger-sequence-fork.test.ts`

**Interfaces:**
- Consumes: `mergeCommittedOperations()`, `manifestDigest()`, existing Graph/Impact/Gate/Approval freshness checks, GitControlStorePort.
- Produces: `resequenceCandidateLedger()`, `prepareIntegration()`, `acceptIntegration()` and deterministic IntegrationRecord.

- [ ] **Step 1: Write the failing no-text-conflict sequence-fork test**

Build Target and Operation branches from the same baseline. Give both distinct LedgerOperation IDs at the same sequence, integrate A, then prepare B:

```ts
const result = await prepareIntegration({
  expected_target_commit: integratedA,
  operation_commit: operationB,
  lease_fencing_token: 2,
});
expect(result).toMatchObject({
  status: "prepared",
  integration_record: {
    ledger_sequence_rewrites: [{ old_sequence: 2, new_sequence: 4 }],
  },
});
const candidateRoot = join(testRoot, "candidate-checkout");
execFileSync("git", ["clone", remoteUrl, candidateRoot]);
execFileSync("git", ["-C", candidateRoot, "checkout", "--detach", result.candidate_commit]);
expect(replayLedger(harnessRootFor(candidateRoot)).operations.map((op) => op.manifest.sequence))
  .toEqual([1, 2, 3, 4, 5]); // A integration record, re-sequenced B, then B integration record
```

Run:

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/runtime/test/collaboration/ledger-resequence.test.ts \
  tests/integration/m3-ledger-sequence-fork.test.ts
```

Expected: FAIL with the existing `LedgerSequenceError`.

- [ ] **Step 2: Implement deterministic candidate-only re-sequencing**

```ts
export interface LedgerSequenceRewrite {
  readonly ledger_operation_id: string;
  readonly old_sequence: number;
  readonly old_manifest_digest: string;
  readonly new_sequence: number;
  readonly new_manifest_digest: string;
}

export function resequenceCandidateLedger(input: {
  readonly target: readonly LedgerOperation[];
  readonly incoming: readonly LedgerOperation[];
}): { manifests: readonly LedgerOperation[]; rewrites: readonly LedgerSequenceRewrite[] };
```

Reject same ID/different digest; sort incoming-only manifests by old sequence then ID; assign from Target max + 1; recompute manifest digest with existing `manifestDigest()`. Do not rewrite artifacts, edge/event shards, LifecycleEvent sequence, Operation Branch bytes or Target history.

- [ ] **Step 3: Extend the Git Adapter for deterministic merge candidates**

`prepareCandidate()` must fetch exact OIDs, use a temporary index/worktree, create a two-parent commit with parent order Target then Operation, and return candidate OID plus tree OID. It must not update any remote ref. Text conflict returns `integration_conflict`; command arguments stay arrays passed to `execFile`.

- [ ] **Step 4: Commit the fixed-path IntegrationRecord in the candidate tree**

Build the record only after re-sequencing and validation inputs are known. Store it at:

```text
.harness/artifacts/integrations/<integration-id>.json
```

The final candidate Ledger transaction is sequence `max(resequenced manifests) + 1`. The record contains rewrite mapping, Evidence and Approval digests but no candidate commit OID. Verify the candidate has exactly the two expected parents and that recomputing merge + re-sequence + fixed record path yields the same tree OID.

- [ ] **Step 5: Run the full Integration prepare validation chain**

Call existing production functions for Graph reconcile, Impact, Evidence freshness, mandatory Gate and Approval binding checks against the candidate tree. Do not create a model seam or mock the result in production. Any failure returns the spec §16 code and leaves Target untouched.

- [ ] **Step 6: Implement Target CAS and lost-response recovery**

`acceptIntegration()` re-reads the Integration Lease, Target head, candidate parents/tree and required digests. Update Target with force-with-lease semantics against `expected_target_commit`. On a lost response, inspect Target history for the same integration ID, command ID and record digest; return `accepted` if found, otherwise `target_cas_failed`. Emit `IntegrationAccepted` only after Target contains the candidate.

- [ ] **Step 7: Cover conflict, drift, tampering and crash paths**

Add tests for text conflict, duplicate LedgerOperation ID/different digest, missing shard, modified rewrite map, stale target, expired/fenced Integration Lease, failed Gate, revoked integration actor permission, CAS success before response and repeated accept.

- [ ] **Step 8: Run integration and existing Ledger tests**

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/core/test/ledger \
  adapters/vcs-git/test/control-store.test.ts \
  packages/runtime/test/collaboration/{ledger-resequence,integration}.test.ts \
  tests/integration/m3-ledger-sequence-fork.test.ts \
  tests/fault/integration-cas-recovery.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
```

Expected: all pass; `mergeCommittedOperations()` remains strict for already accepted histories.

- [ ] **Step 9: Commit**

```bash
git add packages/runtime/src/collaboration packages/runtime/test/collaboration \
  adapters/vcs-git/src/control-store.ts adapters/vcs-git/test/control-store.test.ts \
  tests/integration/m3-ledger-sequence-fork.test.ts tests/fault/integration-cas-recovery.test.ts
git diff --cached --check
git commit -m "feat(collaboration): integrate branches with ledger resequencing"
```

### Task 7: Add HTTPS Coordinator Transport and CLI Commands

**Files:**
- Create: `packages/runtime/src/collaboration/http-client.ts`
- Create: `packages/runtime/src/collaboration/http-server.ts`
- Create: `packages/runtime/test/collaboration/http-transport.test.ts`
- Create: `packages/cli/src/commands/connect.ts`
- Create: `packages/cli/src/commands/disconnect.ts`
- Create: `packages/cli/src/commands/sync.ts`
- Create: `packages/cli/src/commands/integrate.ts`
- Create: `packages/cli/src/commands/coordinator.ts`
- Create: `packages/cli/test/collaboration-commands.test.ts`
- Modify: `packages/cli/src/router.ts`
- Modify: `packages/cli/src/runtime-service.ts`
- Modify: `packages/cli/test/help.test.ts`
- Modify: `packages/cli/test/__snapshots__/help.test.ts.snap`
- Modify: `packages/runtime/src/collaboration/index.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: `CollaborationCoordinatorPort` and its typed unions.
- Produces: `HttpCollaborationCoordinatorAdapter`, `startCollaborationCoordinatorServer()` and user-facing CLI command routes.

- [ ] **Step 1: Write failing transport parity and security tests**

Run the same command/query fixture against in-process and HTTP ports and expect equal typed outcomes. Add negative cases for plain HTTP, invalid content type, oversized body, wrong Origin, missing CSRF token, reused OAuth state and token-shaped error text.

```ts
expect(() => createHttpCollaborationCoordinatorAdapter({ origin: "http://example.com" }))
  .toThrowErrorMatchingObject({ code: "invalid_coordinator_origin" });
expect(await remote.execute(command, session)).toEqual(await local.execute(command, session));
```

- [ ] **Step 2: Implement a thin HTTPS transport**

Use `node:https` and host-owned certificate/key paths. The HTTP layer only decodes a versioned command/query union, authenticates the session, calls the port and encodes the typed result. Set request size and timeout limits; redact Authorization, OAuth code and token fields. Do not duplicate permission, Lease, Approval or Integration logic.

Use these routes:

```text
POST /api/v1/collaboration/commands
POST /api/v1/collaboration/queries
GET  /oauth/<provider>/start
GET  /oauth/<provider>/callback
```

For CLI connect, the command endpoint first returns `authentication_required` with a random in-memory
`oauth_session_id` and `authorization_url`; CLI opens or prints that URL and polls a connection-status query
bound to the same session ID. The callback consumes state once, completes the original connect command and
never returns the provider access token to CLI.

- [ ] **Step 3: Add the host-only Coordinator command**

`harness coordinator` accepts `--host`, `--port`, `--tls-cert`, `--tls-key` and host provider-config path. The provider config contains endpoint/client identifiers and secret environment-variable names, never secret values. Reject project-relative TLS/key paths and refuse startup without TLS. It composes the runtime Coordinator, Git Adapter and SQLite projection; it does not create a new package or daemon manager.

- [ ] **Step 4: Add thin project commands**

Implement exact forms:

```text
harness connect --coordinator https://host:port
harness disconnect
harness sync
harness integrate prepare <operation-id>
harness integrate accept <integration-id>
```

`connect` reads and normalizes the approved `origin` Git Remote and current branch, then calls the HTTP port. Other commands load the active CollaborationConnectionRecord to discover Coordinator origin. `approve/reject/defer`, `iterate/resume` and `status` route remotely only when the connection record is active; disconnected/never-connected projects preserve existing behavior. Connected `iterate/resume` acquires or renews the Operation Lease, performs local candidate work, then submits `publish_operation_candidate` with the current fencing token instead of pushing the managed Operation Ref directly.

- [ ] **Step 5: Update CLI help and typed runtime facade**

Add explicit request/result types to `router.ts`; command handlers only parse flags and delegate. Update help snapshots and reject missing coordinator, non-HTTPS origin, malformed IDs and unknown integrate subcommands with usage exit code.

- [ ] **Step 6: Run transport, CLI and pack checks**

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/runtime/test/collaboration/http-transport.test.ts \
  packages/cli/test/collaboration-commands.test.ts \
  packages/cli/test/help.test.ts \
  packages/cli/test/managed-capture-orchestration.test.ts
pnpm typecheck
pnpm pack:smoke
```

Expected: local CLI regressions pass and the packed binary exposes all five commands.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/collaboration packages/runtime/test/collaboration \
  packages/cli/src packages/cli/test
git diff --cached --check
git commit -m "feat(cli): expose secure remote collaboration commands"
```

### Task 8: Add Dashboard Connection, Approval and Conflict Views

**Files:**
- Create: `packages/dashboard/src/collaboration-api.ts`
- Create: `packages/dashboard/test/collaboration-api.test.ts`
- Modify: `packages/dashboard/src/server.ts`
- Modify: `packages/dashboard/src/router.ts`
- Modify: `packages/dashboard/src/read-api.ts`
- Modify: `packages/dashboard/assets/index.html`
- Modify: `packages/dashboard/assets/dashboard.js`
- Modify: `packages/dashboard/assets/dashboard.css`
- Modify: `packages/dashboard/test/assets.test.ts`
- Modify: `packages/dashboard/test/security.test.ts`
- Create: `tests/e2e/dashboard-m3-collaboration.test.ts`

**Interfaces:**
- Consumes: active CollaborationConnectionRecord and `CollaborationCoordinatorPort.query/execute` through the HTTP Adapter.
- Produces: Connection Status, Approval Inbox and Integration Conflict Dashboard views.

- [ ] **Step 1: Write failing Dashboard API tests**

```ts
expect(await getJson(server, "/api/v1/collaboration/connection"))
  .toMatchObject({ authority: "project_ledger", status: "active" });
expect(await getJson(server, "/api/v1/collaboration/approvals"))
  .toMatchObject({ authority: "control_ref", projection_observed_at: expect.any(String) });
```

Cover disconnected Coordinator, stale SQLite projection, Approval submit, Integration retry, CSRF/Origin rejection and redaction.

- [ ] **Step 2: Add one Dashboard collaboration Adapter**

`collaboration-api.ts` loads connection status locally from project Ledger and forwards remote query/command calls through `HttpCollaborationCoordinatorAdapter`. It returns both `authority` and `projection_observed_at`; it never treats SQLite as accepted project truth.

- [ ] **Step 3: Add only the three approved UI surfaces**

Add Connection Status to Overview, a remote-aware Approval Inbox using the existing Approval card component, and an Integration Conflict panel with retry-after-human-resolution. Do not add a topology editor, Lease administration page, platform-role editor or automatic conflict resolution UI.

- [ ] **Step 4: Keep accepted and candidate observations visually distinct**

Render accepted Ledger facts with the existing authoritative treatment; label Control Ref/SQLite rows `远程协调事实` or `本地投影（observed_at）`. Do not emit Lease/candidate states through EventStream SSE. Existing local approval UI remains functional for disconnected projects.

- [ ] **Step 5: Run Dashboard unit, security and Playwright tests**

```bash
pnpm exec vitest run --config vitest.workspace.ts \
  packages/dashboard/test/collaboration-api.test.ts \
  packages/dashboard/test/assets.test.ts \
  packages/dashboard/test/security.test.ts
pnpm exec playwright test --config playwright.dashboard.config.ts tests/e2e/dashboard-m3-collaboration.test.ts
pnpm --filter @universal-harness-internal/dashboard typecheck
```

Expected: the three views work against a fake Coordinator; existing Dashboard routes remain loopback-only.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src packages/dashboard/assets packages/dashboard/test \
  tests/e2e/dashboard-m3-collaboration.test.ts
git diff --cached --check
git commit -m "feat(dashboard): show remote collaboration state"
```

### Task 9: Prove Conformance, Fault Recovery and Real-Platform Evidence

**Files:**
- Create: `packages/conformance/src/collaboration.ts`
- Create: `packages/conformance/test/collaboration.conformance.test.ts`
- Modify: `packages/conformance/src/index.ts`
- Create: `tests/e2e/m3-remote-collaboration.test.ts`
- Create: `tests/security/m3-collaboration-boundary.test.ts`
- Create: `tests/performance/m3-control-ref-rebuild.test.ts`
- Create: `scripts/dogfood-m3-platform.mjs`
- Create: `docs/evidence/m3-remote-collaboration-completion.md`
- Modify: `scripts/generate-acceptance-report.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/graph-driven-harness-model.md`

**Interfaces:**
- Consumes: all M3 public Interfaces and production Adapters.
- Produces: shared Conformance cases, M3-AC-01..14 Evidence and release-gate integration.

- [ ] **Step 1: Write the shared Conformance suites**

Export cases for each seam:

```ts
export function platformIdentityConformanceCases(factory: PlatformIdentityFactory): ConformanceCase[];
export function gitControlStoreConformanceCases(factory: GitControlStoreFactory): ConformanceCase[];
export function coordinatorProjectionConformanceCases(factory: ProjectionFactory): ConformanceCase[];
```

Platform cases require stable subject/repository IDs, exact role mapping, token redaction and enforceable Coordinator-only Control Ref protection. Git cases require append-only ordering, stale OID loss, no blind retry and Target CAS. Projection cases require delete/rebuild equivalence and no secret columns.

- [ ] **Step 2: Add the full double-Clone E2E**

Use a local bare remote, two clones, deterministic fake platform Adapter and real Git/SQLite Adapters. Prove:

```text
connect → two Operation Leases → parallel candidate work → fenced candidate publish
→ remote Approval → delayed materialization
→ integrate A → re-sequence B → integrate B
→ Target CAS → disconnect → rebuild SQLite from Git
```

Assert both operations remain reachable, Target Ledger replays contiguously, old fencing tokens fail, and no model or Agent statement is used as Evidence.

- [ ] **Step 3: Add security, fault and performance gates**

Security covers OAuth state/PKCE, CSRF/Origin, credential-bearing Remote rejection, command injection, token/log scanning, self-approval and unprotected Control Ref. Fault coverage kills the Coordinator at every Git/SQLite/CAS boundary and proves idempotent recovery. Performance coverage rebuilds exactly 10,000 Control records and asserts complete output/digest equality, not machine-specific timing.

- [ ] **Step 4: Add real-platform dogfood with explicit prerequisites**

`scripts/dogfood-m3-platform.mjs --provider github|gitlab|gitee` consumes host environment credentials, creates or uses a disposable repository, verifies Control Ref protection, runs the AC flow and writes only a redacted Evidence bundle. If a platform/tier cannot prove exclusive Control Ref protection, record `blocked: control_ref_unprotected`; never mark that provider complete.

- [ ] **Step 5: Bind M3 acceptance to the release report and CI**

Add M3 unit/conformance/e2e/security/performance jobs. The completion document records commit SHA, command, exit code, Evidence digest and platform dogfood status for every M3-AC-01..14. Release remains incomplete until GitHub, GitLab and Gitee each have current-commit dogfood Evidence.

- [ ] **Step 6: Update public architecture documentation**

Document the optional remote collaboration mode for Lite/Standard/Governed, the protected Control Ref, candidate-only sequence reordering and the Dashboard surfaces. Do not describe M3 as cross-repository, Multi-Agent, multi-Coordinator or CapabilityPlan activation.

- [ ] **Step 7: Run the complete release gate**

```bash
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm test:security
pnpm test:fault
pnpm test:performance
pnpm test:e2e
pnpm test:e2e:dashboard
pnpm pack:smoke
node scripts/generate-acceptance-report.mjs
```

Expected: every repository-local command passes. Real-platform Evidence is verified separately and must bind the same commit before M3 is marked complete.

- [ ] **Step 8: Commit the release proof**

```bash
git add packages/conformance tests scripts .github/workflows/ci.yml \
  docs/evidence/m3-remote-collaboration-completion.md README.md docs/graph-driven-harness-model.md
git diff --cached --check
git commit -m "test(release): prove M3 remote collaboration"
```

## Dependency Order and Review Gates

```text
Task 1 Protocol
   ↓
Task 2 Coordinator Interface / Connection
   ↓
Task 3 Git Control Ref / Lease / SQLite
   ↓
Task 4 Platform Identity / Protection
   ↓
Task 5 Remote Approval
   ↓
Task 6 Integration / Ledger Re-sequence
   ↓
Task 7 HTTPS Transport / CLI
   ↓
Task 8 Dashboard
   ↓
Task 9 Conformance / E2E / Evidence
```

Tasks 4 and the SQLite portion of Task 3 may be implemented in parallel only after Task 2's Interfaces are committed; all other tasks remain ordered because later acceptance relies on earlier authoritative records. Each task requires a fresh review gate before the next task begins.

## Completion Rule

M3 is complete only when all nine tasks are committed, M3-AC-01..14 have current-commit immutable Evidence, three platform dogfoods pass, and the full release gate is green. A green fake-Adapter suite, Agent self-report, Dashboard screenshot or local branch alone cannot change completion status.
