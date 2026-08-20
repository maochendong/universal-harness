import { contentDigest } from "@universal-harness-internal/core";

/**
 * Untrusted source boundary (prompt governance addendum design 6.2, 11). All
 * project content — README, source, logs, user text, prior model output — is
 * data. It only ever enters the `untrusted-input` partition, wrapped in the
 * contract's delimiter version, after mechanical checks. Any escape attempt,
 * confusion, secret, credential path, oversize or pathological nesting fails
 * closed with the exact preparation code; nothing is sanitized-then-passed.
 */
export type SourceBoundaryFailureCode = "untrusted_source_boundary_failed" | "prompt_size_exceeded";

export class SourceBoundaryError extends Error {
  readonly code: SourceBoundaryFailureCode;

  constructor(code: SourceBoundaryFailureCode, message: string) {
    super(message);
    this.name = "SourceBoundaryError";
    this.code = code;
  }
}

/** One typed, already-collected bundle item. The compiler never reads disks. */
export interface PromptInputItem {
  readonly source_id: string;
  readonly source_kind: string;
  readonly text: string;
}

/** The Harness-compiled typed bundle handed to the PromptCompiler. */
export interface PromptInputBundle {
  readonly bundle_id: string;
  readonly items: readonly PromptInputItem[];
}

export interface UntrustedLimits {
  readonly max_item_bytes: number;
  readonly max_total_bytes: number;
  readonly max_nesting_depth: number;
}

export const DEFAULT_UNTRUSTED_LIMITS: UntrustedLimits = {
  max_item_bytes: 32 * 1024,
  max_total_bytes: 128 * 1024,
  max_nesting_depth: 64,
} as const;

/** Tags emitted by the Harness; their appearance in project data is an escape. */
const RESERVED_TAGS = [
  "authority-boundary",
  "port-role",
  "domain-rubric",
  "profile-overlay",
  "policy-overlay",
  "output-contract",
  "untrusted-input",
  "untrusted-item",
  "system",
  "developer",
  "tool",
] as const;

const RESERVED_TAG_PATTERN = new RegExp(`</?(?:${RESERVED_TAGS.join("|")})(?:\\s|/|>)`, "iu");
const UNICODE_CONFUSION_PATTERN =
  /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]|(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
];
const CREDENTIAL_PATH_PATTERN =
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|~\/\.(?:ssh|aws|config)\b)/u;

function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (const char of text) {
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      if (depth > max) max = depth;
    } else if (char === "}" || char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

function assertItemWithinBoundary(
  item: PromptInputItem,
  limits: UntrustedLimits,
  totalBytes: number,
): void {
  const itemBytes = Buffer.byteLength(item.text, "utf8");
  if (itemBytes > limits.max_item_bytes || totalBytes > limits.max_total_bytes) {
    throw new SourceBoundaryError(
      "prompt_size_exceeded",
      `untrusted item ${item.source_id} exceeds the prompt size budget`,
    );
  }
  if (RESERVED_TAG_PATTERN.test(item.text)) {
    throw new SourceBoundaryError(
      "untrusted_source_boundary_failed",
      `untrusted item ${item.source_id} contains a reserved delimiter tag`,
    );
  }
  if (UNICODE_CONFUSION_PATTERN.test(item.text)) {
    throw new SourceBoundaryError(
      "untrusted_source_boundary_failed",
      `untrusted item ${item.source_id} contains zero-width, bidi or unpaired-surrogate characters`,
    );
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(item.text))) {
    throw new SourceBoundaryError(
      "untrusted_source_boundary_failed",
      `untrusted item ${item.source_id} contains secret-shaped material`,
    );
  }
  if (CREDENTIAL_PATH_PATTERN.test(item.text)) {
    throw new SourceBoundaryError(
      "untrusted_source_boundary_failed",
      `untrusted item ${item.source_id} contains a credential or user path`,
    );
  }
  if (nestingDepth(item.text) > limits.max_nesting_depth) {
    throw new SourceBoundaryError(
      "untrusted_source_boundary_failed",
      `untrusted item ${item.source_id} exceeds the maximum nesting depth`,
    );
  }
}

/** Canonical item order: digests never depend on collection order. */
function canonicalItems(items: readonly PromptInputItem[]): PromptInputItem[] {
  return [...items].sort((left, right) =>
    `${left.source_kind}${left.source_id}`.localeCompare(`${right.source_kind}${right.source_id}`),
  );
}

export interface WrappedUntrustedBundle {
  readonly content: string;
  readonly bundle_digest: string;
}

/**
 * Wrap a typed bundle in the `untrusted-input` partition. The returned digest
 * covers the delimiter version plus every item's identity and content digest.
 */
export function wrapUntrustedBundle(
  bundle: PromptInputBundle,
  delimiterVersion: string,
  limits: UntrustedLimits = DEFAULT_UNTRUSTED_LIMITS,
): WrappedUntrustedBundle {
  const items = canonicalItems(bundle.items);
  let totalBytes = 0;
  for (const item of items) {
    totalBytes += Buffer.byteLength(item.text, "utf8");
    assertItemWithinBoundary(item, limits, totalBytes);
  }
  const blocks = items.map((item) => {
    const itemDigest = contentDigest({
      source_id: item.source_id,
      source_kind: item.source_kind,
      text: item.text,
    });
    return { item, itemDigest };
  });
  const bundleDigest = contentDigest({
    kind: "untrusted_input_bundle",
    delimiter_version: delimiterVersion,
    items: blocks.map((block) => ({
      source_id: block.item.source_id,
      source_kind: block.item.source_kind,
      text_digest: block.itemDigest,
    })),
  });
  const body = blocks
    .map(
      (block) =>
        `<untrusted-item source-id="${block.item.source_id}" source-kind="${block.item.source_kind}" digest="${block.itemDigest}">\n${block.item.text}\n</untrusted-item>`,
    )
    .join("\n");
  return {
    content: `<untrusted-input digest="${bundleDigest}">\n${body}\n</untrusted-input>`,
    bundle_digest: bundleDigest,
  };
}
