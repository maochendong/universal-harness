/**
 * Typed CLI errors with stable exit codes and categories. Non-interactive
 * callers parse the category from the JSON error envelope; the numeric codes
 * are part of the CLI contract and must not be renumbered.
 */
export const EXIT_CODES = {
  ok: 0,
  operationFailed: 1,
  usage: 2,
  projectNotFound: 3,
  stageUnavailable: 10,
  approvalRequired: 11,
  blocked: 12,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type CliErrorCategory =
  "usage_error" | "project_not_found" | "command_failed" | "stage_unavailable";

export class CliError extends Error {
  readonly kind = "cli_error" as const;
  readonly category: CliErrorCategory;
  readonly exitCode: ExitCode;
  readonly data: Record<string, unknown> | undefined;

  constructor(options: {
    readonly category: CliErrorCategory;
    readonly exitCode: ExitCode;
    readonly message: string;
    readonly data?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "CliError";
    this.category = options.category;
    this.exitCode = options.exitCode;
    this.data = options.data;
  }
}

export function usageError(message: string): CliError {
  return new CliError({ category: "usage_error", exitCode: EXIT_CODES.usage, message });
}

export function projectNotFound(message: string): CliError {
  return new CliError({
    category: "project_not_found",
    exitCode: EXIT_CODES.projectNotFound,
    message,
  });
}

export function commandFailed(message: string, data?: Record<string, unknown>): CliError {
  return new CliError({
    category: "command_failed",
    exitCode: EXIT_CODES.operationFailed,
    message,
    ...(data === undefined ? {} : { data }),
  });
}

/** Wrap an unexpected failure without leaking unstable error classes. */
export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return commandFailed(message);
}
