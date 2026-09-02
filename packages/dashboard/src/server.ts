import { createServer, type Server } from "node:http";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  LedgerCorruptionError,
  harnessRootFor,
  replayLedger,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { checkGraphCache, rebuildGraphCache } from "@universal-harness-internal/graph";
import { FileEventStream, type EventStreamPort } from "@universal-harness-internal/runtime";

import {
  createDashboardCollaborationApi,
  unavailableDashboardCollaborationApi,
  type DashboardCollaborationApi,
} from "./collaboration-api.js";
import { DashboardProblem } from "./problem.js";
import { createDashboardReadApi, type DashboardReadApi } from "./read-api.js";
import { unavailableDashboardSchedulerApi, type DashboardSchedulerApi } from "./scheduler-api.js";
import { createDashboardRouter } from "./router.js";
import { DashboardSessionStore } from "./session.js";
import { unavailableDashboardWriteApi, type DashboardWriteApi } from "./write-api.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface DashboardServerOptions {
  readonly projectRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly eventStream?: EventStreamPort;
  readonly writeApi?: DashboardWriteApi;
  /** M4 Scheduler read projection; the CLI composition root supplies it. */
  readonly schedulerApi?: DashboardSchedulerApi;
  /** M3 remote collaboration Adapter; defaults to the Ledger + HTTPS wiring. */
  readonly collaborationApi?: DashboardCollaborationApi;
}

export interface DashboardServer {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly bootstrapUrl: string;
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Dashboard server did not expose a TCP address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function originFor(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${String(port)}`;
}

function prepareCache(projectRoot: string): DashboardProblem | undefined {
  const databasePath = resolveHarnessPath(
    harnessRootFor(projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  try {
    // Validate authoritative shards even when the disposable cache is healthy;
    // a Dashboard must never serve a stale projection over a corrupt Ledger.
    replayLedger(harnessRootFor(projectRoot));
    const check = checkGraphCache(databasePath);
    if (check.status !== "ok") {
      rebuildGraphCache({ projectRoot, databasePath }).database.close();
    }
    return undefined;
  } catch (error) {
    return new DashboardProblem(
      503,
      error instanceof LedgerCorruptionError ? "ledger_corrupt" : "authoritative_state_unavailable",
      "Service Unavailable",
      error instanceof LedgerCorruptionError
        ? "the authoritative Ledger failed integrity validation"
        : "the authoritative project state could not be materialized",
    );
  }
}

function unavailableReadApi(problem: DashboardProblem): DashboardReadApi {
  const reject = (): never => {
    throw problem;
  };
  return {
    project: reject,
    nodes: reject,
    edges: reject,
    neighborhood: reject,
    path: reject,
    iteration: reject,
    evidence: reject,
    findingGroups: reject,
    semanticProposals: reject,
    approvals: reject,
    modelInvocations: reject,
  };
}

/** Start the loopback-only Dashboard server and mint a one-use browser URL. */
export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new DashboardProblem(
      400,
      "non_loopback_host",
      "Invalid Dashboard host",
      `Dashboard refuses non-loopback host ${host}`,
    );
  }
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new DashboardProblem(
      400,
      "invalid_port",
      "Invalid Dashboard port",
      "Dashboard port must be an integer in 0..65535",
    );
  }
  const startupProblem = prepareCache(options.projectRoot);
  const collaborationApi =
    startupProblem === undefined
      ? (options.collaborationApi ??
        createDashboardCollaborationApi({ projectRoot: options.projectRoot }))
      : unavailableDashboardCollaborationApi(startupProblem);
  const sessions = new DashboardSessionStore();
  const shutdown = new AbortController();
  const routing: { handler?: ReturnType<typeof createDashboardRouter> } = {};
  const server = createServer((request, response) => {
    void routing.handler?.(request, response);
  });
  server.maxHeadersCount = 64;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const port = await listen(server, host, requestedPort);
  const origin = originFor(host, port);
  routing.handler = createDashboardRouter({
    origin,
    sessions,
    readApi:
      startupProblem === undefined
        ? createDashboardReadApi(options.projectRoot)
        : unavailableReadApi(startupProblem),
    schedulerApi:
      startupProblem === undefined
        ? (options.schedulerApi ?? unavailableDashboardSchedulerApi())
        : unavailableDashboardSchedulerApi(),
    eventStream: options.eventStream ?? new FileEventStream(options.projectRoot),
    writeApi:
      startupProblem === undefined
        ? (options.writeApi ?? unavailableDashboardWriteApi())
        : unavailableDashboardWriteApi(),
    collaborationApi,
    shutdownSignal: shutdown.signal,
  });
  let closed = false;
  return {
    host,
    port,
    origin,
    bootstrapUrl: `${origin}/?token=${encodeURIComponent(sessions.bootstrapToken)}`,
    close: async () => {
      if (closed) return;
      closed = true;
      shutdown.abort();
      sessions.clear();
      await close(server);
    },
  };
}
