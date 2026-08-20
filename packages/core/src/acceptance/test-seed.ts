import { domainRecordId } from "../identity/record-id.js";
import { PROTOCOL_1_1_VERSION } from "../protocol.js";

/**
 * Criterion → Test seed derivation (intent-to-prd design 13.1). The Test seed
 * id is a pure function of the canonical criterion id, so a criterion that
 * `continues` across proposal revisions keeps its Test seed while the Test
 * node revision/digest track the semantic digest. No other field — source
 * bindings, proposal revision, timestamps — participates.
 */
export function deriveCaptureTestSeedId(criterionId: string): string {
  return domainRecordId({
    domain_tag: "capture_test_seed",
    id_prefix: "prd-test",
    protocol_version: PROTOCOL_1_1_VERSION,
    canonical_input: { criterion_id: criterionId },
  });
}
