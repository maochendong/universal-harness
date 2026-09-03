# M4 本地 Multi-Agent 调度完成证据

本文件由 `scripts/generate-acceptance-report.mjs` 对 typed JSON sidecar 做纯投影生成；结果区禁止人工改写。M4 必须 20/20 才能声明完成。

- 被评估实现 commit：`07676db7803f2aa15030f6cfb0ee265e08b50586`
- 汇总：18/20 通过，2 项阻塞

| AC | 必须证明的结果 | Required suites / invocation | 命令 | Evidence digest | 结果 | 说明 |
|---|---|---|---|---|---|---|
| AC-01 | Plan 是 Task 规划语义唯一权威源，并原子生成全部 `DEPENDS_ON` 和 digest-bound waves。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8` | `pnpm test` | `8987ab8fb0c448bc` | passed | no extra readiness proof required |
| AC-02 | 循环、缺失依赖、不一致 wave 及不确定拆分被拒绝。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8` | `pnpm test` | `79d3653b2a6c63a0` | passed | no extra readiness proof required |
| AC-03 | 写路径与独占资源冲突被机械串行化。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>performance:`c1f2961f-db14-44ec-a6f2-cf62c8079ed4` | `pnpm test`<br>`pnpm test:performance` | `e9210729dd6e183a` | passed | no extra readiness proof required |
| AC-04 | `parallel_task_execution` 满足完整 Module Contract；Lite disabled，Standard/Governed required 并按有效上限并行。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8` | `pnpm test` | `bc3dedd9026fd297` | passed | no extra readiness proof required |
| AC-05 | 不合格 Adapter 不能无人值守并行。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8` | `pnpm test`<br>`pnpm dogfood:m4` | `ec7e1fc12ba0abdd` | passed | no extra readiness proof required |
| AC-06 | 至少两个真实 Task 在隔离槽位并行。 | - | `pnpm dogfood:m4` | `dcdc9a7c5b32922a` | blocked | real parallel overlap proof is incomplete |
| AC-07 | Context、Budget、Run、worktree 和隐藏历史互不共享；Strict TDD 无嵌套 worktree 且 四层写集取交集。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066` | `pnpm test`<br>`pnpm test:e2e` | `4c8527c0f772ce3d` | passed | no extra readiness proof required |
| AC-08 | Task Lease、fencing、Protocol Envelope 和重启恢复无重复接受。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>fault:`b2acb287-bc0f-47e7-a824-3fbbf4065faa` | `pnpm test`<br>`pnpm test:fault` | `fa2fe994ad0db376` | passed | no extra readiness proof required |
| AC-09 | 并发预算预留不突破 Iteration 总上限。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066` | `pnpm test`<br>`pnpm test:e2e` | `6835f7ae44916d24` | passed | no extra readiness proof required |
| AC-10 | 三个调度 Action 及 Policy `allow/deny/requires_approval/block` 四态、Approval 漂移正确生效。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>fault:`b2acb287-bc0f-47e7-a824-3fbbf4065faa`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `d1dfc2062a2f3ede` | passed | tests/e2e/m4-production-policy-source.test.ts passed in canonical e2e |
| AC-11 | 三层 Gate 与 wave 原子集成成立。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066` | `pnpm test`<br>`pnpm test:e2e` | `baa386de9fc42a21` | passed | no extra readiness proof required |
| AC-12 | executor retry 和 patch-apply integration retry 均最多一次；语义冲突与 baseline drift 不进入 retry。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>fault:`b2acb287-bc0f-47e7-a824-3fbbf4065faa` | `pnpm test`<br>`pnpm test:fault` | `4522075f30538584` | passed | no extra readiness proof required |
| AC-13 | 第二次失败、越权写入和预算耗尽正确阻塞。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>security:`092189b1-5544-427a-bc08-d8372ab267dd` | `pnpm test`<br>`pnpm test:security` | `c878ff33bac7b450` | passed | no extra readiness proof required |
| AC-14 | baseline drift 不会自动 force/rebase。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>fault:`b2acb287-bc0f-47e7-a824-3fbbf4065faa` | `pnpm test`<br>`pnpm test:fault` | `559e2f70c496ba8f` | passed | no extra readiness proof required |
| AC-15 | Evidence 绑定 Task、Run、Lease token 和实际基线；丢弃 candidate 后旧 Evidence provisional 且完整重验。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066` | `pnpm test`<br>`pnpm test:e2e` | `f51369945fce4897` | passed | no extra readiness proof required |
| AC-16 | Dashboard 展示完整调度与恢复状态。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>playwright-dashboard:`0d2cd491-0abb-43d2-96b5-00bf61b45ce9` | `pnpm test`<br>`pnpm test:e2e:dashboard` | `5b29bea08afd7049` | passed | tests/e2e/dashboard-m4-governed-controls.test.ts passed in canonical playwright-dashboard |
| AC-17 | CLI run/resume/status/watch/abort 形成闭环，CLI 与 Dashboard 对同一 Operation 保持 单驱动。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>fault:`b2acb287-bc0f-47e7-a824-3fbbf4065faa`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066` | `pnpm test`<br>`pnpm test:fault`<br>`pnpm test:e2e` | `e17bd2f3084981a1` | passed | tests/e2e/m4-live-driver-approval.test.ts passed in canonical e2e |
| AC-18 | SQLite 删除后可从 Ledger 恢复权威状态。 | performance:`c1f2961f-db14-44ec-a6f2-cf62c8079ed4` | `pnpm test:performance` | `ba25d87216b4204a` | passed | no extra readiness proof required |
| AC-19 | Protocol 1.3 Envelope/Reader/`required_reader_version`、M1/M2/M3 与顺序执行回归全部通过。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066` | `pnpm test`<br>`pnpm test:e2e` | `e0922a74f4b7fb39` | passed | no extra readiness proof required |
| AC-20 | 真实 Dogfood 完成并生成绑定当前提交的验收报告。 | main:`dfb9ae66-20cc-4af5-a074-d8177c3b26c8`<br>security:`092189b1-5544-427a-bc08-d8372ab267dd`<br>fault:`b2acb287-bc0f-47e7-a824-3fbbf4065faa`<br>performance:`c1f2961f-db14-44ec-a6f2-cf62c8079ed4`<br>e2e:`6c406767-813d-41ce-b712-5f7d64cb4066`<br>playwright-dashboard:`0d2cd491-0abb-43d2-96b5-00bf61b45ce9` | `pnpm test`<br>`pnpm test:security`<br>`pnpm test:fault`<br>`pnpm test:performance`<br>`pnpm test:e2e`<br>`pnpm test:e2e:dashboard`<br>`pnpm dogfood:m4` | `197d2f1dcc52a169` | blocked | full real Scheduler/Gate/Evaluate/Snapshot dogfood is incomplete |

## 真实 dsh Evidence

- provider=dsh；profile=headless；model=deepseek-v4-flash（dsh_session_request_context_and_assistant_source）；version expected=0.1.1-rc.2 / observed=0.1.1-rc.2；exit=0。
- credential source=project_dotenv_injected_process_env；material recorded=false；material hashed=false。
- backend=deepseek-official；requested model=deepseek-v4-flash（preexisting_process_env）；matches observed=true。
- Harness Adapter metering=unmetered；input/output/total=null/null/null（不代表 dsh 无调用）。
- dsh session observed calls=5；input/cache-read/output/reasoning/total=10776/42752/1082/501/54610；session digest=20845dc1a75b89f1。
- build commit=07676db7803f2aa15030f6cfb0ee265e08b50586；clean archive rebuild=true；runtime packages=13；provenance=3879159b15b99b4f。
- requested concurrency=2，effective concurrency=1；blocker=real_adapter_unattended_ineligible。
- 发布报告不包含原始 transcript、凭据或机器绝对路径；只保存脱敏后的结构化结果与 digest。

M4 完成声明不成立；blocked/not_run 项必须补齐机器 Evidence 后重新生成。
