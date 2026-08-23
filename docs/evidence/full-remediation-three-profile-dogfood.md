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
| Lite | `workflow_01M0QBT3RPCS2ME97SR9DN8ZZB` | `snapshot_b0d4d9186d814fc2` | `4c880abbb69b7b10a42e9c06fcd5934f1f9acf6a2c6eeab36d7bd06c6865b5e0` | `335bebb000bcd96c88384488a65421bab1a73949fb479a91bd004f0d66766c8f` | 0 | passed | not enabled | not enabled | clean |
| Standard | `workflow_01M0QBTCCE2RD9KWZSA7993VFD` | `snapshot_fcdc7893d42271a1` | `193a586775044dc7763242314dfb941f62d24043a9b77db3154b638512825f07` | `61ae8b75dbed4335cb6824b37a9861a618e6420fbcf6121200c9aca3f2ead914` | 9 | passed | passed | controlled not applicable | clean |
| Governed | `workflow_01M0QBTSBFC15F13RKP98KJGHT` | `snapshot_fcdc7893d42271a1` | `619f13c4e96fd2da8ced411d10dd244685bc95d279334d34f66e645169004197` | `73247fa537c419e13e2be472d6d57de1d453b99852fb1d584a2c8c218c013273` | 10 | passed | passed | tdd proven（2 cycles） | clean |

Approval decisions followed the Profile policy one object at a time:

- Lite: `ExecutionAuthorizationSpec`.
- Standard: `ImpactSet`, `DesignSet`, `ExecutionAuthorizationSpec`.
- Governed: `CapturePrdProposal`, `ImpactSet`, `DesignSet`,
  `ExecutionAuthorizationSpec`.

Standard compiled accepted `test_strategy` assets into immutable
TaskTddContracts, but its fixture is deliberately `non_executable_projection`;
the final TaskVerdict therefore reports `controlled_not_applicable` and no
Red/Green Evidence is claimed. Governed uses a required executable strategy
through the packaged public CLI seam and a host-owned isolated-workspace
`StrictTddExecutionPort`. It completed two cycles and persisted the same-chain
`baseline_test_result`, `red_test_result` and `green_test_result` Evidence
before Gate, Evaluation, TaskVerdict and Snapshot completion. The production
write grant was unavailable until accepted Red Evidence existed.

The reproducible machine report is
`.reports/acceptance/three-profile-dogfood.json` (ignored by Git). The public
regression is `tests/e2e/three-profile-real-loop.test.ts`.

Real DeepSeek mode was not run because `DEEPSEEK_API_KEY` was absent. The
driver exits with code 2 in that condition; this document does not claim real
Provider evidence.
