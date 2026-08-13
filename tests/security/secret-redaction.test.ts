import { describe, expect, it } from "vitest";

import {
  REDACTED_SECRET,
  SecretError,
  assertNoSecretValues,
  findSecretReferences,
  isSecretReference,
  redactSecretValues,
  resolveSecretParameters,
} from "../../packages/runtime/src/index.js";

/**
 * Secret redaction invariants (design 13.5; security test list; completion
 * rule 12). Only Environment Secret References -- never resolved values --
 * may enter a persisted structure; redaction rewrites every occurrence of a
 * resolved secret in arbitrarily nested output, and the leak detector itself
 * never echoes the secret it found.
 */
const SECRETS = new Map([
  ["API_TOKEN", "sk-live-9f27acbd"],
  ["DEPLOY_KEY", "deploy-key-00112233"],
]);

describe("secret reference handling", () => {
  it("recognizes only the reference form, never a bare value", () => {
    expect(isSecretReference({ $env: "API_TOKEN" })).toBe(true);
    expect(isSecretReference("sk-live-9f27acbd")).toBe(false);
    expect(isSecretReference({ $env: "not a name!" })).toBe(false);
    expect(
      findSecretReferences({ token: { $env: "API_TOKEN" }, plain: "x" }).map((site) => site.name),
    ).toEqual(["API_TOKEN"]);
  });

  it("resolves only declared secret parameters and keeps references elsewhere intact", () => {
    const parameters = {
      url: "https://example.test",
      token: { $env: "API_TOKEN" },
    };
    const resolved = resolveSecretParameters(parameters, ["token"], {
      API_TOKEN: "sk-live-9f27acbd",
    });
    expect(resolved.values.get("API_TOKEN")).toBe("sk-live-9f27acbd");
    // An undeclared parameter carrying a reference is a smuggling attempt.
    expect(() =>
      resolveSecretParameters({ url: { $env: "API_TOKEN" } }, [], {
        API_TOKEN: "sk-live-9f27acbd",
      }),
    ).toThrowError(SecretError);
  });
});

describe("redaction", () => {
  it("rewrites every occurrence of a resolved secret in nested structures", () => {
    const leaky = {
      summary: "auth failed for sk-live-9f27acbd",
      items: ["token sk-live-9f27acbd expired", { nested: ["deploy-key-00112233"] }],
      count: 3,
      safe: "no secrets here",
    };
    const redacted = redactSecretValues(leaky, SECRETS) as typeof leaky;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("sk-live-9f27acbd");
    expect(serialized).not.toContain("deploy-key-00112233");
    expect(serialized).toContain(REDACTED_SECRET);
    // Non-secret content is preserved untouched.
    expect(redacted.count).toBe(3);
    expect(redacted.safe).toBe("no secrets here");
    // The input structure is never mutated in place.
    expect(leaky.summary).toContain("sk-live-9f27acbd");
  });

  it("treats an empty secret map as a no-op", () => {
    const value = { summary: "anything" };
    expect(redactSecretValues(value, new Map())).toBe(value);
  });
});

describe("leak detection", () => {
  it("accepts structures that carry only reference forms", () => {
    const persisted = {
      request: { token: { $env: "API_TOKEN" } },
      evidence: { output_digest: "a".repeat(64) },
    };
    expect(() => assertNoSecretValues(persisted, SECRETS)).not.toThrow();
  });

  it("throws on a leak without echoing the secret value", () => {
    const leaked = { log: "calling home with sk-live-9f27acbd" };
    let caught: unknown;
    try {
      assertNoSecretValues(leaked, SECRETS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecretError);
    // The error may name the environment variable, never its value.
    expect((caught as Error).message).not.toContain("sk-live-9f27acbd");
  });
});
