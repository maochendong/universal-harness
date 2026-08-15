# dsh headless 本机契约记录

**实测日期**：2026-08-15  
**实测版本**：`@deepseek-ai/dsh 0.1.0-rc.6`  
**启动器**：Node.js 22.23.1 自带的 `npx --no-install`

## 调用契约

版本探针：

```text
npx --no-install @deepseek-ai/dsh --version
```

成功时 stdout 为单行版本号，退出码为 0。任务调用：

```text
npx --no-install @deepseek-ai/dsh --profile headless "<Task Envelope 渲染文本>"
```

任务文本作为 `spawn(..., { shell: false })` 的独立参数传入，不经过 shell。
正常完成时 stdout 是最后一条非空 assistant 文本，退出码为 0；它只构成
`completion_claimed`，Harness 仍需运行 Gate 和 Evaluation。

## 本机失败实测

当前机器没有配置 dsh 的 DeepSeek provider credential。无写入探针任务得到：

```text
exit code: 1
stderr: dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route
        "deepseek-official" ...
```

Adapter 必须把该结果映射为 `outcome=failed`、
`termination_reason=adapter_failure`，保留 checkpoint 和脱敏 transcript；不得
回退为 Direct Executor 或伪造完成。

空 stdout、非零退出、版本不匹配、超时、输出超限和越界写入均使用相同的
类型化失败原则。自动测试通过注入的 fake process 覆盖成功与失败路径，不依赖
真实凭据。

## 轨迹与凭据边界

dsh 0.1.0-rc.6 的 headless stdout 不提供可依赖的 token usage 或稳定的内部
step schema，因此 Adapter 如实声明：

- `control=delegated`
- `trajectory_visibility=external-only`
- `usage_metering=false`
- `resume_semantics=none`

这意味着它只能在 supervised 模式运行。Harness 保存自身捕获的 stdout、
stderr、退出码、耗时和前后仓库摘要到 `.harness/raw-traces/agent-dsh/`；该目录
不进入 Git。dsh 自身会话格式处于 developer preview，本集成不解析它作为
权威协议。
