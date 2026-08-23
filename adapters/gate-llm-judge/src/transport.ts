import { contentDigest } from "@universal-harness-internal/core";
import { lookup } from "node:dns/promises";

export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

export type JudgeTransportErrorKind =
  | "invalid_endpoint"
  | "ssrf_blocked"
  | "secret_not_allowlisted"
  | "secret_missing"
  | "timeout"
  | "rate_limited"
  | "provider_5xx"
  | "network_failure"
  | "invalid_provider_response";

export class JudgeTransportError extends Error {
  readonly kind: JudgeTransportErrorKind;

  constructor(kind: JudgeTransportErrorKind, message: string) {
    super(message);
    this.name = "JudgeTransportError";
    this.kind = kind;
  }
}

export interface JudgeEndpointValidationOptions {
  readonly allowLoopbackHttp?: boolean;
}

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.")
  );
}

/**
 * Parse an IPv6 literal (any RFC 4291 textual form, including an embedded
 * dotted IPv4 tail) into its eight 16-bit groups. Returns undefined when the
 * input is not an IPv6 literal, so callers never mistake a hostname for one.
 */
function parseIpv6Groups(host: string): readonly number[] | undefined {
  let rest = host;
  const tailGroups: number[] = [];
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(rest);
  if (dotted !== null) {
    const bytes = dotted[1]?.split(".").map(Number) ?? [];
    if (bytes.some((byte) => byte > 255)) return undefined;
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;
    tailGroups.push((b0 << 8) | b1, (b2 << 8) | b3);
    rest = rest.slice(0, rest.length - (dotted[1]?.length ?? 0));
    if (rest.endsWith(":") && !rest.endsWith("::")) rest = rest.slice(0, -1);
  }
  if (rest === "") return undefined;
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const parsePart = (part: string): number | undefined =>
    /^[0-9a-f]{1,4}$/u.test(part) ? Number.parseInt(part, 16) : undefined;
  const head: number[] = [];
  for (const part of halves[0] === "" ? [] : (halves[0] ?? "").split(":")) {
    const value = parsePart(part);
    if (value === undefined) return undefined;
    head.push(value);
  }
  const tail: number[] = [];
  if (halves.length === 2) {
    for (const part of halves[1] === "" ? [] : (halves[1] ?? "").split(":")) {
      const value = parsePart(part);
      if (value === undefined) return undefined;
      tail.push(value);
    }
  }
  const present = head.length + tail.length + tailGroups.length;
  if (halves.length === 1) {
    // No "::" compression: exactly eight groups are mandatory.
    if (present !== 8) return undefined;
    return [...head, ...tailGroups];
  }
  const missing = 8 - present;
  if (missing < 0) return undefined;
  return [...head, ...Array<number>(missing).fill(0), ...tail, ...tailGroups];
}

function privateIpv4(first: number, second: number): boolean {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function privateAddress(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/%.*$/u, "");
  if (loopback(host)) return true;
  const groups = parseIpv6Groups(host);
  if (groups !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
    const firstFiveZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
    if (firstFiveZero && f === 0xffff) {
      // IPv4-mapped IPv6 (`::ffff:127.0.0.1`, also reported by Node in the
      // compressed hex form `::ffff:7f00:1`): judge the embedded IPv4.
      return privateIpv4((g >> 8) & 0xff, g & 0xff);
    }
    if (firstFiveZero && f === 0) {
      if (g === 0 && h <= 1) return true; // `::` unspecified, `::1` loopback
      // Deprecated IPv4-compatible IPv6 (`::127.0.0.1`): judge the embedded IPv4.
      return privateIpv4((g >> 8) & 0xff, g & 0xff);
    }
    if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [first = -1, second = -1] = parts;
  return privateIpv4(first, second);
}

/** Validate the endpoint before any credential or network operation occurs. */
export function validateJudgeEndpoint(
  endpoint: string,
  options: JudgeEndpointValidationOptions = {},
): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new JudgeTransportError("invalid_endpoint", "judge endpoint is not a valid URL");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    throw new JudgeTransportError(
      "invalid_endpoint",
      "judge endpoint cannot contain credentials, query parameters or fragments",
    );
  }
  const testLoopback =
    options.allowLoopbackHttp === true && url.protocol === "http:" && loopback(url.hostname);
  if (url.protocol !== "https:" && !testLoopback) {
    throw new JudgeTransportError("invalid_endpoint", "judge endpoint must use HTTPS");
  }
  if (!testLoopback && privateAddress(url.hostname)) {
    throw new JudgeTransportError("ssrf_blocked", "judge endpoint resolves to a private address");
  }
  return url.origin;
}

export interface JudgeTransportConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  readonly timeout_ms: number;
  readonly allow_loopback_http?: boolean;
}

export interface JudgeTransportDependencies {
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Injectable DNS preflight; production resolves every hostname before sending credentials. */
  readonly resolveHostname?: (hostname: string) => Promise<readonly string[]>;
}

export type JudgeTransportResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly response_digest: string;
      readonly attempts: number;
      readonly retry_count: number;
      readonly endpoint_origin: string;
    }
  | {
      readonly ok: false;
      readonly error_kind: JudgeTransportErrorKind;
      readonly attempts: number;
      readonly retry_count: number;
      readonly endpoint_origin: string;
    };

function contentFromProvider(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function failureKind(status: number): JudgeTransportErrorKind {
  return status === 429 ? "rate_limited" : "provider_5xx";
}

/** Perform a bounded OpenAI-compatible request with at most two fixed retries. */
export async function requestJudgeCompletion(
  config: JudgeTransportConfig,
  request: unknown,
  deps: JudgeTransportDependencies = {},
): Promise<JudgeTransportResult> {
  const endpointOrigin = validateJudgeEndpoint(config.endpoint, {
    ...(config.allow_loopback_http === undefined
      ? {}
      : { allowLoopbackHttp: config.allow_loopback_http }),
  });
  if (!config.env_allowlist.includes(config.api_key_env)) {
    throw new JudgeTransportError(
      "secret_not_allowlisted",
      `judge API key ${config.api_key_env} is not in env_allowlist`,
    );
  }
  const hostname = new URL(config.endpoint).hostname.replace(/^\[|\]$/gu, "");
  const testLoopback =
    config.allow_loopback_http === true &&
    new URL(config.endpoint).protocol === "http:" &&
    loopback(hostname);
  const resolveHostname =
    deps.resolveHostname ??
    (deps.fetch === undefined && !testLoopback
      ? async (host: string): Promise<readonly string[]> =>
          (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
      : undefined);
  if (resolveHostname !== undefined) {
    let addresses: readonly string[];
    try {
      addresses = await resolveHostname(hostname);
    } catch {
      throw new JudgeTransportError("network_failure", "judge endpoint DNS resolution failed");
    }
    if (addresses.length === 0 || addresses.some(privateAddress)) {
      throw new JudgeTransportError(
        "ssrf_blocked",
        "judge endpoint DNS resolution includes a private address",
      );
    }
  }
  const apiKey = (deps.ambientEnvironment ?? process.env)[config.api_key_env];
  if (apiKey === undefined || apiKey === "") {
    throw new JudgeTransportError(
      "secret_missing",
      `judge API key ${config.api_key_env} is unavailable`,
    );
  }
  const fetchImpl = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastKind: JudgeTransportErrorKind = "network_failure";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout_ms);
    try {
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.ok) {
        let value: unknown;
        try {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
            return {
              ok: false,
              error_kind: "invalid_provider_response",
              attempts: attempt,
              retry_count: attempt - 1,
              endpoint_origin: endpointOrigin,
            };
          }
          value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        } catch {
          return {
            ok: false,
            error_kind: "invalid_provider_response",
            attempts: attempt,
            retry_count: attempt - 1,
            endpoint_origin: endpointOrigin,
          };
        }
        const content = contentFromProvider(value);
        if (content === undefined) {
          return {
            ok: false,
            error_kind: "invalid_provider_response",
            attempts: attempt,
            retry_count: attempt - 1,
            endpoint_origin: endpointOrigin,
          };
        }
        return {
          ok: true,
          content,
          response_digest: contentDigest(content),
          attempts: attempt,
          retry_count: attempt - 1,
          endpoint_origin: endpointOrigin,
        };
      }
      if (response.status !== 429 && response.status < 500) {
        return {
          ok: false,
          error_kind: "invalid_provider_response",
          attempts: attempt,
          retry_count: attempt - 1,
          endpoint_origin: endpointOrigin,
        };
      }
      lastKind = failureKind(response.status);
    } catch (error) {
      lastKind =
        controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
          ? "timeout"
          : "network_failure";
      if (lastKind === "timeout") {
        return {
          ok: false,
          error_kind: lastKind,
          attempts: attempt,
          retry_count: attempt - 1,
          endpoint_origin: endpointOrigin,
        };
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await sleep(attempt * 100);
  }
  return {
    ok: false,
    error_kind: lastKind,
    attempts: 3,
    retry_count: 2,
    endpoint_origin: endpointOrigin,
  };
}
