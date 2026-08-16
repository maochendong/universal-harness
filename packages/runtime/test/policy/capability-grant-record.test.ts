import { describe, expect, it } from "vitest";

import { validateSchema } from "@universal-harness-internal/core";

import {
  bindCapabilityGrantAuthorization,
  createCapabilityGrantSpec,
} from "../../src/policy/capability-grant.js";
import { mergePolicyLayers } from "../../src/policy/evaluator.js";

import { grantRequest } from "./fixtures.js";

describe("capability grant records", () => {
  it("separates the authorization-free GrantSpec digest from its authorized record", () => {
    const effective = mergePolicyLayers([]).effective;
    const spec = createCapabilityGrantSpec(grantRequest(), effective, {
      planDigest: "1".repeat(64),
      contextBundleDigest: "2".repeat(64),
      adapterProfileDigest: "3".repeat(64),
      baselineCommit: "a".repeat(40),
    });
    const record = bindCapabilityGrantAuthorization(spec, {
      grantRecordId: "grantrecord_01",
      iterationId: "iteration_01",
      authorizationDigest: "4".repeat(64),
      issuedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(spec).not.toHaveProperty("authorization_digest");
    expect(record.spec.spec_digest).toBe(spec.spec_digest);
    expect(record.authorization_digest).toBe("4".repeat(64));
    expect(validateSchema("runtime", record).valid).toBe(true);
  });
});
