# 示例：接管项目（harness adopt）

对应文档：[接管已有项目](../../docs/adopting-a-project.md)。

`run.mjs` 先构造一个 Harness 未知的小型 Git 项目，然后演示完整的 `harness adopt` 闭环：staging 扫描生成 AdoptionBaseline 预览（未批准前不改动项目）、用 `--approve <staging-operation-id>` 提交基线、批准迭代批准点并落地 Snapshot。

运行（仓库根目录，先 `pnpm build`）：

```bash
node examples/adopt-project/run.mjs
```
