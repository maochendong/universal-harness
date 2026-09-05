# M4 本地 Multi-Agent 调度完成证据

本文件由 `scripts/generate-acceptance-report.mjs` 对 typed JSON sidecar 做纯投影生成；结果区禁止人工改写。M4 必须 20/20 才能声明完成。

- 被评估实现 commit：`82c3763c07e40550e861e87d22c7b429f9ba8e91`
- 汇总：18/20 通过，2 项阻塞

| AC | 必须证明的结果 | Required suites / invocation | 命令 | Evidence digest | 结果 | 说明 |
|---|---|---|---|---|---|---|
| AC-01 | Plan 是 Task 规划语义唯一权威源，并原子生成全部 `DEPENDS_ON` 和 digest-bound waves。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10` | `pnpm test` | `4bd712343464a289` | passed | no extra readiness proof required |
| AC-02 | 循环、缺失依赖、不一致 wave 及不确定拆分被拒绝。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10` | `pnpm test` | `a4ad4a9dde05f7e0` | passed | no extra readiness proof required |
| AC-03 | 写路径与独占资源冲突被机械串行化。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>performance:`20d91baa-c274-498a-821b-632dad9564e3` | `pnpm test`<br>`pnpm test:performance` | `94c526c6353d4294` | passed | no extra readiness proof required |
| AC-04 | `parallel_task_execution` 满足完整 Module Contract；Lite disabled，Standard/Governed required 并按有效上限并行。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10` | `pnpm test` | `10e27704c77a9f54` | passed | no extra readiness proof required |
| AC-05 | 不合格 Adapter 不能无人值守并行。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10` | `pnpm test`<br>`pnpm dogfood:m4` | `db889bcf1d86f679` | passed | no extra readiness proof required |
| AC-06 | 至少两个真实 Task 在隔离槽位并行。 | - | `pnpm dogfood:m4` | `467f1871d51b69ba` | blocked | real parallel overlap proof is incomplete |
| AC-07 | Context、Budget、Run、worktree 和隐藏历史互不共享；Strict TDD 无嵌套 worktree 且 四层写集取交集。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91` | `pnpm test`<br>`pnpm test:e2e` | `290505facd30ba5b` | passed | no extra readiness proof required |
| AC-08 | Task Lease、fencing、Protocol Envelope 和重启恢复无重复接受。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>fault:`ede3733f-273e-4ef8-82b9-99b1b5f6cc27` | `pnpm test`<br>`pnpm test:fault` | `e07755e30d41f283` | passed | no extra readiness proof required |
| AC-09 | 并发预算预留不突破 Iteration 总上限。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91` | `pnpm test`<br>`pnpm test:e2e` | `d7c3c2436a17c01e` | passed | no extra readiness proof required |
| AC-10 | 三个调度 Action 及 Policy `allow/deny/requires_approval/block` 四态、Approval 漂移正确生效。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>fault:`ede3733f-273e-4ef8-82b9-99b1b5f6cc27`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `5c11da8f06bb7657` | passed | tests/e2e/m4-production-policy-source.test.ts passed in canonical e2e |
| AC-11 | 三层 Gate 与 wave 原子集成成立。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91` | `pnpm test`<br>`pnpm test:e2e` | `a3bfd51d341511b7` | passed | no extra readiness proof required |
| AC-12 | executor retry 和 patch-apply integration retry 均最多一次；语义冲突与 baseline drift 不进入 retry。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>fault:`ede3733f-273e-4ef8-82b9-99b1b5f6cc27` | `pnpm test`<br>`pnpm test:fault` | `5641b1dd57af574f` | passed | no extra readiness proof required |
| AC-13 | 第二次失败、越权写入和预算耗尽正确阻塞。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>security:`846a447a-5e05-487d-bec8-9652a8fba3b9` | `pnpm test`<br>`pnpm test:security` | `c3e2745233efc650` | passed | no extra readiness proof required |
| AC-14 | baseline drift 不会自动 force/rebase。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>fault:`ede3733f-273e-4ef8-82b9-99b1b5f6cc27` | `pnpm test`<br>`pnpm test:fault` | `28b5a15f3f1f1a10` | passed | no extra readiness proof required |
| AC-15 | Evidence 绑定 Task、Run、Lease token 和实际基线；丢弃 candidate 后旧 Evidence provisional 且完整重验。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91` | `pnpm test`<br>`pnpm test:e2e` | `9ef4a3d5a4c2c64d` | passed | no extra readiness proof required |
| AC-16 | Dashboard 展示完整调度与恢复状态。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>playwright-dashboard:`744bca7d-334a-4229-9bbb-6c0d27c99af3` | `pnpm test`<br>`pnpm test:e2e:dashboard` | `9bd225b4efb8334e` | passed | tests/e2e/dashboard-m4-governed-controls.test.ts passed in canonical playwright-dashboard |
| AC-17 | CLI run/resume/status/watch/abort 形成闭环，CLI 与 Dashboard 对同一 Operation 保持 单驱动。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>fault:`ede3733f-273e-4ef8-82b9-99b1b5f6cc27`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `6443a7bcb28f7ad0` | passed | tests/e2e/m4-live-driver-approval.test.ts passed in canonical e2e |
| AC-18 | SQLite 删除后可从 Ledger 恢复权威状态。 | performance:`20d91baa-c274-498a-821b-632dad9564e3` | `pnpm test:performance` | `4828469615f7cccc` | passed | no extra readiness proof required |
| AC-19 | Protocol 1.3 Envelope/Reader/`required_reader_version`、M1/M2/M3 与顺序执行回归全部通过。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91` | `pnpm test`<br>`pnpm test:e2e` | `512e49e91f579f69` | passed | no extra readiness proof required |
| AC-20 | 真实 Dogfood 完成并生成绑定当前提交的验收报告。 | main:`2e84bef5-b7c1-4a75-8113-52861460ed10`<br>security:`846a447a-5e05-487d-bec8-9652a8fba3b9`<br>fault:`ede3733f-273e-4ef8-82b9-99b1b5f6cc27`<br>performance:`20d91baa-c274-498a-821b-632dad9564e3`<br>e2e:`6a2b276f-d797-468d-b5be-462c5290fa91`<br>playwright-dashboard:`744bca7d-334a-4229-9bbb-6c0d27c99af3` | `pnpm test`<br>`pnpm test:security`<br>`pnpm test:fault`<br>`pnpm test:performance`<br>`pnpm test:e2e`<br>`pnpm test:e2e:dashboard`<br>`pnpm dogfood:m4` | `663e2c02fe03a6d8` | blocked | full real Scheduler/Gate/Evaluate/Snapshot dogfood is incomplete |

## 真实 dsh Evidence

- provider=dsh；profile=headless；model=deepseek-v4-flash（dsh_session_request_context_and_assistant_source）；version expected=0.1.1-rc.2 / observed=0.1.1-rc.2；exit=0。
- credential source=project_dotenv_injected_process_env；material recorded=false；material hashed=false。
- backend=deepseek-official；requested model=deepseek-v4-flash（preexisting_process_env）；matches observed=true。
- Harness Adapter metering=unmetered；input/output/total=null/null/null（不代表 dsh 无调用）。
- dsh session observed calls=6；input/cache-read/output/reasoning/total=10855/53504/1044/471/65403；session digest=ba7445b4fd6c89b5。
- build commit=82c3763c07e40550e861e87d22c7b429f9ba8e91；clean archive rebuild=true；runtime packages=13；provenance=69831b0d80268d6b。
- requested concurrency=2，effective concurrency=1；blocker=real_adapter_unattended_ineligible。
- 发布报告不包含原始 transcript、凭据或机器绝对路径；只保存脱敏后的结构化结果与 digest。

M4 完成声明不成立；blocked/not_run 项必须补齐机器 Evidence 后重新生成。
