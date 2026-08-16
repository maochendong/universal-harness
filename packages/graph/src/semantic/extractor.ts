import type { SemanticScore } from "@universal-harness-internal/plugin-sdk";

export const SEMANTIC_EXTRACTOR_VERSION = "symbol-v1" as const;

export interface SemanticFeatures {
  readonly symbols: readonly string[];
  readonly imports: readonly string[];
  readonly paths: readonly string[];
  readonly terms: readonly string[];
}

const FEATURE_WEIGHTS = {
  symbols: 8,
  imports: 5,
  paths: 3,
  terms: 1,
} as const;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter(Boolean).sort();
}

/** Normalize source identifiers and prose into stable, Unicode-aware tokens. */
export function normalizeSemanticTokens(value: string): string[] {
  const separated = value
    .normalize("NFKC")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return uniqueSorted(
    separated
      .split(/\s+/u)
      .map((token) => token.toLocaleLowerCase("en-US"))
      .filter(Boolean),
  );
}

function collectMatches(content: string, patterns: readonly RegExp[]): string[] {
  const values: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      for (let index = 1; index < match.length; index += 1) {
        if (match[index] !== undefined) values.push(match[index] as string);
      }
    }
  }
  return normalizeSemanticTokens(values.join(" "));
}

/** Deterministically extract local symbols, imports, locator path and document terms. */
export function extractSemanticFeatures(input: {
  readonly locator?: string;
  readonly content: string;
}): SemanticFeatures {
  const declaredSymbols = collectMatches(input.content, [
    /\b(?:class|interface|type|enum|function|const|let|var|def|record)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gmu,
    /\b(?:export|public|private|protected|static|async)\s+(?:class|interface|type|enum|function|const|let|var)?\s*([\p{L}_$][\p{L}\p{N}_$]*)/gmu,
    /\bimport\s*\{([^}]+)\}/gmu,
    /\b(?:describe|it|test)\s*\(?\s*["'`]([^"'`]+)["'`]/gmu,
  ]);
  const imports = collectMatches(input.content, [
    /\bfrom\s*["']([^"']+)["']/gmu,
    /\bimport\s*["']([^"']+)["']/gmu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gmu,
    /\bimport\s+([\p{L}\p{N}_.]+)\s*;?/gmu,
    /\bfrom\s+([\p{L}\p{N}_.]+)\s+import\b/gmu,
  ]);
  const locator = input.locator ?? "";
  const pathValue = locator.includes("://") ? locator.slice(locator.indexOf("://") + 3) : locator;
  const pathWithoutRepository = pathValue.includes("/")
    ? pathValue.slice(pathValue.indexOf("/") + 1)
    : pathValue;
  const paths = normalizeSemanticTokens(pathWithoutRepository);
  const fileName = pathWithoutRepository.split("/").at(-1) ?? "";
  const fileStem = fileName.replace(/(?:\.[^.]+)+$/u, "");
  const symbols = uniqueSorted([...declaredSymbols, ...normalizeSemanticTokens(fileStem)]);
  const terms = normalizeSemanticTokens(input.content);
  return { symbols, imports, paths, terms };
}

/** Fixed-point weighted Jaccard; avoids platform-dependent floating-point ordering. */
export function weightedJaccard(left: SemanticFeatures, right: SemanticFeatures): SemanticScore {
  let numerator = 0;
  let denominator = 0;
  for (const kind of Object.keys(FEATURE_WEIGHTS) as (keyof typeof FEATURE_WEIGHTS)[]) {
    const leftSet = new Set(left[kind]);
    const rightSet = new Set(right[kind]);
    const union = new Set([...leftSet, ...rightSet]);
    let intersection = 0;
    for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
    numerator += intersection * FEATURE_WEIGHTS[kind];
    denominator += union.size * FEATURE_WEIGHTS[kind];
  }
  const millionths =
    denominator === 0 ? 0 : Math.min(990_000, Math.round((numerator * 1_000_000) / denominator));
  return { numerator, denominator, millionths };
}
