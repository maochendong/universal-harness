# 全量评审修复完成证据

- 日期：2026-08-23
- 受测代码基线：`ee9d47a`
- 范围：`e860f45` / `0530cba` 批准的 Full Review Remediation，WP0–WP5 及最终本地证据审计
结论：**仓库内实现与本地可复现证据完成；发布仍被 AC25 同 commit 三平台证据阻塞。当前环境未配置 DeepSeek 密钥，因此本轮真实 Provider dogfood 为 `not_verified`。**

本文件只引用命令结果、Git commit、结构化报告和 Ledger 标识，不把 Agent 自述当作完成证据。

## 1. 修复提交

| 工作包 | 提交 | 已落地结果 |
|---|---|---|
| WP0 | `b0da747` | 稳定 Capture、Criterion/Test/Assertion 与显式 executor 负契约 |
| WP1 | `b4added`、`2dbb6d5`、`7e370aa`、`ce75c38` | 宿主可信 Provider Registry、runtime config v3 引用、Managed Provider/Judge 秘密隔离和有界响应流 |
| WP2 | `420fc51`、`9aa3537`、`fd0a4e0`、`4ef69a8`、`ee9d47a` | Ledger DAG checkpoint、CapabilityPlan 生产路由、strict TDD execute 子图与生产三档证明 |
| WP3 | `cd08836` | FeedbackAnalysis 在 Verify/Evaluate/Audit runner 与 Change Seed 路由前生产接线 |
| WP4 | `8369492`、`279de98`、`36d0172`、`e270b52`、`88dbb5b`、`6cc72f4`、`7d3d2c2` | AC25 真实证据判定、三平台矩阵、自包含 Git fixture、standalone 扫描与 packaged CLI 三档闭环 |
| WP5 | `039bfb5` | Orchestration/CLI façade 拆分，状态机仍由原权威组件独占 |
| 回归收敛 | `fb5c84d` | 全套测试与 fail-closed runtime 契约对齐 |

## 2. 本地门禁实测

| 检查 | 结果 | 权威/可复现输出 |
|---|---|---|
| `pnpm build` | passed | 18/19 workspace package build；15 个公共 package export 解析通过 |
| `pnpm typecheck` | passed | 18/19 workspace package typecheck 通过 |
| `pnpm test` | passed | 345 test files，2182/2182 tests 通过 |
| `pnpm test:security` | passed | 11 files，72 tests 通过 |
| `pnpm test:fault` | passed | 14 files，84 tests 通过 |
| `pnpm test:performance` | passed | 8 files，12 tests 通过；阈值写入 M1 报告 |
| `pnpm test:e2e` | passed | 18 files，39 tests 通过 |
| `pnpm test:e2e:dashboard` | passed | 10 Playwright tests 通过 |
| `pnpm pack:smoke` | passed | clean host 中 new/adopt；无 executor 先 fail closed，配置显式 executor 后完成 |
| `node scripts/check-standalone.mjs` | passed | 当前文件及 commit/path/blob 历史扫描通过 |
| 受版本控制文件 Prettier | passed | `git ls-files -z \| xargs -0 pnpm exec prettier --check --ignore-unknown` |
| 排除用户自有 `teach/` 的 ESLint | passed | `pnpm exec eslint . --ignore-pattern 'teach/**'` |
| `node scripts/generate-acceptance-report.mjs` | expected non-zero | M1 27/28，只有 AC25 `not_verified`；M2 13/13 |

原样运行 `pnpm format:check` 与 `pnpm lint` 会扫描未跟踪、非本计划所有的 `teach/`：格式检查只报告其中 20 个文件，lint 只报告 `teach/assets/quiz.js` 的浏览器 `document` 全局。受版本控制内容分别通过等价检查；本计划遵守“不修改或提交 `teach/`”约束，因此未以修改用户资产制造全绿。

`pnpm test:release` 已依次通过 security、fault、performance、E2E、Dashboard 和 pack smoke，最终仅因验收生成器正确识别 AC25 平台工件缺失而退出 1。该退出是发布阻塞证据，不是实现测试失败。

## 3. 三档 packaged CLI 与 strict TDD 证据

命令：

```bash
node scripts/dogfood-three-profile-loop.mjs .reports/acceptance/three-profile-dogfood.json
```

结构化结果为 `passed`；三个 Profile 都由打包后的 CLI 在干净临时 host 中到达 completed Snapshot，Gate passed 且工作树干净。完整脱敏明细见 [三档 dogfood 证据](./full-remediation-three-profile-dogfood.md)。

| Profile | Operation | Snapshot digest | CapabilityPlan digest | 模型调用 | TDD |
|---|---|---|---|---:|---|
| Lite | `workflow_01M0QBT3RPCS2ME97SR9DN8ZZB` | `4c880abbb69b7b10a42e9c06fcd5934f1f9acf6a2c6eeab36d7bd06c6865b5e0` | `335bebb000bcd96c88384488a65421bab1a73949fb479a91bd004f0d66766c8f` | 0 | `not_enabled_by_profile` |
| Standard | `workflow_01M0QBTCCE2RD9KWZSA7993VFD` | `193a586775044dc7763242314dfb941f62d24043a9b77db3154b638512825f07` | `61ae8b75dbed4335cb6824b37a9861a618e6420fbcf6121200c9aca3f2ead914` | 9 | `controlled_not_applicable` |
| Governed | `workflow_01M0QBTSBFC15F13RKP98KJGHT` | `619f13c4e96fd2da8ced411d10dd244685bc95d279334d34f66e645169004197` | `73247fa537c419e13e2be472d6d57de1d453b99852fb1d584a2c8c218c013273` | 10 | `tdd_proven`，2 cycles |

Governed 通过公共 CLI host seam 注入隔离工作区 strict TDD runner；E2E 机械断言同一完成链包含 `baseline_test_result`、`red_test_result`、`green_test_result`，并在 Gate、Evaluation、TaskVerdict 与 Snapshot 之后才宣告完成。Standard 的 fixture 具有已批准 `non_executable_projection` exemption，因此不伪造 Red/Green。

## 4. 设计 §13 完成定义逐项审计

| # | 状态 | 证据 | 残余风险/说明 |
|---:|---|---|---|
| 1 | partial | §2 全套本地门禁；M1/M2 自动报告 | 受控代码全绿；全局 format/lint 被用户自有未跟踪 `teach/` 污染。release 只因 AC25 正确阻塞 |
| 2 | passed | `tests/security/model-invocation-boundary.test.ts`、`tests/security/judge-security.test.ts`、`adapters/gate-llm-judge/test/transport.test.ts` | 项目配置只能引用宿主 registry；响应流超限会取消 |
| 3 | passed | `packages/runtime/test/orchestration/capability-plan-routing.test.ts`、workflow checkpoint/supersession/fault suites | Protocol 1.1 由 accepted CapabilityPlan DAG 推进，未启用节点零调用 |
| 4 | passed | 三档结构化报告、`tests/e2e/three-profile-real-loop.test.ts`、Governed Ledger 标识 | baseline/red/green、Gate、Evaluation、TaskVerdict 在同一 packaged CLI 闭环中被断言 |
| 5 | passed | `packages/runtime/test/orchestration/feedback-analysis-wiring.test.ts`、Feedback coordinator/router 负向套件 | ambiguous Finding 才调用；确定性 RCA 零模型调用；required failure 保持 typed blocker |
| 6 | not_verified | `docs/m1-acceptance-report.md` AC25、`.github/workflows/ci.yml` | 判定逻辑和三平台矩阵已实现，但当前 commit 没有聚合后的 Ubuntu/macOS/Windows 三平台工件 |
| 7 | passed | `.reports/acceptance/three-profile-dogfood.json` 与 §3 脱敏投影 | hermetic packaged CLI 三档均 completed；本轮不是外部真实模型调用 |
| 8 | passed | standalone scan、本文和更新后的计划/架构状态 | 不再把 component-only 或本地结果写成跨平台发布完成 |
| 9 | passed | façade characterization tests、345/2182 全量回归 | façade 只委托既有 coordinator/engine，没有第二套状态机或 Profile 大分支 |

## 5. 外部未验证项与放行顺序

1. 将本文档提交推送后，对**同一个 commit**运行 GitHub Actions Ubuntu、macOS、Windows matrix；聚合 `.reports/ci-platform/*.json` 后重新运行验收生成器。只有 AC25 变为 `passed` 才可解除 M1 发布阻塞。
2. 当前环境没有 `DEEPSEEK_API_KEY`。`env -u DEEPSEEK_API_KEY node scripts/dogfood-three-profile-loop.mjs --real` 按契约退出 2；如要为当前版本补真实 Provider 证据，必须在受信 host 注入密钥后重跑并只提交脱敏标识与摘要。
3. `teach/` 为未跟踪用户资产，未修改、未暂存、未提交。若它将来进入仓库，应由其所有者单独修复格式与浏览器 ESLint 环境声明。

因此，当前可以声明“Full Review Remediation 的仓库内修复完成且本地证据通过”；不能声明“Protocol 1.1 已通过跨平台发布验收”或“当前 commit 已由真实 DeepSeek 再验证”。
