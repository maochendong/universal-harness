import type { PrdProposalInput, PrdProposalPort, PrdProposalResult } from "./port.js";

/**
 * InMemoryPrdProposalAdapter (intent-to-prd design 9.3): the test double. It
 * records every input so tests can assert the invocation binding, and holds no
 * project or ledger handles — the only bytes it sees arrive through `propose`.
 */
export interface InMemoryPrdProposalAdapter extends PrdProposalPort {
  readonly invocations: readonly PrdProposalInput[];
}

export function createInMemoryPrdProposalAdapter(
  handler: (input: PrdProposalInput) => PrdProposalResult | Promise<PrdProposalResult>,
): InMemoryPrdProposalAdapter {
  const invocations: PrdProposalInput[] = [];
  return {
    name: "in-memory",
    get invocations() {
      return [...invocations];
    },
    async propose(input) {
      invocations.push(input);
      return handler(input);
    },
  };
}
