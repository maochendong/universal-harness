import { describe, expect, it } from "vitest";

import {
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_VERSION,
  assertProtocolCompatible,
  isProtocolCompatible,
} from "../../src/version.js";

describe("protocol version", () => {
  it("accepts supported minor and patch versions but rejects other majors", () => {
    expect(PROTOCOL_VERSION).toBe("1.0.0");
    expect(PROTOCOL_MAJOR_VERSION).toBe(1);
    expect(isProtocolCompatible("1.99.42")).toBe(true);
    expect(isProtocolCompatible("2.0.0")).toBe(false);
    expect(isProtocolCompatible("not-semver")).toBe(false);
    expect(() => assertProtocolCompatible("2.0.0")).toThrow(/unsupported protocol major/i);
  });
});
