import {
  GRAPH_DATABASE_RELATIVE_PATH,
  findProjectRoot,
  harnessRootFor,
  readManagedManifest,
  readManagedPackLock,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { checkGraphCache, type GraphCacheCheck } from "@universal-harness-internal/graph";

/**
 * Doctor diagnostics (design 11.2, plan Task 22). Every check produces an
 * executable typed result: a stable name, a category, a pass/warn/fail
 * verdict, a human detail and -- for every non-pass verdict -- a concrete
 * remedy. Evaluation is pure over a probe input; `collectDoctorProbes` is the
 * only function that touches the environment, which keeps tests hermetic.
 */
export const DOCTOR_CATEGORIES = [
  "environment",
  "git",
  "schema",
  "pack",
  "adapter",
  "cache",
] as const;

export type DoctorCategory = (typeof DOCTOR_CATEGORIES)[number];

export type DoctorVerdict = "pass" | "warn" | "fail";

export interface DoctorDiagnostic {
  readonly name: string;
  readonly category: DoctorCategory;
  readonly status: DoctorVerdict;
  readonly detail: string;
  /** Concrete remediation; present exactly when the verdict is not "pass". */
  readonly remedy?: string;
}

export interface DoctorReport {
  readonly diagnostics: readonly DoctorDiagnostic[];
  readonly failed: number;
  readonly warnings: number;
  readonly ok: boolean;
}

/** Everything the evaluator needs; gathered once by `collectDoctorProbes`. */
export interface DoctorProbes {
  /** `process.version`, e.g. "v22.13.0". */
  readonly nodeVersion: string;
  /** `git --version` output, or undefined when git is unavailable. */
  readonly gitVersion?: string;
  /** Absent when the working directory is not inside a managed project. */
  readonly project?: DoctorProjectProbes;
  /** PG-8: shipped prompt contract registry integrity, when the host probes it. */
  readonly promptRegistry?: {
    readonly contractCount: number;
    readonly compositionError?: string;
  };
}

export interface DoctorProjectProbes {
  readonly projectRoot: string;
  readonly projectName?: string;
  /** Set when the managed manifest could not be read or validated. */
  readonly manifestError?: string;
  readonly packCount?: number;
  /** Set when the pack lockfile could not be read or validated. */
  readonly packLockError?: string;
  readonly cache: GraphCacheCheck;
  /** Schema validation errors found in managed records, if any. */
  readonly schemaErrors?: readonly string[];
  /** Adapter/plugin load errors found in managed configuration, if any. */
  readonly adapterErrors?: readonly string[];
}

const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 13;

function checkNodeRuntime(probes: DoctorProbes): DoctorDiagnostic {
  const match = /^v(\d+)\.(\d+)/u.exec(probes.nodeVersion);
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);
  const ok =
    major > MINIMUM_NODE_MAJOR || (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR);
  return ok
    ? {
        name: "node_runtime",
        category: "environment",
        status: "pass",
        detail: `${probes.nodeVersion} satisfies >= ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}.0`,
      }
    : {
        name: "node_runtime",
        category: "environment",
        status: "fail",
        detail: `${probes.nodeVersion} is older than the required >= ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}.0`,
        remedy: `install Node.js ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}.0 or newer and re-run harness doctor`,
      };
}

function checkPromptRegistry(probes: DoctorProbes): DoctorDiagnostic {
  const probe = probes.promptRegistry;
  if (probe === undefined) {
    return {
      name: "prompt_registry",
      category: "schema",
      status: "pass",
      detail: "prompt registry probe not provided (skipped)",
    };
  }
  if (probe.compositionError !== undefined) {
    return {
      name: "prompt_registry",
      category: "schema",
      status: "fail",
      detail: `shipped prompt contract registry drifted: ${probe.compositionError}`,
      remedy:
        "恢复各域注册的 Prompt Contract 与 Registry 摘要一致（contract_content_conflict / digest 漂移），然后重跑 harness doctor",
    };
  }
  return {
    name: "prompt_registry",
    category: "schema",
    status: "pass",
    detail: `${String(probe.contractCount)} shipped prompt contracts compose cleanly`,
  };
}

function checkGit(probes: DoctorProbes): DoctorDiagnostic {
  if (probes.gitVersion === undefined) {
    return {
      name: "git_executable",
      category: "git",
      status: "fail",
      detail: "git executable not found on PATH",
      remedy:
        "install git and ensure it is on PATH; the ledger is Git-native and cannot commit without it",
    };
  }
  return {
    name: "git_executable",
    category: "git",
    status: "pass",
    detail: probes.gitVersion,
  };
}

function projectDiagnostics(project: DoctorProjectProbes): DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];
  if (project.manifestError !== undefined) {
    diagnostics.push({
      name: "project_layout",
      category: "schema",
      status: "fail",
      detail: project.manifestError,
      remedy: "restore .harness/project.json from version control or re-run harness adopt",
    });
  } else {
    diagnostics.push({
      name: "project_layout",
      category: "schema",
      status: "pass",
      detail: `project ${project.projectName ?? "unknown"} at ${project.projectRoot}`,
    });
  }
  if (project.packLockError !== undefined) {
    diagnostics.push({
      name: "pack_lock",
      category: "pack",
      status: "fail",
      detail: project.packLockError,
      remedy: "restore .harness/packs.lock.json from version control or re-pin packs",
    });
  } else {
    diagnostics.push({
      name: "pack_lock",
      category: "pack",
      status: "pass",
      detail: `${project.packCount ?? 0} pinned packs`,
    });
  }
  const schemaErrors = project.schemaErrors ?? [];
  if (schemaErrors.length > 0) {
    diagnostics.push({
      name: "schema_validation",
      category: "schema",
      status: "fail",
      detail: schemaErrors.join("; "),
      remedy: "repair or remove the invalid managed records; the ledger refuses to replay them",
    });
  }
  const adapterErrors = project.adapterErrors ?? [];
  if (adapterErrors.length > 0) {
    diagnostics.push({
      name: "adapter_loading",
      category: "adapter",
      status: "fail",
      detail: adapterErrors.join("; "),
      remedy: "reinstall or unpin the failing adapter; runs stay blocked until adapters load",
    });
  }
  const cache = project.cache;
  if (cache.status === "ok") {
    diagnostics.push({
      name: "graph_cache",
      category: "cache",
      status: "pass",
      detail: cache.detail ?? "cache is consistent with the ledger",
    });
  } else if (cache.status === "missing") {
    diagnostics.push({
      name: "graph_cache",
      category: "cache",
      status: "warn",
      detail: cache.detail ?? "no graph cache present",
      remedy: "run harness graph sync to rebuild the disposable SQLite cache from the ledger",
    });
  } else {
    diagnostics.push({
      name: "graph_cache",
      category: "cache",
      status: "fail",
      detail: cache.detail === undefined ? cache.status : `${cache.status}: ${cache.detail}`,
      remedy:
        "run harness graph sync; a corrupt or inconsistent cache is rebuilt wholesale from the ledger",
    });
  }
  return diagnostics;
}

/**
 * Evaluate all doctor checks over pre-gathered probes. Diagnostic order is
 * fixed: environment, git, then project checks in declaration order.
 */
export function evaluateDoctorDiagnostics(probes: DoctorProbes): DoctorReport {
  const diagnostics = [
    checkNodeRuntime(probes),
    checkGit(probes),
    checkPromptRegistry(probes),
    ...(probes.project === undefined
      ? [
          {
            name: "project_layout",
            category: "schema",
            status: "pass",
            detail: "no managed project at or above the working directory (project checks skipped)",
          } satisfies DoctorDiagnostic,
        ]
      : projectDiagnostics(probes.project)),
  ];
  const failed = diagnostics.filter((diagnostic) => diagnostic.status === "fail").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.status === "warn").length;
  return { diagnostics, failed, warnings, ok: failed === 0 };
}

/**
 * Gather doctor probes from the environment. Reading failures become probe
 * error fields -- collection itself never throws for a broken project, so the
 * evaluator can always produce its typed verdicts.
 */
export function collectDoctorProbes(
  cwd: string,
  probes: {
    readonly gitVersion: () => string | undefined;
    readonly nodeVersion?: string;
    /** PG-8: shipped prompt registry integrity probe (never throws). */
    readonly promptRegistry?: () => {
      readonly contractCount: number;
      readonly compositionError?: string;
    };
  },
): DoctorProbes {
  const gitVersion = probes.gitVersion();
  const promptRegistry = probes.promptRegistry?.();
  const base: DoctorProbes = {
    nodeVersion: probes.nodeVersion ?? process.version,
    ...(gitVersion === undefined ? {} : { gitVersion }),
    ...(promptRegistry === undefined ? {} : { promptRegistry }),
  };
  const projectRoot = findProjectRoot(cwd);
  if (projectRoot === undefined) return base;

  let projectName: string | undefined;
  let manifestError: string | undefined;
  try {
    projectName = readManagedManifest(projectRoot).name;
  } catch (error) {
    manifestError = error instanceof Error ? error.message : String(error);
  }
  let packCount: number | undefined;
  let packLockError: string | undefined;
  try {
    packCount = readManagedPackLock(projectRoot).packs.length;
  } catch (error) {
    packLockError = error instanceof Error ? error.message : String(error);
  }
  const cache = checkGraphCache(
    resolveHarnessPath(harnessRootFor(projectRoot), GRAPH_DATABASE_RELATIVE_PATH),
  );
  return {
    ...base,
    project: {
      projectRoot,
      ...(projectName === undefined ? {} : { projectName }),
      ...(manifestError === undefined ? {} : { manifestError }),
      ...(packCount === undefined ? {} : { packCount }),
      ...(packLockError === undefined ? {} : { packLockError }),
      cache,
    },
  };
}
