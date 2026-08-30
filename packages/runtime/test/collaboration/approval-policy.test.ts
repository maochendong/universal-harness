import { describe, expect, it } from "vitest";

import {
  DEFAULT_REMOTE_REQUIRED_PERMISSION,
  resolveRequiredPermission,
  type ApprovalPermissionPolicy,
} from "../../src/collaboration/approval-policy.js";

const digest = (letter: string): string => letter.repeat(64);

describe("resolveRequiredPermission", () => {
  it("fails closed to maintain when no Policy view is available", () => {
    expect(resolveRequiredPermission(undefined, "requirement_baseline")).toBe("maintain");
    expect(DEFAULT_REMOTE_REQUIRED_PERMISSION).toBe("maintain");
  });

  it("keeps the maintain default for a Policy without downgrade rules", () => {
    const policy: ApprovalPermissionPolicy = { policy_digest: digest("1") };
    expect(resolveRequiredPermission(policy, "requirement_baseline")).toBe("maintain");
    const empty: ApprovalPermissionPolicy = { policy_digest: digest("1"), downgrades: [] };
    expect(resolveRequiredPermission(empty, "requirement_baseline")).toBe("maintain");
  });

  it("lowers to write only for the exact object scope a rule names", () => {
    const policy: ApprovalPermissionPolicy = {
      policy_digest: digest("1"),
      downgrades: [{ object_id: "requirement_baseline", permission: "write" }],
    };
    expect(resolveRequiredPermission(policy, "requirement_baseline")).toBe("write");
    // Any other object scope stays at the maintain default.
    expect(resolveRequiredPermission(policy, "other_object")).toBe("maintain");
  });

  it("carries the governing Policy digest for binding into the decision record", () => {
    const policy: ApprovalPermissionPolicy = {
      policy_digest: digest("9"),
      downgrades: [{ object_id: "requirement_baseline", permission: "write" }],
    };
    resolveRequiredPermission(policy, "requirement_baseline");
    expect(policy.policy_digest).toBe(digest("9"));
  });
});
