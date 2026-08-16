import { describe, expect, it, vi } from "vitest";

import {
  ExecutionBindingError,
  assertExecutionBindingCompatible,
  type ExecutionBinding,
} from "../../src/orchestration/execution-binding.js";

function binding(kind: "workflow" | "agent"): ExecutionBinding {
  return {
    kind,
    name: kind === "agent" ? "test-agent" : "workflow-tools",
    deterministic: kind === "workflow",
    execute: vi.fn(),
  };
}

describe("execution binding", () => {
  it("accepts a direct plan only for a workflow binding", () => {
    expect(() =>
      assertExecutionBindingCompatible(
        { execution_kind: "workflow", mode: "direct" },
        binding("workflow"),
      ),
    ).not.toThrow();
    expect(() =>
      assertExecutionBindingCompatible(
        { execution_kind: "workflow", mode: "direct" },
        binding("agent"),
      ),
    ).toThrow(ExecutionBindingError);
  });

  it("refuses a legacy plan without execution kind before calling an executor", () => {
    try {
      assertExecutionBindingCompatible({ mode: "direct" }, binding("agent"));
      expect.unreachable("expected a migration error");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionBindingError);
      expect((error as ExecutionBindingError).kind).toBe("migration_required");
    }
  });
});
