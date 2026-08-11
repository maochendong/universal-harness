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

The M1 design is approved and the project is currently in implementation planning. Product code starts only after the written implementation plan is reviewed and approved.

## Design

- [Approved M1 design](docs/superpowers/specs/2026-08-11-universal-harness-m1-design.md)
- [Proposed M1 implementation plan](docs/superpowers/plans/2026-08-11-universal-harness-m1-implementation-plan.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
