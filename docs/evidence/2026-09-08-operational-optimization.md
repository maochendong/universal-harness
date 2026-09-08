# 运行可靠性与使用成本：本轮验证记录

日期：2026-09-08；实施基线：`20846174e45b35e2675ffea431f5089156234b41`。
本记录采集自当时的**未提交工作区**，随本轮改动入库；不是已发布版本或新的不可变里程碑验收报告。
验证时的源码状态不因后续提交而改写，实际提交和推送状态以 Git 历史及远端引用为准。

## 已完成的改动

1. 事件只从有效已提交 manifest 读取，共用 core 的 Schema、字节 digest、事务绑定和分片内序号检查。
   未提交分片不可见；损坏的权威文件报错，不能静默返回部分成功。未知类型仅在完整信封和 digest 有效时由观察器跳过，严格 Ledger replay 仍拒绝。
2. 位置游标替代“时间戳 + 字符串 ID”排序锚点。相同时间戳的 1～12 不漏项，迟到事件继续送达，
   重启/历史替换 reset，Live→Ledger 替换保留恢复锚点。UTF-8 半行保留到完整换行后解析。
3. 分离文件缓存、交付索引和公共读取接口；预热后未变化的轮询不再读取历史内容。
   `refreshView().read()` 无文件 I/O，可固定本次读取上界。没有添加新服务或整体改写 Coordinator。
4. Live Spool 缓存编码记录与累计字节；追加不再重读全部保留记录，保持窗口、字节上限和外部变化重载。
5. `harness doctor` 显示 Agent 控制、轨迹、用量、resume 和单槽限制；预检不运行模型。
   README/快速开始不再承诺固定两次审批，不嵌入过期完成计数，并给出经验证的固定 dsh 版本准备方式。
6. Release CI 删除完整 `test:release` 前重复的 `test` 与 `pack:smoke`。
   canonical 发布命令链、三平台任务及证据上传要求不变。

## 测试结果

| 检查                                                 | 本机结果                                              |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `pnpm build`                                         | 通过；15 个 workspace public exports 解析通过         |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | 通过                                                  |
| `pnpm test`                                          | 424 文件、3186 测试全部通过，451.13 秒                |
| `pnpm test:performance`                              | 14 文件、19 测试全部通过，81.37 秒                    |
| `pnpm test:e2e:dashboard`                            | Chrome，17 测试全部通过，约 1.1 分钟                  |
| `pnpm pack:smoke`                                    | 离线安装、CLI binary、ESM exports、new/adopt 闭环通过 |
| `node scripts/check-standalone.mjs`                  | 当前文件和历史扫描通过                                |
| `git diff --check`                                   | 通过                                                  |

验证过程保留了真实 RED：
同时间戳 12 条逐页读取原先只得到 1～9；orphan shard 原先被暴露为权威事件；
预热追加原先仍读取历史文件；空 event_type 原先误被未知事件兼容路径跳过。对应回归现均通过。
首轮全量为 3183 通过、2 失败：旧故障 fixture 没有提交 manifest，且精确断言旧页面结构。
改为真实 Ledger fixture 和向后兼容的页面字段断言后，第二轮全量通过；未放宽权威校验。

原报告完整性检查也通过，但它校验的是既有 `2084617 → cee281c` 报告拓扑，**不证明本轮改动已通过远端 CI**。
本轮没有运行发布聚合并覆盖既有 M1～M4 权威完成报告。普通全量中含 security/fault/E2E 测试，但不冒称每个 canonical suite 都重新生成了发布级证明。

## 性能：实际测量范围

同一文件，20 次预热、200 次采样；本机 Node.js 22.23.1/macOS，独立运行性能套件：

| 场景                   | p95 / 总耗时   |
| ---------------------- | -------------- |
| 1,000 条历史，空轮询   | p95 0.064 ms   |
| 100,000 条历史，空轮询 | p95 0.068 ms   |
| 单流 1,000 次追加      | 总计 89.30 ms  |
| 单流 10,000 次追加     | 总计 819.10 ms |

追加测量在进入持续淘汰前完成；满窗口压缩仍会重写保留窗口。
目录发现仍为 O(F)，变化后的合并仍可能为 O(E)，没有宣称全面常数复杂度。
原 SSE 计划的 1k/10k manifest 对、100k 事件 RSS、四客户端共享工作量和浏览器实时延迟专门门槛仍待验证。

## 唯一一次真实 Provider 小任务

完整脱敏记录：[supervised-provider-probe.json](2026-09-08-supervised-provider-probe.json)。

- dsh expected/observed：`0.1.1-rc.2`；dsh 会话请求和响应身份：`deepseek-official / deepseek-v4-flash`。
- 1 个 Agent Task、0 次 Task 自动重试，约 17.3 秒。
- 独立文件核对：`src/dogfood/probe.ts` 精确字节 SHA-256 一致；无越界文件、无 Git HEAD 改动；
  唯一额外文件为 Harness 允许的原始 transcript。
- 一个任务内部有 4 次模型请求。会话观测：10,368 input、31,104 cache-read input、827 output，总计 42,299 tokens；
  reasoning 433 已含在 output 中，不重复求和。这不是费用金额。
- Adapter 自身仍为 unmetered，token 字段为 null。任务信封的 20k token 限额并未被它强制执行；
  事后会话观测超出该值，不能把配置限额当成执行保证。时长限制为 180 秒。
- 配置准备只将固定包加入 npm 执行缓存，未改全局安装或受管项目 Provider 配置；凭据未写入报告。
- 保留临时探针项目与原始本地轨迹供复核；未调用第二个任务。此证据不证明完整迭代、双槽并发或无人值守能力。

## 未覆盖项和后续顺序

1. 继续原 SSE 计划：共享 Hub/背压与批量读取 → Protocol 1.4 审批决定事件 → Dashboard 决策反馈 →
   15 类产出固定版本安全正文 → conformance/规模/RSS/浏览器延迟验收。盘点见 [产出引用覆盖](artifact-reference-coverage.md)。
2. 真实执行后端的可强制 token/step 计量、完整轨迹、side-effect interception/resume 没有凭空补成；
   不放宽现有无人值守准入。M4 AC-06/20 的双槽/完整 Dogfood 缺口不关闭。
3. M3 的真实平台证据不由本地 Git fixture 代替。采集本记录时，Windows/Linux CI 尚未对本次改动运行。
4. Lite 人工单需求录入时间尚无人工实测；自动三档闭环不是人工 UX 耗时。后续先采样再决定是否改变表单。
5. 本轮只做窄范围模块拆分；没有引入新的模型 Port、数据库、进程或控制平面。

本轮按 TDD 的公共接口先红后绿验证，并按 codebase-design 的单职责边界拆分事件读取。
writing-plans 用于把优化与原 SSE 六任务计划分开追踪；未把尚未实现的正式 SSE 能力标为完成。
