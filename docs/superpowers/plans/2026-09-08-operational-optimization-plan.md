# 运行可靠性与使用成本优化 Implementation Plan

> 执行方式：本会话逐项 TDD 验证，不新增服务、不整体改写 Coordinator。原 SSE 六任务计划单独跟踪。

**Goal:** 修复事件读取确定性缺陷，降低读写和 CI 成本，提前呈现执行限制并纠正文档状态。

**Architecture:** 保留 Git Ledger、可重建缓存和既有 Port。SSE 正式功能继续由六任务计划管理；此清单只追踪增补和共享首批修复。

**Tech Stack:** TypeScript、Node.js、Vitest、pnpm、GitHub Actions。

**Spec:** [运行可靠性与使用成本优化](../specs/2026-09-08-operational-optimization-design.md)

**验证记录：** [2026-09-08 本轮结果与未覆盖项](../../evidence/2026-09-08-operational-optimization.md)。本轮共享基础优化已验证，随改动入库；提交和推送状态以 Git 为准，原 SSE 计划不自动视为完成。

## Global Constraints

不修改权威历史，不放宽 Gate/审批/Provider 准入，不引入额外服务。真实 Provider 仅一次隔离小任务，不自动重试。未完成的外部验收保持未完成。

## 执行顺序与接口

- [x] O1：完成 [SSE Task 1](2026-09-05-harness-transparency-sse-implementation-plan.md) 的共享基础修复：manifest 权威性、数值顺序/位置游标、文件缓存、迟到/重启/轮转恢复及公开回归。补充 [15 类产出盘点](../../evidence/artifact-reference-coverage.md)。**不等于原 Task 1 的所有规模/RSS门槛完成**。
- [x] O2：优化 `packages/runtime/src/observability/live-spool.ts`，保持 `append(input): ObservationEvent` 与 `readLiveObservations(root)`。测试窗口、字节上限、重启和外部轮转，先失败后实现缓存累计字节；记录 1k/10k append 规模和耗时。满窗口压缩仍有全窗口重写成本。
- [x] O3：扩展 `packages/runtime/src/doctor/doctor.ts` 与 CLI doctor 生产收集入口，复用已有 Agent manifest/准入规则；CLI 测试确认 delegated/external-only/unmetered 限制可见，且不启动 Agent。
- [x] O4：修改 `.github/workflows/ci.yml` 的 Release job，删除完整 release 前重复的 `pnpm test` 与 `pnpm pack:smoke`。发布入口保留完整原命令链、build、三平台工件下载与报告上传。`package.json` canonical 命令不变。
- [x] O5：更新 README 与 `docs/getting-started.md`：状态来自最新报告、审批次数不固定、三档入口和真实 Provider 限制明确；文档一致性检查通过。此项不包含 Lite 人工 UX 耗时验收。
- [x] O6：唯一一次临时项目 dsh 小任务通过：4 次内部模型请求、无 Task 自动重试，独立字节/路径检查通过，使用 flash；保存 [脱敏诊断](../../evidence/2026-09-08-supervised-provider-probe.json)。类型/格式/lint、3186 项全量测试和 19 项性能测试通过；发布验收缺口不据此销项。

O1→O2（共同读写约定）；O3、O4、O5相互独立，可在本会话顺序执行；O6依赖本地改动验证完成。完整 SSE Task 2–6仍使用原计划，不因 O1完成自动勾选。

执行顺序偏差：原计划要求产出盘点先于编码；本轮先完成已复现的读取缺陷修复，后补盘点，已在盘点文档说明。
不能将此顺序偏差或 O1 的局部通过包装成原六任务计划全部符合完成定义。

## 实际文件与回归接口

| 工作包 | 实现入口                                                                                                       | 主要回归                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| O1     | core `ledger/event-store.ts`；runtime `observability/event-stream.ts`、`event-file-cache.ts`、`event-index.ts` | core `ledger/observer-validation.test.ts`；runtime `observability/event-stream-recovery.test.ts`；CLI watch；fault event-stream recovery |
| O2     | runtime `observability/live-spool.ts`                                                                          | runtime observability；`tests/performance/observation-cost.test.ts`                                                                      |
| O3     | runtime `doctor/doctor.ts`；CLI `commands/doctor.ts`                                                           | `packages/cli/test/doctor-agent.test.ts` 和已有 doctor 套件                                                                              |
| O4–O5  | CI、README、getting-started                                                                                    | `tests/reporting/operational-optimization.test.ts`                                                                                       |
| O6     | 现有 DshAdapter、TaskEnvelope、独立 workspace/session 证明辅助函数；临时 run-once 脚本                         | `agent_task_invocations=1`、精确文件 SHA-256、无越界路径、模型/session 用量来源                                                          |

事件端口新增可选页面字段 `itemCursors/headCursor` 和 `untilCursor`；`refreshView().read()` 不执行文件 I/O。
重启/历史替换产生新 generation，旧游标返回 reset；消费者不能持久缓存旧 generation 并将其当成全局事件序号。

## 检查命令

```bash
pnpm --filter @universal-harness-internal/core build
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/ledger packages/runtime/test/observability packages/runtime/test/doctor packages/cli/test/doctor.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
git diff --check
```

每步仅修改所列范围；已有测试正确行为作为回归，已证实错误行为改为 RED 用例。代码生成/全量发布结果另行实测，不将计划复选框当成证据。
