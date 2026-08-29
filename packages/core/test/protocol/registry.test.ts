import { describe, expect, it } from "vitest";

import {
  PROTOCOL_1_1_VERSION,
  PROTOCOL_1_2_VERSION,
  PROTOCOL_REGISTRY,
  assertKnownProtocol,
  isKnownProtocol,
  lookupProtocol,
} from "../../src/protocol.js";
import { PROTOCOL_MAJOR_VERSION, PROTOCOL_VERSION } from "../../src/version.js";

describe("protocol registry", () => {
  it("registers 1.0.0 as stable and 1.1.0/1.2.0 as in-development on the same major", () => {
    expect(PROTOCOL_REGISTRY.map((entry) => entry.version)).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    expect(lookupProtocol(PROTOCOL_VERSION)).toMatchObject({
      version: "1.0.0",
      major: PROTOCOL_MAJOR_VERSION,
      status: "stable",
    });
    expect(lookupProtocol(PROTOCOL_1_1_VERSION)).toMatchObject({
      version: "1.1.0",
      major: PROTOCOL_MAJOR_VERSION,
      status: "development",
    });
    expect(lookupProtocol(PROTOCOL_1_2_VERSION)).toMatchObject({
      version: "1.2.0",
      major: PROTOCOL_MAJOR_VERSION,
      status: "development",
    });
  });

  it("keeps exactly one registration per version", () => {
    const versions = PROTOCOL_REGISTRY.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("fails closed on unknown or malformed protocol versions", () => {
    expect(isKnownProtocol("1.0.0")).toBe(true);
    expect(isKnownProtocol("1.1.0")).toBe(true);
    expect(isKnownProtocol("1.2.0")).toBe(true);
    expect(isKnownProtocol("1.3.0")).toBe(false);
    expect(isKnownProtocol("2.0.0")).toBe(false);
    expect(isKnownProtocol("not-semver")).toBe(false);
    expect(() => assertKnownProtocol("1.3.0")).toThrow(/unknown protocol version/i);
    expect(() => assertKnownProtocol("not-semver")).toThrow(/unknown protocol version/i);
  });

  it("returns the registration for known versions", () => {
    expect(assertKnownProtocol("1.1.0")).toMatchObject({ version: "1.1.0", major: 1 });
    expect(assertKnownProtocol("1.2.0")).toMatchObject({ version: "1.2.0", major: 1 });
  });
});
