import { describe, expect, it } from "vitest";

import {
  RenameChainError,
  appendSupersedesLink,
  chainHead,
  chainNodeIds,
  classifyRescan,
} from "../../src/identity/rename.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);

describe("rescan classification", () => {
  const previous = { locator: "repo://repository_01/src/old.ts", digest };

  it("treats identical locator and digest as unchanged", () => {
    expect(classifyRescan(previous, { ...previous })).toBe("unchanged");
    // Logically equal locators (separator/Unicode variants) are unchanged too.
    expect(classifyRescan(previous, { locator: "repo://repository_01/src\\old.ts", digest })).toBe(
      "unchanged",
    );
  });

  it("treats a locator-only change with stable digest as a pure rename", () => {
    expect(classifyRescan(previous, { locator: "repo://repository_01/src/new.ts", digest })).toBe(
      "pure-rename",
    );
  });

  it("treats same-locator content changes as content-change", () => {
    expect(classifyRescan(previous, { ...previous, digest: otherDigest })).toBe("content-change");
  });

  it("treats simultaneous locator and content changes as rename-with-change", () => {
    expect(
      classifyRescan(previous, { locator: "repo://repository_01/src/new.ts", digest: otherDigest }),
    ).toBe("rename-with-change");
  });
});

describe("SUPERSEDES rename chain", () => {
  it("grows at the head and stays traceable", () => {
    let chain: ReturnType<typeof appendSupersedesLink> = [];
    chain = appendSupersedesLink(chain, { superseding_id: "b", superseded_id: "a" });
    chain = appendSupersedesLink(chain, { superseding_id: "c", superseded_id: "b" });
    expect(chainHead(chain)).toBe("c");
    expect(chainNodeIds(chain)).toEqual(["a", "b", "c"]);
  });

  it("rejects self-supersede and identity reuse", () => {
    expect(() => appendSupersedesLink([], { superseding_id: "a", superseded_id: "a" })).toThrow(
      RenameChainError,
    );
    const chain = [{ superseding_id: "b", superseded_id: "a" }];
    // A superseded identity is dead; reusing it as superseding is forbidden.
    expect(() => appendSupersedesLink(chain, { superseding_id: "a", superseded_id: "b" })).toThrow(
      RenameChainError,
    );
    // A superseding identity cannot supersede twice.
    expect(() => appendSupersedesLink(chain, { superseding_id: "b", superseded_id: "c" })).toThrow(
      RenameChainError,
    );
  });

  it("rejects orphans and branches away from the head", () => {
    const chain = [
      { superseding_id: "b", superseded_id: "a" },
      { superseding_id: "c", superseded_id: "b" },
    ];
    expect(() => appendSupersedesLink(chain, { superseding_id: "d", superseded_id: "a" })).toThrow(
      RenameChainError,
    );
  });

  it("is acyclic by construction", () => {
    const chain = [
      { superseding_id: "b", superseded_id: "a" },
      { superseding_id: "c", superseded_id: "b" },
    ];
    expect(() => appendSupersedesLink(chain, { superseding_id: "a", superseded_id: "c" })).toThrow(
      RenameChainError,
    );
  });
});
