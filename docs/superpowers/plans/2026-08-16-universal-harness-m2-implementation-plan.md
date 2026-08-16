# Universal Harness M2 实施计划

日期：2026-08-16

状态：已完成

完成日期：2026-08-16

验收证据：[M2 验收报告](../../m2-acceptance-report.md)（13/13）

设计依据：[Universal Harness M2 完整设计](../specs/2026-08-16-universal-harness-m2-design.md)

## 1. 目标

完整交付 M2-A Finding 治理、M2-B 可选 LLM-judge Gate、M2-C 语义检索种子和 M2-D 本地 Dashboard/实时可观测性。每个切片采用测试先行，保持 Git Ledger 权威、缓存可重建、模型输出不可自证、Web 写操作无旁路。

## 2. 执行规则

1. 每个 Task 先加入会失败的单元或集成测试，再做最小实现，再重构。
2. 每个 Task 完成时运行聚焦测试、受影响包 typecheck，并提交一个可回滚 commit。
3. schema、端口和安全边界先于 UI；UI 不得反向定义领域语义。
4. 新缓存和 live spool 均可删除重建；测试必须证明删除不影响权威状态。
5. 不使用外部网络做测试；Judge 只连注入的 fake transport/server。
6. 最终完成以设计第 15 节验收矩阵的逐项证据为准，不以代码数量或窄测试代替。

## 3. Task 1：协议扩展与 Observation schema

**修改文件**

- `packages/core/src/schema/event.ts`
- `packages/core/src/schema/observation.ts`（新增）
- `packages/core/src/schema/edge.ts`
- `packages/core/src/schema/registry.ts`
- `packages/core/src/index.ts`
- `packages/core/scripts/write-schemas.mjs`
- `packages/core/test/schema/observation.test.ts`（新增）
- `packages/core/test/schema/persisted-records.test.ts`

**测试先行**

- 严格校验 ObservationEvent 类型、stream id、正整数 sequence、observation key 和 payload。
- 拒绝未知字段、未知 event type、无效标识和 secret-bearing fixture。
- LifecycleEvent 接受 FindingAccepted/Closed/Superseded。
- Edge schema 接受合法 `MAY_IMPACT`，拒绝其他未知关系。

**实现**

- 新增非 persisted record 的 Observation schema；不得复用 `persistedRecordProperties`。
- 增加 Finding 生命周期事件和 `MAY_IMPACT` 关系。
- 导出 TS 类型并生成/打包 JSON schema。

**验证**

```text
pnpm vitest run packages/core/test/schema
pnpm --filter @universal-harness-internal/core typecheck
```

## 4. Task 2：EventStreamPort、live spool 与 watch 迁移

**修改文件**

- `packages/runtime/src/observability/event-stream.ts`（新增）
- `packages/runtime/src/observability/live-spool.ts`（新增）
- `packages/runtime/src/observability/redaction.ts`（新增或复用 Tool redactor）
- `packages/runtime/src/index.ts`
- `packages/runtime/test/observability/event-stream.test.ts`（新增）
- `packages/runtime/test/observability/live-spool.test.ts`（新增）
- `packages/cli/src/commands/watch.ts`
- `packages/cli/test/watch.test.ts`

**测试先行**

- 合并 Ledger/live、稳定顺序、opaque cursor、过滤、authoritative 覆盖 live duplicate。
- per-stream sequence 严格递增；10,000 条/10 MiB 轮转；evicted cursor 返回 reset。
- 跨 chunk token、URL credential、环境变量值在落盘前被脱敏。
- 删除 spool 后 Ledger 历史仍完整；`watch --follow` 同时看到 live 和 committed 事件。

**实现**

- 定义 `read`/`subscribe` 端口与 file-backed adapter。
- live spool 只写 `.harness/cache/event-stream`，使用 segment 原子轮转。
- 将 watch 的直接 JSONL tail 改为 EventStreamPort，保留现有终端和 NDJSON 兼容输出。

**验证**

```text
pnpm vitest run packages/runtime/test/observability packages/cli/test/watch.test.ts
pnpm --filter @universal-harness-internal/runtime typecheck
pnpm --filter universal-harness typecheck
```

## 5. Task 3：Graph、Execution、Evaluation 读端口

**修改文件**

- `packages/graph/src/read-ports.ts`（新增）
- `packages/graph/src/evaluation-read-port.ts`（新增）
- `packages/graph/src/query-port.ts`
- `packages/graph/src/index.ts`
- `packages/graph/test/read-ports.test.ts`（新增）
- `packages/graph/test/evaluation-read-port.test.ts`（新增）

**测试先行**

- Graph/Execution view 分页、过滤、neighborhood、bridge、shortest path 顺序稳定。
- EvaluationReadPort 正确汇总五维 verdict、case、Evidence、coverage 和 freshness。
- limit/depth/cursor 越界返回 typed error；旧/损坏缓存不返回伪健康数据。

**实现**

- 用对象端口封装现有查询函数与 views，不重复 SQL。
- 增加 Dashboard 所需的只读 DTO，禁止任意文件读取。

**验证**

```text
pnpm vitest run packages/graph/test/read-ports.test.ts packages/graph/test/evaluation-read-port.test.ts
pnpm --filter @universal-harness-internal/graph typecheck
```

## 6. Task 4：M2-A Finding 分组与 status

**修改文件**

- `packages/runtime/src/finding/governance.ts`（新增）
- `packages/runtime/src/finding/groups.ts`（新增）
- `packages/runtime/src/audit/auditor.ts`
- `packages/runtime/src/gates/runner.ts`
- `packages/runtime/src/status/status.ts`
- `packages/runtime/src/index.ts`
- `packages/runtime/test/finding/groups.test.ts`（新增）
- `packages/runtime/test/status/status.test.ts`
- `packages/cli/src/commands/status.ts`
- `packages/cli/test/status.test.ts`

**测试先行**

- producer metadata、legacy fallback、rule/scope/severity/actionability 分组。
- group id 与 membership digest 对输入顺序和重放稳定，成员 revision 漂移会改变 digest。
- terminal 只显示组计数/样本；`status --json` 保留旧 arrays 并新增 `finding_groups`。
- Atlas 规模 fixture 的 52 个 stale + 1 个 design warning 不再平铺 53 行。
- advisory Gate failure 创建 `blocking:false` Finding。

**实现**

- 统一治理元数据 builder 与 legacy adapter。
- 实现纯分组投影并接入 `ProjectStatus`。
- Audit/Gate/Evaluation producer 写入稳定 rule/scope/actionability。

**验证**

```text
pnpm vitest run packages/runtime/test/finding packages/runtime/test/status packages/cli/test/status.test.ts
```

## 7. Task 5：M2-A 批量处置、衰减与事件

**修改文件**

- `packages/runtime/src/finding/lifecycle.ts`（从 orchestrator 抽取）
- `packages/runtime/src/finding/group-service.ts`（新增）
- `packages/runtime/src/finding/decay.ts`（新增）
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/graph/reconcile.ts`
- `packages/runtime/test/finding/group-service.test.ts`（新增）
- `packages/runtime/test/finding/decay.test.ts`（新增）
- `packages/cli/src/commands/finding.ts`
- `packages/cli/src/router.ts`
- `packages/cli/test/finding.test.ts`

**测试先行**

- batch accept/close/supersede 单 transaction 全成全败；digest mismatch 零写入。
- close Evidence 对全组的 passed/provisional/fresh/subject 适用性。
- source refresh 后 stale predicate 不复现，Finding superseded、所有关联活动边退休并有事件。
- 第二次 decay/reconcile 为 no-op；`graph sync` 不提交 Ledger。

**实现**

- 抽取单项/批量共用生命周期 service。
- 增加 `harness finding group ... --digest` 路由与稳定 JSON/error。
- 在 rescan/snapshot/reconcile 的正确 transaction 边界调用 decay。

**验证**

```text
pnpm vitest run packages/runtime/test/finding packages/runtime/test/graph/reconcile.test.ts packages/cli/test/finding.test.ts
```

## 8. Task 6：Dashboard server、安全 session 与只读 API

**新增包**

- `packages/dashboard/package.json`
- `packages/dashboard/tsconfig.json`
- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/session.ts`
- `packages/dashboard/src/router.ts`
- `packages/dashboard/src/problem.ts`
- `packages/dashboard/src/read-api.ts`
- `packages/dashboard/src/index.ts`
- `packages/dashboard/test/server.test.ts`
- `packages/dashboard/test/security.test.ts`

**CLI 修改**

- `packages/cli/package.json`
- `packages/cli/src/commands/serve.ts`
- `packages/cli/src/router.ts`
- `packages/cli/src/runtime-service.ts`
- `packages/cli/test/serve.test.ts`

**测试先行**

- 默认 loopback + random port；非 loopback 拒绝。
- URL token 只交换一次，重定向后移除；session cookie 属性和 CSRF session 绑定正确。
- Graph/Iteration/Evidence/Finding API 分页、限制、typed errors 和缓存损坏 503。
- CSP、nosniff、frame denial、无 CORS、path traversal/XSS payload 被拒绝。

**实现**

- 使用 Node 原生 HTTP，避免为本地 server 引入 Web framework。
- 组合读端口与受控应用服务；GET handler 不读取任意磁盘路径。
- 新增 `harness serve [--port] [--json]`，CLI 为唯一 composition root。

**验证**

```text
pnpm vitest run packages/dashboard/test packages/cli/test/serve.test.ts
pnpm --filter @universal-harness-internal/dashboard typecheck
```

## 9. Task 7：Dashboard 单页与 Graph/Impact/Iteration/Evidence/Findings

**修改文件**

- `packages/dashboard/assets/dashboard.html`
- `packages/dashboard/assets/dashboard.css`
- `packages/dashboard/assets/dashboard.js`
- `packages/dashboard/src/assets.ts`
- `packages/dashboard/test/assets.test.ts`
- `tests/e2e/dashboard-readonly.test.ts`

**测试先行**

- 静态资源由 package 自带、无 CDN/远程资源、正确 content type/cache policy。
- 六个只读视图支持 loading/empty/error、分页和筛选。
- 图只按需加载邻域，不一次性拉全量节点。
- 键盘、焦点、语义 label、非纯颜色状态、reduced-motion、窄屏列表符合验收。

**实现**

- 使用轻量 ES modules + CSS，无运行时前端框架或构建时远程依赖。
- 视觉实现阶段使用 `frontend-design` 技能；E2E 阶段使用 `playwright-best-practices` 技能并遵循其测试约束。

**验证**

```text
pnpm vitest run packages/dashboard/test/assets.test.ts
pnpm test:e2e -- dashboard-readonly
```

## 10. Task 8：M2-D runtime publisher、SSE 与 Web 操作闭环

**修改文件**

- `packages/runtime/src/observability/publisher.ts`（新增）
- `packages/runtime/src/orchestration/orchestrator.ts`
- `packages/runtime/src/gates/runner.ts`
- `packages/runtime/src/tools/invocation.ts`
- `packages/dashboard/src/sse.ts`（新增）
- `packages/dashboard/src/write-api.ts`（新增）
- `packages/dashboard/assets/dashboard.js`
- `packages/runtime/test/observability/publisher.test.ts`
- `packages/dashboard/test/sse.test.ts`
- `tests/e2e/dashboard-live-approval.test.ts`

**测试先行**

- Phase/Gate/Run/heartbeat/output/budget/approval 事件顺序、频率、大小与脱敏。
- Gate live completion 被 Ledger completion authoritative 替换，不重复显示。
- SSE Last-Event-ID、heartbeat、backpressure、disconnect cleanup、stream reset。
- Web approve/reject/defer 与 resume 复用现有 service；expected digest/actor 可在 Ledger readback。
- 15 秒无 heartbeat 显示 unknown，不写伪终态。

**实现**

- 在既有相位和 Tool lifecycle seam 发布 Observation，不拆分 Ledger 原子提交。
- SSE 仅订阅 EventStreamPort；write API 只调用 Approval/Resume/FindingGroup service。
- UI 增加 live swimlane、Approval card 与冲突刷新。

**验证**

```text
pnpm vitest run packages/runtime/test/observability packages/dashboard/test/sse.test.ts
pnpm test:e2e -- dashboard-live-approval
```

## 11. Task 9：M2-C Provider、确定性索引与建议审批

**修改文件**

- `packages/plugin-sdk/src/semantic-seed.ts`（新增）
- `packages/plugin-sdk/src/index.ts`
- `packages/graph/src/semantic/extractor.ts`（新增）
- `packages/graph/src/semantic/index.ts`（新增）
- `packages/graph/src/semantic/provider.ts`（新增）
- `packages/graph/src/impact/propagation.ts`
- `packages/graph/src/integrity.ts`
- `packages/runtime/src/graph/edits.ts`
- `packages/cli/src/commands/impact.ts`
- `packages/graph/test/semantic/*.test.ts`（新增）
- `packages/cli/test/impact.test.ts`
- `packages/conformance/test/semantic-seed-provider.test.ts`（新增）

**测试先行**

- NFKC/token/symbol/import/path 提取、定点 weighted Jaccard、阈值/topK/tie break。
- 删除索引后 descriptor、字节和候选顺序一致；Git/blob/graph/provider 变化使缓存失效。
- `impact --semantic` 只提交 proposal artifact，不产生 active edge。
- approve digest/revision/index 漂移拒绝；批准后 `MAY_IMPACT` 只产生 inspect。
- Provider failure 不阻断结构 ImpactSet。

**实现**

- 定义 SDK port 与 conformance kit。
- 实现本地 symbol provider 和 cache。
- 扩展 edge proposal 支持 suggestion metadata 和 batch staging。
- 在 CLI/Dashboard 展示候选、解释、digest 和批准入口。

**验证**

```text
pnpm vitest run packages/graph/test/semantic packages/cli/test/impact.test.ts packages/conformance/test/semantic-seed-provider.test.ts
```

## 12. Task 10：M2-B Judge adapter、配置、Policy 与 Evidence

**新增适配器**

- `adapters/gate-llm-judge/package.json`
- `adapters/gate-llm-judge/tsconfig.json`
- `adapters/gate-llm-judge/src/review-bundle.ts`
- `adapters/gate-llm-judge/src/transport.ts`
- `adapters/gate-llm-judge/src/response.ts`
- `adapters/gate-llm-judge/src/provider.ts`
- `adapters/gate-llm-judge/src/index.ts`
- `adapters/gate-llm-judge/test/*.test.ts`

**其他修改**

- `packages/cli/src/project-runtime-config.ts`
- `packages/cli/src/project-gates.ts`
- `packages/runtime/src/gates/evidence.ts`
- `packages/runtime/src/gates/runner.ts`
- `packages/runtime/src/policy/*`
- `packages/cli/test/project-runtime-config.test.ts`
- `packages/runtime/test/gates/llm-judge.test.ts`

**测试先行**

- v1/v2 config、默认零调用、env allowlist、HTTPS/SSRF 校验。
- Review Bundle canonicalization、256 KiB 上限、untrusted data delimiter 和 digest。
- pass/warn/fail/invalid/timeout/429/5xx；重试次数和 typed outcome。
- strict response schema、path/line 边界；任何异常不 pass。
- effective mandatory 只有 approved/fresh Policy opt-in 时成立。
- Evidence 完整记录 prompt/bundle/model/response/replay digest 且无 secret。
- advisory failure 产生 warning Finding，mandatory failure 产生 blocker。

**实现**

- runtime config v2 reader，同时支持 v1。
- OpenAI-compatible adapter 只经 ToolRegistry 和白名单 transport。
- 扩展 Gate Evidence/Policy evaluation，不改变确定性 Gate 行为。

**验证**

```text
pnpm vitest run adapters/gate-llm-judge/test packages/runtime/test/gates packages/cli/test/project-runtime-config.test.ts
```

## 13. Task 11：跨切片安全、故障、性能与发布

**修改文件**

- `tests/security/dashboard-security.test.ts`
- `tests/security/judge-security.test.ts`
- `tests/fault/event-stream-recovery.test.ts`
- `tests/fault/dashboard-cache-corruption.test.ts`
- `tests/performance/m2-dashboard.test.ts`
- `tests/performance/m2-finding-semantic.test.ts`
- `tests/e2e/m2-vertical-loop.test.ts`
- `scripts/pack-cli.mjs`
- `scripts/pack-smoke.mjs`
- `scripts/check-standalone.mjs`
- `scripts/generate-acceptance-report.mjs`

**验收**

- 设计中的 10k/30k/20k/1k fixture 达到 server/query/SSE/group/semantic 阈值。
- Ledger corruption 503、spool/index 删除重建、SSE reset、服务重启恢复均符合设计。
- pack 包含 Dashboard assets、Judge adapter 与所有运行依赖，无 workspace 绝对路径或 secret。
- 端到端跑通 iterate → live → Gate/Judge → Approval → resume → Evaluation → Snapshot。

**验证**

```text
pnpm test:security
pnpm test:fault
pnpm test:performance
pnpm test:e2e
pnpm pack:smoke
```

## 14. Task 12：文档、dogfood、完成度审计与推送

**修改文件**

- `README.md`
- `docs/operations.md`
- `docs/superpowers/specs/2026-08-16-universal-harness-m2-design.md`（状态）
- `docs/superpowers/plans/2026-08-16-universal-harness-m2-implementation-plan.md`（状态）
- M2 acceptance report（由脚本生成）

**步骤**

1. 更新 CLI、runtime config v2、Finding group、semantic、Judge、serve、安全与故障恢复文档。
2. 在真实临时受管项目运行完整纵向闭环，保存命令输出与 Ledger/Snapshot 证据。
3. 用 Atlas 规模 fixture 验证 warning 聚合和 stale refresh 清零。
4. 对设计第 15 节每行填写 test/command/artifact 证据；缺一项继续实现。
5. 运行完整发布门禁：

```text
pnpm verify
pnpm test:release
pnpm pack:smoke
git status --short
```

6. 将设计和计划状态更新为“已完成”，提交并推送唯一 `main`。
7. 拉取远程 refs，确认 `main == origin/main` 且工作树干净。

## 15. 计划退出标准

- Task 1–12 全部有对应提交和当前运行测试证据。
- M2-A/B/C/D 均有直接端到端证据，不以相邻模块测试代替。
- `pnpm verify`、release、pack smoke 全绿。
- acceptance report 对设计验收矩阵逐项证明完成。
- 本地与 GitHub 唯一 `main` 一致；无未提交文件、无未推送提交。
