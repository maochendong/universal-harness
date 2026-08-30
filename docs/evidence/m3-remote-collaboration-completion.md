# M3 远程协作完成证据

本文件由 `scripts/generate-acceptance-report.mjs` 从测试、Playwright、性能与真实平台 dogfood 的结构化输出生成；验收语句引用自 M3 设计第 22 节，结果区禁止人工改写。

- 生成基线 commit：`00886a6acfbdc0fb36014fa4b10dd64da0d6be97`
- 汇总：12/14 通过

| AC | 必须证明的结果（设计第 22 节） | 命令 | Exit | Evidence（sha256 前 12 位） | 结果 | Commit |
|---|---|---|---|---|---|---|
| M3-AC-01 | 从批准 Git Remote 自动识别 GitHub/GitLab/Gitee，无人工平台绑定 | `pnpm test` | 0 | packages/runtime/test/collaboration/remote-discovery.test.ts (`c63578fa6e3b`)<br>packages/conformance/test/collaboration.conformance.test.ts (`0d7bdba68372`) | passed | 00886a6 |
| M3-AC-02 | OAuth 主体形成稳定 Principal，Token 不进入任何持久化或日志 | `pnpm test && pnpm test:security` | 0 | packages/runtime/test/collaboration/oauth-session.test.ts (`0b1ac2eff5b3`)<br>packages/runtime/test/collaboration/platform-adapters.test.ts (`a44186b53406`)<br>packages/runtime/test/collaboration/sqlite-projection.test.ts (`c7dbbb650998`)<br>tests/security/m3-collaboration-boundary.test.ts (`46ac42e6cfb9`)<br>tests/security/m3-dogfood-redaction.test.ts (`6f2b9cd9dce9`) | passed | 497b725 |
| M3-AC-03 | 两个 Replica 可并行推进不同 Operation，互不覆盖 | `pnpm test && pnpm test:e2e` | 0 | tests/e2e/m3-remote-collaboration.test.ts (`c54a4cbd75ed`)<br>packages/runtime/test/collaboration/lease.test.ts (`5d56d84fba9b`)<br>packages/runtime/test/collaboration/coordinator-git.test.ts (`1886e75ea112`) | passed | 938a40b |
| M3-AC-04 | 同一 Operation 的旧 fencing token 在 Lease 过期后不能受管写入 | `pnpm test && pnpm test:e2e` | 0 | packages/runtime/test/collaboration/lease.test.ts (`5d56d84fba9b`)<br>tests/e2e/m3-remote-collaboration.test.ts (`c54a4cbd75ed`) | passed | 0d23ecf |
| M3-AC-05 | 断网允许本地准备，但不能更新 Control、Operation 受管状态或 Target | `pnpm test && pnpm test:e2e` | 0 | tests/e2e/m3-remote-collaboration.test.ts (`c54a4cbd75ed`)<br>packages/runtime/test/collaboration/coordinator-git.test.ts (`1886e75ea112`) | passed | 938a40b |
| M3-AC-06 | 有权限非提出者可批准；越权、自批、主体漂移和错误 digest 被拒绝；决定时有效的 snapshot 后续到期不单独使 Decision 失效 | `pnpm test && pnpm test:fault && pnpm test:security && pnpm test:e2e` | 0 | packages/runtime/test/collaboration/remote-approval.test.ts (`d994e72928a5`)<br>tests/fault/remote-approval-materialization.test.ts (`95220532d33e`)<br>tests/security/m3-collaboration-boundary.test.ts (`46ac42e6cfb9`)<br>tests/e2e/m3-remote-collaboration.test.ts (`c54a4cbd75ed`) | passed | 0d6fdd1 |
| M3-AC-07 | clean merge 后确定性解决 Ledger sequence 分叉，并重新执行 Graph、Impact、Freshness、Gate 与 Approval 校验 | `pnpm test && pnpm test:e2e` | 0 | tests/integration/m3-ledger-sequence-fork.test.ts (`4c555e8638fe`)<br>packages/runtime/test/collaboration/ledger-resequence.test.ts (`c7da3c90e66a`)<br>packages/runtime/test/collaboration/integration.test.ts (`fceed6bb1164`)<br>tests/e2e/m3-remote-collaboration.test.ts (`c54a4cbd75ed`) | passed | 0d23ecf |
| M3-AC-08 | 文本冲突、Gate 失败、权限撤销或 Target 漂移阻止错误 CAS | `pnpm test` | 0 | packages/runtime/test/collaboration/integration.test.ts (`fceed6bb1164`) | passed | 00886a6 |
| M3-AC-09 | Target CAS 成功但响应丢失时，重试不产生第二个 Integration | `pnpm test:fault` | 0 | tests/fault/integration-cas-recovery.test.ts (`89683f502d36`) | passed | 0d6fdd1 |
| M3-AC-10 | SQLite 可从 Git 重建，旧 Lease 不复活 | `pnpm test && pnpm test:performance` | 0 | packages/runtime/test/collaboration/sqlite-projection.test.ts (`c7dbbb650998`)<br>tests/performance/m3-control-ref-rebuild.test.ts (`79d02637be33`)<br>packages/runtime/test/collaboration/coordinator-git.test.ts (`1886e75ea112`) | passed | 1d4fb4c |
| M3-AC-11 | Protocol 1.2 向后读取 1.0/1.1；旧 Reader 对权威 1.2 记录类型化拒绝；未启用 M3 时零远程副作用 | `pnpm test` | 0 | packages/core/test/protocol/protocol-1.2.test.ts (`0e11a85711e5`)<br>packages/core/test/protocol/registry.test.ts (`fa61a92333d6`)<br>packages/cli/test/collaboration-commands.test.ts (`1d0775a04c86`) | passed | bbfe398 |
| M3-AC-12 | CLI 与 Dashboard 对连接、Approval 和 Conflict 呈现一致 | `pnpm test && pnpm test:e2e:dashboard` | 0 | packages/cli/test/collaboration-commands.test.ts (`1d0775a04c86`)<br>tests/e2e/dashboard-m3-collaboration.test.ts (`7b0fea6a7b00`) | passed | 959531c |
| M3-AC-13 | 三平台 Adapter 通过身份、权限与 Control Ref 保护 Conformance，且各有一次脱敏真实 dogfood | `pnpm test && node scripts/dogfood-m3-platform.mjs --provider github|gitlab|gitee` | - | packages/conformance/test/collaboration.conformance.test.ts (`0d7bdba68372`)<br>scripts/dogfood-m3-platform.mjs (`5669b162eb9a`)<br>scripts/dogfood-m3-redaction.mjs (`baa45d06e094`)<br>docs/evidence/m3-dogfood-github.json (`-`)<br>docs/evidence/m3-dogfood-gitlab.json (`-`)<br>docs/evidence/m3-dogfood-gitee.json (`-`) | not_run | 938a40b |
| M3-AC-14 | M1、M2、Protocol 1.1 全量发布门禁无回归 | `pnpm test:release` | - | scripts/generate-acceptance-report.mjs (`404b33d7691a`) | not_run | 938a40b |

## 三平台真实 dogfood（M3-AC-13）

- github：缺少 `docs/evidence/m3-dogfood-github.json`。
- gitlab：缺少 `docs/evidence/m3-dogfood-gitlab.json`。
- gitee：缺少 `docs/evidence/m3-dogfood-gitee.json`。

M3 尚有缺失或失败证据，发布退出门禁未通过。
