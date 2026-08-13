import {
  AGENT_RESUME_SEMANTICS,
  AGENT_TRAJECTORY_VISIBILITIES,
  AgentError,
  type AgentProviderManifest,
} from "@universal-harness-internal/plugin-sdk";

/**
 * Command provider manifest (design 13.2). The generic Command Adapter runs a
 * coding-agent provider as one delegated process. The manifest fixes the
 * executable and the argument template up front: no task text ever becomes an
 * argument and no shell is involved, so the only runtime input is the path of
 * the Harness-written envelope file substituted for `{input_file}`.
 *
 * The manifest's declared metering, interception, trajectory and resume
 * capabilities decide whether the provider may run unattended; the claims
 * are checked against what the process actually reports at run time.
 */

export const INPUT_FILE_PLACEHOLDER = "{input_file}";

export interface CommandProviderManifest extends AgentProviderManifest {
  readonly control: "delegated";
  /** Fixed executable: a bare name resolved via PATH or an absolute path. */
  readonly executable: string;
  /** Argument template; must contain exactly one `{input_file}` placeholder. */
  readonly args: readonly string[];
  /** Only these environment variables are passed to the provider process. */
  readonly env_allowlist: readonly string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalid(message: string): never {
  throw new AgentError("invalid_manifest", message);
}

/**
 * Validate an untrusted manifest. Anything structurally off is a typed
 * `invalid_manifest` error, so a misdeclared provider can never run.
 */
export function validateCommandManifest(raw: unknown): CommandProviderManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("a command provider manifest must be an object");
  }
  const manifest = raw as CommandProviderManifest;

  if (!isNonEmptyString(manifest.provider)) invalid("manifest.provider must be a non-empty string");
  if (manifest.control !== "delegated") {
    invalid('the command adapter only runs delegated providers (control: "delegated")');
  }
  if (!isNonEmptyString(manifest.executable)) {
    invalid("manifest.executable must be a non-empty string");
  }
  if (/[\r\n]/u.test(manifest.executable)) {
    invalid("manifest.executable contains illegal characters");
  }
  if (
    !(AGENT_TRAJECTORY_VISIBILITIES as readonly string[]).includes(manifest.trajectory_visibility)
  ) {
    invalid(
      `manifest.trajectory_visibility must be one of ${AGENT_TRAJECTORY_VISIBILITIES.join(", ")}`,
    );
  }
  if (typeof manifest.usage_metering !== "boolean") {
    invalid("manifest.usage_metering must be a boolean");
  }
  if (typeof manifest.side_effect_interception !== "boolean") {
    invalid("manifest.side_effect_interception must be a boolean");
  }
  if (!(AGENT_RESUME_SEMANTICS as readonly string[]).includes(manifest.resume_semantics)) {
    invalid(`manifest.resume_semantics must be one of ${AGENT_RESUME_SEMANTICS.join(", ")}`);
  }
  if (!Array.isArray(manifest.args) || manifest.args.some((arg) => typeof arg !== "string")) {
    invalid("manifest.args must be an array of strings");
  }
  const placeholders = manifest.args.filter((arg) => arg === INPUT_FILE_PLACEHOLDER).length;
  if (placeholders !== 1) {
    invalid(`manifest.args must contain exactly one ${INPUT_FILE_PLACEHOLDER} placeholder`);
  }
  for (const arg of manifest.args) {
    if (arg.includes("{") && arg !== INPUT_FILE_PLACEHOLDER) {
      invalid(`manifest.args contains an unsupported placeholder in "${arg}"`);
    }
  }
  if (
    !Array.isArray(manifest.env_allowlist) ||
    manifest.env_allowlist.some((name) => !isNonEmptyString(name))
  ) {
    invalid("manifest.env_allowlist must be an array of non-empty strings");
  }
  return manifest;
}

/** Render the argument template for one envelope file path. */
export function renderArgs(manifest: CommandProviderManifest, inputFile: string): string[] {
  return manifest.args.map((arg) => (arg === INPUT_FILE_PLACEHOLDER ? inputFile : arg));
}

/** Build the scrubbed environment: only allowlisted variables pass through. */
export function buildEnvironment(
  manifest: CommandProviderManifest,
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of manifest.env_allowlist) {
    const value = ambient[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
