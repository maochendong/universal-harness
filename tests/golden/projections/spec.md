<!-- harness:projection
view: spec
generation_digest: 9c6178f6940bda4e2727dda8d7929c7698274a4667e14b0a00b34d5b1d8d99b9
sources:
- constraint_01 r1
- requirement_01 r2
- test_01 r1
-->

# Specification

## Requirement requirement_01 (revision 2)

The widget renders in under 100ms

Constrained by: constraint_01

### Verification

- test_01: render benchmark passes (verified by: gate perf_benchmark)

## Constraint constraint_01 (revision 1)

No network access from the widget

Verification: no test verifies this subject yet.

