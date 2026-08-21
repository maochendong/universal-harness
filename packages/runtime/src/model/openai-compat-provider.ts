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

function privateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (loopback(host)) return true;
  if (
    host === "0.0.0.0" ||
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  )
    return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [first = -1, second = -1] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
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
            try {
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (bytes.byteLength > maxBytes) {
                return failure(
                  "budget_exhausted",
                  `provider response exceeded ${String(maxBytes)} bytes`,
                  false,
                );
              }
              value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
            } catch {
              return failure("invalid_output", "provider response is not valid JSON", false);
            }
            const content = completionText(value);
            if (content === undefined) {
              return failure("invalid_output", "provider response carries no text content", false);
            }
            return { ok: true, content };
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
        }
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
      }
      return lastRetryable;
    },
  };
}
