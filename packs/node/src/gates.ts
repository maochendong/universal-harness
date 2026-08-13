import type { GateProvider } from "@universal-harness-internal/plugin-sdk";

import { NODE_PACK, NODE_PACK_MANIFEST } from "./pack.js";

/**
 * Node Pack gate provider (design 13.6, plan Task 25 step 2): the
 * stack-profile gate declarations from the canonical descriptor. Gates are
 * data -- the named tools (`node_test`, `node_lint`) are registered and
 * executed by the host through the Tool Registry, so no gate ever depends on
 * an undeclared external command at scan or test time.
 */
export function createNodeGateProvider(): GateProvider {
  return {
    name: NODE_PACK.name,
    manifest: NODE_PACK_MANIFEST,
    listGates: () => NODE_PACK.gates,
  };
}
