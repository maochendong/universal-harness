# 接管已有项目（harness adopt）

`harness adopt` 把一个现有 Git 仓库变成受管项目，并立即运行一次完整迭代。整个过程遵循同一治理原则：**先扫描进 staging，批准后才提交权威基线**。可执行示例见 `examples/adopt-project/`。

## 流程

```bash
harness adopt /path/to/project --intent "Introduce the requested change"
```

1. **确定性扫描**：Harness 在根边界内扫描项目（文件、组件、主技术栈），结果只写入 `.harness/` 下的 staging 区，不触碰项目内容。
2. **预览**：生成 Adoption Preview——主技术栈、文件数、组件数、冲突列表和 Preview Digest。非交互会话返回 `approval_required`（退出码 11）与 `staging_operation_id`；交互会话直接展示预览并询问 decision。
3. **批准**：批准后 staging 被提交为带仓库限定身份的权威 Baseline（AdoptionBaseline），`.harness/` 控制平面落地。

非交互批准方式（预览摘要与批准的 digest 严格绑定）：

```bash
harness adopt /path/to/project --intent "..." --approve <staging-operation-id>
```

4. **首次迭代**：基线提交后，按 `--intent` 运行与 `harness new` 相同的闭环（RequirementBaseline 与 ImpactSet 批准点照常出现，见 [运维与恢复](operations-and-recovery.md)）。

## 接管保证

- `.harness/` 之外不做任何修改；项目根目录已有的 `.gitignore` 永不被改动。
- staging 是唯一的暂存区；拒绝（reject）会关闭提案但保留审计历史，暂缓（defer）保留可恢复提案。
- Preview Digest 防漂移：批准时 staging 内容必须与预览时一致，否则提交被拒绝，需要重新扫描。
- 相同仓库与配置产生相同、带仓库限定的扫描 Node ID、Edge 与 Digest，接管结果可复现、可审计。
- 生成的 Provider Mirror 只写入受管路径，可以从 Canonical Pack 与 Graph 复现；未经预览与批准，不覆盖用户已有的 Provider 配置。

## 冲突与拒绝

预览中的 `conflicts` 列出扫描无法确定归类的内容（例如同名多义组件）。冲突不阻塞接管，但会记录在基线中供后续审计；如果你不接受预览结果，用 reject 关闭本次 staging，调整项目后重新运行 `adopt` 生成新的 staging。

## 接管之后

接管完成即进入正常的迭代循环：

```bash
cd /path/to/project
harness status
harness iterate "Implement the next change"
```
