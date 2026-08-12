export * from "./errors.js";
export * from "./io.js";
export {
  CLI_VERSION,
  createStubRuntimeService,
  runCli,
  type AdoptProjectRequest,
  type CliDependencies,
  type CommandContext,
  type IterateRequest,
  type NewProjectRequest,
  type ResumeRequest,
  type RuntimeService,
} from "./router.js";

export const workspacePackageName = "universal-harness" as const;
