/**
 * Deterministic API contract entry extraction (comparative design direction
 * 2, card T3). The auditor is pure and never reads files, so contract
 * entries are extracted at scan time -- when the scanner already holds the
 * document bytes -- and stored in the `harness.scan` extension as
 * `api_entries`. Extraction runs only for documentation files whose path
 * names a contract (the same keyword family the auditor uses), so ordinary
 * documentation never grows the field.
 *
 * Two entry shapes are recognized, in order: HTTP endpoint lines
 * (`POST /retrieve`) and ATX headings. Entries are sorted, de-duplicated and
 * capped, so identical content always yields identical output.
 */
export const CONTRACT_PATH_PATTERN = /\bapi\b|\bcontract\b|\bopenapi\b|\bproto\b/iu;

const ENDPOINT_PATTERN = /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/[A-Za-z0-9_\-./{}:]*)/gu;
const HEADING_PATTERN = /^#{1,3}[ \t]+(\S[^\n]*)$/gmu;

/** Largest entry set kept per document; extraction stays bounded. */
const API_ENTRIES_LIMIT = 50;

/** Extract the contract entry list of one document, or undefined when not applicable. */
export function extractApiEntries(path: string, content: string): readonly string[] | undefined {
  if (!CONTRACT_PATH_PATTERN.test(path)) return undefined;
  const entries = new Set<string>();
  for (const match of content.matchAll(ENDPOINT_PATTERN)) {
    entries.add(`${match[1] as string} ${match[2] as string}`);
  }
  for (const match of content.matchAll(HEADING_PATTERN)) {
    const heading = (match[1] as string).trim();
    if (heading.length > 0) entries.add(heading);
  }
  if (entries.size === 0) return undefined;
  return [...entries].sort().slice(0, API_ENTRIES_LIMIT);
}
