# Universal Harness

Universal Harness is a graph-native, provider-neutral engineering harness for auditable software iteration.

Its M1 goal is a complete vertical loop from one orchestration command:

```text
create or adopt a project
→ capture requirements
→ synchronize the Artifact Graph
→ analyze impact
→ create a declarative ExecutionPlan
→ compile bounded context
→ execute directly, through a controlled agent loop, or manually
→ enforce quality gates and evaluate the run
→ perform RCA and targeted repair when needed
→ record improvement candidates and an iteration snapshot
```

The design uses one Git-native ledger with Artifact Graph and Execution Graph views. Agents propose semantic work; the Harness controls plans, context, capabilities, budgets, termination, evidence, recovery, and authoritative updates.

The M1 design and implementation plan are approved. Task 1 workspace implementation is now in progress.

## Design

- [Approved M1 design](docs/superpowers/specs/2026-08-11-universal-harness-m1-design.md)
- [Approved M1 implementation plan (Chinese)](docs/superpowers/plans/2026-08-11-universal-harness-m1-implementation-plan.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
