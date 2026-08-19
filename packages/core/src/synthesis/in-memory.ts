import type {
  GroundedSynthesisInput,
  GroundedSynthesisPort,
  GroundedSynthesisResult,
} from "./port.js";

/**
 * InMemoryGroundedSynthesisAdapter: the T5 test double. It records every
 * input it received so tests can assert conversation/run isolation and that
 * the compiled input carries bundle data only. It holds no project files,
 * ledger handles or shared history — the only thing it can do is map one
 * input to one canned result.
 */
export interface InMemoryGroundedSynthesisAdapter extends GroundedSynthesisPort {
  readonly invocations: readonly GroundedSynthesisInput[];
}

export function createInMemoryGroundedSynthesisAdapter(
  handler: (input: GroundedSynthesisInput) => GroundedSynthesisResult,
): InMemoryGroundedSynthesisAdapter {
  const invocations: GroundedSynthesisInput[] = [];
  return {
    name: "in-memory",
    get invocations() {
      return [...invocations];
    },
    synthesize(input) {
      invocations.push(input);
      return handler(input);
    },
  };
}
