import {
  AgentError,
  isEvidenceDigest,
  type AgentEvidenceLocator,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Structured provider telemetry parsing (design 13.2). A delegated provider
 * reports its result as one JSON document on stdout. Parsing is strict and
 * total: malformed JSON, an unknown status or wrongly typed fields are a
 * typed `invalid_result` error, so a provider can never turn garbage output
 * into a silent success. Unknown extra fields are ignored -- the provider
 * cannot extend the contract by smuggling keys.
 */

export const PROVIDER_RESULT_STATUSES = ["completed", "failed"] as const;

export type ProviderResultStatus = (typeof PROVIDER_RESULT_STATUSES)[number];

export interface ProviderUsageReport {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
}

export interface ProviderToolActivity {
  readonly total_calls: number;
  readonly by_tool: Readonly<Record<string, number>>;
}

export interface ProviderResult {
  readonly status: ProviderResultStatus;
  readonly summary: string;
  /** Provider-supplied detail for a failed status. */
  readonly message?: string;
  readonly state_proposal?: Readonly<Record<string, unknown>>;
  readonly evidence?: readonly AgentEvidenceLocator[];
  readonly usage?: ProviderUsageReport;
  readonly tool_activity?: ProviderToolActivity;
}

function invalid(message: string): never {
  throw new AgentError("invalid_result", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseUsage(raw: unknown): ProviderUsageReport {
  if (!isPlainObject(raw)) invalid("provider usage must be an object");
  for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const) {
    const value = raw[key];
    if (value !== null && value !== undefined && !isTokenCount(value)) {
      invalid(`provider usage.${key} must be a non-negative integer or null`);
    }
  }
  return {
    input_tokens: (raw.input_tokens ?? null) as number | null,
    output_tokens: (raw.output_tokens ?? null) as number | null,
    total_tokens: (raw.total_tokens ?? null) as number | null,
  };
}

function parseEvidence(raw: unknown): AgentEvidenceLocator[] {
  if (!Array.isArray(raw)) invalid("provider evidence must be an array");
  return raw.map((entry, index) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.kind !== "string" ||
      entry.kind === "" ||
      typeof entry.locator !== "string" ||
      entry.locator === "" ||
      !isEvidenceDigest(entry.digest)
    ) {
      invalid(`provider evidence entry ${String(index)} needs a kind, a locator and a digest`);
    }
    return { kind: entry.kind, locator: entry.locator, digest: entry.digest };
  });
}

function parseToolActivity(raw: unknown): ProviderToolActivity {
  if (!isPlainObject(raw)) invalid("provider tool_activity must be an object");
  if (!isTokenCount(raw.total_calls)) {
    invalid("provider tool_activity.total_calls must be a non-negative integer");
  }
  const byTool: Record<string, number> = {};
  if (raw.by_tool !== undefined) {
    if (!isPlainObject(raw.by_tool)) invalid("provider tool_activity.by_tool must be an object");
    for (const [tool, count] of Object.entries(raw.by_tool)) {
      if (!isTokenCount(count)) {
        invalid(`provider tool_activity.by_tool.${tool} must be a non-negative integer`);
      }
      byTool[tool] = count;
    }
  }
  return { total_calls: raw.total_calls, by_tool: byTool };
}

/** Parse and strictly validate the provider's structured stdout result. */
export function parseProviderResult(stdout: string): ProviderResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    invalid("provider stdout is not valid JSON; unparseable output is never a result");
  }
  if (!isPlainObject(raw)) invalid("provider result must be a JSON object");
  if (
    typeof raw.status !== "string" ||
    !(PROVIDER_RESULT_STATUSES as readonly string[]).includes(raw.status)
  ) {
    invalid(`provider status must be one of ${PROVIDER_RESULT_STATUSES.join(", ")}`);
  }
  if (typeof raw.summary !== "string" || raw.summary === "") {
    invalid("provider result requires a non-empty summary");
  }

  const result: {
    -readonly [K in keyof ProviderResult]?: ProviderResult[K];
  } = {
    status: raw.status as ProviderResultStatus,
    summary: raw.summary,
  };
  if (raw.message !== undefined) {
    if (typeof raw.message !== "string") invalid("provider message must be a string");
    result.message = raw.message;
  }
  if (raw.state_proposal !== undefined) {
    if (!isPlainObject(raw.state_proposal)) invalid("provider state_proposal must be an object");
    result.state_proposal = raw.state_proposal;
  }
  if (raw.evidence !== undefined) result.evidence = parseEvidence(raw.evidence);
  if (raw.usage !== undefined) result.usage = parseUsage(raw.usage);
  if (raw.tool_activity !== undefined) result.tool_activity = parseToolActivity(raw.tool_activity);
  return result as ProviderResult;
}
