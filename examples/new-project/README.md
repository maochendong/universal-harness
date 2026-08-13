# 示例：新建项目（harness new）

对应文档：[快速开始](../../docs/getting-started.md)。

`run.mjs` 通过 CLI 公共 API 演示一次完整的 `harness new` 纵向闭环：创建受管项目、依次批准 RequirementBaseline 与 ImpactSet 两个强制批准点、落地 `completed` 状态的 Iteration Snapshot，并验证 Ledger 提交后 Git 工作区干净。

运行（仓库根目录，先 `pnpm build`）：

```bash
node examples/new-project/run.mjs
```
