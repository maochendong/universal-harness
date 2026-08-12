/**
 * Deterministic JSON serialization for persisted records and content digests.
 *
 * The output is stable across platforms and process runs: object keys are
 * sorted by UTF-16 code unit, strings are Unicode-normalized to NFC, and only
 * plain JSON values are accepted.
 */
export class CanonicalJsonError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Cannot canonicalize value: ${reason}`);
    this.name = "CanonicalJsonError";
    this.reason = reason;
  }
}

export function canonicalizeJson(value: unknown): string {
  return writeValue(value);
}

function writeValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number ${String(value)}`);
      }
      // Normalize -0 to 0 so bitwise-equal logical values serialize identically.
      return JSON.stringify(value === 0 ? 0 : value);
    case "object":
      return Array.isArray(value)
        ? writeArray(value)
        : writeObject(value as Record<string, unknown>);
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof value}`);
  }
}

function writeArray(values: unknown[]): string {
  return `[${values.map((item) => writeValue(item)).join(",")}]`;
}

function writeObject(record: Record<string, unknown>): string {
  const entries = Object.entries(record).map(
    ([key, entryValue]) => [key.normalize("NFC"), entryValue] as const,
  );
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]?.[0] === entries[index - 1]?.[0]) {
      throw new CanonicalJsonError(
        `duplicate key after Unicode normalization: ${entries[index]?.[0]}`,
      );
    }
  }
  const body = entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${writeValue(entryValue)}`)
    .join(",");
  return `{${body}}`;
}
