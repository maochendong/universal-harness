import { PROFILE_IDS, type ProfileId, type ProjectProfileRecord } from "../schema/profile.js";
import { isProfileId } from "./definitions.js";

/**
 * Profile selection semantics (slim-profiles design 10, 17.2). There is no
 * silent default: non-interactive callers must pass `--profile`, interactive
 * sessions choose and confirm explicitly, and a legacy project without any
 * ProjectProfileRecord is asked exactly once before its next iterate/resume.
 */
export class ProfileSelectionError extends Error {
  readonly kind = "unknown_profile" as const;

  constructor(value: string) {
    super(`unknown profile ${JSON.stringify(value)}; expected one of: ${PROFILE_IDS.join(", ")}`);
    this.name = "ProfileSelectionError";
  }
}

export type ProfileSelectionOutcome =
  | {
      readonly status: "selected";
      readonly profile_id: ProfileId;
      readonly source: "explicit" | "interactive";
    }
  | {
      readonly status: "input_required";
      readonly reason: "profile_required";
      readonly options: readonly ProfileId[];
    };

function inputRequired(): ProfileSelectionOutcome {
  return { status: "input_required", reason: "profile_required", options: PROFILE_IDS };
}

/** The human-readable comparison shown before an interactive selection. */
export function profileSelectionPreview(): string {
  return [
    "Choose the project profile (governance tier):",
    "  lite      — evidence kernel only; optional capabilities activate per risk or choice",
    "  standard  — impact analysis, design governance and independent evaluation required",
    "  governed  — full governance: strict TDD and advanced audit required",
  ].join("\n");
}

export async function resolveProfileSelection(input: {
  readonly explicit?: string;
  readonly interactive: boolean;
  readonly choose?: (options: readonly ProfileId[], preview: string) => Promise<string | null>;
}): Promise<ProfileSelectionOutcome> {
  if (input.explicit !== undefined) {
    if (!isProfileId(input.explicit)) {
      throw new ProfileSelectionError(input.explicit);
    }
    return { status: "selected", profile_id: input.explicit, source: "explicit" };
  }
  if (input.interactive && input.choose !== undefined) {
    const answer = await input.choose(PROFILE_IDS, profileSelectionPreview());
    // A dismissed or invalid answer never becomes a silent default.
    if (answer !== null && isProfileId(answer.trim().toLowerCase())) {
      return {
        status: "selected",
        profile_id: answer.trim().toLowerCase() as ProfileId,
        source: "interactive",
      };
    }
  }
  return inputRequired();
}

export type IterationProfileResolution =
  | { readonly status: "resolved"; readonly profile: ProjectProfileRecord }
  | {
      readonly status: "input_required";
      readonly reason: "profile_required";
      readonly options: readonly ProfileId[];
      readonly migration: "legacy_project_without_profile";
    };

/**
 * `iterate`/`resume` always bind the current ProjectProfileRecord revision. A
 * project without any record (protocol 1.0 history) is never guessed onto a
 * tier: it must be migrated through an explicit selection first.
 */
export function resolveIterationProfile(
  latest: ProjectProfileRecord | undefined,
): IterationProfileResolution {
  if (latest === undefined) {
    return {
      status: "input_required",
      reason: "profile_required",
      options: PROFILE_IDS,
      migration: "legacy_project_without_profile",
    };
  }
  return { status: "resolved", profile: latest };
}
