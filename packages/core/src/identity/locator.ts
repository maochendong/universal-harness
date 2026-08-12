import { IDENTIFIER_PATTERN } from "../schema/common.js";

/**
 * Repository-qualified locators: `repo://<repository_id>/<path>` with an
 * optional `#<kind>=<value>` fragment qualifying a symbol, API or migration.
 *
 * Normalization is platform-neutral: backslashes become forward slashes and
 * strings are Unicode-normalized to NFC, so the same logical locator produces
 * the same string on Linux, macOS and Windows. Normalization is purely
 * lexical — paths are never resolved against the filesystem — and any input
 * that could escape the repository boundary (absolute paths, `..` segments,
 * ambiguous drive prefixes) is rejected outright.
 */
export class LocatorError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid locator: ${reason}`);
    this.name = "LocatorError";
    this.reason = reason;
  }
}

export const LOCATOR_QUALIFIER_KINDS = ["symbol", "api", "migration"] as const;
export type LocatorQualifierKind = (typeof LOCATOR_QUALIFIER_KINDS)[number];

const QUALIFIER_VALUE_PATTERNS: Record<LocatorQualifierKind, RegExp> = {
  symbol: /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/,
  api: /^(?:get|post|put|patch|delete|head|options):\/[A-Za-z0-9_./{}-]+$/,
  migration: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
};

const IDENTIFIER_REGEX = new RegExp(IDENTIFIER_PATTERN);
const RESERVED_PATH_CHARACTER = /[?#%:]/;

function hasIllegalPathCharacter(segment: string): boolean {
  if (RESERVED_PATH_CHARACTER.test(segment)) return true;
  for (const character of segment) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface LocatorQualifier {
  kind: LocatorQualifierKind;
  value: string;
}

export interface ParsedLocator {
  repository_id: string;
  path?: string;
  qualifier?: LocatorQualifier;
}

/** Normalize a repository-relative path to its canonical `/`-separated form. */
export function normalizeLocatorPath(input: string): string {
  const normalized = input.normalize("NFC");
  if (normalized.length === 0) {
    throw new LocatorError("path is empty");
  }
  if (/^[/\\]/.test(normalized)) {
    throw new LocatorError(`absolute path is not repository-relative: ${input}`);
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new LocatorError(`ambiguous drive prefix: ${input}`);
  }
  const segments = normalized.replaceAll("\\", "/").split("/");
  const canonical: string[] = [];
  for (const segment of segments) {
    if (segment === "") {
      throw new LocatorError(`empty path segment in: ${input}`);
    }
    if (segment === "..") {
      throw new LocatorError(`traversal segment escapes the repository boundary: ${input}`);
    }
    if (hasIllegalPathCharacter(segment)) {
      throw new LocatorError(`illegal character in path segment "${segment}"`);
    }
    if (segment === ".") continue;
    canonical.push(segment);
  }
  if (canonical.length === 0) {
    throw new LocatorError(`path resolves outside the repository boundary: ${input}`);
  }
  return canonical.join("/");
}

export function parseLocator(locator: string): ParsedLocator {
  const normalized = locator.normalize("NFC");
  if (!normalized.startsWith("repo://")) {
    throw new LocatorError(`missing repo:// scheme: ${locator}`);
  }
  const body = normalized.slice("repo://".length);
  const fragmentIndex = body.indexOf("#");
  const authorityAndPath = fragmentIndex === -1 ? body : body.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? undefined : body.slice(fragmentIndex + 1);
  if (fragment !== undefined && fragment.includes("#")) {
    throw new LocatorError(`multiple fragment separators in: ${locator}`);
  }

  const slashIndex = authorityAndPath.indexOf("/");
  const repositoryId = slashIndex === -1 ? authorityAndPath : authorityAndPath.slice(0, slashIndex);
  const rawPath = slashIndex === -1 ? undefined : authorityAndPath.slice(slashIndex + 1);
  if (!IDENTIFIER_REGEX.test(repositoryId)) {
    throw new LocatorError(`invalid repository identifier "${repositoryId}"`);
  }

  const parsed: ParsedLocator = { repository_id: repositoryId };
  if (rawPath !== undefined) {
    parsed.path = normalizeLocatorPath(rawPath);
  }
  if (fragment !== undefined) {
    parsed.qualifier = parseQualifier(fragment);
  }
  return parsed;
}

export function buildLocator(parts: ParsedLocator): string {
  if (!IDENTIFIER_REGEX.test(parts.repository_id)) {
    throw new LocatorError(`invalid repository identifier "${parts.repository_id}"`);
  }
  let locator = `repo://${parts.repository_id}`;
  if (parts.path !== undefined) {
    locator += `/${normalizeLocatorPath(parts.path)}`;
  }
  if (parts.qualifier !== undefined) {
    locator += `#${formatQualifier(parts.qualifier)}`;
  }
  return locator;
}

/** Parse and re-emit a locator in canonical form. */
export function canonicalizeLocator(locator: string): string {
  return buildLocator(parseLocator(locator));
}

function parseQualifier(fragment: string): LocatorQualifier {
  const equalsIndex = fragment.indexOf("=");
  if (equalsIndex === -1) {
    throw new LocatorError(`fragment must use <kind>=<value> form: ${fragment}`);
  }
  const kind = fragment.slice(0, equalsIndex) as LocatorQualifierKind;
  const value = fragment.slice(equalsIndex + 1);
  const pattern = QUALIFIER_VALUE_PATTERNS[kind];
  if (pattern === undefined) {
    throw new LocatorError(`unknown qualifier kind "${kind}"`);
  }
  if (!pattern.test(value)) {
    throw new LocatorError(`illegal ${kind} qualifier value "${value}"`);
  }
  return { kind, value };
}

function formatQualifier(qualifier: LocatorQualifier): string {
  const pattern = QUALIFIER_VALUE_PATTERNS[qualifier.kind];
  if (pattern === undefined || !pattern.test(qualifier.value)) {
    throw new LocatorError(`illegal ${qualifier.kind} qualifier value "${qualifier.value}"`);
  }
  return `${qualifier.kind}=${qualifier.value}`;
}
