import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  canonicalizeJson,
  contentDigest,
  harnessRootFor,
  resolveHarnessPath,
  type ModelInvocationRecord,
} from "@universal-harness-internal/core";

/**
 * Replayable, schema-validated model value. Raw provider text is never kept:
 * only the parsed value that passed the pinned output schema is persisted.
 * The invocation transition commits its locator and digest afterwards, so a
 * terminal invocation can recover the exact first result without another
 * non-deterministic provider call.
 */
interface ValidatedModelResultArtifact {
  readonly schema_version: "model-result-artifact.v1";
  readonly invocation_id: string;
  readonly attempt: number;
  readonly output_schema_id: string;
  readonly output_digest: string;
  readonly value: unknown;
}

export class ModelResultArtifactError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ModelResultArtifactError";
    this.kind = kind;
  }
}

function locatorFor(invocationId: string, attempt: number): string {
  return `artifacts/model-results/${invocationId}/attempt-${String(attempt)}.json`;
}

function parseArtifact(value: unknown, locator: string): ValidatedModelResultArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelResultArtifactError(
      "corrupt_result",
      `model result is not an object: ${locator}`,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record["schema_version"] !== "model-result-artifact.v1" ||
    typeof record["invocation_id"] !== "string" ||
    !Number.isInteger(record["attempt"]) ||
    typeof record["output_schema_id"] !== "string" ||
    typeof record["output_digest"] !== "string" ||
    contentDigest(record["value"]) !== record["output_digest"]
  ) {
    throw new ModelResultArtifactError(
      "corrupt_result",
      `model result failed integrity validation: ${locator}`,
    );
  }
  return record as unknown as ValidatedModelResultArtifact;
}

export function writeValidatedModelResult(input: {
  readonly projectRoot: string;
  readonly invocation_id: string;
  readonly attempt: number;
  readonly output_schema_id: string;
  readonly output_digest: string;
  readonly value: unknown;
}): string {
  if (contentDigest(input.value) !== input.output_digest) {
    throw new ModelResultArtifactError(
      "output_digest_mismatch",
      "validated model value does not match its output digest",
    );
  }
  const locator = locatorFor(input.invocation_id, input.attempt);
  const absolute = resolveHarnessPath(harnessRootFor(input.projectRoot), locator);
  const artifact: ValidatedModelResultArtifact = {
    schema_version: "model-result-artifact.v1",
    invocation_id: input.invocation_id,
    attempt: input.attempt,
    output_schema_id: input.output_schema_id,
    output_digest: input.output_digest,
    value: input.value,
  };
  const content = `${canonicalizeJson(artifact)}\n`;
  mkdirSync(
    resolveHarnessPath(
      harnessRootFor(input.projectRoot),
      `artifacts/model-results/${input.invocation_id}`,
    ),
    {
      recursive: true,
    },
  );
  try {
    // `wx` is the immutable-artifact commit point. Two concurrent recoveries
    // can never truncate or replace one another's validated result.
    writeFileSync(absolute, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(absolute, "utf8") === content) return locator;
    throw new ModelResultArtifactError(
      "result_conflict",
      `model result already exists with different content: .harness/${locator}`,
    );
  }
  return locator;
}

export function readValidatedModelResult(
  projectRoot: string,
  record: Pick<
    ModelInvocationRecord,
    "invocation_id" | "attempt" | "output_schema_id" | "output_digest" | "result_locator"
  >,
): { readonly value: unknown; readonly output_digest: string } {
  if (record.result_locator === undefined || record.output_digest === undefined) {
    throw new ModelResultArtifactError(
      "result_missing",
      `invocation ${record.invocation_id} has no replayable validated result`,
    );
  }
  const absolute = resolveHarnessPath(harnessRootFor(projectRoot), record.result_locator);
  if (!existsSync(absolute)) {
    throw new ModelResultArtifactError(
      "result_missing",
      `model result artifact is missing: .harness/${record.result_locator}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new ModelResultArtifactError(
      "corrupt_result",
      `model result is not valid JSON: .harness/${record.result_locator}`,
    );
  }
  const artifact = parseArtifact(parsed, record.result_locator);
  if (
    artifact.invocation_id !== record.invocation_id ||
    artifact.attempt !== record.attempt ||
    artifact.output_schema_id !== record.output_schema_id ||
    artifact.output_digest !== record.output_digest
  ) {
    throw new ModelResultArtifactError(
      "result_binding_drift",
      `model result does not match invocation ${record.invocation_id} attempt ${String(record.attempt)}`,
    );
  }
  return { value: artifact.value, output_digest: artifact.output_digest };
}
