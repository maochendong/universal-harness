import type { GateProvider } from "@universal-harness-internal/plugin-sdk";

import { PYTHON_PACK, PYTHON_PACK_MANIFEST } from "./pack.js";

/**
 * Python Pack gate provider (design 13.6, plan Task 25 step 2): the
 * stack-profile gate declarations from the canonical descriptor. Gates are
 * data -- the named tools (`python_test`, `python_lint`) are registered and
 * executed by the host through the Tool Registry, so no gate ever depends on
 * an undeclared external command at scan or test time.
 */
export function createPythonGateProvider(): GateProvider {
  return {
    name: PYTHON_PACK.name,
    manifest: PYTHON_PACK_MANIFEST,
    listGates: () => PYTHON_PACK.gates,
  };
}
