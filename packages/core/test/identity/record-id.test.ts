import { describe, expect, it } from "vitest";

import { domainRecordId } from "../../src/identity/record-id.js";

const identity = {
  domain_tag: "profile_decision",
  id_prefix: "profile-decision",
  protocol_version: "1.1.0",
  canonical_input: {
    project_id: "project_01K1ABCDEFGHIJKLMNO",
    profile_id: "standard",
    risk_digest: "a".repeat(64),
  },
} as const;

describe("domain record identity", () => {
  it("is deterministic and matches the protocol identifier pattern", () => {
    const id = domainRecordId(identity);
    expect(domainRecordId(identity)).toBe(id);
    expect(id).toMatch(
      /^profile-decision_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("ignores key ordering inside the canonical input", () => {
    const reordered = {
      ...identity,
      canonical_input: {
        risk_digest: identity.canonical_input.risk_digest,
        profile_id: identity.canonical_input.profile_id,
        project_id: identity.canonical_input.project_id,
      },
    };
    expect(domainRecordId(reordered)).toBe(domainRecordId(identity));
  });

  it("changes when the domain tag, protocol version or canonical input changes", () => {
    const baseline = domainRecordId(identity);
    expect(domainRecordId({ ...identity, domain_tag: "capability_plan" })).not.toBe(baseline);
    expect(domainRecordId({ ...identity, protocol_version: "1.0.0" })).not.toBe(baseline);
    expect(
      domainRecordId({
        ...identity,
        canonical_input: { ...identity.canonical_input, profile_id: "governed" },
      }),
    ).not.toBe(baseline);
    expect(domainRecordId({ ...identity, id_prefix: "other" })).not.toBe(baseline);
  });

  it("fails closed on unknown protocols and malformed tags or prefixes", () => {
    expect(() => domainRecordId({ ...identity, protocol_version: "9.9.9" })).toThrow(
      /unknown protocol version/i,
    );
    expect(() => domainRecordId({ ...identity, domain_tag: "ProfileDecision" })).toThrow(
      /domain tag/i,
    );
    expect(() => domainRecordId({ ...identity, id_prefix: "Profile-Decision" })).toThrow(
      /id prefix/i,
    );
  });
});
