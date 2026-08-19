import type { ProjectContextPathPolicy } from "./port.js";

/**
 * Untrusted-content defenses for project context (intent-to-prd design 19,
 * model advisory design 14). Repository text is data, never instructions:
 * these helpers keep locators inside the project, keep secrets and binary
 * blobs out of bundles, and strip the characters that could smuggle control
 * sequences into a prompt.
 */

const BUILT_IN_DENIED_PREFIXES = [".git", ".harness"] as const;

/** A locator is a relative POSIX path inside the project, nothing else. */
export function isSafeRelativeLocator(locator: string): boolean {
  if (locator.length === 0 || locator.length > 400) return false;
  if (locator.includes("\\") || locator.includes("\u0000")) return false;
  if (locator.startsWith("/") || /^[A-Za-z]:/.test(locator)) return false;
  const segments = locator.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return true;
}

function normalizePrefix(prefix: string): string | undefined {
  if (!isSafeRelativeLocator(prefix) && !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\/$/.test(prefix)) {
    return undefined;
  }
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

function hasPrefix(locator: string, prefix: string): boolean {
  return locator === prefix || locator.startsWith(`${prefix}/`);
}

/**
 * Pure locator policy check used by both the adapters (before reading) and
 * the Harness acceptance gate (before trusting an adapter's bundle).
 */
export function isLocatorAllowedByPolicy(
  locator: string,
  pathPolicy: ProjectContextPathPolicy,
): boolean {
  if (!isSafeRelativeLocator(locator)) return false;
  for (const denied of BUILT_IN_DENIED_PREFIXES) {
    if (hasPrefix(locator, denied)) return false;
  }
  for (const denied of pathPolicy.denied_paths ?? []) {
    const normalized = normalizePrefix(denied);
    if (normalized !== undefined && hasPrefix(locator, normalized)) return false;
  }
  const allowedRoots = (pathPolicy.allowed_roots ?? [])
    .map((root) => normalizePrefix(root))
    .filter((root): root is string => root !== undefined);
  if (allowedRoots.length > 0 && !allowedRoots.some((root) => hasPrefix(locator, root))) {
    return false;
  }
  return true;
}

const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(?:\..+)?$/u,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u,
  /\.(?:pem|key|p12|pfx|keystore|jks)$/u,
  /(?:^|[._-])credentials?(?:[._-]|$)/u,
  /(?:^|[._-])secrets?(?:[._-]|$)/u,
];

/** Well-known secret file names fail closed before any content is read. */
export function isSecretLocator(locator: string): boolean {
  const basename = locator.split("/").at(-1) ?? locator;
  return SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/iu,
];

/** Content-level secret scan: any hit excludes the whole source. */
export function containsSecretContent(text: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** A NUL byte or a heavy control-character ratio marks binary content. */
export function looksBinaryContent(content: Uint8Array): boolean {
  const probe = content.subarray(0, 8192);
  if (probe.length === 0) return false;
  let control = 0;
  for (const byte of probe) {
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control += 1;
  }
  return control / probe.length > 0.1;
}

const UNSAFE_TEXT_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/**
 * Neutralize untrusted text before it enters a bundle summary: strip C0/C1
 * control characters (keeping tab, LF and CR), zero-width characters and
 * bidi overrides. The text itself stays — as data.
 */
export function sanitizeContextText(text: string): string {
  return text.normalize("NFC").replace(UNSAFE_TEXT_PATTERN, "");
}

/** Harness-side check: an accepted summary must already be sanitized. */
export function hasUnsafeText(text: string): boolean {
  return new RegExp(UNSAFE_TEXT_PATTERN.source, "u").test(text);
}
