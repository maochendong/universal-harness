# 示例：Manual AgentAdapter

对应文档：[插件契约](../../docs/plugin-contracts.md)。

`run.mjs` 把 Manual Adapter（`control: "manual"`，`trajectory_visibility: "external-only"`）接入真实编排：执行阶段把 Task Envelope 与渲染好的任务简报交给 handoff 通道（示例中用脚本化的"人工"完成并附上 attestation 证据），闭环跑通到 Snapshot。Adapter 自身不执行任何动作——这正是 manual control level 的语义。

运行（仓库根目录，先 `pnpm build`）：

```bash
node examples/manual-adapter/run.mjs
```
