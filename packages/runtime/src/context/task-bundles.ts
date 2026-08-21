import {
  CONTEXT_EXTENSION_KEY,
  type ContextBundleManifest,
  type ContextBundleRecord,
} from "./compiler.js";

export type TaskBundleBindingErrorKind = "binding_drift" | "manifest_missing";

export class TaskBundleBindingError extends Error {
  readonly kind: TaskBundleBindingErrorKind;

  constructor(kind: TaskBundleBindingErrorKind, message: string) {
    super(message);
    this.name = "TaskBundleBindingError";
    this.kind = kind;
  }
}

export interface ExpectedTaskBundleBinding {
  readonly taskId: string;
  readonly taskDigest: string;
  readonly planDigest: string;
  readonly impactCoverageDigest: string;
  /** Required when design_governance is active; absent otherwise. */
  readonly designSetDigest?: string;
}

export function readContextBundleManifest(record: ContextBundleRecord): ContextBundleManifest {
  const manifest = record.extensions?.[CONTEXT_EXTENSION_KEY];
  if (typeof manifest !== "object" || manifest === null) {
    throw new TaskBundleBindingError(
      "manifest_missing",
      `context bundle ${record.context_bundle_id} has no persisted manifest`,
    );
  }
  return manifest as ContextBundleManifest;
}

/** Reject cross-task reuse and immutable binding drift before an executor can run. */
export function assertTaskBundleBinding(
  record: ContextBundleRecord,
  expected: ExpectedTaskBundleBinding,
): void {
  const manifest = readContextBundleManifest(record);
  const drift: string[] = [];
  if (record.task_id !== expected.taskId || manifest.task_id !== expected.taskId) {
    drift.push(`task ${record.task_id}/${manifest.task_id} != ${expected.taskId}`);
  }
  if (manifest.bindings.task_digest !== expected.taskDigest) drift.push("task digest");
  if (manifest.bindings.plan_digest !== expected.planDigest) drift.push("plan digest");
  if (manifest.bindings.impact_coverage_digest !== expected.impactCoverageDigest) {
    drift.push("impact coverage digest");
  }
  if ((manifest.bindings.design_set_digest ?? "") !== (expected.designSetDigest ?? "")) {
    drift.push("design set digest");
  }
  if (manifest.content_digest !== record.digest) drift.push("manifest digest");
  if (drift.length > 0) {
    throw new TaskBundleBindingError(
      "binding_drift",
      `context bundle ${record.context_bundle_id} binding drift: ${drift.join(", ")}`,
    );
  }
}
