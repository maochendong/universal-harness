import type { GateProvider } from "@universal-harness-internal/plugin-sdk";

import { JAVA_PACK, JAVA_PACK_MANIFEST } from "./pack.js";

/**
 * Java Pack gate provider (design 13.6, plan Task 25 step 2): the
 * stack-profile gate declarations from the canonical descriptor. Gates are
 * data -- the named tools (`java_test`, `java_build`) are registered and
 * executed by the host through the Tool Registry, so no gate ever depends on
 * an undeclared external command at scan or test time.
 */
export function createJavaGateProvider(): GateProvider {
  return {
    name: JAVA_PACK.name,
    manifest: JAVA_PACK_MANIFEST,
    listGates: () => JAVA_PACK.gates,
  };
}
