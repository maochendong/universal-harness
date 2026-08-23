import type { CapabilityId } from "@universal-harness-internal/core";

import type { DagNodeRunner, DagRunnerRegistry } from "../workflow/dag.js";

export const CAPABILITY_DAG_KERNEL_NODE_IDS = [
  "capture",
  "capability_decision",
  "plan",
  "context",
  "execute",
  "verify",
  "snapshot",
] as const;

export interface CapabilityDagRunnerPorts {
  readonly kernel: Readonly<Record<string, DagNodeRunner>>;
  readonly modules?: Readonly<Partial<Record<CapabilityId, DagNodeRunner>>>;
}

/**
 * Production runner assembly seam. The registry contains phase ports only;
 * profile selection and DAG topology remain exclusively in CapabilityPlan.
 */
export function createCapabilityDagRunnerRegistry(
  ports: CapabilityDagRunnerPorts,
): DagRunnerRegistry {
  return Object.freeze({
    kernel: Object.freeze({ ...ports.kernel }),
    ...(ports.modules === undefined ? {} : { modules: Object.freeze({ ...ports.modules }) }),
  });
}
