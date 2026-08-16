export const LLM_JUDGE_VERDICTS = ["pass", "warn", "fail"] as const;
export type LlmJudgeVerdict = (typeof LLM_JUDGE_VERDICTS)[number];

export interface LlmJudgeReason {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
}

export interface LlmJudgeResult {
  readonly verdict: LlmJudgeVerdict;
  readonly confidence: number;
  readonly reasons: readonly LlmJudgeReason[];
}

export class JudgeResponseError extends Error {
  readonly kind = "invalid_response" as const;

  constructor(message: string) {
    super(message);
    this.name = "JudgeResponseError";
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new JudgeResponseError(`${context} contains unknown field ${key}`);
  }
}

export interface JudgeResponseBounds {
  readonly changed_paths: readonly string[];
  readonly line_counts: Readonly<Record<string, number>>;
}

/** Strictly validate model JSON. Any ambiguity or out-of-bundle reference fails closed. */
export function parseJudgeResponse(content: string, bounds: JudgeResponseBounds): LlmJudgeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    throw new JudgeResponseError("judge response is not JSON");
  }
  if (!plainObject(raw)) throw new JudgeResponseError("judge response must be an object");
  exactKeys(raw, ["verdict", "confidence", "reasons"], "judge response");
  if (!LLM_JUDGE_VERDICTS.includes(raw.verdict as LlmJudgeVerdict)) {
    throw new JudgeResponseError("judge verdict must be pass, warn or fail");
  }
  if (typeof raw.confidence !== "number" || raw.confidence < 0 || raw.confidence > 1) {
    throw new JudgeResponseError("judge confidence must be in 0..1");
  }
  if (!Array.isArray(raw.reasons)) throw new JudgeResponseError("judge reasons must be an array");
  if (raw.verdict !== "pass" && raw.reasons.length === 0) {
    throw new JudgeResponseError("warn/fail verdicts require at least one reason");
  }
  const changedPaths = new Set(bounds.changed_paths);
  const reasons = raw.reasons.map((value, index): LlmJudgeReason => {
    if (!plainObject(value))
      throw new JudgeResponseError(`reasons[${String(index)}] must be an object`);
    exactKeys(value, ["code", "message", "path", "line"], `reasons[${String(index)}]`);
    if (typeof value.code !== "string" || value.code.trim() === "") {
      throw new JudgeResponseError(`reasons[${String(index)}].code must be non-empty`);
    }
    if (typeof value.message !== "string" || value.message.trim() === "") {
      throw new JudgeResponseError(`reasons[${String(index)}].message must be non-empty`);
    }
    if (
      value.path !== undefined &&
      (typeof value.path !== "string" || !changedPaths.has(value.path))
    ) {
      throw new JudgeResponseError(`reasons[${String(index)}].path is outside changed_paths`);
    }
    if (value.line !== undefined) {
      if (value.path === undefined || !Number.isInteger(value.line) || (value.line as number) < 1) {
        throw new JudgeResponseError(
          `reasons[${String(index)}].line requires a valid path and line`,
        );
      }
      const maximum = bounds.line_counts[value.path as string];
      if (maximum === undefined || (value.line as number) > maximum) {
        throw new JudgeResponseError(`reasons[${String(index)}].line is outside the file`);
      }
    }
    return {
      code: value.code,
      message: value.message,
      ...(value.path === undefined ? {} : { path: value.path as string }),
      ...(value.line === undefined ? {} : { line: value.line as number }),
    };
  });
  return { verdict: raw.verdict as LlmJudgeVerdict, confidence: raw.confidence, reasons };
}
