/**
 * Environment Secret Reference (design 14). M1 secrets come only from the
 * environment and are referenced by name: a parameter value of the form
 * `{ "$env": "NAME" }` is resolved at the invocation boundary, and only the
 * reference -- never the value -- may appear in schemas, ledger records,
 * events, projections, checkpoints or logs. A pluggable SecretProvider is a
 * separate follow-up design.
 */
export const SECRET_REFERENCE_KEY = "$env";

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

/** Placeholder substituted wherever a secret value was redacted. */
export const REDACTED_SECRET = "[redacted:secret]";

export const SECRET_ERROR_KINDS = [
  "invalid_secret_reference",
  "undeclared_secret_parameter",
  "unresolved_secret",
  "secret_leak",
] as const;

export type SecretErrorKind = (typeof SECRET_ERROR_KINDS)[number];

export class SecretError extends Error {
  readonly kind: SecretErrorKind;

  constructor(kind: SecretErrorKind, message: string) {
    super(message);
    this.name = "SecretError";
    this.kind = kind;
  }
}

/** Whether a value is exactly one Environment Secret Reference. */
export function isSecretReference(value: unknown): value is { readonly $env: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== 1) return false;
  const [key, name] = entries[0] as [string, unknown];
  return key === SECRET_REFERENCE_KEY && typeof name === "string" && SECRET_NAME_PATTERN.test(name);
}

interface ReferenceSite {
  readonly path: string;
  readonly name: string;
}

function collectReferences(value: unknown, path: string, sites: ReferenceSite[]): void {
  if (isSecretReference(value)) {
    sites.push({ path, name: value[SECRET_REFERENCE_KEY] });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectReferences(entry, `${path}[${String(index)}]`, sites));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectReferences(entry, `${path}.${key}`, sites);
    }
  }
}

/** All secret references inside a parameter tree, with their JSON paths. */
export function findSecretReferences(parameters: Record<string, unknown>): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  collectReferences(parameters, "", sites);
  return sites;
}

export interface ResolvedSecrets {
  /** Parameters with every declared reference replaced by its env value. */
  readonly parameters: Record<string, unknown>;
  /** Resolved name/value pairs; used only for redaction, never persisted. */
  readonly values: ReadonlyMap<string, string>;
}

/**
 * Resolve declared Environment Secret References at the invocation boundary.
 * A reference at any path whose top-level parameter is not declared in the
 * tool descriptor is refused, so a prompt can never smuggle a secret into an
 * undeclared channel; a missing or empty environment variable is a typed
 * unresolved_secret, not a silent empty string.
 */
export function resolveSecretParameters(
  parameters: Record<string, unknown>,
  declared: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ResolvedSecrets {
  const sites = findSecretReferences(parameters);
  const values = new Map<string, string>();
  for (const site of sites) {
    const topLevel = site.path.replace(/^\./u, "").split(/[.[]/u)[0] ?? "";
    if (!declared.includes(topLevel)) {
      throw new SecretError(
        "undeclared_secret_parameter",
        `secret reference at "${site.path}" is not a declared secret parameter of the tool`,
      );
    }
    const value = env[site.name];
    if (value === undefined || value === "") {
      throw new SecretError(
        "unresolved_secret",
        `environment variable ${site.name} referenced at "${site.path}" is not set`,
      );
    }
    values.set(site.name, value);
  }
  const resolve = (value: unknown): unknown => {
    if (isSecretReference(value)) {
      const resolved = values.get(value[SECRET_REFERENCE_KEY]);
      if (resolved === undefined) {
        throw new SecretError(
          "invalid_secret_reference",
          `secret reference "${value[SECRET_REFERENCE_KEY]}" was not resolved`,
        );
      }
      return resolved;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    }
    return value;
  };
  return { parameters: resolve(parameters) as Record<string, unknown>, values };
}

function containsSecret(value: unknown, secrets: ReadonlyMap<string, string>): boolean {
  if (typeof value === "string") {
    for (const secret of secrets.values()) {
      if (value.includes(secret)) return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secrets));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => containsSecret(entry, secrets));
  }
  return false;
}

/**
 * Deep-redact every occurrence of a resolved secret value. Any string that
 * contains a secret is replaced wholesale, so no partial secret can survive
 * in evidence, errors or logs.
 */
export function redactSecretValues<T>(value: T, secrets: ReadonlyMap<string, string>): T {
  if (secrets.size === 0) return value;
  if (typeof value === "string") {
    return (containsSecret(value, secrets) ? REDACTED_SECRET : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretValues(entry, secrets)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactSecretValues(entry, secrets)]),
    ) as T;
  }
  return value;
}

/**
 * Persistence guard: throws secret_leak when any resolved secret value would
 * enter a structure about to be persisted or logged.
 */
export function assertNoSecretValues(value: unknown, secrets: ReadonlyMap<string, string>): void {
  if (containsSecret(value, secrets)) {
    throw new SecretError(
      "secret_leak",
      "a resolved secret value would enter a persisted record; only references may be stored",
    );
  }
}
