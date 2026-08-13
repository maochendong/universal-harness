# 示例：Command AgentAdapter

对应文档：[插件契约](../../docs/plugin-contracts.md)。

`run.mjs` 把 Command Adapter（`control: "delegated"`，强制 supervised）接入真实编排：执行阶段由 Harness 按 Envelope 约束调用 `provider.mjs`——固定可执行文件加参数数组（不经 shell）、脱敏环境、受限工作目录、超时与输出上限；Provider 以一份 JSON 结果文档作答。`provider.mjs` 是确定性的本地命令，演示 Provider 结果契约。

运行（仓库根目录，先 `pnpm build`）：

```bash
node examples/command-adapter/run.mjs
```
