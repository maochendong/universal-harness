<!-- harness:projection
view: prd
generation_digest: fff5dfae6a4ee3efde67138e98a0ef4fc3da891b946446ea03879ac4de6d4df2
sources:
- constraint_01 r1
- intent_01 r1
- requirement_01 r2
- test_01 r1
-->

# Product Requirements: Ship the widget

## requirement_01 (revision 2)

The widget renders in under 100ms

### Acceptance Criteria

- render benchmark passes (verified by: gate perf_benchmark)

### Constraints

- constraint_01: No network access from the widget (verified by: gate policy_check)

Verified by: test_01

