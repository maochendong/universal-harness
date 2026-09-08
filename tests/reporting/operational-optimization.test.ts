import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("operational release and documentation contracts", () => {
  it("runs the complete release entry once without preceding duplicate test or pack smoke", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const release = workflow.slice(workflow.indexOf("\n  release:"));
    const runs = [...release.matchAll(/^\s+- run: (.+)$/gmu)].map((match) => match[1]);
    expect(runs.filter((run) => run === "pnpm test:release")).toHaveLength(1);
    expect(runs).not.toContain("pnpm test");
    expect(runs).not.toContain("pnpm pack:smoke");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:release"]).toBe(
      "pnpm verify && pnpm test:security && pnpm test:fault && pnpm test:m4:fault-matrix && pnpm test:performance && pnpm test:e2e && pnpm test:e2e:dashboard && pnpm pack:smoke && node scripts/generate-acceptance-report.mjs",
    );
  });

  it("does not promise fixed approval counts or embed stale milestone counters in the quick start", () => {
    const quickStart = readFileSync("docs/getting-started.md", "utf8");
    expect(quickStart).not.toContain("两个强制批准点");
    expect(quickStart).not.toContain("两次批准并 resume 之后");
    expect(quickStart).toContain("Lite / Standard / Governed");
    const readme = readFileSync("README.md", "utf8");
    expect(readme).not.toContain("M1 为 27/28");
    expect(readme).toContain("docs/m1-acceptance-report.md");
  });
});
