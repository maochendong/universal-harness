import { describe, expect, it } from "vitest";

import {
  contentDigest,
  createProjectProfileRecord,
  type NodeRecord,
} from "@universal-harness-internal/core";

import {
  MODULE_STATUS_MAPPINGS,
  deriveModuleDomainStatus,
} from "../../src/orchestration/module-status.js";
import { projectProfileModuleStatus } from "../../src/orchestration/profile-modules.js";

/**
 * T10 module status projection: each active module owns a domain status
 * enum, registered with the shared projector and derived from committed
 * graph facts only — the Read API never infers. Unknown or absent evidence
 * fails closed to `controlled_not_applicable`/`invalid_or_incomplete`,
 * never to a synthetic "passed".
 */
let counter = 0;
function makeNode(
  type: NodeRecord["type"],
  spec: {
    readonly status?: NodeRecord["status"];
    readonly source?: NodeRecord["source"];
    readonly revision?: number;
    readonly id?: string;
    readonly extensions?: Record<string, unknown>;
  } = {},
): NodeRecord {
  counter += 1;
  const record: Record<string, unknown> = {
    protocol_version: "1.0.0",
    record_kind: "node",
    id: spec.id ?? `${type.toLowerCase()}_${String(counter).padStart(3, "0")}`,
    type,
    revision: spec.revision ?? 1,
    status: spec.status ?? "accepted",
    source: spec.source ?? "workflow",
    provenance: {
      iteration_id: "iteration_01",
      actor: "module-status-test",
      timestamp: "2026-08-20T00:00:00Z",
    },
    confidence: 1,
    ...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
  };
  return { ...record, digest: contentDigest(record) } as unknown as NodeRecord;
}

function evaluationEvidence(passed: boolean, status: NodeRecord["status"]): NodeRecord {
  return makeNode("Evidence", {
    status,
    source: "evaluation",
    extensions: {
      "harness.evaluation": {
        evidence_digest: "a".repeat(64),
        passed,
        provisional: status === "proposed",
      },
    },
  });
}

function auditFinding(severity: "blocker" | "warning", status: NodeRecord["status"]): NodeRecord {
  return makeNode("Finding", {
    status,
    source: "audit",
    extensions: {
      "harness.finding": {
        origin: "audit",
        blocking: severity === "blocker",
        violates: [],
        blocks: [],
        evidence: [],
        rule: `audit/${severity === "blocker" ? "contradictory_constraint" : "stale_knowledge"}`,
        scope_prefix: "project/repo/requirements",
        severity,
        actionability: "human_review",
        subject_ids: [],
        subject_digests: [],
      },
    },
  });
}

describe("deriveModuleDomainStatus", () => {
  it("maps impact set lifecycle facts", () => {
    expect(deriveModuleDomainStatus("impact_analysis", [])).toBe("impact_set_not_started");
    expect(
      deriveModuleDomainStatus("impact_analysis", [makeNode("ImpactSet", { status: "proposed" })]),
    ).toBe("impact_set_proposed");
    expect(
      deriveModuleDomainStatus("impact_analysis", [
        makeNode("ImpactSet", { status: "proposed", revision: 1 }),
        makeNode("ImpactSet", { status: "accepted", revision: 2 }),
      ]),
    ).toBe("impact_set_approved");
  });

  it("maps evaluation evidence facts, provisional first", () => {
    expect(deriveModuleDomainStatus("independent_evaluation", [])).toBe("evaluation_not_started");
    expect(
      deriveModuleDomainStatus("independent_evaluation", [evaluationEvidence(true, "accepted")]),
    ).toBe("evaluation_passed");
    expect(
      deriveModuleDomainStatus("independent_evaluation", [evaluationEvidence(false, "accepted")]),
    ).toBe("evaluation_failed");
    expect(
      deriveModuleDomainStatus("independent_evaluation", [
        evaluationEvidence(true, "accepted"),
        evaluationEvidence(true, "proposed"),
      ]),
    ).toBe("evaluation_provisional");
  });

  it("maps audit finding facts", () => {
    expect(deriveModuleDomainStatus("advanced_audit", [])).toBe("audit_not_started");
    expect(deriveModuleDomainStatus("advanced_audit", [auditFinding("blocker", "proposed")])).toBe(
      "audit_blockers_open",
    );
    expect(deriveModuleDomainStatus("advanced_audit", [auditFinding("warning", "accepted")])).toBe(
      "audit_warnings_open",
    );
    expect(
      deriveModuleDomainStatus("advanced_audit", [auditFinding("blocker", "superseded")]),
    ).toBe("audit_clean");
  });
});

describe("module status projection through the shared projector", () => {
  const standardProfile = createProjectProfileRecord({
    project_id: "project_demo",
    revision: 1,
    profile_id: "standard",
    policy_digest: "a".repeat(64),
    actor: "human:reviewer",
    effective_from: "2026-08-20T00:00:00Z",
  });

  it("registers only the slim five generic statuses", () => {
    for (const mapping of MODULE_STATUS_MAPPINGS) {
      for (const generic of Object.values(mapping.mappings)) {
        expect([
          "proven",
          "controlled_not_applicable",
          "not_enabled_by_profile",
          "historical_without_proof",
          "invalid_or_incomplete",
        ]).toContain(generic);
      }
    }
  });

  it("projects active modules from graph evidence and keeps the generic five", () => {
    const entries = projectProfileModuleStatus(standardProfile, {
      nodes: [
        makeNode("ImpactSet", { status: "accepted" }),
        evaluationEvidence(true, "accepted"),
        auditFinding("warning", "accepted"),
      ],
    });
    const byId = new Map(entries.map((entry) => [entry.capability_id, entry]));
    expect(byId.get("impact_analysis")).toMatchObject({
      resolution: "active",
      domain_status: "impact_set_approved",
      generic_status: "proven",
    });
    expect(byId.get("independent_evaluation")).toMatchObject({
      domain_status: "evaluation_passed",
      generic_status: "proven",
    });
    expect(byId.get("advanced_audit")).toMatchObject({
      domain_status: "audit_warnings_open",
      generic_status: "proven",
    });
    // design_governance activates under Standard (T12): active, but without
    // graph evidence it makes no proof claim at all.
    expect(byId.get("design_governance")).toMatchObject({ resolution: "active" });
    expect(byId.get("design_governance")?.generic_status).toBeUndefined();
    expect(byId.get("strict_tdd")?.generic_status).toBe("not_enabled_by_profile");
  });

  it("keeps lite modules inactive regardless of evidence", () => {
    const liteProfile = createProjectProfileRecord({
      project_id: "project_demo",
      revision: 2,
      profile_id: "lite",
      policy_digest: "a".repeat(64),
      actor: "human:reviewer",
      effective_from: "2026-08-20T01:00:00Z",
    });
    const entries = projectProfileModuleStatus(liteProfile, {
      nodes: [makeNode("ImpactSet", { status: "accepted" })],
    });
    for (const entry of entries) {
      expect(entry.generic_status).toBe("not_enabled_by_profile");
    }
  });
});
