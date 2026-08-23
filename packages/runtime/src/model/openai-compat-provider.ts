import { lookup } from "node:dns/promises";

import type { ModelPortFailure } from "@universal-harness-internal/core";

import type {
  ManagedModelProviderPort,
  ManagedModelProviderRequest,
  ManagedModelProviderResponse,
} from "./managed-runner.js";

/**
 * OpenAI-compatible managed provider (real counterpart to the PG-2 port).
 * One instance serves one endpoint/model pair; the per-slot wiring lives in
 * provider-registry.ts. DeepSeek's official endpoint is the canonical target,
 * but any chat-completions-compatible HTTPS gateway works.
 *
 * Security posture mirrors the LLM judge transport: the endpoint is validated
 * before any credential or network operation (HTTPS only, no URL
 * credentials/query/fragment, no private/loopback targets, DNS preflight
 * against private resolutions), and the API key is read from an allowlisted
 * environment variable — never from config, never logged.
 */

export const MANAGED_PROVIDER_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;

export interface OpenAiCompatProviderConfig {
  readonly provider_identity: string;
  readonly endpoint: string;
  readonly model: string;
  readonly api_key_env: string;
  readonly env_allowlist: readonly string[];
  /** Response read cap; independent of the runner's output budget. */
  readonly max_response_bytes?: number;
  /** Test-only escape hatch; production endpoints remain HTTPS-only. */
  readonly allow_loopback_http?: boolean;
}

export interface OpenAiCompatProviderDependencies {
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Injectable DNS preflight; production resolves every hostname before sending credentials. */
  readonly resolveHostname?: (hostname: string) => Promise<readonly string[]>;
}

function failure(
  code: ModelPortFailure["code"],
  summary: string,
  retryable: boolean,
): ManagedModelProviderResponse {
  return { ok: false, failure: { code, summary, retryable } };
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
function validateEndpoint(
  endpoint: string,
  allowLoopbackHttp: boolean | undefined,
): ManagedModelProviderResponse | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return failure("policy_denied", "provider endpoint is not a valid URL", false);
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    return failure(
      "policy_denied",
      "provider endpoint cannot contain credentials, query parameters or fragments",
      false,
    );
  }
  const testLoopback =
    allowLoopbackHttp === true && url.protocol === "http:" && loopback(url.hostname);
  if (url.protocol !== "https:" && !testLoopback) {
    return failure("policy_denied", "provider endpoint must use HTTPS", false);
  }
  if (!testLoopback && privateAddress(url.hostname)) {
    return failure("policy_denied", "provider endpoint targets a private address", false);
  }
  return undefined;
}

function completionText(value: unknown): string | undefined {
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

function tokenUsage(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const total = record["total_tokens"];
  if (Number.isSafeInteger(total) && (total as number) >= 0) return total as number;
  const prompt = record["prompt_tokens"];
  const completion = record["completion_tokens"];
  if (
    Number.isSafeInteger(prompt) &&
    (prompt as number) >= 0 &&
    Number.isSafeInteger(completion) &&
    (completion as number) >= 0
  ) {
    return (prompt as number) + (completion as number);
  }
  return undefined;
}

/**
 * Read a response body while enforcing the byte cap incrementally: the moment
 * the accumulated bytes exceed the cap the stream is cancelled, so a hostile
 * or broken provider cannot force the full payload into memory before the
 * budget check runs. Falls back to a single buffered read only when the
 * implementation exposes no stream.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | "too_large" | "unreadable"> {
  if (response.body === null) {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > maxBytes ? "too_large" : bytes;
    } catch {
      return "unreadable";
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return "unreadable";
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createOpenAiCompatManagedProvider(
  config: OpenAiCompatProviderConfig,
  deps: OpenAiCompatProviderDependencies = {},
): ManagedModelProviderPort {
  const maxBytes = config.max_response_bytes ?? MANAGED_PROVIDER_MAX_RESPONSE_BYTES;
  return {
    async invoke(request: ManagedModelProviderRequest): Promise<ManagedModelProviderResponse> {
      const endpointFailure = validateEndpoint(config.endpoint, config.allow_loopback_http);
      if (endpointFailure !== undefined) return endpointFailure;
      if (!config.env_allowlist.includes(config.api_key_env)) {
        return failure(
          "policy_denied",
          `provider API key ${config.api_key_env} is not in env_allowlist`,
          false,
        );
      }
      const url = new URL(config.endpoint);
      const hostname = url.hostname.replace(/^\[|\]$/gu, "");
      const testLoopback =
        config.allow_loopback_http === true && url.protocol === "http:" && loopback(hostname);
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
          return failure("provider_unavailable", "provider endpoint DNS resolution failed", true);
        }
        if (addresses.length === 0 || addresses.some(privateAddress)) {
          return failure(
            "policy_denied",
            "provider endpoint DNS resolution includes a private address",
            false,
          );
        }
      }
      const apiKey = (deps.ambientEnvironment ?? process.env)[config.api_key_env];
      if (apiKey === undefined || apiKey === "") {
        return failure(
          "provider_unavailable",
          `provider API key ${config.api_key_env} is unavailable`,
          false,
        );
      }
      const fetchImpl = deps.fetch ?? fetch;
      const sleep =
        deps.sleep ??
        ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
      const body = JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });
      let lastRetryable: ManagedModelProviderResponse = failure(
        "provider_unavailable",
        "provider request failed",
        true,
      );
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        // Runner-level cancellation (budget expiry upstream) aborts in-flight
        // sockets immediately instead of waiting out the per-attempt timeout.
        const runnerSignal = request.signal;
        if (runnerSignal?.aborted === true) controller.abort();
        const onRunnerAbort = (): void => {
          controller.abort();
        };
        runnerSignal?.addEventListener("abort", onRunnerAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), request.timeout_ms);
        try {
          const response = await fetchImpl(config.endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body,
            signal: controller.signal,
            redirect: "error",
          });
          if (response.ok) {
            let value: unknown;
            const bounded = await readBoundedBody(response, maxBytes);
            if (bounded === "too_large") {
              return failure(
                "budget_exhausted",
                `provider response exceeded ${String(maxBytes)} bytes`,
                false,
              );
            }
            if (bounded === "unreadable") {
              return failure("invalid_output", "provider response is not valid JSON", false);
            }
            try {
              value = JSON.parse(new TextDecoder().decode(bounded)) as unknown;
            } catch {
              return failure("invalid_output", "provider response is not valid JSON", false);
            }
            const content = completionText(value);
            if (content === undefined) {
              return failure("invalid_output", "provider response carries no text content", false);
            }
            const tokens = tokenUsage(value);
            return {
              ok: true,
              content,
              ...(tokens === undefined ? {} : { usage: { tokens } }),
            };
          }
          if (response.status !== 429 && response.status < 500) {
            return failure(
              "provider_unavailable",
              `provider rejected the request with HTTP ${String(response.status)}`,
              false,
            );
          }
          lastRetryable = failure(
            "provider_unavailable",
            `provider is unavailable (HTTP ${String(response.status)})`,
            true,
          );
        } catch (error) {
          const aborted =
            controller.signal.aborted ||
            (error instanceof Error && error.name === "AbortError") ||
            (error instanceof DOMException && error.name === "AbortError");
          if (aborted) {
            return failure(
              "timeout",
              `provider call exceeded ${String(request.timeout_ms)}ms`,
              true,
            );
          }
          lastRetryable = failure("provider_unavailable", "provider request failed", true);
        } finally {
          clearTimeout(timer);
          runnerSignal?.removeEventListener("abort", onRunnerAbort);
        }
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
      }
      return lastRetryable;
    },
  };
}
