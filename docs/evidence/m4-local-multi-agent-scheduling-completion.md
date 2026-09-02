# M4 本地 Multi-Agent 调度完成证据

本文件由 `scripts/generate-acceptance-report.mjs` 从结构化测试结果、性能基线和真实 dsh dogfood Evidence 生成；结果区禁止人工改写。M4 必须 20/20 才能声明完成。

- 被评估实现 commit：`bdf00e9adaa527ac94286fc2c8e9ad378ba54825`
- 报告输入 commit：`bdf00e9adaa527ac94286fc2c8e9ad378ba54825`（包含本文件的 Git commit 由提交历史记录，避免 SHA 自引用）
- 汇总：16/20 通过，4 项阻塞

| AC | 必须证明的结果 | 命令 | Evidence digest | 结果 | 说明 |
|---|---|---|---|---|---|
| AC-01 | Plan 是 Task 规划语义唯一权威源，并原子生成全部 `DEPENDS_ON` 和 digest-bound waves。 | `pnpm test` | `d56e8d712a6e3203` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-02 | 循环、缺失依赖、不一致 wave 及不确定拆分被拒绝。 | `pnpm test` | `a7952d4f5830a40a` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-03 | 写路径与独占资源冲突被机械串行化。 | `pnpm test && pnpm test:performance` | `7e55664cb362ee2a` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-04 | `parallel_task_execution` 满足完整 Module Contract；Lite disabled，Standard/Governed required 并按有效上限并行。 | `pnpm test` | `59859b13891ce522` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-05 | 不合格 Adapter 不能无人值守并行。 | `pnpm test && pnpm dogfood:m4` | `b1e0f94146918d80` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-06 | 至少两个真实 Task 在隔离槽位并行。 | `pnpm dogfood:m4` | `f33e65117a890971` | blocked | 真实 dsh Adapter 仅支持受监督单槽位，未形成两个真实 Agent Run 的时间重叠证据 |
| AC-07 | Context、Budget、Run、worktree 和隐藏历史互不共享；Strict TDD 无嵌套 worktree 且 四层写集取交集。 | `pnpm test && pnpm test:e2e` | `c6b1688ee51eb837` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-08 | Task Lease、fencing、Protocol Envelope 和重启恢复无重复接受。 | `pnpm test && pnpm test:fault` | `1f23c400417c8169` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-09 | 并发预算预留不突破 Iteration 总上限。 | `pnpm test && pnpm test:e2e` | `fd1eac8586525762` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-10 | 三个调度 Action 及 Policy `allow/deny/requires_approval/block` 四态、Approval 漂移正确生效。 | `pnpm test && pnpm test:fault` | `30ea46b0161ffd25` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-11 | 三层 Gate 与 wave 原子集成成立。 | `pnpm test && pnpm test:e2e` | `1b7f6d6587559091` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-12 | executor retry 和 patch-apply integration retry 均最多一次；语义冲突与 baseline drift 不进入 retry。 | `pnpm test && pnpm test:fault` | `5f9a710657c94da8` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-13 | 第二次失败、越权写入和预算耗尽正确阻塞。 | `pnpm test && pnpm test:security` | `ce0656cfbcbfb464` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-14 | baseline drift 不会自动 force/rebase。 | `pnpm test:fault` | `1f23c400417c8169` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-15 | Evidence 绑定 Task、Run、Lease token 和实际基线；丢弃 candidate 后旧 Evidence provisional 且完整重验。 | `pnpm test && pnpm test:e2e` | `1b7f6d6587559091` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-16 | Dashboard 展示完整调度与恢复状态。 | `pnpm test && pnpm test:e2e:dashboard` | `f45db88be0cb49ac` | blocked | Dashboard 尚缺生产 Policy Proposal 入口、完整 grounded approval context 与 operation 级待取消任务投影 |
| AC-17 | CLI run/resume/status/watch/abort 形成闭环，CLI 与 Dashboard 对同一 Operation 保持 单驱动。 | `pnpm test && pnpm test:fault` | `ee39e72b335afdda` | blocked | driver 存活时批准不会自动唤醒，operation 级 durable cancellation 与 cancel digest/PolicyDecision 闭环尚不完整 |
| AC-18 | SQLite 删除后可从 Ledger 恢复权威状态。 | `pnpm test:performance` | `142464584a0f22d0` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-19 | Protocol 1.3 Envelope/Reader/`required_reader_version`、M1/M2/M3 与顺序执行回归全部通过。 | `pnpm test && pnpm test:e2e` | `b47d53a160c99814` | passed | 绑定测试与结构化 Evidence 已通过 |
| AC-20 | 真实 Dogfood 完成并生成绑定当前提交的验收报告。 | `pnpm test:release && pnpm dogfood:m4` | `98aa9488bb87c723` | blocked | 真实 dsh 未满足四 Task、至少两个并发 Task、至少两个 wave 的完整 Scheduler/Gate/Evaluate/Snapshot dogfood |

## 真实 dsh Evidence

- provider=dsh 0.1.0-rc.6；exit=0；监督探针=handoff/completion；requested concurrency=2，effective concurrency=1；blocker=real_adapter_unattended_ineligible。
- 发布报告不包含原始 transcript、凭据或机器绝对路径；只保存脱敏后的结构化结果与 digest。

M4 完成声明不成立；blocked/not_run 项必须补齐机器 Evidence 后重新生成。
