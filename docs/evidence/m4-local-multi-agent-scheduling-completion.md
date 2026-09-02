# M4 本地 Multi-Agent 调度完成证据

本文件由 `scripts/generate-acceptance-report.mjs` 对 typed JSON sidecar 做纯投影生成；结果区禁止人工改写。M4 必须 20/20 才能声明完成。

- 被评估实现 commit：`4aa872dd1212ba6d80459b7f44c1e1021ccbb0cd`
- 汇总：18/20 通过，2 项阻塞

| AC | 必须证明的结果 | Required suites / invocation | 命令 | Evidence digest | 结果 | 说明 |
|---|---|---|---|---|---|---|
| AC-01 | Plan 是 Task 规划语义唯一权威源，并原子生成全部 `DEPENDS_ON` 和 digest-bound waves。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2` | `pnpm test` | `231ab6c6cf90c666` | passed | no extra readiness proof required |
| AC-02 | 循环、缺失依赖、不一致 wave 及不确定拆分被拒绝。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2` | `pnpm test` | `43e2d7d64fe4a7f3` | passed | no extra readiness proof required |
| AC-03 | 写路径与独占资源冲突被机械串行化。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>performance:`d5789934-86fd-4b66-88ca-fbe5c8ec3f7d` | `pnpm test`<br>`pnpm test:performance` | `200aef8bd0fc11e5` | passed | no extra readiness proof required |
| AC-04 | `parallel_task_execution` 满足完整 Module Contract；Lite disabled，Standard/Governed required 并按有效上限并行。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2` | `pnpm test` | `0b8cf160d8a31be9` | passed | no extra readiness proof required |
| AC-05 | 不合格 Adapter 不能无人值守并行。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2` | `pnpm test`<br>`pnpm dogfood:m4` | `eeec97fee773c3d0` | passed | no extra readiness proof required |
| AC-06 | 至少两个真实 Task 在隔离槽位并行。 | - | `pnpm dogfood:m4` | `656b73ed696deaf2` | blocked | real parallel overlap proof is incomplete |
| AC-07 | Context、Budget、Run、worktree 和隐藏历史互不共享；Strict TDD 无嵌套 worktree 且 四层写集取交集。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4` | `pnpm test`<br>`pnpm test:e2e` | `8225def378ba1eab` | passed | no extra readiness proof required |
| AC-08 | Task Lease、fencing、Protocol Envelope 和重启恢复无重复接受。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>fault:`b508fede-3709-4aa3-9d68-165f61056bf3` | `pnpm test`<br>`pnpm test:fault` | `640fbac893dae8b4` | passed | no extra readiness proof required |
| AC-09 | 并发预算预留不突破 Iteration 总上限。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4` | `pnpm test`<br>`pnpm test:e2e` | `4b755d283306a3e9` | passed | no extra readiness proof required |
| AC-10 | 三个调度 Action 及 Policy `allow/deny/requires_approval/block` 四态、Approval 漂移正确生效。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>fault:`b508fede-3709-4aa3-9d68-165f61056bf3`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `14d2d3ea040a1491` | passed | tests/e2e/m4-production-policy-source.test.ts passed in canonical e2e |
| AC-11 | 三层 Gate 与 wave 原子集成成立。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4` | `pnpm test`<br>`pnpm test:e2e` | `d556f49b4ed59086` | passed | no extra readiness proof required |
| AC-12 | executor retry 和 patch-apply integration retry 均最多一次；语义冲突与 baseline drift 不进入 retry。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>fault:`b508fede-3709-4aa3-9d68-165f61056bf3` | `pnpm test`<br>`pnpm test:fault` | `3fa0638410240198` | passed | no extra readiness proof required |
| AC-13 | 第二次失败、越权写入和预算耗尽正确阻塞。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>security:`54af3d7d-5003-434e-85de-550ccd173a38` | `pnpm test`<br>`pnpm test:security` | `0733fb6a8f0cb047` | passed | no extra readiness proof required |
| AC-14 | baseline drift 不会自动 force/rebase。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>fault:`b508fede-3709-4aa3-9d68-165f61056bf3` | `pnpm test`<br>`pnpm test:fault` | `bd5c0ffcadb69553` | passed | no extra readiness proof required |
| AC-15 | Evidence 绑定 Task、Run、Lease token 和实际基线；丢弃 candidate 后旧 Evidence provisional 且完整重验。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4` | `pnpm test`<br>`pnpm test:e2e` | `d1f0dd1efd3f182c` | passed | no extra readiness proof required |
| AC-16 | Dashboard 展示完整调度与恢复状态。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>playwright-dashboard:`6dfcddcc-36d8-4fa7-9a3f-8bab07ff24a8` | `pnpm test`<br>`pnpm test:e2e:dashboard` | `18435c4b0568c036` | passed | tests/e2e/dashboard-m4-governed-controls.test.ts passed in canonical playwright-dashboard |
| AC-17 | CLI run/resume/status/watch/abort 形成闭环，CLI 与 Dashboard 对同一 Operation 保持 单驱动。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>fault:`b508fede-3709-4aa3-9d68-165f61056bf3`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `0143e8d4acdcfca4` | passed | tests/e2e/m4-live-driver-approval.test.ts passed in canonical e2e |
| AC-18 | SQLite 删除后可从 Ledger 恢复权威状态。 | performance:`d5789934-86fd-4b66-88ca-fbe5c8ec3f7d` | `pnpm test:performance` | `80fdf56315506920` | passed | no extra readiness proof required |
| AC-19 | Protocol 1.3 Envelope/Reader/`required_reader_version`、M1/M2/M3 与顺序执行回归全部通过。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4` | `pnpm test`<br>`pnpm test:e2e` | `20d80dc595696c40` | passed | no extra readiness proof required |
| AC-20 | 真实 Dogfood 完成并生成绑定当前提交的验收报告。 | main:`c7c32bdd-141a-4599-8a23-7014b85ce4a2`<br>security:`54af3d7d-5003-434e-85de-550ccd173a38`<br>fault:`b508fede-3709-4aa3-9d68-165f61056bf3`<br>performance:`d5789934-86fd-4b66-88ca-fbe5c8ec3f7d`<br>e2e:`60a7e3c7-f642-4afa-b847-41bab554a7f4`<br>playwright-dashboard:`6dfcddcc-36d8-4fa7-9a3f-8bab07ff24a8` | `pnpm test`<br>`pnpm test:security`<br>`pnpm test:fault`<br>`pnpm test:performance`<br>`pnpm test:e2e`<br>`pnpm test:e2e:dashboard`<br>`pnpm dogfood:m4` | `52ba8234b2ae6687` | blocked | full real Scheduler/Gate/Evaluate/Snapshot dogfood is incomplete |

## 真实 dsh Evidence

- provider=dsh；profile=headless；model=deepseek-v4-flash（dsh_session_request_context_and_assistant_source）；version expected=0.1.1-rc.2 / observed=0.1.1-rc.2；exit=0。
- credential source=project_dotenv_injected_process_env；material recorded=false；material hashed=false。
- backend=deepseek-official；requested model=deepseek-v4-flash（preexisting_process_env）；matches observed=true。
- Harness Adapter metering=unmetered；input/output/total=null/null/null（不代表 dsh 无调用）。
- dsh session observed calls=4；input/cache-read/output/reasoning/total=10891/32128/1096/585/44115；session digest=81383e57c6b53d31。
- build commit=4aa872dd1212ba6d80459b7f44c1e1021ccbb0cd；clean archive rebuild=true；runtime packages=13；provenance=8b17ae9e04ddbdc5。
- requested concurrency=2，effective concurrency=1；blocker=real_adapter_unattended_ineligible。
- 发布报告不包含原始 transcript、凭据或机器绝对路径；只保存脱敏后的结构化结果与 digest。

M4 完成声明不成立；blocked/not_run 项必须补齐机器 Evidence 后重新生成。
