# 插件契约

Universal Harness 的技术栈相关行为全部由插件边界提供：AgentAdapter、Tool Provider、VCS Adapter、Projection Adapter 和 Project Pack。Core 不嵌入任何技术栈或领域知识。所有插件契约由 `packages/plugin-sdk` 定义、由 `packages/conformance` 的共享 Conformance Kit 验证。

## 1. Plugin Capability Manifest

每个插件以一份 Manifest 自描述（JSON Schema 2020-12 校验）：

```json
{
  "protocol_version": "1.0.0",
  "record_kind": "plugin_manifest",
  "name": "@example/minimal-tool",
  "version": "1.0.0",
  "kind": "tool",
  "capabilities": ["tool.echo"],
  "resources": []
}
```

- `protocol_version` 不兼容或声明外的 capability 在插件运行前即失败。
- Manifest 必须如实声明 control 与 visibility；Harness 不替插件"美化"能力。

最小可运行示例见 `examples/plugin-minimal/`（由 Conformance Kit 直接验证）。

## 2. Tool Provider 契约

- Host 以固定可执行文件 + 参数数组调用插件（`shell: false`），环境经脱敏，工作目录受限，带超时与输出上限。
- 未知 Tool、非法参数、越界资源、能力违规与非法输出都在权威变更前被阻止并留痕。
- MCP Capability 只有被现有 Provider 显式注册为普通 ToolDefinition 后才可用；Secret Value 不进入任何持久化记录，M1 只解析环境中的 Secret Reference。

## 3. AgentAdapter 契约与 Control Profile

Adapter Manifest 声明两个维度：

- `control`：`manual`（人执行 Harness 之外的工作）/ `delegated`（外部 Provider 执行）/ 受管执行；
- `trajectory_visibility`：Harness 可见的轨迹粒度（如 `external-only`）。

行为规则：

- Manual Adapter（`adapters/agent-manual`）：`control: "manual"`、`trajectory_visibility: "external-only"`。人收到 Task Envelope 并交回结构化结果。
- Command Adapter（`adapters/agent-command`）：`control: "delegated"`，把本机命令当作 Agent 执行，输出映射为类型化 Run 结果。
- 控制或可见性不足时，始终阻止无人值守选择：delegated 且无内部轨迹的 Provider 被强制 Supervised Mode。

两个 Adapter 的可执行示例见 `examples/manual-adapter/` 与 `examples/command-adapter/`。

## 4. Project Pack 契约

- Pack 提供技术栈约定、Gate、Policy、词汇、Template 与 Provider Projection（`packs/generic|node|python|java`）。
- Pack 使用语义版本与 lockfile；升级提供预览、迁移与回滚；Project Override 与 Upstream Pack 分开存储，升级不得覆盖。
- Pack 只能降低默认预算上限；提高 Ceiling 需要 Policy Authorization，且始终受 Installation Hard Bound 约束。

## 5. Conformance Kit

`packages/conformance` 对每个插件运行同一组契约测试：Manifest 校验、子进程监督、Adapter 行为评估（含 correct-failure 场景）、Pack 内容与 Provider Projection 可复现性。新插件接入 M1 的准入条件就是通过该 Kit。

## 6. M2–M4 兼容端口

M1 固化以下版本化接口，后续里程碑只能消费、不能绕过：

- `GraphQueryPort`：分页 Node、Edge、Path、ImpactSet 与 Neighborhood。
- `EventStreamPort`：按 Project、Iteration、Sequence 读取已脱敏事件。
- `ExecutionGraphPort`、`EvaluationPort`、`TaskDagPort`、`PolicyDecisionPort`。
- `PluginCapabilityManifest`：插件能力、版本与资源需求。
