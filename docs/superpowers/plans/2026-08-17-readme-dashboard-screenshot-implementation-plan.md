# README Dashboard 效果截图实施计划

日期：2026-08-17

状态：实施中

设计依据：[README Dashboard 效果截图设计](../specs/2026-08-17-readme-dashboard-screenshot-design.md)

## 1. 目标

从当前 `atlas-mvp` Harness Observatory Overview 捕获一张约 1440×900 的桌面首屏 PNG，保存到 `docs/assets/harness-observatory-overview.png`，并在 README 项目简介之后、Graph-native 驱动模型之前增加独立产品效果区域。

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
