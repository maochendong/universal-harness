import { validateSchema, type ValidationIssue, type ValidationResult } from "./registry.js";

type RunRecordShape = {
  attempt_id: string;
  record_kind: string;
  run_id: string;
  sequence: number;
  workflow_operation_id: string;
};

function streamIssue(message: string, instancePath = ""): ValidationIssue {
  return { instancePath, keyword: "runStream", message };
}

function runShape(value: unknown): RunRecordShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<RunRecordShape>;
  if (
    typeof record.attempt_id !== "string" ||
    typeof record.record_kind !== "string" ||
    typeof record.run_id !== "string" ||
    typeof record.sequence !== "number" ||
    typeof record.workflow_operation_id !== "string"
  ) {
    return undefined;
  }
  return record as RunRecordShape;
}

export function validateRunRecordStream(records: readonly unknown[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const shapes: RunRecordShape[] = [];

  records.forEach((record, index) => {
    const result = validateSchema("runtime", record);
    if (!result.valid) {
      errors.push(
        ...result.errors.map((error) => ({
          ...error,
          instancePath: `/${index}${error.instancePath}`,
        })),
      );
      return;
    }
    const shape = runShape(record);
    if (shape === undefined || !shape.record_kind.startsWith("run_")) {
      errors.push(streamIssue("stream may only contain run records", `/${index}`));
      return;
    }
    shapes.push(shape);
  });

  if (shapes.length === 0) {
    errors.push(streamIssue("run stream must not be empty"));
  } else {
    const [first] = shapes;
    const starts = shapes.filter((record) => record.record_kind === "run_started");
    const terminals = shapes.filter(
      (record) =>
        record.record_kind === "run_terminated" || record.record_kind === "run_interrupted",
    );

    if (starts.length !== 1 || shapes[0]?.record_kind !== "run_started") {
      errors.push(streamIssue("run stream must contain exactly one leading RunStarted"));
    }
    if (
      terminals.length !== 1 ||
      !["run_terminated", "run_interrupted"].includes(shapes.at(-1)?.record_kind ?? "")
    ) {
      errors.push(streamIssue("run stream must contain exactly one trailing terminal record"));
    }

    shapes.forEach((record, index) => {
      if (first !== undefined) {
        if (record.run_id !== first.run_id)
          errors.push(streamIssue("run_id changed within stream", `/${index}/run_id`));
        if (record.workflow_operation_id !== first.workflow_operation_id) {
          errors.push(
            streamIssue(
              "workflow_operation_id changed within stream",
              `/${index}/workflow_operation_id`,
            ),
          );
        }
        if (record.attempt_id !== first.attempt_id) {
          errors.push(streamIssue("attempt_id changed within stream", `/${index}/attempt_id`));
        }
      }
      if (index > 0 && record.sequence <= (shapes[index - 1]?.sequence ?? 0)) {
        errors.push(streamIssue("run sequence must be strictly increasing", `/${index}/sequence`));
      }
    });
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}
