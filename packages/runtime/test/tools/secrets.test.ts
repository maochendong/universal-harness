import { describe, expect, it } from "vitest";

import {
  REDACTED_SECRET,
  SecretError,
  assertNoSecretValues,
  findSecretReferences,
  isSecretReference,
  redactSecretValues,
  resolveSecretParameters,
} from "../../src/secrets/environment-reference.js";

/**
 * Environment Secret References (design 14): M1 secrets come only from the
 * environment, travel by name, resolve at the invocation boundary and never
 * enter a persisted structure.
 */
describe("environment secret references", () => {
  it("recognizes only well-formed references", () => {
    expect(isSecretReference({ $env: "API_TOKEN" })).toBe(true);
    expect(isSecretReference({ $env: "lowercase" })).toBe(false);
    expect(isSecretReference({ $env: "API_TOKEN", extra: 1 })).toBe(false);
    expect(isSecretReference("$env:API_TOKEN")).toBe(false);
    expect(isSecretReference(null)).toBe(false);
  });

  it("finds nested references with their paths", () => {
    const sites = findSecretReferences({
      url: "https://example.test",
      headers: { auth: { $env: "API_TOKEN" } },
      list: [{ $env: "SECOND_TOKEN" }],
    });
    expect(sites).toEqual([
      { path: ".headers.auth", name: "API_TOKEN" },
      { path: ".list[0]", name: "SECOND_TOKEN" },
    ]);
  });

  it("resolves declared references only", () => {
    const resolved = resolveSecretParameters(
      { token: { $env: "API_TOKEN" }, url: "https://example.test" },
      ["token"],
      { API_TOKEN: "s3cr3t" },
    );
    expect(resolved.parameters).toEqual({ token: "s3cr3t", url: "https://example.test" });
    expect(resolved.values.get("API_TOKEN")).toBe("s3cr3t");
    expect(() =>
      resolveSecretParameters({ token: { $env: "API_TOKEN" } }, [], { API_TOKEN: "x" }),
    ).toThrowError(SecretError);
    expect(() =>
      resolveSecretParameters({ token: { $env: "API_TOKEN" } }, ["token"], {}),
    ).toThrowError(SecretError);
  });

  it("redacts any structure containing a resolved secret value", () => {
    const secrets = new Map([["API_TOKEN", "s3cr3t"]]);
    expect(redactSecretValues("prefix s3cr3t suffix", secrets)).toBe(REDACTED_SECRET);
    expect(redactSecretValues({ a: ["s3cr3t", "clean"] }, secrets)).toEqual({
      a: [REDACTED_SECRET, "clean"],
    });
    expect(redactSecretValues("clean", secrets)).toBe("clean");
    expect(() => assertNoSecretValues({ log: "s3cr3t" }, secrets)).toThrowError(SecretError);
    expect(() => assertNoSecretValues({ log: "clean" }, secrets)).not.toThrow();
  });
});
