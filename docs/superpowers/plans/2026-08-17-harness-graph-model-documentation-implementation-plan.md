# Harness Graph-native 驱动模型文档实施计划

日期：2026-08-17

状态：实施中

设计依据：[Harness Graph-native 驱动模型文档设计](../specs/2026-08-17-harness-graph-model-documentation-design.md)

## 1. 目标

为 Universal Harness 建立两层 Graph-native 模型说明：README 用一张中英双语总图解释纵向闭环，`docs/graph-driven-harness-model.md` 完整列出 26 类 Node、31 类 Edge、15 类 Lifecycle Event、11 类 Observation Event，以及 17 条影响传播规则。新增测试把说明与代码权威枚举绑定，防止模型演进后文档静默漂移。

## 2. 执行规则

1. 采用 Red → Green → Refactor：先写会失败的文档一致性测试，再补充文档。
2. 代码中的 Schema、兼容矩阵、传播规则和评分逻辑是唯一权威；文档不进入 Runtime。
3. 中文业务说明优先，所有枚举保留英文原名以便定位实现。
4. README 图只解释驱动主干；完整清单、精确规则和详细机制进入独立文档。
5. 使用 GitHub 支持的基础 Mermaid flowchart 语法，不增加生产依赖。
6. Mermaid 旁保留 Markdown 表格和文字降级，不把渲染成功作为语义完整性的唯一条件。
7. 每个 Task 完成后运行聚焦验证并形成一个可回滚提交。

## 3. Task 1：文档一致性测试

**新增文件**

- `tests/e2e/graph-model-documentation.test.ts`

**测试先行**

- README 必须包含 Graph-native 总览标题、Mermaid 图和完整模型文档链接。
- 完整模型文档必须存在并包含明确的机器可读章节边界。
- `NODE_TYPES` 中 26 个枚举全部出现在 Node 清单，且清单没有缺失、额外或重复枚举。
- `RELATION_TYPES` 中 31 个枚举完整划分为传播和非传播两组，交集为空、并集完整。
- 传播规则表逐条匹配 `PROPAGATION_RULES` 的 type、direction、defaultRisk 和 allowsInference。
- `EVENT_TYPES` 和 `OBSERVATION_EVENT_TYPES` 分别完整出现在自己的事件清单中，不能互相替代。
- 文档包含 Ledger / Live Spool / SQLite 权威边界和无图降级说明。
- 断言失败时输出缺失项、额外项、重复项或规则字段差异。

**实现**

- 使用 HTML 注释标记完整文档中的 Node、传播 Edge、结构 Edge、Lifecycle Event 和 Observation Event 机器可读区间。
- 测试只读取 Markdown，不自动修改文件。
- 用小型解析函数提取表格第一列的反引号枚举，避免对自然语言段落做模糊计数。

**验证**

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
```

初始预期为失败，因为 README 和完整文档尚未实现。

**提交**

```text
test(docs): bind graph model docs to authoritative enums
```

## 4. Task 2：完整 Graph-native 模型文档

**新增文件**

- `docs/graph-driven-harness-model.md`

**实现**

- 添加完整模型 Mermaid 总图，按权威上下文、意图与设计、影响与治理、执行与验证、反馈修复五个职责域组织 26 类 Node。
- 每个职责域说明“包含什么、负责什么、怎样驱动下一步”。
- 添加 26 类 Node 中英双语清单。
- 添加 17 条影响传播规则表，逐条列出中文含义、方向、默认风险和推理边许可。
- 解释 Change Seed、方向视角、路径风险、推理边 inspect 降级、确定性 BFS、默认深度 6 与硬上限 10。
- 添加 14 条非传播结构关系清单，按来源恢复、执行绑定、产物证据、层级归属、批准治理和反馈入口分组。
- 解释非传播关系仍参与完整性、查询和审计，但不进入 Impact BFS。
- 添加 15 类 Lifecycle Event 和 11 类 Observation Event 的完整清单、分组说明和同名事件边界。
- 解释 Ledger、Live Spool、SQLite、Dashboard、Projection、Audit 和 Snapshot 的数据流。
- 添加一个从 Requirement 变化到 Finding 反馈修复的端到端示例。
- 添加权威源码链接和 Mermaid 无法渲染时的文字降级说明。

**验证**

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
pnpm exec prettier --check docs/graph-driven-harness-model.md
```

此时完整文档断言应通过，README 断言仍失败。

**提交**

```text
docs(graph): explain complete harness model
```

## 5. Task 3：README Graph-native 驱动总览

**修改文件**

- `README.md`

**实现**

- 在“核心设计思路”之前新增“Graph-native 驱动模型”部分。
- 用精简 Mermaid 图展示五个 Node 职责域、Capture → Snapshot 阶段链、Finding → RCA → Improvement → Impact 反馈环，以及两类 Event 对 Ledger / Live Spool 的分流。
- 每个区域提供中文职责与驱动说明，保留关键英文枚举。
- 明确 17 条传播关系决定方向、风险和推理许可；14 条结构关系不会被 Impact BFS 自动穿越。
- 明确 Ledger 是权威事实、Live Spool 是可删除实时观察、SQLite 是可重建缓存。
- 链接 `docs/graph-driven-harness-model.md` 以查看全部 26/31/15/11 枚举、17 条规则和端点兼容矩阵。

**验证**

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
pnpm exec prettier --check README.md docs/graph-driven-harness-model.md
```

**提交**

```text
docs(readme): visualize graph-driven harness loop
```

## 6. Task 4：回归、渲染与收尾

**验证**

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

**人工检查**

- README 总图在 GitHub Markdown 兼容渲染器中无语法错误。
- 总图在常规桌面宽度下能从左到右阅读，中文不会遮挡节点。
- 完整文档目录、锚点和 README 链接可跳转。
- Mermaid 不可用时，表格和说明仍完整覆盖模型语义。
- `git diff --check` 通过，工作区只包含本任务文件。

**收尾**

- 将本计划状态改为“已完成”，写入完成日期。
- 在文档导航中加入完整模型文档链接。
- 提交最终状态更新；经用户授权后推送远端。

**提交**

```text
docs(plan): complete graph model documentation rollout
```
