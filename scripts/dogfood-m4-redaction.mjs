/** Redaction boundary for M4 real-provider dogfood Evidence. */

const SECRET_PLACEHOLDER = "***redacted-secret***";
const PATH_PLACEHOLDER = "<redacted-path>";

function replaceEvery(text, value, replacement) {
  if (value.length === 0) return text;
  return text.split(value).join(replacement);
}

/**
 * @param {string} text
 * @param {{secrets?: readonly unknown[], absolute_paths?: readonly unknown[]}} input
 */
export function redactM4Evidence(text, input = {}) {
  let output = String(text);
  for (const candidate of input.secrets ?? []) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    output = replaceEvery(output, candidate, SECRET_PLACEHOLDER);
    const encoded = encodeURIComponent(candidate);
    if (encoded !== candidate) output = replaceEvery(output, encoded, SECRET_PLACEHOLDER);
  }
  const paths = (input.absolute_paths ?? [])
    .filter((candidate) => typeof candidate === "string" && candidate.startsWith("/"))
    .sort((left, right) => right.length - left.length);
  for (const path of paths) output = replaceEvery(output, path, PATH_PLACEHOLDER);
  return output;
}
