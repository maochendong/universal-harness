/**
 * Host composition seam for required strict-TDD tasks. The published CLI does
 * not choose an implementation Agent or manufacture Red/Green evidence; an
 * embedding host supplies the versioned execution port. The in-memory
 * constructors are exported as deterministic reference adapters for
 * conformance tests and hermetic automation.
 */
export {
  createInMemoryTddEvidenceStore,
  createInMemoryWorkspacePort,
  createStrictTddExecutionRunner,
  type StrictTddExecutionPort,
} from "@universal-harness-internal/runtime";
