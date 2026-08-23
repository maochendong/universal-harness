# Full Remediation Three-Profile Dogfood Evidence

Date: 2026-08-23  
Mode: hermetic packaged CLI, host-owned fake Provider and explicit deterministic command Agent  
Result: passed

This evidence was produced by installing the packed `universal-harness` CLI
into a clean temporary host and completing one authoritative iteration for
each Profile. It records only identifiers, digests and verdicts; Provider
credentials, prompt bodies and response bodies are deliberately excluded.

| Profile | Workflow Operation | Final Snapshot | Snapshot digest | Final CapabilityPlan digest | Model calls | Gate | Evaluation | TDD | Worktree |
|---|---|---|---|---|---:|---|---|---|---|
| Lite | `workflow_01M0Q681MBV8G0Y8WKRDTJS0RS` | `snapshot_b0d4d9186d814fc2` | `21c58be0b93466c03a8a91c81d74b7c606d90b91983aaf1c6a489e752ac2dcc3` | `b51220d23c85fe07fe9a0a794ef9d76310589097912982bb68b06c36cb000ec2` | 0 | passed | not enabled | not enabled | clean |
| Standard | `workflow_01M0Q689NG1KZX4AWW1XGT8E8V` | `snapshot_fcdc7893d42271a1` | `d1403605a62c4f896de3b94ba5ddc4c11f9b53cc8b296440896efedb07086fe2` | `463914c831d29e8c4429f59f1e415f0cb44d65d167500a3e65815a37ed169b24` | 9 | passed | passed | controlled not applicable | clean |
| Governed | `workflow_01M0Q68PP99YMJGG57AZ402798` | `snapshot_fcdc7893d42271a1` | `037fb7c636b23c1d3d26f05f00cf8a662642449da1ca00d84d4fbaf0c5565365` | `456b5c888f09d553daf5a1448e335f9564ceff9eedf96e9b93ceb261c5d63156` | 10 | passed | passed | controlled not applicable | clean |

Approval decisions followed the Profile policy one object at a time:

- Lite: `ExecutionAuthorizationSpec`.
- Standard: `ImpactSet`, `DesignSet`, `ExecutionAuthorizationSpec`.
- Governed: `CapturePrdProposal`, `ImpactSet`, `DesignSet`,
  `ExecutionAuthorizationSpec`.

Standard and Governed compiled accepted `test_strategy` assets into immutable
TaskTddContracts. The operation intentionally changes no product behavior, so
each strategy carries the approved `non_executable_projection` exemption and
the final TaskVerdict reports `controlled_not_applicable`; no Red/Green
Evidence is claimed. A required TDD contract remains production-write locked
unless a `StrictTddExecutionPort` is configured.

The reproducible machine report is
`.reports/acceptance/three-profile-dogfood.json` (ignored by Git). The public
regression is `tests/e2e/three-profile-real-loop.test.ts`.

Real DeepSeek mode was not run because `DEEPSEEK_API_KEY` was absent. The
driver exits with code 2 in that condition; this document does not claim real
Provider evidence.
