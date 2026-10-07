# Jev Impact Advisory 本地验收记录

实施与首轮验收日期：2026-09-28；收尾复核日期：2026-10-03。状态：J1–J3 代码与 Mock 闭环已完成，最终全量 3,570/3,570 与 Dashboard 41/41 通过；聚合 verify 仍有既有格式阻塞，不代表全部发布门禁或真实 Provider 已验收。

基线：`fc14fc9ba4314b9ae3051f4d9eea72a3dee2ecdc`。范围为 [J1–J3 实施计划](../superpowers/plans/2026-09-28-jev-impact-advisory-implementation-plan.md)。本记录区分本地测试结果与真实供应商验证；本轮只使用 Mock HTTP，没有读取真实 key、调用付费 Provider、修改项目配置、提交或推送。

2026-10-07 发布授权更新：用户要求检查本地版本并 commit/push。下文“未提交/未推送”描述的是 10 月 3 日验收时的工作树；此次将 Jev 实现、测试与五份相关文档纳入提交。原有 `artifact-reference-coverage.md`、`.agents/`、`skills-lock.json` 保持在提交范围外。此次发布不扩大真实模型调用或项目配置授权，也不将旧测试日期改写为今天。

## 实施前基线

命令（仓库根目录）：

```sh
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/model/provider-registry.test.ts packages/runtime/test/model/impact-advisory-adapter.test.ts packages/runtime/test/model/managed-runner.test.ts packages/runtime/test/orchestration/impact-advisory.test.ts packages/cli/test/model-providers.test.ts
```

结果：5 个测试文件、38 个测试通过，耗时 4.46 秒。首次普通 sandbox 启动因 Vite 缓存目录写入 `EPERM` 失败；经合法权限升级重跑通过。前一次属于环境启动失败，不计为 TDD red 证据。

## J1：本地验收与独立复审通过

所有路径相对于仓库根目录；以下 red 均为预期行为缺失，不含 sandbox 启动失败。

| 纵向测试 | Red → Green（2026-09-28 本地时间） | 结果 |
| --- | --- | --- |
| Core 新输出 Schema | 21:51 unknown schema → 21:52 | 首例通过，后续严格负例共 6 项 |
| Graph contract | 21:53 缺新模块 → 21:54 | Schema + contract 2 files / 7 tests |
| Runtime 传输与绑定 | 21:55 缺模块 → 21:56；绑定错配 red → 21:57 | 2 项通过 |
| HTTP 失败归一 | 21:58 7 项失败 → 最小实现 | 累计 9 项通过 |
| 原始输出验证 | 21:59 15 项失败 → 22:00 | 累计 26 项通过 |
| 缺 key、取消、网络异常 | 22:01 4 项失败 → 最小实现 | 累计 30 项通过 |
| 响应流限制与取消 | 22:02 2 项失败 → 22:03 | 累计 33 项通过 |
| 单次闭包与原生重定向失败 | 22:05 2 项失败 → 22:06 | Provider 最终 41 项通过 |
| 合成 TypeSafe 密钥边界 | 22:04 1 项失败 → 最小实现 | source-boundary 9 项通过 |

限定回归命令：

```sh
pnpm exec vitest run --config vitest.workspace.ts packages/core/test/schema packages/graph/test/impact/jev-prompt-contract.test.ts packages/runtime/test/model/jev-impact-provider.test.ts packages/runtime/test/model/source-boundary.test.ts packages/runtime/test/model/managed-runner.test.ts
```

实现者初次实测：19 files / 131 tests 通过；`pnpm build`、`pnpm typecheck`、J1 文件 ESLint 均退出 0。Schema 生成仅新增 `jev-impact-judgments.schema.json`，未改变旧 Schema/golden。

独立 Spec 审查发现 1 项 P2：缺少合法多 Choice 的成功/回放覆盖。已补双候选 `affected + insufficient` 经真实 compiler/runner 单次发送、原始分布完整持久化、二次回放零新增 HTTP。另以红测实证并修复候选重复、questions/candidates 集合不一致的绑定缺口：调用前拒绝，零 HTTP。独立复核已关闭 P2，无新增问题。Standards 轴未发现需整改项。

修复后 `pnpm build` 通过；主代理于 22:12 独立复跑同一限定命令：**19 files / 133 tests 通过，退出 0，3.42 秒**（Provider 43 项）。J1 本地验收通过，不代表真实 Provider 或完整 J1–J3 已验收。

## J2 本地验收与复审

- 首条投影测试先因新模块缺失失败；主代理于 22:15 通过原权限审批机制重跑，1 file / 1 test 通过。子代理两次审批服务 HTTP 403 均未执行对应操作；未改变 sandbox 或缓存路径绕过，后续由正常获批调用继续。
- 完整候选来源/白名单校验按切片推进。20 个长 ID 候选、精确 16,384-byte state 在旧重复指令下三档均触发 source boundary 红测；精简未发布 Jev contract 的重复文本后，三档通过原有 32 KiB 单 item 限制，没有提高预算、截断输入或自动分批。
- 22:28 实施者限定回归：input 26 + provider 43 + contract 1，共 70 项通过。J2 Port/恢复与映射尚待最终集成，不据此标记 J2 完成。
- 恢复切片 22:39 的 14 项测试中 5 项红测，经 Jev 局部 guard 修复后 14/14；随后补齐原始结果损坏、失效缓存、同 attempt 更换绑定、planned/failed 回放和整批补证。
- 交叉复审共 4 项 P2：注册表已知错误需转换为准备失败；JSON 转义隐藏 Windows 用户路径；空白 DesignArtifact 被当作有业务内容；映射后缺少领域输出 Schema 校验。均补 red→green，并由审查者逐项复核关闭。未知异常未被兜底吞掉，共享 Runner 未修改。
- 22:45 主代理复跑 J2 限定范围：**18 files / 177 tests，退出 0，4.67 秒**；其中 input 30、mapping 42、adapter 25。`pnpm build` 与 `pnpm typecheck` 退出 0；22:46 J1 再回归 **19 files / 133 tests**，3.41 秒。
- 独立性说明：Spec 审查者曾编写最初极小的 input starter，故不宣称其完全独立；最终扩展实现、mapping、恢复 guard 和跨模块边界经交叉审查，另有非作者 Standards 检查及主代理全文件复核。

## J3：红测、实现与复审

```sh
pnpm exec vitest run --config vitest.workspace.ts packages/runtime/test/orchestration/impact-advisory.test.ts -t 'blocks instead of approving'
```

2026-09-28 22:02（本地时间）：退出码 1，1 failed / 4 skipped。断言要求已启用的 advisory 失败时拒绝继续，实际 Promise 返回原 proposed ImpactSet；这是原实现吞掉失败的真实行为红测。仅提前准备该测试，生产阶段接线仍待 J1/J2 验收后完成。

J3.5 浏览器预备红测（沿用原临时项目、真实 ModelInvocation Store/Read API，无内部 API mock）：

```sh
pnpm exec playwright test --config playwright.dashboard.config.ts tests/e2e/dashboard-live-approval.test.ts --grep 'project-level model invocation'
```

结果：退出码 1，1 failed，8.0 秒。目标“项目级模型调用记录”区域不存在；临时 Dashboard 与 21 条合成调用记录均正常启动。单条纵向测试后续还将验收分页、用量缺失、安全文本、引用复制与新身份刷新。当前仅观察到第一个缺失区域断言，不能将后续未到达断言计为通过。

22:36 阶段边界扩展红测：`impact-advisory.test.ts -t 'impact contributor advisory wiring'`，7 failed / 3 passed / 1 skipped。失败与补证以及五类失败原因仍返回成功；未知编程异常原样传播测试已绿。

22:39 新增真实临时 Git 项目流水线测试 `jev-impact-pipeline.test.ts`，3 failed / 3 passed（14.86 秒）：affected/unrelated 整体审批与冻结、无 Advisory 的确定性路径已通；insufficient、HTTP 失败未阻塞，以及零候选诊断不存在构成三条行为红测。仅 HTTP 使用 Mock，Ledger、PromptCompiler、ManagedInvocationRunner、审批与 resume 均使用实际实现。

22:49 最小阶段接线后，同两份阶段测试 **2 files / 21 tests 通过，15.80 秒**。后续继续补诊断恢复、显式配置切换与 CLI/UI 综合验收，尚不代表完整 J3 完成。

### 配置、阶段与界面收口

- 配置层已完成 V3 显式 `typesafe` 选择、唯一 Impact contract selector 和全部 resolver consumer 的判别收窄。拒绝 default、其他槽位、V2 inline、模型/宿主信任错配；其他 Provider 摘要未轮换。CLI 限定回归 **8 files / 95 tests** 通过。
- Mock 纵向测试使用真实 PromptCompiler、ManagedInvocationRunner、Ledger、审批和 resume，只有供应商 HTTP 被替换。覆盖 affected/unrelated 后仍等待整体 ImpactSet 审批、insufficient 阻塞、HTTP 失败后显式新 attempt、零候选零调用留诊断、unsupported 提示显式切换配置、Lite 未配置的确定性路径。
- 两项阶段恢复 P2 已先补反例再修复：落盘但尚未进入 manifest 的 proposed/diagnostic 不能当作已提交；仅外层摘要合法但业务内容被改动的旧 ImpactSet 不能复用。实现按已提交 manifest 核查，原子补入内容相同的孤立产物，对业务内容不一致明确阻塞。没有增加公共事件、共享 Runner 重构或自动重试。
- 一项安全断言 P3 已补齐：不只检查阻塞 reason，还核查返回 detail、错误消息与 WorkingState 均不泄露合成敏感输入。
- Live 页面接入现有 Read API，明确标注“项目级模型调用记录，不代表当前迭代证据”；分页、刷新、失败提示、缺失 usage、纯文本渲染和可复制结果引用均纳入浏览器验证。没有从 ID 猜 operation 归属，也没有把磁盘路径当作任意文件读取接口。
- J3 交叉 Spec 与非作者 Standards 复核通过，以上问题均已关闭。先前 Live/Approval 专项 **9/9** 和 assets 单测 **10/10** 通过；最终完整浏览器套件另列在门禁表，不用专项代替全量。

### 首轮全量失败与修复复验

2026-09-28 首次全量运行结果是 **438/442 files、3,559/3,564 tests 通过**，并非一次全绿。失败涉及新增第 12 个 prompt contract 的 help/golden 预期、三档真实闭环及开发中的孤立产物反例。处理如下：

1. help 数量由 11 改为 12；golden 从 33 条增加到 36 条，仅新增 Jev 的三档编译结果。逐项核对原有 33 条 golden 与基线一致，未用批量刷新掩盖旧行为变化；相关 **17/17** 通过。
2. 三档闭环暴露原生成式 Impact Adapter 的恢复身份问题：新 attempt 使用新 run/input，却复用旧 conversation；现在以 workflow + attempt 派生 conversation，保留跨 attempt 隔离，不改共享 Runner。真实 generic Adapter 的双 attempt 反例先红后绿；未改原三档 fixture，**Lite/Standard/Governed 完整闭环 1/1 通过，57.44 秒**。
3. 本机旧 npm 与 Node 22 的环境不兼容另行排除，最终命令使用下列 PATH；不修改系统许可证或全局配置。
4. 孤立产物及摘要合法的内容篡改反例修复后通过。稳定树的 `impact-advisory.test.ts` 为 **16 tests**、`jev-impact-pipeline.test.ts` 为 **10 tests**，均包含在最终全量结果中。

稳定树全量命令：

```sh
PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH pnpm test --reporter=default --reporter=json --outputFile.json=.reports/jev-vitest-final.json
```

**2026-09-28 23:14:21–23:22:31（UTC+8）：442/442 files、3,565/3,565 tests 通过，退出 0，489.98 秒；无 failed/pending。** 2026-10-03 收尾时读取原进程退出结果与 JSON，二者一致；这不是声称 10 月 3 日又重跑了一次全量。

本地报告 `.reports/jev-vitest-final.json` 的 SHA-256：`fd8a0f69f00c9cc89ab17e6a6a131bf376282f924fe64bc0ccd6929807089fcf`。报告未提交，可能被后续本地清理移除；此摘要只用于核对本次文件，不是远端 CI 或 Ledger 证明。

### 10 月 3 日最终审计补漏

文档—实现交叉复核发现并关闭一项 P2：设计 §3.1 承诺排除数量和原因，但原实现只在零候选路径返回总数，正常结果无诊断。没有删除设计承诺；补齐本地互斥原因计数，并通过原阶段 artifact/manifest 记账，不改变模型请求、编译绑定、原始结果 Schema、传播与审批。

- 输入：混合排除原因的新增反例于 13:15:28 失败（ready 无诊断），修复后通过；零候选、重叠原因优先级与节点乱序也验证。
- Adapter：正常结果及缓存回放、零候选各自先红后绿；新增被排除 Run 后，本地统计更新，HTTP 数和已有调用记录不增加。输入与 Adapter 最终 **2 files / 56 tests**，13:19:40 通过，1.74 秒。
- 阶段：13:11:37 正常候选诊断反例失败，13:12:58 通过；另补 3 项非法计数拒绝用例。真实 affected 流水线于 13:14:05 因缺诊断产物失败，随后 affected/unrelated 均证明诊断进入 manifest 后才等待整体审批。
- 主代理于 13:20:39 整组复验：`jev-impact-input`、`jev-impact-adapter`、`impact-advisory`、`jev-impact-pipeline`，**4 files / 86 tests，退出 0，26.17 秒**。
- Spec 独立复核关闭该 P2；非作者 Standards 复核通过。input/adapter 与 phase 各自有独立审查者，审查者只读，不把其反馈误记为测试执行。
- mapping 的手写 ready 测试 fixture 机械补齐诊断字段；不更改 mapping 的生产规则。随后最终 build、typecheck、pack smoke、lint 与独立性扫描均退出 0。

最终代码/测试快照包含相对 HEAD 已变更及未跟踪的 `packages/`、`tests/` 文件共 **46 个**。按路径排序，对每文件取 SHA-256，再将 `{path,sha256}` 数组经 `JSON.stringify` 后取 SHA-256，结果为 `bc4f499edd5867ac7d1f71d31954ab2b42cedce762c359a1f7fc858b679c89c7`。此范围不含文档、已有技能安装或构建输出；避免用同一个未变 HEAD 冒充已提交实现。

### Standards

最终复审未发现未关闭的硬性规范问题；本地统计采用固定字段复制，拒绝非法数量与状态组合，沿用现有原子产物和冲突检查，没有扩大模型权限或新增通用框架。

### Spec

本次已识别的范围、来源验证、结果校验、恢复及排除审计问题均关闭；真实 Provider 和实际项目图适配不在本轮验证范围。Spec 与 Standards 分别记录，不以其中一轴通过替代另一轴。

## 最终门禁

下列检查独立运行，不能合并表述为 `pnpm verify` 成功。2026-10-03 文档复核后发现并补修候选排除统计；修复前后的验证范围分别记录，不把旧全量结果冒充最终工作树验证。

| 检查 | 实测结果 | 时间/边界 |
| --- | --- | --- |
| `pnpm test` | 最终 442 files / 3,570 tests 通过，退出 0，542.68 秒 | 10 月 3 日 13:22:26–13:31:29（UTC+8），补修后的工作树 |
| `pnpm test:security` | 17 files / 114 tests 通过，11.60 秒 | 9 月 28 日独立专项；10 月 3 日最终全量再次覆盖同 17 files / 114 tests，全部通过 |
| `pnpm test:fault` | 20 files / 113 tests 通过，32.39 秒 | 9 月 28 日独立专项；10 月 3 日最终全量再次覆盖同 20 files / 113 tests，全部通过 |
| `pnpm lint` | 退出 0 | 10 月 3 日最终补修后重跑 |
| `node scripts/check-standalone.mjs` | 退出 0 | 10 月 3 日补修后重跑 |
| `pnpm pack:smoke` | 退出 0，含最终 build | 10 月 3 日补修后重跑；离线安装、CLI binary、ESM exports、new/adopt 闭环均通过 |
| `pnpm typecheck` | 退出 0 | 10 月 3 日补修后最终工作树 |
| `pnpm verify` | 退出 1；仅 `.agents/skills/typesafe-ai/SKILL.md` 格式告警 | 10 月 3 日重跑；在 format:check 阶段停止，未假定后续子命令执行 |
| `pnpm test:e2e` | 24 files / 73 tests 通过，198.76 秒，退出 0 | 10 月 3 日独立专项；补修后最终全量再次覆盖同 24 files / 73 tests，全部通过 |
| `pnpm test:e2e:dashboard` | 6 files / 41 tests 通过，3.2 分钟，退出 0 | 10 月 3 日；完整 Playwright 套件，UI 未因随后诊断补修改变 |

10 月 3 日补修后 `pnpm format:check` 再次退出 1，仍只有同一个既有 TypeSafe 技能文件；本轮代码、测试无新增格式告警。最终全量报告 `.reports/jev-vitest-20261003-final.json`：success=true、failed=0、pending=0，SHA-256 为 `dc95b32fd3ea0a8dbe3024c4e2e364f8139851d4d1f3f5fe01b44d618bc4d240`。再次计算 46 个实现/测试文件的快照摘要，与上文一致，证明最后全量期间未继续修改被测代码。

Dashboard 的本地结构化报告为 `.reports/acceptance/playwright-dashboard.json`（coverage=full、status=passed，6 files、0 failed），截图为 `.reports/playwright-results/dashboard-live-approval-Da-6b0dd-ecovered-Jev-attempt-safely/jev-model-invocations-desktop.png`。主代理已目视检查；它们记录未提交工作树，不冒充 clean commit 证明。最终文档本地链接、`git diff --check` 与独立性扫描也通过。

## 剩余限制与交付状态

- 聚合 `verify` 的既有技能文件格式问题仍未解决。本轮不修改无关 `.agents/`，也不增加 ignore；需由该文件的维护工作单独处理后再取得聚合全绿。
- 未对用户实际项目图做投影适配检查，也未调用真实 TypeSafe Provider；没有生产准确率、成本、时延或真实凭据连通结论。此前 shadow 实验不能替代当前 Adapter 验收。
- 保留首版明确限制：单种子、至多 20 个候选、16 KiB state、权威业务字段白名单。超限/不支持来源会阻塞，不自动截断、分批或切换 Provider。
- 全部交付仍是基线 `fc14fc9ba4314b9ae3051f4d9eea72a3dee2ecdc` 之上的未提交工作树；没有修改实际项目配置，没有提交或推送。

## 证据边界

- 本文是本地执行记录，不是已提交的不可变 Ledger 或远程 CI 证据。
- 已有 `artifact-reference-coverage.md`、`.agents/`、`skills-lock.json` 变更不属于本次交付，保持原样。
- 先前独立的 Jev shadow 实验不作为当前受管 Adapter 集成的验收依据。

## 已发现的基线环境项

`pnpm exec prettier --check .agents skills-lock.json` 退出 1，报告已有未跟踪 `.agents/skills/typesafe-ai/SKILL.md` 格式不符合 Prettier；`skills-lock.json` 未报错。该技能安装文件在本轮开始前已存在，本轮不改它，也不修改 ignore 规则掩盖门禁。最终仍执行原 `pnpm verify`；若此项阻塞聚合命令，应分别记录其他门禁结果，而非宣称聚合门禁全绿。
