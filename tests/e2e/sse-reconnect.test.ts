import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../../adapters/vcs-git/src/index.js";
import { startDashboardServer, type DashboardServer } from "../../packages/dashboard/src/index.js";
import { createNewProject, FileLiveSpool } from "../../packages/runtime/src/index.js";

/**
 * SSE resume over real HTTP (plan Task 2 Step 4): a Node HTTP client only, no
 * Playwright. The browser idempotency half is covered by Task 4/5 Playwright
 * specs. Cursor bytes are per-process opaque values, so ordering is always
 * compared between connections of one server, never across processes.
 */
interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
}

const roots: string[] = [];
const servers: DashboardServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function managedProject(): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "harness-sse-reconnect-"));
  roots.push(parent);
  const created = await createNewProject(
    { parentDirectory: parent, name: "sse-reconnect", intent: "verify SSE resume over HTTP" },
    { vcs: createGitVcsAdapter() },
  );
  if (!created.ok) throw new Error(created.error.message);
  // Seed live observations so the history spans enough events to observe a
  // mid-stream disconnect and a non-empty resume suffix.
  const spool = new FileLiveSpool(created.value.projectRoot);
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    spool.append({
      streamId: "stream_sse_reconnect",
      observationKey: `observation_sse_reconnect_${String(sequence)}`,
      eventType: "RunHeartbeat",
      projectId: "project_sse_reconnect",
      iterationId: created.value.iterationId,
      workflowOperationId: created.value.workflowOperationId,
      timestamp: `2026-09-08T00:00:0${String(sequence)}.000Z`,
      payload: { run_id: "run_sse_reconnect" },
    });
  }
  return created.value.projectRoot;
}

async function sessionCookie(server: DashboardServer): Promise<string> {
  const exchange = await fetch(server.bootstrapUrl, { redirect: "manual" });
  expect(exchange.status).toBe(303);
  const cookie = exchange.headers.get("set-cookie");
  if (cookie === null) throw new Error("session cookie missing");
  return cookie.split(";", 1)[0] ?? "";
}

function parseFrame(raw: string): SseFrame {
  const frame: { id?: string; event?: string; data?: string } = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = line.slice(6);
  }
  return frame;
}

/**
 * Read SSE frames until `minFrames` is reached and the stream then stays idle
 * for `idleMs` (caught up), or until the guard timeout aborts the socket.
 */
async function readFrames(
  server: DashboardServer,
  cookie: string,
  options: { minFrames?: number; idleMs?: number; lastEventId?: string } = {},
): Promise<SseFrame[]> {
  const minFrames = options.minFrames ?? 0;
  const idleMs = options.idleMs ?? 800;
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), 20_000);
  const response = await fetch(`${server.origin}/events`, {
    headers: {
      cookie,
      ...(options.lastEventId === undefined ? {} : { "last-event-id": options.lastEventId }),
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (response.body === null) throw new Error("SSE response body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];
  try {
    while (true) {
      const idle = new Promise<"idle">((resolve) => {
        const timer = setTimeout(() => resolve("idle"), idleMs);
        timer.unref();
      });
      const chunk = await Promise.race([reader.read().then((result) => ({ result })), idle]);
      if (chunk === "idle") {
        if (frames.length >= minFrames) break;
        continue;
      }
      if (chunk.result.done === true) break;
      buffer += decoder.decode(chunk.result.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (raw !== "" && !raw.startsWith(":")) frames.push(parseFrame(raw));
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(guard);
    controller.abort();
  }
  return frames;
}

function foreignCursor(): string {
  const encoded = Buffer.from(
    JSON.stringify({ version: 2, generation: "generation_elsewhere", position: 1 }),
  ).toString("base64url");
  return `cursor_${encoded}`;
}

describe("Dashboard SSE reconnect over HTTP", () => {
  it("resumes from Last-Event-ID without skipped or replayed items in one generation", async () => {
    const projectRoot = await managedProject();
    const server = await startDashboardServer({ projectRoot });
    servers.push(server);
    const cookie = await sessionCookie(server);

    // First connection disconnects after processing two item frames; any
    // further frames already in flight count as unprocessed buffer.
    const first = await readFrames(server, cookie, { minFrames: 2, idleMs: 400 });
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.every((frame) => frame.event !== undefined && frame.data !== undefined)).toBe(
      true,
    );
    const resumeAfter = first[1]?.id;
    expect(resumeAfter).toBeDefined();

    // Reconnect from the last processed id, then read the full history from
    // scratch on a third connection of the same server generation.
    const resumed = await readFrames(server, cookie, { idleMs: 800, lastEventId: resumeAfter });
    const complete = await readFrames(server, cookie, { minFrames: 6, idleMs: 800 });
    const completeIds = complete.map((frame) => frame.id);
    expect(completeIds.length).toBeGreaterThanOrEqual(6);
    expect(first.slice(0, 2).map((frame) => frame.id)).toEqual(completeIds.slice(0, 2));
    // Same-generation resume: the suffix after the resume cursor arrives in
    // order with no gap and no replay of already-processed items.
    expect(resumed.map((frame) => frame.id)).toEqual(completeIds.slice(2));
  }, 30_000);

  it("answers an unknown-generation Last-Event-ID with stream_reset and allows replay", async () => {
    const projectRoot = await managedProject();
    const server = await startDashboardServer({ projectRoot });
    servers.push(server);
    const cookie = await sessionCookie(server);

    const complete = await readFrames(server, cookie, { minFrames: 1, idleMs: 800 });
    expect(complete.length).toBeGreaterThanOrEqual(1);

    const reset = await readFrames(server, cookie, {
      minFrames: 1,
      idleMs: 800,
      lastEventId: foreignCursor(),
    });
    const resetFrame = reset.find((frame) => frame.event === "stream_reset");
    expect(resetFrame).toBeDefined();
    expect(JSON.parse(resetFrame?.data ?? "{}")).toEqual({ reason: "cursor_evicted" });
    // The server ends the connection after a reset.
    expect(reset.at(-1)?.event).toBe("stream_reset");

    // After a reset the client restarts without a cursor; replay is allowed.
    const replayed = await readFrames(server, cookie, { minFrames: 1, idleMs: 800 });
    expect(replayed[0]?.id).toBe(complete[0]?.id);
  }, 30_000);
});
