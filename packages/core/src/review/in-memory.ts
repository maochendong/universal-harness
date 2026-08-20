import type { PrdReviewInput, PrdReviewPort, PrdReviewResult } from "./port.js";

/**
 * InMemoryPrdReviewAdapter (intent-to-prd design 10.3): the test double. It
 * records every input so tests can assert the invocation binding and the
 * independence from the proposal invocation, and holds no project or ledger
 * handles — the only bytes it sees arrive through `review`.
 */
export interface InMemoryPrdReviewAdapter extends PrdReviewPort {
  readonly invocations: readonly PrdReviewInput[];
}

export function createInMemoryPrdReviewAdapter(
  handler: (input: PrdReviewInput) => PrdReviewResult | Promise<PrdReviewResult>,
): InMemoryPrdReviewAdapter {
  const invocations: PrdReviewInput[] = [];
  return {
    name: "in-memory",
    get invocations() {
      return [...invocations];
    },
    async review(input) {
      invocations.push(input);
      return handler(input);
    },
  };
}
