# README Dashboard 效果截图实施计划

日期：2026-08-17

状态：已完成

完成日期：2026-08-17

设计依据：[README Dashboard 效果截图设计](../specs/2026-08-17-readme-dashboard-screenshot-design.md)

## 1. 目标

从当前 `atlas-mvp` Harness Observatory 捕获 Overview、Graph 和 Impact 三张约 1440×900 的桌面首屏 PNG，并在 README 项目简介之后、Graph-native 驱动模型之前组成独立产品效果区域。

## 2. 执行规则

1. 使用测试先行：先扩展现有文档契约并确认因截图和 README 区域缺失而失败。
2. 只捕获页面内容，不包含浏览器框、地址栏、token、调试信息或桌面内容。
3. 保留 `atlas-mvp` 真实项目名和指标，图注说明其为真实 Harness dogfood 数据。
4. 截图前等待权威状态加载，并确认浏览器控制台没有 error。
5. 使用目标视口直接截图，不通过后期裁剪改变内容边界。
6. 图片使用稳定相对路径；README 不写入 localhost 或 tokenized URL。
7. 每个任务完成后运行聚焦验证并形成可回滚提交。

## 3. Task 1：建立 README 截图契约

**修改文件**

- `tests/e2e/graph-model-documentation.test.ts`

**测试先行**

- 图片文件存在且前八字节匹配 PNG 签名。
- README 包含 `## Dashboard 效果`。
- README 图片替代文本描述 Harness Observatory 和 `atlas-mvp` Overview。
- 图片路径固定为 `docs/assets/harness-observatory-overview.png`。
- 图注明确说明 `atlas-mvp` 使用真实 Harness 数据。
- README 不包含 `?token=`、bootstrap token 或带 token 的 loopback URL。

**验证**

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
```

初始预期为失败。

## 4. Task 2：捕获真实 Overview 首屏

**新增文件**

- `docs/assets/harness-observatory-overview.png`

**实施**

- 使用当前已认证的应用内浏览器会话打开 `http://127.0.0.1:56510/#overview`。
- 设置约 1440×900 桌面视口，重新加载并等待 Overview 权威状态稳定。
- 检查页面包含 `atlas-mvp`、核心指标、Iteration Signal、Graph Cache 与 Control。
- 检查 console error 列表为空。
- 只截取当前视口并直接保存目标 PNG。
- 检查 PNG 类型、尺寸和文件大小。

**验证**

```text
file docs/assets/harness-observatory-overview.png
sips -g pixelWidth -g pixelHeight docs/assets/harness-observatory-overview.png
```

## 5. Task 3：嵌入 README 并完成回归

**修改文件**

- `README.md`

**实施**

- 在 M1/M2 状态说明后增加 `## Dashboard 效果`。
- 使用中文替代文本嵌入固定相对路径图片。
- 添加 `atlas-mvp` 真实 Harness 数据图注。
- 保持后续 Graph-native 驱动模型结构不变。

**验证**

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

人工检查 README 图片可显示、文字清晰且没有 token 或浏览器框。

## 6. 完成

- 将设计和实施计划状态改为“已实施 / 已完成”，写入完成日期。
- 提交截图、README、测试和状态更新。
- 保持工作区干净；推送远端需要用户明确授权。

## 7. 实施结果

- 已从 `atlas-mvp` 的真实 Observatory Overview 捕获 PNG，最终尺寸为 1425×891，页面不含浏览器框、访问 token 或调试信息。
- 截图前已确认 Overview 权威状态加载完成，Iteration Signal、Graph Cache、Control 等区域齐全，浏览器 console error 数量为 0。
- README 已增加独立 `Dashboard 效果` 区域，使用稳定相对路径、中文替代文本和真实数据图注。
- 文档契约测试通过：`tests/e2e/graph-model-documentation.test.ts` 共 7 项测试全部通过。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck` 均通过。
- 完整回归通过：216 个测试文件、1329 项测试全部通过。

## 8. Task 4：扩展 Graph 与 Impact 真实视图

**新增文件**

- `docs/assets/harness-observatory-graph.png`
- `docs/assets/harness-observatory-impact.png`

**测试先行**

- 扩展既有 README 文档契约，要求两张图片存在、具有 PNG 签名，并通过固定相对路径嵌入 README。
- 要求中文替代文本和图注分别解释 Graph 关系邻域与 Impact 最短路径。
- 先运行聚焦测试，确认因两张资产尚不存在而失败。

**捕获状态**

- Graph：Artifact 视图选择 `case_docs`，等待 `3 EDGES / 4 NODES` 邻域加载完成。
- Impact：FROM 为 `case_docs`、TO 为 `evidence_evaluation_docs`，等待 `1 governed relationships explain this path`。
- 两页均确认 console error 为空，再以统一桌面视口捕获首屏。

**README 排列**

- 保留 Overview 为第一张。
- Graph 与 Impact 依次追加在后，每张图下添加简短中文说明。

**验证**

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

## 9. 扩展实施结果

- Graph 截图已在 `case_docs` 邻域加载后捕获，画面同时展示筛选控制、`3 EDGES / 4 NODES` 关系摘要以及 Evidence、Run、Task 相邻节点。
- Impact 截图已在 `case_docs` 到 `evidence_evaluation_docs` 路径查询完成后捕获，画面展示 `SUPPORTS` 关系和最短解释路径。
- 两张截图均为 1440×900 PNG，页面 console error 数量为 0，不含浏览器框、访问 token 或调试信息。
- README 已按 Overview、Graph、Impact 顺序展示三张真实视图，并为新增图片提供中文替代文本与说明。
- 用户已完成人工图片检查；文档契约测试 7/7、格式检查、Lint、TypeScript 均通过。
- 完整回归通过：216 个测试文件、1329 项测试全部通过。
