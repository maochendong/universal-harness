# README Dashboard 效果截图设计

日期：2026-08-17  
状态：已确认，待实施

## 1. 目标

在 Universal Harness README 的项目简介与 Graph-native 驱动模型之间增加一张本地 Observatory Dashboard 的真实效果截图，让读者先看到可用产品，再理解底层图驱动模型。

截图使用当前 `atlas-mvp` 受管项目的真实 Harness 数据，展示 Universal Harness dogfood 结果，不把 README 绑定到临时访问地址或本地会话凭据。

## 2. 截图范围

- 页面：Harness Observatory 的 Overview 视图。
- 视口：约 1440×900 的桌面宽屏首屏。
- 内容：品牌导航、项目标题、核心指标、迭代流水线、Graph Cache 和 Control 状态卡片。
- 保留：`atlas-mvp` 项目名和真实指标。
- 排除：浏览器边框、地址栏、一次性 token、调试面板、控制台输出和页面外的桌面内容。
- 捕获条件：页面完成加载，权威状态已显示，且浏览器控制台没有错误。

不使用完整长页面截图，也不增加 Graph 等第二张截图，避免 README 过长。

## 3. 仓库交付

新增图片：

```text
docs/assets/harness-observatory-overview.png
```

README 在 M1/M2 状态说明之后、`## Graph-native 驱动模型` 之前增加：

```markdown
## Dashboard 效果

![Harness Observatory Dashboard：atlas-mvp 项目 Overview](docs/assets/harness-observatory-overview.png)

_基于 atlas-mvp 真实 Harness 数据的本地 Observatory Dashboard。_
```

图片使用相对路径，不链接 `127.0.0.1` 或带 token 的 bootstrap URL。读者通过现有 `harness serve` 文档启动自己的本地 Dashboard。

## 4. 数据与隐私边界

- 允许展示项目名 `atlas-mvp`、Ledger 操作数、任务完成数、评估覆盖率、开放 Finding 数和迭代状态。
- 不展示访问 token、CSRF、文件系统路径、用户名、环境变量、Provider 凭据或未脱敏运行输出。
- PNG 不写入自定义文本元数据；仓库只保存页面像素，不保存浏览器会话。
- 如果当前页面出现错误、空状态、加载占位或敏感内容，停止捕获并重新加载，不提交占位图。

## 5. 验证设计

扩展 `tests/e2e/graph-model-documentation.test.ts` 的 README 文档契约，验证：

1. `docs/assets/harness-observatory-overview.png` 存在；
2. 文件具有 PNG 签名字节；
3. README 包含 `## Dashboard 效果`；
4. README 使用固定相对路径和有意义的中文替代文本；
5. README 图注明确说明 `atlas-mvp` 是真实 Harness 数据；
6. README 不包含 Dashboard bootstrap token 或本地 tokenized URL。

人工检查截图尺寸接近 1440×900、文字可读、首屏内容完整且没有浏览器框。完成后运行：

```text
pnpm vitest run tests/e2e/graph-model-documentation.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## 6. 错误处理

- 本地服务不可达时，先用现有 `harness serve` 重新启动针对 `atlas-mvp` 的 Dashboard。
- 页面未完成权威状态加载时等待状态区域稳定，不按固定延时盲截。
- 浏览器控制台有错误时先诊断，不把错误页面作为产品效果图。
- 截图尺寸不符合 README 目标时重新设置视口并重新捕获，不对错误尺寸图片做不可追踪裁剪。
- 文档测试、格式检查或完整回归失败时不标记实施完成。

## 7. 验收标准

1. README 项目简介之后出现独立 Dashboard 效果区域。
2. 截图只包含 Observatory Overview 页面首屏，无浏览器框和敏感凭据。
3. 图片展示 `atlas-mvp` 真实 Harness 数据，图注解释其 dogfood 性质。
4. 图片在 GitHub 和离线 Markdown 中均可由相对路径显示。
5. 文档测试可以检测图片缺失、错误路径、缺少替代文本或意外 tokenized URL。
6. 定向测试、格式、Lint、TypeScript 和完整测试通过。
