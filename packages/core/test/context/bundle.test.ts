import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { contentDigest } from "../../src/identity/digest.js";
import {
  createProjectContextBundleInvalidationRecord,
  createProjectContextBundleRecord,
  ProjectContextError,
} from "../../src/context/records.js";
import {
  acceptProjectContextBundle,
  assertContextBundleIndependence,
  validateBundleFreshness,
} from "../../src/context/validate.js";
import {
  appendProjectContextBundleInvalidationRecord,
  appendProjectContextBundleRecord,
  isProjectContextBundleInvalidated,
  readProjectContextBundle,
  type ProjectContextRequest,
} from "../../src/context/index.js";
import { verifyRecordEnvelope } from "../../src/schema/envelope.js";
import { PROTOCOL_1_1_SCHEMA_REGISTRY } from "../../src/schema/registry.js";
import type {
  ProjectContextBudget,
  ProjectContextBundleRecord,
  ProjectContextSource,
} from "../../src/schema/context.js";

const goldenDirectory = join(dirname(fileURLToPath(import.meta.url)), "../golden/context");

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDirectory, name), "utf8")) as T;
}

const SESSION_ID = "capture-session_01K1ABCDEFGHIJKLMNO";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

const BUDGET: ProjectContextBudget = {
  max_files: 8,
  max_bytes_per_source: 4096,
  max_total_bytes: 16384,
  max_summary_chars: 1000,
};

function makeSource(
  locator: string,
  kind: ProjectContextSource["source_kind"],
  text: string,
): ProjectContextSource {
  return {
    locator,
    source_kind: kind,
    source_digest: contentDigest(text),
    selection_reason: `matched default candidate for source kind ${kind}`,
    classification: "internal_project",
    summary: text.slice(0, 80),
    truncated: false,
  };
}

function goldenSources(): ProjectContextSource[] {
  return [
    makeSource("README.md", "readme", "# Demo\n\n订单服务。"),
    makeSource("package.json", "manifest", '{"name":"demo"}'),
    makeSource("harness.config.json", "gate", '{"gates":["test"]}'),
  ];
}

function goldenBundle(purpose: "proposal" | "review" = "proposal"): ProjectContextBundleRecord {
  return createProjectContextBundleRecord({
    session_id: SESSION_ID,
    purpose,
    project_baseline_digest: DIGEST_D,
    profile_digest: DIGEST_A,
    policy_digest: DIGEST_C,
    budget: BUDGET,
    sources: goldenSources(),
    exclusions: [{ locator: ".env", reason: "secret_pattern" }],
  });
}

function requestFor(overrides: Partial<ProjectContextRequest> = {}): ProjectContextRequest {
  return {
    session_id: SESSION_ID,
    purpose: "proposal",
    intent_text: "为订单服务增加幂等重试。",
    project_root_kind: "adopted",
    project_baseline_digest: DIGEST_D,
    project_profile_digest: DIGEST_A,
    capture_policy_digest: DIGEST_C,
    allowed_source_kinds: ["manifest", "readme", "gate", "graph"],
    path_policy: {},
    budget: BUDGET,
    ...overrides,
  };
}

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-context-bundle-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("project context bundle record", () => {
  it("matches the committed golden fixture", () => {
    expect(goldenBundle()).toEqual(readGolden("project-context-bundle.json"));
  });

  it("seals a schema-valid envelope", () => {
    const bundle = goldenBundle();
    expect(bundle.record_kind).toBe("project_context_bundle");
    expect(bundle.purpose).toBe("proposal");
    expect(PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-context-bundle", bundle).valid).toBe(
      true,
    );
    expect(verifyRecordEnvelope(bundle as unknown as Record<string, unknown>)).toBe(true);
  });

  it("produces the same identity and digest for any source ordering", () => {
    const reversed = createProjectContextBundleRecord({
      session_id: SESSION_ID,
      purpose: "proposal",
      project_baseline_digest: DIGEST_D,
      profile_digest: DIGEST_A,
      policy_digest: DIGEST_C,
      budget: BUDGET,
      sources: [...goldenSources()].reverse(),
      exclusions: [{ locator: ".env", reason: "secret_pattern" }],
    });
    expect(reversed.bundle_id).toBe(goldenBundle().bundle_id);
    expect(reversed.record_digest).toBe(goldenBundle().record_digest);
  });

  it("changes the digest when any source content changes", () => {
    const changed = createProjectContextBundleRecord({
      session_id: SESSION_ID,
      purpose: "proposal",
      project_baseline_digest: DIGEST_D,
      profile_digest: DIGEST_A,
      policy_digest: DIGEST_C,
      budget: BUDGET,
      sources: [makeSource("README.md", "readme", "# Demo v2"), ...goldenSources().slice(1)],
      exclusions: [{ locator: ".env", reason: "secret_pattern" }],
    });
    expect(changed.record_digest).not.toBe(goldenBundle().record_digest);
  });

  it("rejects duplicate source locators", () => {
    expect(() =>
      createProjectContextBundleRecord({
        session_id: SESSION_ID,
        purpose: "proposal",
        project_baseline_digest: DIGEST_D,
        profile_digest: DIGEST_A,
        policy_digest: DIGEST_C,
        budget: BUDGET,
        sources: [goldenSources()[0]!, goldenSources()[0]!],
        exclusions: [],
      }),
    ).toThrow(ProjectContextError);
  });

  it("rejects malformed digests", () => {
    expect(() =>
      createProjectContextBundleRecord({
        session_id: SESSION_ID,
        purpose: "proposal",
        project_baseline_digest: "not-a-digest",
        profile_digest: DIGEST_A,
        policy_digest: DIGEST_C,
        budget: BUDGET,
        sources: goldenSources(),
        exclusions: [],
      }),
    ).toThrow(ProjectContextError);
  });
});

describe("harness-side bundle acceptance", () => {
  it("accepts a bundle that matches the request", () => {
    expect(acceptProjectContextBundle(requestFor(), goldenBundle())).toEqual({
      status: "accepted",
    });
  });

  it("rejects baseline, profile, policy, session and purpose mismatches", () => {
    const bundle = goldenBundle();
    for (const overrides of [
      { project_baseline_digest: DIGEST_B },
      { project_profile_digest: DIGEST_B },
      { capture_policy_digest: DIGEST_B },
      { session_id: "capture-session_999999999999999999" },
      { purpose: "review" as const },
    ]) {
      const result = acceptProjectContextBundle(requestFor(overrides), bundle);
      expect(result.status).toBe("rejected");
    }
  });

  it("rejects source kinds outside the request allowlist", () => {
    const bundle = createProjectContextBundleRecord({
      session_id: SESSION_ID,
      purpose: "proposal",
      project_baseline_digest: DIGEST_D,
      profile_digest: DIGEST_A,
      policy_digest: DIGEST_C,
      budget: BUDGET,
      sources: [...goldenSources(), makeSource("docs/policy.md", "policy", "policy")],
      exclusions: [],
    });
    const result = acceptProjectContextBundle(requestFor(), bundle);
    expect(result).toMatchObject({ status: "rejected", code: "source_kind_not_allowed" });
  });

  it("rejects unsafe locators even when an adapter emits them", () => {
    for (const locator of [
      "../outside.md",
      "/etc/passwd",
      ".harness/ledger/operations/x.json",
      ".git/config",
      "docs/../../secret",
      "docs\\windows.md",
    ]) {
      const bundle = createProjectContextBundleRecord({
        session_id: SESSION_ID,
        purpose: "proposal",
        project_baseline_digest: DIGEST_D,
        profile_digest: DIGEST_A,
        policy_digest: DIGEST_C,
        budget: BUDGET,
        sources: [makeSource(locator, "readme", "x")],
        exclusions: [],
      });
      const result = acceptProjectContextBundle(requestFor(), bundle);
      expect(result, locator).toMatchObject({ status: "rejected", code: "unsafe_locator" });
    }
  });

  it("rejects summaries that still carry control characters", () => {
    const source = makeSource("README.md", "readme", "x");
    const dirty = { ...source, summary: "line one\u0007 injected" };
    const bundle = createProjectContextBundleRecord({
      session_id: SESSION_ID,
      purpose: "proposal",
      project_baseline_digest: DIGEST_D,
      profile_digest: DIGEST_A,
      policy_digest: DIGEST_C,
      budget: BUDGET,
      sources: [dirty],
      exclusions: [],
    });
    expect(acceptProjectContextBundle(requestFor(), bundle)).toMatchObject({
      status: "rejected",
      code: "unsanitized_summary",
    });
  });

  it("rejects bundles that exceed the file budget", () => {
    const sources = Array.from({ length: 9 }, (_, index) =>
      makeSource(`docs/file-${String(index)}.md`, "adr", `content ${String(index)}`),
    );
    const bundle = createProjectContextBundleRecord({
      session_id: SESSION_ID,
      purpose: "proposal",
      project_baseline_digest: DIGEST_D,
      profile_digest: DIGEST_A,
      policy_digest: DIGEST_C,
      budget: BUDGET,
      sources,
      exclusions: [],
    });
    expect(
      acceptProjectContextBundle(requestFor({ allowed_source_kinds: ["adr"] }), bundle),
    ).toMatchObject({ status: "rejected", code: "budget_exceeded" });
  });
});

describe("proposal/review bundle independence", () => {
  it("allows overlapping source files across purposes", () => {
    const proposal = goldenBundle("proposal");
    const review = goldenBundle("review");
    expect(proposal.sources.map((source) => source.locator)).toEqual(
      review.sources.map((source) => source.locator),
    );
  });

  it("never reuses bundle id, content digest or record digest across purposes", () => {
    const proposal = goldenBundle("proposal");
    const review = goldenBundle("review");
    expect(review.bundle_id).not.toBe(proposal.bundle_id);
    expect(review.content_digest).not.toBe(proposal.content_digest);
    expect(review.record_digest).not.toBe(proposal.record_digest);
    expect(() => assertContextBundleIndependence(proposal, review)).not.toThrow();
  });

  it("rejects reusing the same bundle for both purposes", () => {
    const proposal = goldenBundle("proposal");
    expect(() => assertContextBundleIndependence(proposal, proposal)).toThrow(ProjectContextError);
    const otherProposal = goldenBundle("proposal");
    expect(() => assertContextBundleIndependence(proposal, otherProposal)).toThrow(
      ProjectContextError,
    );
  });

  it("rejects independence claims across different sessions", () => {
    const proposal = goldenBundle("proposal");
    const foreignReview = createProjectContextBundleRecord({
      session_id: "capture-session_999999999999999999",
      purpose: "review",
      project_baseline_digest: DIGEST_D,
      profile_digest: DIGEST_A,
      policy_digest: DIGEST_C,
      budget: BUDGET,
      sources: goldenSources(),
      exclusions: [],
    });
    expect(() => assertContextBundleIndependence(proposal, foreignReview)).toThrow(
      ProjectContextError,
    );
  });
});

describe("bundle freshness and invalidation", () => {
  it("is fresh while baseline, profile and policy match", () => {
    expect(
      validateBundleFreshness(goldenBundle(), {
        project_baseline_digest: DIGEST_D,
        profile_digest: DIGEST_A,
        policy_digest: DIGEST_C,
      }),
    ).toEqual({ status: "fresh" });
  });

  it("invalidates the bundle on baseline drift", () => {
    expect(
      validateBundleFreshness(goldenBundle(), {
        project_baseline_digest: DIGEST_B,
        profile_digest: DIGEST_A,
        policy_digest: DIGEST_C,
      }),
    ).toEqual({ status: "invalidated", reasons: ["baseline_drift"] });
  });

  it("reports every drifted binding", () => {
    expect(
      validateBundleFreshness(goldenBundle(), {
        project_baseline_digest: DIGEST_B,
        profile_digest: DIGEST_B,
        policy_digest: DIGEST_B,
      }),
    ).toEqual({
      status: "invalidated",
      reasons: ["baseline_drift", "profile_drift", "policy_drift"],
    });
  });

  it("persists bundles and invalidation records so downstream consumers fail closed", () => {
    const root = makeRoot();
    const bundle = goldenBundle();
    appendProjectContextBundleRecord(root, bundle);
    expect(readProjectContextBundle(root, bundle.bundle_id)).toEqual(bundle);
    expect(isProjectContextBundleInvalidated(root, bundle.record_digest)).toBe(false);

    const invalidation = createProjectContextBundleInvalidationRecord({
      bundle,
      reasons: ["baseline_drift"],
    });
    expect(invalidation).toEqual(readGolden("project-context-bundle-invalidation.json"));
    expect(
      PROTOCOL_1_1_SCHEMA_REGISTRY.validate("project-context-bundle-invalidation", invalidation)
        .valid,
    ).toBe(true);
    appendProjectContextBundleInvalidationRecord(root, invalidation);
    // Idempotent retry after a crash appends nothing new.
    appendProjectContextBundleInvalidationRecord(root, invalidation);
    expect(isProjectContextBundleInvalidated(root, bundle.record_digest)).toBe(true);
  });
});
