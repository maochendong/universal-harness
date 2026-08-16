import { createServer, type Server } from "node:http";

import {
  GRAPH_DATABASE_RELATIVE_PATH,
  harnessRootFor,
  resolveHarnessPath,
} from "@universal-harness-internal/core";
import { checkGraphCache, rebuildGraphCache } from "@universal-harness-internal/graph";

import { DashboardProblem } from "./problem.js";
import { createDashboardReadApi } from "./read-api.js";
import { createDashboardRouter } from "./router.js";
import { DashboardSessionStore } from "./session.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface DashboardServerOptions {
  readonly projectRoot: string;
  readonly host?: string;
  readonly port?: number;
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

function prepareCache(projectRoot: string): void {
  const databasePath = resolveHarnessPath(
    harnessRootFor(projectRoot),
    GRAPH_DATABASE_RELATIVE_PATH,
  );
  const check = checkGraphCache(databasePath);
  if (
    check.status === "missing" ||
    check.status === "unsupported_version" ||
    check.status === "inconsistent"
  ) {
    rebuildGraphCache({ projectRoot, databasePath }).database.close();
  }
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
  prepareCache(options.projectRoot);
  const sessions = new DashboardSessionStore();
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
    readApi: createDashboardReadApi(options.projectRoot),
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
      sessions.clear();
      await close(server);
    },
  };
}
