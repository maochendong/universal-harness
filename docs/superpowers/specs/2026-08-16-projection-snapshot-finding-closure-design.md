# 投影、Snapshot 锚点与 Finding 收敛设计

日期：2026-08-16  
状态：已批准  
范围：Universal Harness M1.x 修复；Atlas MVP 历史数据迁移

## 1. 背景

Atlas T6、T7 dogfood 暴露出三类闭环缺口：

1. `tasks.md` 是 Harness 生成的受管投影，但第二次迭代开始，任何内容变化都被 `writeManagedOutput` 当成未经批准的覆盖；Snapshot 捕获异常后静默保留旧文件，导致权威图已完成 T6/T7、任务投影仍停在 T5。
2. Snapshot 在 Agent 产出的源码尚未形成 Git commit 时写入 `final_commit`，随后只提交 `.harness`。因此 T6/T7 Snapshot 指向迭代前基线，而实际源码在闭环之后由人工另行提交。
3. Audit Finding 被 supersede 时只退休其 `BLOCKS` 边；历史追踪边仍活动并指向已退休 Finding，持续产生 `stale_knowledge` 告警。

此外，Atlas 尚无被图扫描接受的 ADR/decision 文档，产生一条 `missing_design_artifact` 告警；旧 T5 分支已合入 `main`，但本地与 Gitee 远程引用仍存在。

本设计保持 Git-native Ledger 的 append-only 约束，不改写旧 Ledger 操作、旧 Snapshot 或 Git 历史。

## 2. 目标与非目标

### 2.1 目标

- 未经手工修改的 Harness 投影可在每次 Snapshot 自动、安全地更新。
- 完成态 Snapshot 的 `final_commit` 指向本次迭代经门禁验证的源码提交。
- 历史 Snapshot 可通过追加式修正记录绑定正确源码提交。
- Finding 退休后不再有活动边引用它，审计告警可以确定性收敛。
- Atlas T6/T7 投影、提交锚点、Finding 与 Decision Record 全部闭合。

### 2.2 非目标

- 不自动覆盖无法验证来源的投影文件。
- 不修改已提交 Snapshot 的原始字节。
- 不重写、rebase 或 force-push Atlas 历史。
- 不在本修复中实现 M2-A 的 Finding 分组 UI；本次只保证历史 Finding 正确退休。
- 不把 `.harness` 与源码压成一个自引用提交；源码提交与 Ledger 提交保持两个可审计步骤。

## 3. 受管投影安全重写

### 3.1 自验证投影

Markdown Projection 已携带以下头部：

- `view`
- `generation_digest`
- 精确的 source id/revision 列表
- 生成正文

新增纯函数解析并验证现有 Markdown：从头部读取 `view` 与 sources，以现有正文重新计算 `contentDigest({ view, sources, body })`。只有重算摘要与头部 `generation_digest` 一致时，文件才被视为 Harness 上一次生成的可信投影。

### 3.2 重写规则

`writeManagedOutput` 的行为保持默认保守；为调用方增加“允许重写已验证 Harness 投影”的显式选项：

- 文件不存在：`create`。
- 新旧内容相同：`noop`。
- 旧文件是摘要自洽的 Harness 投影：允许 `rewrite`。
- 旧文件无法解析、摘要不一致或不是 Harness 投影：继续抛出 `unapproved_overwrite`。
- 显式 `overwriteApproved: true` 仍可覆盖外国字节，供人工批准命令使用。

Snapshot 的 Task Projection 调用启用该选项；其他 Provider Mirror 不自动获得权限。

### 3.3 验证

- 连续两个完成迭代后，`tasks.md` 同时包含两轮任务且复选框正确。
- 手改正文、sources 或 digest 后，下一次 Snapshot 拒绝覆盖。
- 相同图状态重放产生 `noop` 与相同字节。

## 4. 完成态 Snapshot 的源码提交锚点

### 4.1 两阶段提交

完成相位调整为：

1. 重扫文档、物化 Evidence、运行 Audit。
2. 确认所有 Run、Gate、Evaluation 和 Audit 允许完成。
3. 汇总每个成功 Run 的 `change_summary.paths`。
4. 校验每个路径位于该 Task Envelope 的 `proposed_write_paths` 内，并排除 `.harness`。
5. 通过 VCS Adapter 只提交这些路径，提交信息为 `harness: apply iteration <iteration-id>`。
6. 读取该源码提交 SHA，构建 Snapshot，并将其写入 `final_commit`。
7. 完成 Iteration 节点、投影与工作流状态。
8. 通过第二次 VCS 提交只提交 `.harness`，提交信息保持 `harness: record iteration <iteration-id>`。

如果没有源码变化，第 5 步为 `nothing_to_commit`，Snapshot 锚定当前 HEAD。若源码提交失败，则不得生成完成态 Snapshot。

### 4.2 安全约束

- 只提交 Run 报告且 Task Envelope 已授权的相对路径。
- 路径必须仍位于仓库内，不允许绝对路径、`..`、符号链接逃逸或 `.harness`。
- 未出现在 Agent change summary 的用户修改不得被暂存或提交。
- 源码提交发生在全部质量判断通过之后；门禁失败仍保留工作树供修复，不制造完成提交。
- Ledger 提交失败时，源码提交已存在但没有完成 Snapshot；恢复流程从源码提交继续，禁止重复提交源码。

### 4.3 输出语义

- Snapshot `final_commit`：被本轮 Evidence 验证的源码提交。
- Orchestration Outcome `finalCommit`：为兼容既有调用方，继续表示最后一次 Harness Ledger 提交。
- Outcome 新增 `sourceCommit`，明确暴露 Snapshot 锚点。

## 5. 历史 Snapshot Anchor Correction

### 5.1 追加记录

历史 T6/T7 不修改原 Snapshot。新增运行时记录 `snapshot_anchor_correction`，存放于：

```text
.harness/artifacts/snapshot-anchor-corrections/<snapshot-id>/<digest>.json
```

字段包括：

- `snapshot_id`、`iteration_id`
- `original_final_commit`
- `corrected_source_commit`
- `code_digest`
- `evidence_ids`
- `reason`
- `actor`、`created_at`
- 内容摘要 `digest`

### 5.2 命令与校验

新增命令：

```text
harness snapshot anchor <snapshot-id> --source-commit <sha> --reason <text>
```

命令必须验证：

1. Snapshot 存在且状态为 `completed`。
2. 目标 commit 是当前仓库中的真实 commit。
3. Snapshot 关联的至少一条已接受、通过、非 provisional Gate Evidence 具有 `code_digests`。
4. 目标 commit 在排除 `.harness` 后的代码摘要与 Evidence 摘要一致。
5. 对同一 Snapshot 重复提交相同修正为幂等 `noop`；不同修正必须拒绝，不能静默替换。

读取 Snapshot 提交锚点的内部逻辑优先采用有效 Correction；没有 Correction 时回退原 `final_commit`，保证旧项目兼容。

### 5.3 Atlas 修正映射

- T6 `snapshot_0e44133c80958235` → `25883a2ab6973e74862ae7e9d5885eaaf92315b7`
- T7 `snapshot_8c02ad303d7456ee` → `4b59a08926f354e19c1310daf5caa46335fbc1f8`

两个映射必须分别通过代码摘要校验，不能仅因 commit 顺序合理而接受。

## 6. Finding 边退休

### 6.1 规则

当 Audit Finding 进入 `superseded` 时，所有仍活动且以该 Finding 为 source 或 target 的边都追加同 id 的 `superseded` 修订。原边记录保留，不删除。

该规则同时应用于：

- 正常 Snapshot Audit 收敛路径。
- `harness graph reconcile` 历史修复路径。

现有 `block_edges_retired` 计数保持兼容；新增 `finding_edges_retired` 统计所有退休边。

### 6.2 幂等性

第二次 reconcile 不新增节点、边或修订；审计不得再次产生由这些旧边引起的 `stale_knowledge`。

## 7. Atlas Decision Record 与迁移流程

Atlas 新增 `docs/decisions/0001-harness-governed-iteration.md`，记录以下决策：

- 采用 Universal Harness 作为需求、影响、计划、执行、门禁、评估和快照的治理闭环。
- 源码提交与 Ledger 提交分离。
- 确定性 Gate 为完成依据，Agent 自述不构成通过证据。
- 历史修正只追加，不覆盖。

迁移顺序：

1. 使用修复后的 Universal Harness 对 Atlas 执行 `graph reconcile`。
2. 追加 T6、T7 Snapshot Anchor Correction。
3. 重新生成 `tasks.md`；只有自验证失败时才使用显式覆盖批准。
4. 通过一个维护迭代扫描并接受 ADR，运行正式项目门禁和 Audit。
5. 验证 `blockers=[]`、`warnings=[]`、`stale_evidence=[]`、Evaluation Coverage 保持全覆盖、图完整性为零。
6. 删除本地与 Gitee 远程 `codex/harness-driven-t5`；删除前确认其 tip 已被 `main` 包含。

## 8. 测试与验收

### 8.1 Universal Harness

- Projection 单元测试覆盖可信重写、手改拒绝、幂等重放。
- Orchestrator E2E 覆盖源码提交先于 Snapshot、Snapshot SHA 正确、Ledger 提交独立、恢复不重复提交。
- Snapshot Correction 单元/CLI 测试覆盖摘要匹配、错误 commit、冲突修正、幂等。
- Audit 与 reconcile 测试覆盖 Finding 入边、出边和 `BLOCKS` 边全部退休。
- `pnpm verify` 全绿；同时修复当前 Prettier 门禁。

### 8.2 Atlas

- JDK 21 Gate 通过。
- Maven 全量测试通过。
- Python pytest 全量通过。
- `harness graph check --json` 为零违规。
- `harness audit --json` 为零 Finding。
- `harness status --json` 为零 blocker、零 warning、零 stale Evidence。
- `tasks.md` 明确包含完成的 T6 与 T7。
- Correction 查询结果分别解析到 T6/T7 实际源码 commit。
- `main` 与 `gitee/main` 一致，`codex/harness-driven-t5` 本地及远程均不存在。

## 9. 兼容性与失败恢复

- 未修正的旧 Snapshot 继续按原 `final_commit` 工作。
- 新字段只增加，不移除既有 Outcome 字段。
- Correction 是追加 artifact，不改变 Node/Edge 公共 schema。
- 源码已提交但 Ledger 提交中断时，resume 识别 commit 已存在且代码摘要匹配，继续写 Snapshot/Ledger；不重复提交、不回滚用户代码。
- Atlas 迁移任一步校验失败即停止，不删除分支、不推送部分收敛状态。
