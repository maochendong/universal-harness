# M4 本地 Multi-Agent 调度完成证据

本文件由 `scripts/generate-acceptance-report.mjs` 对 typed JSON sidecar 做纯投影生成；结果区禁止人工改写。M4 必须 20/20 才能声明完成。

- 被评估实现 commit：`cee281c3f4df9f780ff0ec7fd81af6d7c6b8fafd`
- 汇总：18/20 通过，2 项阻塞

| AC | 必须证明的结果 | Required suites / invocation | 命令 | Evidence digest | 结果 | 说明 |
|---|---|---|---|---|---|---|
| AC-01 | Plan 是 Task 规划语义唯一权威源，并原子生成全部 `DEPENDS_ON` 和 digest-bound waves。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98` | `pnpm test` | `a2933c26a7c0e6b9` | passed | no extra readiness proof required |
| AC-02 | 循环、缺失依赖、不一致 wave 及不确定拆分被拒绝。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98` | `pnpm test` | `b1d59fb0c92a5fc5` | passed | no extra readiness proof required |
| AC-03 | 写路径与独占资源冲突被机械串行化。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>performance:`5d4ce77e-ab72-40bf-a9ef-1aaf9adbed77` | `pnpm test`<br>`pnpm test:performance` | `c6e4ba6be5ef4b4f` | passed | no extra readiness proof required |
| AC-04 | `parallel_task_execution` 满足完整 Module Contract；Lite disabled，Standard/Governed required 并按有效上限并行。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98` | `pnpm test` | `d99f673e5690951d` | passed | no extra readiness proof required |
| AC-05 | 不合格 Adapter 不能无人值守并行。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98` | `pnpm test`<br>`pnpm dogfood:m4` | `8d25c2b3b88b0136` | passed | no extra readiness proof required |
| AC-06 | 至少两个真实 Task 在隔离槽位并行。 | - | `pnpm dogfood:m4` | `0201b6685d4b6127` | blocked | real parallel overlap proof is incomplete |
| AC-07 | Context、Budget、Run、worktree 和隐藏历史互不共享；Strict TDD 无嵌套 worktree 且 四层写集取交集。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f` | `pnpm test`<br>`pnpm test:e2e` | `f465ad89b56a11d3` | passed | no extra readiness proof required |
| AC-08 | Task Lease、fencing、Protocol Envelope 和重启恢复无重复接受。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>fault:`36ca195f-1598-4c32-9b33-1e9de6f2c281` | `pnpm test`<br>`pnpm test:fault` | `68a00dc7ccf0255c` | passed | no extra readiness proof required |
| AC-09 | 并发预算预留不突破 Iteration 总上限。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f` | `pnpm test`<br>`pnpm test:e2e` | `847177d6ce06bc7e` | passed | no extra readiness proof required |
| AC-10 | 三个调度 Action 及 Policy `allow/deny/requires_approval/block` 四态、Approval 漂移正确生效。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>fault:`36ca195f-1598-4c32-9b33-1e9de6f2c281`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `db3f0c96ccc57468` | passed | tests/e2e/m4-production-policy-source.test.ts passed in canonical e2e |
| AC-11 | 三层 Gate 与 wave 原子集成成立。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f` | `pnpm test`<br>`pnpm test:e2e` | `a831e1eb8f01a5b4` | passed | no extra readiness proof required |
| AC-12 | executor retry 和 patch-apply integration retry 均最多一次；语义冲突与 baseline drift 不进入 retry。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>fault:`36ca195f-1598-4c32-9b33-1e9de6f2c281` | `pnpm test`<br>`pnpm test:fault` | `66e8b4c2bec450c8` | passed | no extra readiness proof required |
| AC-13 | 第二次失败、越权写入和预算耗尽正确阻塞。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>security:`375eee18-a163-4b6e-9c57-85928411ca0d` | `pnpm test`<br>`pnpm test:security` | `59e2a7b4e1c756f3` | passed | no extra readiness proof required |
| AC-14 | baseline drift 不会自动 force/rebase。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>fault:`36ca195f-1598-4c32-9b33-1e9de6f2c281` | `pnpm test`<br>`pnpm test:fault` | `e1980d3d3bfb47b8` | passed | no extra readiness proof required |
| AC-15 | Evidence 绑定 Task、Run、Lease token 和实际基线；丢弃 candidate 后旧 Evidence provisional 且完整重验。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f` | `pnpm test`<br>`pnpm test:e2e` | `53a62d03b32e2c7c` | passed | no extra readiness proof required |
| AC-16 | Dashboard 展示完整调度与恢复状态。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>playwright-dashboard:`601051b4-1850-4f07-8067-4be426115bab` | `pnpm test`<br>`pnpm test:e2e:dashboard` | `96c17d0d2d5e7b28` | passed | tests/e2e/dashboard-m4-governed-controls.test.ts passed in canonical playwright-dashboard |
| AC-17 | CLI run/resume/status/watch/abort 形成闭环，CLI 与 Dashboard 对同一 Operation 保持 单驱动。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>fault:`36ca195f-1598-4c32-9b33-1e9de6f2c281`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `a1a58d87c0c7f946` | passed | tests/e2e/m4-live-driver-approval.test.ts passed in canonical e2e |
| AC-18 | SQLite 删除后可从 Ledger 恢复权威状态。 | performance:`5d4ce77e-ab72-40bf-a9ef-1aaf9adbed77` | `pnpm test:performance` | `f87922b68280cadf` | passed | no extra readiness proof required |
| AC-19 | Protocol 1.3 Envelope/Reader/`required_reader_version`、M1/M2/M3 与顺序执行回归全部通过。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f` | `pnpm test`<br>`pnpm test:e2e` | `445d8bcbc66def22` | passed | no extra readiness proof required |
| AC-20 | 真实 Dogfood 完成并生成绑定当前提交的验收报告。 | main:`0831eec1-c884-43f7-8fb5-f5d21b802b98`<br>security:`375eee18-a163-4b6e-9c57-85928411ca0d`<br>fault:`36ca195f-1598-4c32-9b33-1e9de6f2c281`<br>performance:`5d4ce77e-ab72-40bf-a9ef-1aaf9adbed77`<br>e2e:`82bf5d6d-9ef8-4040-b689-645868d05a2f`<br>playwright-dashboard:`601051b4-1850-4f07-8067-4be426115bab` | `pnpm test`<br>`pnpm test:security`<br>`pnpm test:fault`<br>`pnpm test:performance`<br>`pnpm test:e2e`<br>`pnpm test:e2e:dashboard`<br>`pnpm dogfood:m4` | `7584c10b539a206d` | blocked | full real Scheduler/Gate/Evaluate/Snapshot dogfood is incomplete |

## 真实 dsh Evidence

- provider=dsh；profile=headless；model=deepseek-v4-flash（dsh_session_request_context_and_assistant_source）；version expected=0.1.1-rc.2 / observed=0.1.1-rc.2；exit=0。
- credential source=project_dotenv_injected_process_env；material recorded=false；material hashed=false。
- backend=deepseek-official；requested model=deepseek-v4-flash（preexisting_process_env）；matches observed=true。
- Harness Adapter metering=unmetered；input/output/total=null/null/null（不代表 dsh 无调用）。
- dsh session observed calls=4；input/cache-read/output/reasoning/total=10787/31360/630/223/42777；session digest=e01dd0d4cb2ecebd。
- build commit=cee281c3f4df9f780ff0ec7fd81af6d7c6b8fafd；clean archive rebuild=true；runtime packages=13；provenance=5fb91e4d726b01b8。
- requested concurrency=2，effective concurrency=1；blocker=real_adapter_unattended_ineligible。
- 发布报告不包含原始 transcript、凭据或机器绝对路径；只保存脱敏后的结构化结果与 digest。

M4 完成声明不成立；blocked/not_run 项必须补齐机器 Evidence 后重新生成。
