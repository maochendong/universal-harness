import { describe, expect, it } from "vitest";

import {
  RenameChainError,
  appendSupersedesLink,
  chainHead,
  chainNodeIds,
  type SupersedesLink,
} from "../../src/identity/rename.js";
import { mulberry32, pick, randomInt } from "./seeds.js";

function assertChainInvariants(chain: readonly SupersedesLink[]): void {
  const ids = chainNodeIds(chain);
  // Stable: every node ID appears exactly once.
  expect(new Set(ids).size).toBe(ids.length);
  // Linear and orphan-free: each link supersedes the previous head.
  for (let index = 1; index < chain.length; index += 1) {
    expect(chain[index]?.superseded_id).toBe(chain[index - 1]?.superseding_id);
  }
  // Acyclic: no superseding ID ever reappears as a superseded ID.
  const superseding = new Set(chain.map((link) => link.superseding_id));
  const supersededNonRoot = chain.slice(1).map((link) => link.superseded_id);
  for (const id of supersededNonRoot) {
    expect(superseding.has(id)).toBe(true);
  }
  if (chain.length > 0) {
    expect(chain[0]?.superseded_id).toBe(ids[0]);
    expect(chainHead(chain)).toBe(ids[ids.length - 1]);
  }
}

describe("rename chain properties", () => {
  it("valid appends keep the chain stable, acyclic and orphan-free", () => {
    const random = mulberry32(808);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      let chain: SupersedesLink[] = [];
      const length = randomInt(random, 8) + 1;
      for (let step = 0; step < length; step += 1) {
        const link = {
          superseding_id: `node_${iteration}_${step + 1}`,
          superseded_id: chainHead(chain) ?? `node_${iteration}_0`,
        };
        chain = appendSupersedesLink(chain, link);
        assertChainInvariants(chain);
      }
    }
  });

  it("invalid links are always rejected and never mutate the chain", () => {
    const random = mulberry32(909);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      let chain: SupersedesLink[] = [];
      const length = randomInt(random, 5);
      for (let step = 0; step < length; step += 1) {
        chain = appendSupersedesLink(chain, {
          superseding_id: `n${step + 1}`,
          superseded_id: chainHead(chain) ?? "n0",
        });
      }
      const ids = chainNodeIds(chain);
      const invalid: SupersedesLink =
        ids.length === 0
          ? { superseding_id: "x", superseded_id: "x" }
          : pick(random, [
              { superseding_id: "fresh", superseded_id: pick(random, ids.slice(0, -1)) },
              { superseding_id: pick(random, ids), superseded_id: chainHead(chain) ?? "n0" },
              {
                superseding_id: ids[0] ?? "n0",
                superseded_id: chainHead(chain) ?? "n0",
              },
            ]);
      const before = chain;
      expect(() => appendSupersedesLink(chain, invalid), JSON.stringify(invalid)).toThrow(
        RenameChainError,
      );
      expect(chain).toBe(before);
      assertChainInvariants(chain);
    }
  });
});
