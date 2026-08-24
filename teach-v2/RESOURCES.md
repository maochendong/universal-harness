# Universal Harness 2.0 课程资源

## Knowledge

- [README 产品总览](../README.md)
  当前产品声称的入口。用于发现待验证声明；不能单独作为完成证据。
- [Graph-native 驱动模型](../docs/graph-driven-harness-model.md)
  Node、Edge、Event、Profile-aware Capability DAG 与五个模型 Port 的人类可读总图。用于建立架构模型，并与源码注册表交叉核对。
- [完整修复完成证据](../docs/evidence/full-review-remediation-completion.md)
  当前仓库内实现、本地门禁、三档 dogfood 和未验证项的范围化结论。用于判断“已实现”与“已发布”的边界。
- [三档 packaged CLI dogfood](../docs/evidence/full-remediation-three-profile-dogfood.md)
  Lite、Standard、Governed 在干净 host 中的 Snapshot、CapabilityPlan、模型调用与 TDD 结果。用于验证动态 DAG。
- [Managed 模型调用层架构](../docs/model-invocation-architecture.md)
  Managed Runner、Provider Registry、失败语义与接线状态。部分状态已经落后于后续源码，适合作为证据冲突练习。
- [真实 Provider dogfood](../docs/evidence/t20-real-provider-dogfood.md)
  历史真实外部 Provider 调用、失败收敛和残余问题。用于证明“真实调用过”，但不能替代当前提交复验。
- [Graph 模型 Schema](../packages/core/src/schema/node.ts) · [Capability Compiler](../packages/core/src/capability/compiler.ts) · [Operation DAG](../packages/core/src/capability/dag.ts)
  当前实现的裁决入口。用于从文档投影下钻到类型、注册表和 fail-closed 守卫。
- [M1 验收报告](../docs/m1-acceptance-report.md) · [M2 验收报告](../docs/m2-acceptance-report.md)
  自动报告生成物。用于学习验收标准、命令、证据与 commit 的映射方式。

## Wisdom (Communities)

- 本仓库的 GitHub Issues / Discussions
  用于把无法由源码和测试直接裁决的问题交给项目维护语境；当前是低频渠道，不把社区意见当权威事实。

## Gaps

- 当前提交缺少真实外部 Provider 复验，因此课程只能声明仓库内生产接线完成，外部证据为部分连通。
- M1 AC25 仍缺同一提交上的 Ubuntu、macOS、Windows 聚合证据，不能声明跨平台发布完成。
- 用户尚未提交课程练习结果，因此没有任何 2.0 学习记录或“已掌握”结论。
