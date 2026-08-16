/**
 * Execution mode selection (design 10.1). Selection happens after requirement
 * capture and baseline approval, and is a pure function of how the intent was
 * captured, whether an authoritative graph already exists, whether the planned
 * work is fully deterministic and how many independent tasks the plan holds.
 *
 * - `direct`: structured intent, or a Pack conversion that is deterministic
 *   and lossless, with no agent semantic action required.
 * - `single-loop`: one bounded goal with one independently reviewable output.
 *   A free-text intent captured without an existing graph yields a
 *   *restricted* loop that may only finish requirement capture — it can never
 *   be skipped because later implementation steps look deterministic.
 * - `dag`: two or more tasks that each satisfy the independent value rule.
 */
export const EXECUTION_MODES = ["direct", "single-loop", "dag"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** How the intent entered requirement capture. */
export type IntentShape = "structured" | "pack-converted" | "free-text";

export type ExecutionKind = "workflow" | "agent";

export interface ModeSelectionInput {
  /** Authority boundary that will execute the plan. Agents can never be direct. */
  readonly executionKind: ExecutionKind;
  readonly intentShape: IntentShape;
  /** Whether the project already has an authoritative graph to plan against. */
  readonly hasExistingGraph: boolean;
  /** Whether every planned step is deterministic and needs no agent semantics. */
  readonly deterministicWork: boolean;
  /** Number of validated task specifications in the plan. */
  readonly taskCount: number;
}

export interface ModeSelection {
  readonly mode: ExecutionMode;
  /** A restricted loop may only complete requirement capture. */
  readonly restricted: boolean;
  readonly reason: string;
}

export class ModeSelectionError extends Error {
  readonly kind = "mode_selection" as const;

  constructor(message: string) {
    super(message);
    this.name = "ModeSelectionError";
  }
}

/** Deterministic mode selection; the same input always yields the same mode. */
export function selectExecutionMode(input: ModeSelectionInput): ModeSelection {
  if (!Number.isInteger(input.taskCount) || input.taskCount < 1) {
    throw new ModeSelectionError(
      `mode selection requires at least one task, got ${String(input.taskCount)}`,
    );
  }
  if (input.intentShape === "free-text" && !input.hasExistingGraph) {
    return {
      mode: "single-loop",
      restricted: true,
      reason:
        "free-text intent without an existing graph must complete requirement " +
        "capture through a restricted single loop first",
    };
  }
  if (input.executionKind === "agent") {
    if (input.taskCount === 1) {
      return {
        mode: "single-loop",
        restricted: false,
        reason: "one bounded agent goal with one independently reviewable output",
      };
    }
    return {
      mode: "dag",
      restricted: false,
      reason: `${String(input.taskCount)} agent tasks with independent value run in dependency order`,
    };
  }
  const capturableDirectly =
    input.intentShape === "structured" || input.intentShape === "pack-converted";
  if (capturableDirectly && input.deterministicWork) {
    return {
      mode: "direct",
      restricted: false,
      reason: `${input.intentShape} intent with fully deterministic work runs without an agent loop`,
    };
  }
  if (input.taskCount === 1) {
    return {
      mode: "single-loop",
      restricted: false,
      reason: "one bounded goal with one independently reviewable output",
    };
  }
  return {
    mode: "dag",
    restricted: false,
    reason: `${String(input.taskCount)} tasks with independent value run in dependency order`,
  };
}
