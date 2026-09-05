# M2 验收报告

本文件由 `scripts/generate-acceptance-report.mjs` 从测试、Playwright、性能与打包门禁的结构化输出生成；验收语句引用自 M2 设计第 15 节。

- 生成基线 commit：`82c3763`
- 汇总：13/13 通过

| AC | 范围 | 必须证明的结果 | 命令 | Evidence | 结果 |
|---|---|---|---|---|---|
| M2-AC-01 | M2-A 聚合 | Atlas 类 53 条 warning 不再平铺，组数/计数/样本正确 | `pnpm test && pnpm test:performance` | packages/runtime/test/finding/groups.test.ts<br>packages/cli/test/status.test.ts<br>tests/performance/m2-finding-semantic.test.ts<br>docs/evidence/m2-atlas-readonly-dogfood.md | passed |
| M2-AC-02 | M2-A 衰减 | 知识源刷新后 stale group 清零，历史仍可追溯 | `pnpm test` | packages/runtime/test/finding/decay.test.ts | passed |
| M2-AC-03 | M2-A 批处理 | digest 漂移零写入，同 digest 原子完成 | `pnpm test` | packages/runtime/test/finding/group-service.test.ts | passed |
| M2-AC-04 | M2-B 默认安全 | 未配置时零网络调用；配置后默认 advisory | `pnpm test` | packages/cli/test/project-runtime-config.test.ts<br>adapters/gate-llm-judge/test/transport.test.ts | passed |
| M2-AC-05 | M2-B blocking | 仅 approved Policy opt-in 后阻断 | `pnpm test` | packages/runtime/test/gates/llm-judge.test.ts<br>packages/cli/test/project-runtime-config.test.ts | passed |
| M2-AC-06 | M2-B replay | prompt/bundle/model/response digest 完整 | `pnpm test` | adapters/gate-llm-judge/test/provider.test.ts<br>adapters/gate-llm-judge/test/review-bundle.test.ts<br>adapters/gate-llm-judge/test/response.test.ts | passed |
| M2-AC-07 | M2-C 确定性 | 删除索引后候选及 digest 字节一致 | `pnpm test` | packages/graph/test/semantic/provider.test.ts<br>packages/conformance/test/semantic-seed-provider.test.ts | passed |
| M2-AC-08 | M2-C 人审 | 未 approve 不进活动图，approve 后才影响 inspect | `pnpm test` | packages/cli/test/impact.test.ts<br>packages/graph/test/semantic/graph-policy.test.ts | passed |
| M2-AC-09 | M2-D 事件 | Phase/Gate/Run/预算实时且脱敏，终态以 Ledger 为准 | `pnpm test && pnpm test:fault` | packages/runtime/test/observability/event-stream.test.ts<br>packages/runtime/test/observability/publisher.test.ts<br>tests/fault/event-stream-recovery.test.ts | passed |
| M2-AC-10 | M2-D Server | `harness serve` 本地启动，Graph/Impact/Iteration/Evidence 可用 | `pnpm test && pnpm test:e2e:dashboard && pnpm pack:smoke` | packages/dashboard/test/server.test.ts<br>packages/cli/test/serve.test.ts<br>tests/e2e/dashboard-readonly.test.ts | passed |
| M2-AC-11 | M2-D Approval | Web 决策走原服务并绑定 digest/actor，可 resume | `pnpm test && pnpm test:e2e && pnpm test:e2e:dashboard` | packages/dashboard/test/write-api.test.ts<br>tests/e2e/m2-vertical-loop.test.ts<br>tests/e2e/dashboard-live-approval.test.ts | passed |
| M2-AC-12 | 安全 | 非 loopback、伪造 Origin/CSRF、SSRF、XSS 被拒绝 | `pnpm test:security` | tests/security/dashboard-security.test.ts<br>tests/security/judge-security.test.ts | passed |
| M2-AC-13 | 发布 | 安装后的 CLI 包含 server 与 assets，无源码工作区依赖 | `pnpm verify && pnpm pack:smoke` | scripts/check-standalone.mjs<br>scripts/pack-smoke.mjs | passed |

## 纵向闭环 dogfood

已保存真实受管 fixture 的脱敏证据：`workflow_t0003` → `snapshot_7cb7e5dc124c72be`；Judge 调用 1 次，终态 completed，工作树干净。

## Full-remediation 三档闭环

Packaged CLI 已完成 Lite / Standard / Governed 三档闭环；三个终态均为 completed Snapshot、Gate passed 且工作树干净。脱敏清单见 `docs/evidence/full-remediation-three-profile-dogfood.md`。

M2 验收矩阵全部具有当前运行证据，发布退出门禁通过。
