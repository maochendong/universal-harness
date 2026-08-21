# T23 引用保真 prompt 迭代 dogfood 证据

日期：2026-08-21
端点：`https://api.deepseek.com/chat/completions`（OpenAI 兼容）
模型：`deepseek-v4-pro`
凭证：仓库根 `.env`（gitignored）的 `DEEPSEEK_API_KEY`，dogfood 脚本自动加载
驱动：`scripts/dogfood-real-provider.mjs`（三档 profile 各建临时项目、两轮迭代、自动批准、不配置执行器）

## 目标与修复

T20–T22 遗留两类模型输出「引用造假」，外加 `plan_proposal` 槽位本轮新接生产
（`f62327e`）。修复手段分两层：

**契约文本（prompt 层）**

- design_review rubric：封闭集规则——`affected_asset_id` 必须逐字来自提案的
  `node_changes`/`reused_assets` 成员，`affected_criterion_id` 必须来自
  coverage 的 `test_strategy_coverage`；`coverage_assessment` 恰好覆盖
  must-change 集合。
- 四份 grounded synthesis 契约（context_enrichment / iteration_narrative /
  project_discovery / approval_brief）：locator 与 `source_digest` 必须逐字符
 从 synthesis input 的 `bundle_sources` 清单复制，`bundle_digest` 逐字符复制，
 不得计算/截断/回忆。
- design_proposal rubric：`proposed_extensions` 的 key 必须命名空间化
 （`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$`），裸 key 在工件落账时会被拒。
- plan_proposal rubric：`canonical_assertions` 为空时直接按已知需求分解、
 `assertion_ids` 留空（Harness 确定性兜底），不得返回空输出。

**输入保真（代码层）**

- `capture-adapters.ts`：grounded synthesis 的 synthesis-input 新增
  `bundle_sources` 清单——此前 prompt 里根本没有 per-source digest，模型只能
  编造，这是 `citation_invalid` 的真正根因，单靠契约文本无解。
- `plan-adapters.ts`：新增 `node_content` 分项（known_requirement_ids 的节点
  正文进 prompt，CLI 经 `materializeProjectGraph` 解析）——此前模型只拿到 id
  列表，面对「分配零个断言、无需求正文」正确地返回了空输出。
- `capture-adapters.ts`：grounded synthesis 的 `invocation_id` 前缀 strip 会
  把同一 operation 的 enrichment 与 narrative 折叠成同一 id
  （`identity_conflict`），id 中现保留 purpose。

## 四轮回归

| 轮次 | lite | standard | governed |
| --- | --- | --- | --- |
| R1（契约修复后） | plan 空输出 fail-closed（新槽位暴露输入保真缺口） | 组件工件 extensions 裸 key 落账被拒 | **review consumed**，实质 `revision_required`，`unknown_affected_target` 消除 |
| R2（plan 回退 + extensions 规则） | enrichment consumed 后 narrative 触发 `identity_conflict`（潜伏 bug 首次到达） | **enrichment consumed**（`citation_invalid` 消除），评审生效 | review 300s 超时（暂时性） |
| R3（invocation id 修复） | **两轮迭代全部完成**，enrichment + narrative 均 consumed | 设计链全 consumed，review 实质 `revision_required` | review consumed，`blocked` 带两条真实 critical finding |
| R4（plan node_content） | **plan_proposal consumed**，两轮迭代全部完成（4 端口） | 设计链全 consumed，review 给三条 warning 级修订意见 | design_proposal 300s 超时（暂时性），advisory consumed |

每类目标错误的终态：`unknown_affected_target` 三轮未再现；`citation_invalid`
两轮未再现（enrichment/narrative 均 consumed）；plan 空输出、extensions 裸
key、invocation 冲突各自由对应修复消除并有单测/回归测试锁定。

## 残余（非契约问题）

- governed 档间歇性 `provider call exceeded 300000ms`：端点延迟抖动，
  retryable，R1/R3 同配置成功，非系统性问题。
- governed impact_advisory 偶发 validated 未 consumed：advisory 输出未通过
  merge 校验，确定性影响集照常推进（advisory 永不改写确定性结果），属于
  advisory prompt 的下一轮迭代候选。
