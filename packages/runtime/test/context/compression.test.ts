import { describe, expect, it } from "vitest";

import {
  NO_COMPRESSION,
  TRUNCATE_COMPRESSOR_ID,
  assertProtectedFieldsPresent,
  createTruncateCompressor,
} from "../../src/context/compression.js";
import { ContextError } from "../../src/context/selector.js";

describe("truncate-v1 compressor", () => {
  const compressor = createTruncateCompressor();

  it("passes content that fits through unchanged", () => {
    const result = compressor.compress("short content", 100, []);
    expect(result.method).toBe(NO_COMPRESSION);
    expect(result.content).toBe("short content");
    expect(result.originalTokens).toBe(result.includedTokens);
  });

  it("drops unprotected lines greedily while keeping the original order", () => {
    const content = ["aaaa aaaa", "bbbb bbbb", "cccc cccc", "dddd dddd"].join("\n");
    // 3 tokens per line; budget fits exactly two lines.
    const result = compressor.compress(content, 6, []);
    expect(result.method).toBe(TRUNCATE_COMPRESSOR_ID);
    expect(result.content).toBe("aaaa aaaa\nbbbb bbbb");
    expect(result.originalTokens).toBe(10); // 39 characters plus newlines
    expect(result.includedTokens).toBe(6);
  });

  it("never removes protected lines, even when they exceed the ceiling", () => {
    const content = ["aaaa aaaa", "PROTECTED safety constraint", "cccc cccc"].join("\n");
    const result = compressor.compress(content, 2, ["safety constraint"]);
    expect(result.content).toBe("PROTECTED safety constraint");
    expect(result.includedTokens).toBeGreaterThan(2);
  });

  it("keeps protected lines in place among included unprotected lines", () => {
    const content = ["aaaa aaaa", "keep this goal", "bbbb bbbb", "cccc cccc"].join("\n");
    // Budget fits the protected line plus one unprotected line.
    const result = compressor.compress(content, 7, ["keep this goal"]);
    expect(result.content).toBe("aaaa aaaa\nkeep this goal");
  });

  it("is deterministic", () => {
    const content = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].join("\n");
    const first = compressor.compress(content, 2, []);
    const second = compressor.compress(content, 2, []);
    expect(first).toEqual(second);
  });
});

describe("assertProtectedFieldsPresent", () => {
  it("accepts verbatim spans of the content", () => {
    expect(() =>
      assertProtectedFieldsPresent("node_01", "alpha beta gamma", ["beta"]),
    ).not.toThrow();
  });

  it("rejects protected fields that are not part of the content", () => {
    expect(() => assertProtectedFieldsPresent("node_01", "alpha beta", ["delta"])).toThrowError(
      ContextError,
    );
    expect(() => assertProtectedFieldsPresent("node_01", "alpha beta", ["delta"])).toThrowError(
      /node_01/,
    );
    expect(() => assertProtectedFieldsPresent("node_01", "alpha beta", [""])).toThrowError(
      ContextError,
    );
  });
});
