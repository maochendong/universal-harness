import { PROJECT_CONTEXT_SOURCE_KINDS, type ProjectContextSourceKind } from "../schema/context.js";
import { PROFILE_IDS, type ProfileId } from "../schema/profile.js";

/**
 * The Profile selection matrix (intent-to-prd design 14): Lite reads only the
 * minimal manifest/README/Gate/Graph summaries, Standard adds ADR/API/Schema,
 * Governed adds Policy. The matrix is the single authority for which source
 * kinds a profile may ever see; requests may narrow it, never widen it.
 */
const LITE_KINDS: readonly ProjectContextSourceKind[] = ["manifest", "readme", "gate", "graph"];
const STANDARD_KINDS: readonly ProjectContextSourceKind[] = [...LITE_KINDS, "adr", "api", "schema"];
const GOVERNED_KINDS: readonly ProjectContextSourceKind[] = [...STANDARD_KINDS, "policy"];

const PROFILE_CONTEXT_SOURCE_MATRIX: Readonly<
  Record<ProfileId, readonly ProjectContextSourceKind[]>
> = {
  lite: LITE_KINDS,
  standard: STANDARD_KINDS,
  governed: GOVERNED_KINDS,
};

export class ProjectContextMatrixError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid profile context selection: ${reason}`);
    this.name = "ProjectContextMatrixError";
    this.reason = reason;
  }
}

/** The canonically ordered source kinds a profile may read. */
export function allowedSourceKindsForProfile(
  profileId: ProfileId,
): readonly ProjectContextSourceKind[] {
  if (!PROFILE_IDS.includes(profileId)) {
    throw new ProjectContextMatrixError(`unknown profile id: ${String(profileId)}`);
  }
  return [...PROFILE_CONTEXT_SOURCE_MATRIX[profileId]].sort();
}

/** Whether the profile matrix permits a source kind at all. */
export function isSourceKindAllowedForProfile(
  profileId: ProfileId,
  kind: ProjectContextSourceKind,
): boolean {
  return allowedSourceKindsForProfile(profileId).includes(kind);
}

/**
 * Default file candidates per source kind (design 8.2). Fixed and public: an
 * adapter can only select from these relative paths, so the port never
 * becomes an arbitrary file read.
 */
export const PROJECT_CONTEXT_CANDIDATE_PATHS: Readonly<
  Record<ProjectContextSourceKind, readonly string[]>
> = {
  manifest: [
    "package.json",
    "pnpm-workspace.yaml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
  ],
  readme: ["README.md", "README", "readme.md"],
  gate: ["harness.config.json", "gates.json", "docs/gates.md"],
  graph: ["docs/graph.md", "docs/architecture.md"],
  adr: ["docs/adr/README.md", "docs/decisions.md", "DECISIONS.md"],
  api: ["docs/api.md", "openapi.json", "openapi.yaml"],
  schema: ["schema.json", "docs/schema.md"],
  policy: ["POLICY.md", "docs/policy.md"],
};

/** Compile-time guard: every registered kind has candidates. */
for (const kind of PROJECT_CONTEXT_SOURCE_KINDS) {
  if (PROJECT_CONTEXT_CANDIDATE_PATHS[kind].length === 0) {
    throw new ProjectContextMatrixError(`source kind has no candidate paths: ${kind}`);
  }
}
