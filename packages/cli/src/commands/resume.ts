import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CAPTURE_ANSWER_KINDS, type CaptureAnswerInput } from "@universal-harness-internal/core";

import { usageError } from "../errors.js";
import { parseCommandArgs, requireProjectRoot, type CommandResult } from "../io.js";
import type { CommandContext } from "../router.js";

const USAGE =
  "harness resume <workflow-operation-id> [--profile <lite|standard|governed>] " +
  "[--answer <question-id>=<value> ...] [--answers <file.json>]";

/** `--answer q=v`: free-text answer bound to the coordinator-issued question id. */
function parseInlineAnswer(raw: string): CaptureAnswerInput {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw usageError(`malformed --answer ${JSON.stringify(raw)}; expected <question-id>=<value>`);
  }
  return {
    question_id: raw.slice(0, separator),
    answer_kind: "free_text",
    value: raw.slice(separator + 1),
  };
}

/**
 * `--answers file.json`: an array of `{ question_id, value, answer_kind? }`
 * entries; the kind defaults to free_text and must be a capture answer kind
 * when present.
 */
function parseAnswersFile(cwd: string, file: string): CaptureAnswerInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(cwd, file), "utf8"));
  } catch (error) {
    throw usageError(
      `cannot read answers file ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw usageError(`answers file ${file} must contain a JSON array of answer entries`);
  }
  return parsed.map((entry, index): CaptureAnswerInput => {
    if (typeof entry !== "object" || entry === null) {
      throw usageError(`answers file ${file} entry ${String(index)} is not an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate["question_id"] !== "string" || candidate["question_id"].length === 0) {
      throw usageError(`answers file ${file} entry ${String(index)} needs a question_id string`);
    }
    const answerKind = candidate["answer_kind"] ?? "free_text";
    if (
      typeof answerKind !== "string" ||
      !(CAPTURE_ANSWER_KINDS as readonly string[]).includes(answerKind)
    ) {
      throw usageError(
        `answers file ${file} entry ${String(index)} has unknown answer_kind ${JSON.stringify(answerKind)}`,
      );
    }
    return {
      question_id: candidate["question_id"],
      answer_kind: answerKind as CaptureAnswerInput["answer_kind"],
      value: candidate["value"],
    };
  });
}

/** Thin route: parse, locate the managed project and delegate. */
export async function runResumeCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      profile: { type: "string" },
      answer: { type: "string", multiple: true },
      answers: { type: "string" },
    },
    USAGE,
  );
  const [workflowOperationId, extra] = positionals;
  if (workflowOperationId === undefined || extra !== undefined) {
    throw usageError(`expected exactly one workflow operation id; usage: ${USAGE}`);
  }
  const profile = values["profile"];
  const inline = values["answer"];
  const answers: CaptureAnswerInput[] = [
    ...(Array.isArray(inline) ? inline : typeof inline === "string" ? [inline] : []).map(
      parseInlineAnswer,
    ),
    ...(typeof values["answers"] === "string"
      ? parseAnswersFile(context.cwd, values["answers"])
      : []),
  ];
  return context.runtime.resume({
    workflowOperationId,
    projectRoot: requireProjectRoot(context.cwd),
    ...(typeof profile === "string" ? { profile } : {}),
    ...(answers.length === 0 ? {} : { answers }),
  });
}
