import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentProviderManifest } from "@universal-harness-internal/plugin-sdk";
import {
  collectProjectStatus,
  createDirectExecutor,
  createProjectSchedulerHost,
  type AgentSlotFactory,
  type ProjectSchedulerHost,
} from "@universal-harness-internal/runtime";

import { EXIT_CODES, runCli, type CliIo } from "../src/index.js";
import {
  createOrchestratedRuntimeService,
  type SchedulerHostRequest,
} from "../src/runtime-service.js";

/**
 * Driver Lock discipline (M4 design 10.2/19.5, plan Task 12): run/resume take
 * the lock explicitly and release it in `finally`; contention fails closed
 * with driver_lock_unavailable before the parallel port or the ledger is
 * touched; read paths (status/watch/abort) never acquire.
 */

const FIXED_NOW = "2026-08-31T00:00:00.000Z";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function captureIo(): { io: CliIo; stdout(): string; stderr(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeStdout: (text) => out.push(text),
      writeStderr: (text) => err.push(text),
      isInteractive: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function headOf(projectRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

function sequentialIds(): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_${String(next).padStart(4, "0")}`;
  };
}

type LockHandle = Awaited<ReturnType<ProjectSchedulerHost["acquireDriverLock"]>>;
type ParallelRunInput = Parameters<ProjectSchedulerHost["parallelExecution"]["port"]["run"]>[0];

interface FakeLockHost {
  readonly host: ProjectSchedulerHost;
  readonly requests: SchedulerHostRequest[];
  readonly acquired: string[];
  readonly released: string[];
  readonly runInputs: ParallelRunInput[];
}

/** A recording host whose read model must never be consulted by these tests. */
function makeFakeLockHost(
  input: {
    readonly onAcquire?: (operationId: string) => LockHandle;
  } = {},
): FakeLockHost {
  const fake: FakeLockHost = {
    host: undefined as unknown as ProjectSchedulerHost,
    requests: [],
    acquired: [],
    released: [],
    runInputs: [],
  };
  const host: ProjectSchedulerHost = {
    parallelExecution: {
      port: {
        run: (runInput) => {
          fake.runInputs.push(runInput);
          throw new Error("the parallel port must not run in driver-lock tests");
        },
      },
      driverLock: () => {
        throw new Error("the deferred facade must not reach the kernel");
      },
    },
    readSchedulerModel: () => {
      throw new Error("unexpected scheduler read in a driver-lock test");
    },
    acquireDriverLock: (operationId) => {
      fake.acquired.push(operationId);
      if (input.onAcquire !== undefined) return Promise.resolve(input.onAcquire(operationId));
      const handle: LockHandle = {
        operation_id: operationId,
        owner_token: "owner_fake_lock_test",
        path: "/fake/driver-lock",
        release: () => {
          fake.released.push(operationId);
          return Promise.resolve();
        },
      };
      return Promise.resolve(handle);
    },
    cancelOperation: () => {
      throw new Error("unexpected scheduler cancellation in a driver-lock drive test");
    },
    close: () => {},
  };
  (fake as { host: ProjectSchedulerHost }).host = host;
  return fake;
}

const STUB_MANIFEST: AgentProviderManifest = {
  provider: "stub-managed",
  control: "managed",
  trajectory_visibility: "full",
  usage_metering: true,
  side_effect_interception: true,
  resume_semantics: "explicit",
};

const stubSlotFactory: AgentSlotFactory = {
  adapter_manifest_digest: "a".repeat(64),
  manifest: STUB_MANIFEST,
  create: () => {
    throw new Error("the driver-lock tests never dispatch to an adapter");
  },
};

function realHost(projectRoot: string): ProjectSchedulerHost {
  return createProjectSchedulerHost({
    projectRoot,
    readBaseline: () => headOf(projectRoot),
    agentSlotFactory: stubSlotFactory,
    adapterCapabilities: [],
    projectionStorePath: ":memory:",
    now: () => FIXED_NOW,
  });
}

interface OpenProject {
  readonly parent: string;
  readonly projectRoot: string;
  readonly workflowOperationId: string;
  readonly newId: (kind: string) => string;
}

/**
 * A Lite project whose first iteration paused at the baseline approval: an
 * open operation with no scheduler capability — exactly the pre-M4 shape the
 * Driver Lock must protect without changing the outcome vocabulary.
 */
async function makeOpenProject(name: string): Promise<OpenProject> {
  const parent = tempRoot("harness-cli-m4-lock-");
  const newId = sequentialIds();
  const captured = captureIo();
  const service = createOrchestratedRuntimeService({
    cwd: parent,
    io: captured.io,
    now: () => FIXED_NOW,
    newId,
    execute: createDirectExecutor(),
  });
  const created = await service.newProject({
    name,
    intent: "exercise the driver lock",
    profile: "lite",
  });
  if (created.status !== "approval_required") {
    throw new Error(`expected the first iteration to pause for approval, got ${created.status}`);
  }
  const workflowOperationId = created.data["workflow_operation_id"] as string;
  return {
    parent,
    projectRoot: join(parent, name),
    workflowOperationId,
    newId,
  };
}

function serviceWithHost(
  project: OpenProject,
  host: ProjectSchedulerHost,
  requests?: SchedulerHostRequest[],
) {
  const captured = captureIo();
  const service = createOrchestratedRuntimeService({
    cwd: project.parent,
    io: captured.io,
    now: () => FIXED_NOW,
    newId: project.newId,
    execute: createDirectExecutor(),
    schedulerHost: (request) => {
      requests?.push(request);
      return host;
    },
  });
  return { service, captured };
}

describe("driver lock discipline", { timeout: 30000 }, () => {
  it("releases the driver lock when the drive itself throws", async () => {
    const project = await makeOpenProject("m4-lock-throw");
    const fake = makeFakeLockHost();
    const { service } = serviceWithHost(project, fake.host, fake.requests);

    // The drive target does not exist: resumeIteration throws
    // (operation_not_found) after the CLI already holds the lock — the
    // finally must still release it before the guard maps the failure.
    const result = await service.resume({
      projectRoot: project.projectRoot,
      workflowOperationId: "workflow_missing",
      maxConcurrency: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.data["kind"]).toBe("operation_not_found");
    expect(fake.requests).toEqual([
      {
        projectRoot: project.projectRoot,
        driverKind: "cli",
        maxConcurrency: 1,
        live: "write",
      },
    ]);
    expect(fake.acquired).toEqual(["workflow_missing"]);
    expect(fake.released).toEqual(["workflow_missing"]);
  });

  it("fails closed on contention without touching the port or the ledger", async () => {
    const project = await makeOpenProject("m4-lock-contention");
    const fake = makeFakeLockHost({
      onAcquire: () => {
        const error = new Error("driver lock held by pid 4242");
        error.name = "DriverLockError";
        throw error;
      },
    });
    const { service } = serviceWithHost(project, fake.host, fake.requests);
    const before = collectProjectStatus(project.projectRoot).committed_operations;

    const result = await service.run({ projectRoot: project.projectRoot, dryRun: false });

    expect(result.status).toBe("failed");
    expect(result.data["kind"]).toBe("driver_lock_unavailable");
    expect(result.data["workflow_operation_id"]).toBe(project.workflowOperationId);
    expect(result.message).toMatch(/driver lock/u);
    // The parallel port never ran and the ledger gained no operation.
    expect(fake.runInputs).toEqual([]);
    expect(collectProjectStatus(project.projectRoot).committed_operations).toBe(before);
  });

  it("a second real host cannot acquire while another driver holds the file-system lock", async () => {
    const project = await makeOpenProject("m4-lock-real");
    // Driver A (e.g. another CLI process or a dashboard) holds the real lock.
    const hostA = realHost(project.projectRoot);
    const handleA = await hostA.acquireDriverLock(project.workflowOperationId);
    const requests: SchedulerHostRequest[] = [];
    try {
      const hostB = realHost(project.projectRoot);
      const { service } = serviceWithHost(project, hostB, requests);

      const result = await service.run({ projectRoot: project.projectRoot, dryRun: false });

      expect(result.status).toBe("failed");
      expect(result.data["kind"]).toBe("driver_lock_unavailable");
      expect(requests).toEqual([
        {
          projectRoot: project.projectRoot,
          driverKind: "cli",
          maxConcurrency: 1,
          live: "write",
        },
      ]);
    } finally {
      await handleA.release();
    }
    // Once driver A releases, driver B's acquisition succeeds.
    const hostB = realHost(project.projectRoot);
    const handleB = await hostB.acquireDriverLock(project.workflowOperationId);
    await handleB.release();
  });

  it("status and watch stay readable while another driver holds the lock", async () => {
    const project = await makeOpenProject("m4-lock-reads");
    const hostA = realHost(project.projectRoot);
    const handleA = await hostA.acquireDriverLock(project.workflowOperationId);
    const requests: SchedulerHostRequest[] = [];
    try {
      const hostB = realHost(project.projectRoot);
      const { service, captured } = serviceWithHost(project, hostB, requests);

      // The scheduler facet reads the model without acquiring: with no
      // accepted parallel CapabilityPlan it honestly reports inactive.
      const statusExit = await runCli(["status", "--json"], {
        io: captured.io,
        cwd: project.projectRoot,
        runtime: service,
      });
      expect(statusExit).toBe(EXIT_CODES.ok);
      const parsed = JSON.parse(captured.stdout()) as {
        data: { scheduler?: { capability_status: string; operation_id: string } };
      };
      expect(parsed.data.scheduler?.capability_status).toBe("inactive_by_profile");
      expect(parsed.data.scheduler?.operation_id).toBe(project.workflowOperationId);
      expect(requests).toContainEqual({
        projectRoot: project.projectRoot,
        driverKind: "cli",
        live: "read",
      });

      const watchExit = await runCli(["watch", "--lines", "5"], {
        io: captureIo().io,
        cwd: project.projectRoot,
        runtime: service,
      });
      expect(watchExit).toBe(EXIT_CODES.ok);
    } finally {
      await handleA.release();
    }
  });
});
