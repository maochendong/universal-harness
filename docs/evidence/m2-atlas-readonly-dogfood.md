# M2 Atlas 只读 dogfood 证据

日期：2026-08-16

在现有受管 Atlas 项目的 `abe3a35` 提交上，使用当前 Universal Harness CLI 执行了只读命令：

```bash
harness status --json
```

未修改 Atlas 工作树。脱敏后的结果摘要如下：

| 指标 | 结果 |
|---|---:|
| Ledger 已提交操作 | 709 |
| Graph cache | ok |
| 当前 Iteration | completed |
| Evaluation coverage | 21 / 21 |
| 历史 Finding 成员 | 120 |
| Finding groups | 6 |
| 当前 open Findings | 0 |
| stale-knowledge 历史成员 | 52 |
| stale-knowledge groups | 1 |
| stale-knowledge open | 0 |

该结果证明历史 Finding 不再以逐条列表呈现：120 条历史记录稳定聚合为 6 组；其中 52 条 stale-knowledge 记录聚合为 1 组，知识刷新后的 open 计数为 0，同时历史成员、样本、时间范围和 membership digest 仍可追溯。
