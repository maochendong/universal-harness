/**
 * Secret redaction for the M3 real-platform dogfood evidence bundles
 * (plan M3 Task 9 review fix).
 *
 * The dogfood driver shells out to git with a credential-bearing transport
 * URL, so a failed `execFileSync` error message contains the full command
 * line — including the PAT. Before any evidence bundle (passed, blocked or
 * failed) is written, every byte of it passes through `redactSecrets`,
 * which replaces each registered secret and its URL-encoded form with a
 * fixed placeholder. Exercised by `tests/security/m3-dogfood-redaction.test.ts`.
 */

/**
 * Replace every occurrence of each non-empty string secret in `text` with a
 * placeholder. Split/join instead of RegExp so secrets never need escaping.
 * @param {string} text
 * @param {readonly unknown[]} secrets
 * @returns {string}
 */
export function redactSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    out = out.split(secret).join("***redacted***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      out = out.split(encoded).join("***redacted***");
    }
  }
  return out;
}
