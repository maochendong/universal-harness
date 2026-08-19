import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RELATION_TYPES } from "../../packages/core/src/schema/edge.js";
import { EVENT_TYPES } from "../../packages/core/src/schema/event.js";
import { NODE_TYPES } from "../../packages/core/src/schema/node.js";
import { OBSERVATION_EVENT_TYPES } from "../../packages/core/src/schema/observation.js";
import { PROPAGATION_RULES } from "../../packages/graph/src/impact/propagation.js";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modelDocumentPath = join(repositoryRoot, "docs", "graph-driven-harness-model.md");
const readmePath = join(repositoryRoot, "README.md");
const dashboardScreenshotNames = [
  "harness-observatory-overview.png",
  "harness-observatory-graph.png",
  "harness-observatory-impact.png",
] as const;

function modelDocument(): string {
  return readFileSync(modelDocumentPath, "utf8");
}

function readme(): string {
  return readFileSync(readmePath, "utf8");
}

function markedSection(markdown: string, name: string): string {
  const start = `<!-- graph-model:${name}:start -->`;
  const end = `<!-- graph-model:${name}:end -->`;
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  expect(startIndex, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing ${end}`).toBeGreaterThan(startIndex);
  return markdown.slice(startIndex + start.length, endIndex);
}

function firstColumnEnums(section: string): string[] {
  return section
    .split("\n")
    .map((line) => /^\|\s*`([^`]+)`\s*\|/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

// Protocol 1.1 文档先行对齐（77bfb3b）：DesignSet/DesignArtifact 节点与
// SPECIFIES 传播关系由实施计划 T11 落地。落地后删除这些集合，测试恢复严格相等。
const PENDING_1_1_NODE_TYPES = ["DesignArtifact", "DesignSet"] as const;
const PENDING_1_1_EDGE_TYPES = ["SPECIFIES"] as const;
const PENDING_1_1_PROPAGATION_RULE = {
  type: "SPECIFIES",
  direction: "both",
  defaultRisk: "high",
  allowsInference: false,
} as const;

function withoutPending(values: readonly string[], pending: readonly string[]): string[] {
  return values.filter((value) => !pending.includes(value));
}

function propagationRows(section: string): Array<{
  type: string;
  direction: string;
  defaultRisk: string;
  allowsInference: boolean;
}> {
  return section
    .split("\n")
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => /^`[^`]+`$/u.test(cells[0] ?? ""))
    .map((cells) => ({
      type: (cells[0] as string).slice(1, -1),
      direction: (cells[2] as string).split(" ")[0] as string,
      defaultRisk: cells[3] as string,
      allowsInference: cells[4] === "是",
    }));
}

describe("Graph-native model documentation", () => {
  it("publishes every authoritative Node type exactly once", () => {
    const documented = firstColumnEnums(markedSection(modelDocument(), "nodes"));

    expect(documented).toHaveLength(new Set(documented).size);
    for (const pending of PENDING_1_1_NODE_TYPES) expect(documented).toContain(pending);
    expect(sorted(withoutPending(documented, PENDING_1_1_NODE_TYPES))).toEqual(sorted(NODE_TYPES));
  });

  it("partitions every Edge type into propagation or structural semantics", () => {
    const markdown = modelDocument();
    const propagation = firstColumnEnums(markedSection(markdown, "propagation-edges"));
    const structural = firstColumnEnums(markedSection(markdown, "structural-edges"));

    expect(propagation).toHaveLength(new Set(propagation).size);
    expect(structural).toHaveLength(new Set(structural).size);
    expect(propagation.filter((type) => structural.includes(type))).toEqual([]);
    for (const pending of PENDING_1_1_EDGE_TYPES) expect(propagation).toContain(pending);
    expect(sorted(withoutPending([...propagation, ...structural], PENDING_1_1_EDGE_TYPES))).toEqual(
      sorted(RELATION_TYPES),
    );
  });

  it("documents the executable propagation policy without drift", () => {
    const documented = propagationRows(markedSection(modelDocument(), "propagation-edges"));
    const authoritative = PROPAGATION_RULES.map((rule) => ({
      type: rule.type,
      direction: rule.direction,
      defaultRisk: rule.defaultRisk,
      allowsInference: rule.allowsInference,
    }));

    const pendingRule = documented.find((rule) => rule.type === PENDING_1_1_PROPAGATION_RULE.type);
    expect(pendingRule).toEqual(PENDING_1_1_PROPAGATION_RULE);
    expect(documented.filter((rule) => rule.type !== PENDING_1_1_PROPAGATION_RULE.type)).toEqual(
      authoritative,
    );
  });

  it("publishes authoritative and live event streams without conflating them", () => {
    const markdown = modelDocument();
    const lifecycle = firstColumnEnums(markedSection(markdown, "lifecycle-events"));
    const observations = firstColumnEnums(markedSection(markdown, "observation-events"));

    expect(lifecycle).toHaveLength(new Set(lifecycle).size);
    expect(observations).toHaveLength(new Set(observations).size);
    expect(sorted(lifecycle)).toEqual(sorted(EVENT_TYPES));
    expect(sorted(observations)).toEqual(sorted(OBSERVATION_EVENT_TYPES));
  });

  it("explains the complete loop and its authority boundaries without relying on rendering", () => {
    const markdown = modelDocument();

    expect(markdown).toContain("```mermaid");
    expect(markdown).toMatch(
      /Capture.*Impact.*Plan.*Context.*Execute.*Verify.*Evaluate.*Snapshot/su,
    );
    expect(markdown).toMatch(/Finding.*RootCauseAnalysis.*ImprovementCandidate.*ImpactSet/su);
    expect(markdown).toContain("Ledger 是唯一权威来源");
    expect(markdown).toContain("Live Spool 是可删除的实时观察");
    expect(markdown).toContain("SQLite 是可确定性重建的查询缓存");
    expect(markdown).toContain("Mermaid 无法渲染");
  });

  it("gives README readers a Chinese graph-driven overview and a path to full semantics", () => {
    const markdown = readme();
    const overview = markedSection(markdown, "readme-overview");

    expect(markdown).toContain("## Graph-native 驱动模型");
    expect(overview).toContain("```mermaid");
    for (const type of NODE_TYPES) expect(overview).toContain(type);
    expect(overview).toContain("18 条影响传播关系");
    expect(overview).toContain("14 条非传播结构关系");
    expect(overview).toContain("Lifecycle Event");
    expect(overview).toContain("Observation Event");
    expect(overview).toContain("Ledger 是唯一权威来源");
    expect(overview).toContain("Live Spool 是可删除的实时观察");
    expect(overview).toContain("SQLite 是可确定性重建的查询缓存");
    expect(markdown).toContain(
      "[完整 Graph-native 模型与传播规则](docs/graph-driven-harness-model.md)",
    );
  });

  it("shows real atlas-mvp Observatory overview, graph and impact views without publishing a local session token", () => {
    const markdown = readme();

    for (const screenshotName of dashboardScreenshotNames) {
      const screenshotPath = join(repositoryRoot, "docs", "assets", screenshotName);
      expect(existsSync(screenshotPath), `${screenshotName} must exist`).toBe(true);
      expect(readFileSync(screenshotPath).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
    expect(markdown).toContain("## Dashboard 效果");
    expect(markdown).toContain(
      "![Harness Observatory Dashboard：atlas-mvp 项目 Overview](docs/assets/harness-observatory-overview.png)",
    );
    expect(markdown).toContain(
      "![Harness Observatory Dashboard：atlas-mvp 项目 Graph 邻域](docs/assets/harness-observatory-graph.png)",
    );
    expect(markdown).toContain(
      "![Harness Observatory Dashboard：atlas-mvp 项目 Impact 路径](docs/assets/harness-observatory-impact.png)",
    );
    expect(markdown).toContain("基于 atlas-mvp 真实 Harness 数据的本地 Observatory Dashboard");
    expect(markdown).toContain("Graph 视图展开评估用例 `case_docs`");
    expect(markdown).toContain(
      "Impact 视图展示 `case_docs` 到 `evidence_evaluation_docs` 的受治理最短解释路径",
    );
    expect(markdown).not.toMatch(/[?&]token=/u);
  });
});
