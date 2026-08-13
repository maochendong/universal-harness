import type { GateProvider } from "@universal-harness-internal/plugin-sdk";

import { GENERIC_PACK, GENERIC_PACK_MANIFEST } from "./pack.js";

/**
 * Generic Pack gate provider. The generic stack contributes no stack-profile
 * gates: universal integrity gates come from the runtime and project-specific
 * gates from the project, so this provider deliberately returns an empty list
 * (design 13.6 gate layers).
 */
export function createGenericGateProvider(): GateProvider {
  return {
    name: GENERIC_PACK.name,
    manifest: GENERIC_PACK_MANIFEST,
    listGates: () => GENERIC_PACK.gates,
  };
}
