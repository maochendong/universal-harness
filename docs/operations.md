# M2 运维指南

本文覆盖 M2 的 Finding 分组、确定性语义建议、可选 LLM Judge、本地 Dashboard、事件恢复和 runtime config v2。基础批准、Checkpoint、Resume 与 Ledger 故障处理仍见 [运维与恢复手册](operations-and-recovery.md)。

## 1. 默认配置与兼容性

新建或接管的受管项目会提交 `.harness/runtime.json`：

```json
{"gates":[],"runtime_config_version":2}
```

该默认配置不包含 `judge_gates`，因此不会发起模型网络调用。旧项目的 v1 配置继续可读，并在内存中等价于“无 Judge”；Harness 不会为了迁移而改写旧文件。

运行前建议检查：

```bash
harness doctor
harness graph check
harness status --json
```

## 2. Finding 分组与批量处置

`harness status` 的 `finding_groups` 按稳定的 `rule + scope_prefix + severity + actionability` 聚合当前 Finding revision。每组包含成员计数、open/accepted 计数、最多五个样本和 `membership_digest`。

```bash
harness finding group accept finding-group_<id> \
  --digest <membership-digest> \
  --actor human:<id>

harness finding group close finding-group_<id> \
  --digest <membership-digest> \
  --evidence evidence_<id> \
  --actor human:<id>
```

- 组处置是单个 Ledger transaction：任一成员或 digest 漂移会以冲突失败，零成员被修改。
- `close` 需要适用、通过、非 provisional 且仍 fresh 的 Evidence。
- `stale-knowledge` 在知识源 digest 刷新后自动关闭；历史 Finding 和生命周期事件不会删除。
- 收到 409 或 CLI digest mismatch 时重新执行 `harness status --json`，使用新 digest 人工重试；Harness 不自动重放旧决定。

## 3. 确定性语义影响建议

```bash
harness impact <source-node-id> --semantic --json
```

内置 Provider 仅在本地读取受控 Git/blob/Graph 输入，按 symbol、import、path 和 term 的固定权重生成 top-K 建议。命令只暂存 proposal，不会创建活动边。JSON 输出会给出候选分数、解释、preview digest 和批准命令：

```bash
harness graph approve-edge <edge-id> --digest <preview-digest>
```

批准时会重新核对 source/candidate revision、Provider version、input/index digest；任一漂移都拒绝旧建议。批准后的 `MAY_IMPACT` 只传播为 `inspect`，不会把概率建议升级为 must-change。

语义索引位于 `.harness/cache/semantic/`，不是权威状态。怀疑索引损坏时先停止相关命令，将该目录移到项目外备份，再重跑 `impact --semantic`；相同输入应重建出相同 descriptor、字节和候选顺序。重建失败时 CLI 返回诊断并保留纯结构 ImpactSet。

## 4. 配置可选 LLM Judge

Judge 默认关闭。启用时在 `.harness/runtime.json` 的 v2 配置中显式声明：

```json
{
  "runtime_config_version": 2,
  "gates": [],
  "judge_gates": [
    {
      "gate_id": "gate_semantic-review",
      "name": "Semantic review",
      "subject_id": "test_semantic-review",
      "requested_mandatory": false,
      "endpoint": "https://judge.example.com/v1/chat/completions",
      "model": "reviewer-v1",
      "prompt_version": "v1",
      "api_key_env": "JUDGE_API_KEY",
      "env_allowlist": ["JUDGE_API_KEY"],
      "timeout_ms": 30000,
      "seed": 42
    }
  ]
}
```

运行 CLI 的进程必须提供 allowlist 中的环境变量。API key 不得写入配置、Git、命令参数或 URL。生产 endpoint 仅允许 HTTPS，禁止 URL credential/query/fragment，并在发送凭据前拒绝 loopback、link-local、private address 和 DNS 私网解析。

`requested_mandatory: true` 本身不会使 Judge 阻断。effective mandatory 还要求当前 accepted Policy 含 `gates.<gate-id>.llm_judge_blocking = true`，并且该 Policy revision 有 digest 匹配的有效 Approval；否则 Gate 以 advisory 执行并在 Evidence 中记录诊断。

Judge 的 pass/warn/fail、prompt/bundle/model/request/response digest、标准化响应、error kind 和 retry count 写入 `harness.llm-judge` Evidence extension。timeout、非法 JSON/schema、越界 path/line 或 Provider 故障全部 fail closed；advisory 失败生成 warning Finding，mandatory 失败生成 blocker。

## 5. 启动和关闭 Dashboard

```bash
harness serve
# 或固定本地端口
harness serve --port 43123
```

命令只监听 `127.0.0.1`。它输出一次带随机 token 的 bootstrap URL；首次访问把 token 交换为进程内 HttpOnly、SameSite=Strict session cookie，然后重定向到无 token URL。不要把 bootstrap URL 发到日志、工单或聊天中。

Dashboard 提供 Overview、Graph、Impact、Iteration、Evidence、Findings、Live 和 Approvals 视图。Approvals 直接读取 Ledger 已提交的 ApprovalRequest/ApprovalDecision：approve/reject 移出队列，defer 保持 pending，被重新签发的旧请求由 supersedes 关系退役，因此它不依赖 Live EventSource 的在线时机。页面不加载 CDN、远程脚本或远程字体。批准、恢复和 Finding 组处置必须同时满足 session、同源 Origin、session CSRF、actor 与 expected digest；冲突返回 409。

使用 `Ctrl-C` 或 `SIGTERM` 关闭服务。服务会停止接受新写请求、终止 SSE、等待当前 HTTP/Ledger 操作结束，再关闭数据库与监听 socket。

## 6. EventStream 与恢复

- 权威历史位于 Git Ledger；`.harness/cache/event-stream/` 只保存可丢失的 live observation。
- `harness watch --follow` 与 Dashboard `/events` 合并 live 和 Ledger。相同 observation key 的 Ledger 事件替代 live 事件。
- cursor 已被轮转时 SSE 发送 `stream_reset`；客户端必须重新获取 REST 快照后再订阅，不能猜测缺失终态。
- Dashboard 重启后从 Ledger 恢复历史；没有权威终态的旧 live Run 显示 unknown。
- dsh stdout/stderr 增量输出只以脱敏、节流、限长的 `RunOutputSummary` 进入 live spool；原始 transcript 留在 `.harness/raw-traces/`。输出摘要可丢失且不构成完成证据，token/step 不可观测时必须显示 unavailable。
- 可在停止相关进程后把 live spool 移到项目外备份；删除它不会改变 `resume`、`status`、`snapshot` 或 `audit`。

## 7. 缓存与故障矩阵

| 症状 | 行为 | 操作 |
|---|---|---|
| SQLite 缺失、损坏或旧版本 | Dashboard 启动时从 Ledger 确定性重建 | 也可手工运行 `harness graph sync` |
| 服务期间 SQLite 文件变化且校验失败 | Graph API 返回脱敏的 `graph_cache_unavailable` 503 | 停止服务，运行 `harness graph check` 与 `graph sync` |
| Ledger manifest/shard digest 损坏 | 不使用旧缓存伪装健康；读 API 返回 `ledger_corrupt` 503，写服务禁用 | 从 Git 恢复正确权威文件并运行 `harness graph check`；不得手改 digest |
| live cursor 被逐出 | SSE 发送 `stream_reset` 后关闭 | 重新获取页面快照并订阅 |
| Judge 不可用或响应非法 | 生成失败 Evidence；按 effective mandatory 成为 warning 或 blocker | 修复 endpoint/secret/Provider 后重新迭代，不把失败改写为 pass |
| semantic index 损坏 | 重建；失败则退回结构影响分析 | 备份并移走 cache 后重跑 |
| Approval/Finding group digest 漂移 | HTTP 409 或 CLI typed conflict，零旧动作执行 | 刷新后以新 digest 人工决定 |

## 8. 发布门禁

M2 发布必须完整执行：

```bash
pnpm verify
pnpm test:release
pnpm pack:smoke
git status --short
```

`test:release` 包含 security、fault、performance、CLI E2E、Dashboard Playwright、离线 pack smoke，并生成 [M1 验收报告](m1-acceptance-report.md) 与 [M2 验收报告](m2-acceptance-report.md)。打包门禁确认安装产物包含 Dashboard assets、Judge adapter 和运行依赖，且没有 workspace 绝对路径或构建环境中的凭据值。
