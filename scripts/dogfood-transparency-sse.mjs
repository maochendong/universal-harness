/**
 * Real transparency/SSE dogfood (plan Task 6 Step 3).
 *
 * Boots a real `harness serve` subprocess over a temporary long-history
 * project, drives at least 30 real approval decisions through the real CLI
 * (`node packages/cli/dist/bin.js approve <request-id> --decision ...`), and
 * measures — on one host clock — the boundary from the committed Ledger
 * manifest (file mtime) to the decision card rendered in a real Playwright
 * browser fed by the production SSE Hub. Nothing about SSE is mocked; frames
 * are observed through an EventSource wrapper and each frame is bound back to
 * the committed ApprovalDecided payload by decision_digest.
 *
 * Cold start/first catch-up and a stalled-client scenario are measured as
 * separate groups and never enter the steady-state <1s budget. The report
 * contains no raw actor, secret or absolute machine path.
 *
 * Requires a prior `pnpm build` (the CLI/runtime dists are executed, not
 * rebuilt here). Usage: node scripts/dogfood-transparency-sse.mjs --samples 30
 */
/* global window, document */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import { chromium } from "@playwright/test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = join(repositoryRoot, "packages", "cli", "dist", "bin.js");
const reportPath = join(repositoryRoot, ".reports", "acceptance", "transparency-dogfood.json");
const ACTOR = "human:dogfood-transparency";
const STEADY_BUDGET_MS = 1000;
const HISTORY_TRANSACTIONS = 120;
const HISTORY_EVENTS_PER_TRANSACTION = 3;
const SLOW_CLIENT_DECISIONS = 3;
const DECIDED_TEXT = {
  approve: "审批决定 · 已批准",
  defer: "已暂缓，仍待处理",
};

function fail(message) {
  throw new Error(`dogfood-transparency-sse: ${message}`);
}

function parseSamples(argv) {
  const args = { samples: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--samples") {
      args.samples = Number(argv[index + 1]);
      index += 1;
    } else {
      fail(`unknown argument: ${argv[index]}`);
    }
  }
  if (!Number.isSafeInteger(args.samples) || args.samples < 1) {
    fail("--samples must be a positive integer");
  }
  return args.samples;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(samples) {
  const latencies = samples.map((sample) => sample.latency_ms).sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const max = latencies.at(-1) ?? 0;
  return { p50_ms: p50, p95_ms: p95, max_ms: max };
}

/** Strip machine-local absolute paths from failure text before persisting. */
function sanitize(text, projectRoot) {
  return String(text).split(projectRoot).join("<project>").split(repositoryRoot).join("<repo>");
}

function manifestDirectory(projectRoot) {
  return join(projectRoot, ".harness", "ledger", "operations");
}

function snapshotManifestIds(projectRoot) {
  const directory = manifestDirectory(projectRoot);
  if (!existsSync(directory)) return new Set();
  return new Set(readdirSync(directory));
}

/**
 * Locate the manifest whose committed event shard carries the ApprovalDecided
 * for `requestId`; the manifest mtime is the authoritative commit boundary.
 */
async function findDecisionManifest(projectRoot, before, requestId) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const directory = manifestDirectory(projectRoot);
    const fresh = readdirSync(directory)
      .filter((name) => !before.has(name))
      .map((name) => join(directory, name))
      .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
    for (const manifestPath of fresh) {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        continue;
      }
      const eventFile = manifest?.event_file;
      if (typeof eventFile !== "string") continue;
      const shardPath = join(projectRoot, ".harness", eventFile);
      if (!existsSync(shardPath)) continue;
      for (const line of readFileSync(shardPath, "utf8").split("\n")) {
        if (line.length === 0) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          event?.event_type === "ApprovalDecided" &&
          event?.payload?.request_id === requestId &&
          typeof event?.payload?.decision_digest === "string"
        ) {
          return {
            committedAtMs: statSync(manifestPath).mtimeMs,
            decisionDigest: event.payload.decision_digest,
            event,
          };
        }
      }
    }
    if (Date.now() > deadline) {
      fail(`no committed ApprovalDecided manifest appeared for ${requestId}`);
    }
    await sleep(25);
  }
}

function cliDecision(projectRoot, requestId, decision) {
  execFileSync(
    process.execPath,
    [cliBin, "approve", requestId, "--decision", decision, "--actor", ACTOR],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Wait until the decision card renders the expected terminal/defer text. */
async function waitRendered(page, requestId, decision) {
  const selector = `#approval-queue [data-request-id="${requestId}"]`;
  const expected = DECIDED_TEXT[decision];
  const deadline = Date.now() + 15_000;
  for (;;) {
    const texts = await page
      .locator(selector)
      .allTextContents()
      .catch(() => []);
    if (texts.some((text) => text.includes(expected))) return Date.now();
    if (Date.now() > deadline) {
      const debug = await page
        .evaluate(() => {
          const frames = Array.isArray(window.__dogfoodFrames) ? window.__dogfoodFrames : [];
          const statusLine = document.querySelector('[data-state="approvals"]');
          return {
            frameCount: frames.length,
            lastFrames: frames.slice(-5).map((frame) => ({
              type: frame?.type,
              eventType: frame?.data?.event?.event_type ?? null,
            })),
            statusText: statusLine?.textContent ?? null,
            cardCount: document.querySelectorAll("#approval-queue [data-request-id]").length,
          };
        })
        .catch((error) => ({ debugError: String(error) }));
      process.stderr.write(`dogfood debug on render timeout: ${JSON.stringify(debug, null, 2)}\n`);
      fail(`browser did not render "${expected}" for ${requestId} within 15s`);
    }
    await sleep(50);
  }
}

async function drainFrames(page) {
  return page.evaluate(() => {
    const frames = window.__dogfoodFrames;
    if (!Array.isArray(frames)) return [];
    return frames.splice(0, frames.length);
  });
}

function frameBindsDecision(frames, requestId, decisionDigest) {
  return frames.some(
    (frame) =>
      frame?.data?.event?.event_type === "ApprovalDecided" &&
      frame?.data?.event?.payload?.request_id === requestId &&
      frame?.data?.event?.payload?.decision_digest === decisionDigest,
  );
}

function countLayout(projectRoot) {
  const manifests = readdirSync(manifestDirectory(projectRoot)).length;
  let events = 0;
  const eventsRoot = join(projectRoot, ".harness", "events");
  if (existsSync(eventsRoot)) {
    for (const month of readdirSync(eventsRoot)) {
      const monthDirectory = join(eventsRoot, month);
      for (const file of readdirSync(monthDirectory)) {
        events += readFileSync(join(monthDirectory, file), "utf8")
          .split("\n")
          .filter((line) => line.length > 0).length;
      }
    }
  }
  return { manifest_files: manifests, event_records: events };
}

async function startServe(projectRoot) {
  const child = spawn(process.execPath, [cliBin, "serve", "--port", "0"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const bootstrapUrl = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`serve did not print its bootstrap URL; stderr: ${stderr}`)),
      30_000,
    );
    child.on("error", rejectPromise);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /Dashboard listening at (\S+)/u.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
  });
  return { child, bootstrapUrl };
}

/** A stalled subscriber: headers are accepted but the body is never read. */
async function attachStalledClient(origin, cookieHeader) {
  const stalled = {
    status: null,
    closed: false,
    attachedAt: Date.now(),
    closedAt: null,
    request: null,
    response: null,
  };
  await new Promise((resolvePromise, rejectPromise) => {
    const request = http.get(
      `${origin}/events`,
      { headers: { Cookie: cookieHeader } },
      (response) => {
        stalled.request = request;
        stalled.response = response;
        stalled.status = response.statusCode;
        response.on("close", () => {
          stalled.closed = true;
          stalled.closedAt = Date.now();
        });
        response.on("error", () => {
          stalled.closed = true;
          stalled.closedAt = Date.now();
        });
        resolvePromise();
      },
    );
    stalled.request = request;
    request.on("error", rejectPromise);
    setTimeout(
      () => rejectPromise(new Error("stalled client received no response headers")),
      10_000,
    );
  });
  return stalled;
}

async function measureDecision(page, projectRoot, requestId, decision, index) {
  const before = snapshotManifestIds(projectRoot);
  cliDecision(projectRoot, requestId, decision);
  const committed = await findDecisionManifest(projectRoot, before, requestId);
  const renderedAtMs = await waitRendered(page, requestId, decision);
  const frames = await drainFrames(page);
  const bound = frameBindsDecision(frames, requestId, committed.decisionDigest);
  return {
    index,
    request_id: requestId,
    decision,
    committed_at_ms: Math.round(committed.committedAtMs),
    rendered_at_ms: renderedAtMs,
    latency_ms: Math.round(renderedAtMs - committed.committedAtMs),
    decision_digest: committed.decisionDigest,
    frame_bound: bound,
  };
}

async function main() {
  const samples = parseSamples(process.argv.slice(2));
  for (const dist of [
    cliBin,
    join(repositoryRoot, "packages", "runtime", "dist", "index.js"),
    join(repositoryRoot, "packages", "core", "dist", "index.js"),
    join(repositoryRoot, "adapters", "vcs-git", "dist", "index.js"),
  ]) {
    if (!existsSync(dist)) fail(`missing build output ${dist}; run pnpm build first`);
  }
  const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const command = `node scripts/dogfood-transparency-sse.mjs --samples ${String(samples)}`;
  const startedAt = new Date().toISOString();

  const runtime = await import(
    pathToFileURL(join(repositoryRoot, "packages", "runtime", "dist", "index.js")).href
  );
  const core = await import(
    pathToFileURL(join(repositoryRoot, "packages", "core", "dist", "index.js")).href
  );
  const { createGitVcsAdapter } = await import(
    pathToFileURL(join(repositoryRoot, "adapters", "vcs-git", "dist", "index.js")).href
  );

  const parent = mkdtempSync(join(tmpdir(), "harness-transparency-dogfood-"));
  let server;
  let browser;
  let stalledClient;
  const partial = {
    cold_start: null,
    slow_client: null,
    steady_state: { samples: [] },
    layout: null,
  };
  try {
    const vcs = createGitVcsAdapter();
    const created = await runtime.createNewProject(
      {
        parentDirectory: parent,
        name: "transparency-dogfood",
        intent: "measure committed decision visibility latency",
      },
      { vcs },
    );
    if (!created.ok) fail(`project creation failed: ${created.error.message}`);
    const projectRoot = created.value.projectRoot;
    const head = () =>
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();

    // Long committed history: 120 real Ledger transactions, 360 event records.
    const repository = new core.LedgerRepository({ projectRoot, readBaseline: head });
    const historyBase = Date.parse("2026-09-01T00:00:00.000Z");
    for (let transaction = 1; transaction <= HISTORY_TRANSACTIONS; transaction += 1) {
      const operationId = `ledger_dogfood_history_${String(transaction).padStart(4, "0")}`;
      const events = Array.from({ length: HISTORY_EVENTS_PER_TRANSACTION }, (_, offset) => ({
        protocol_version: "1.0.0",
        record_kind: "event",
        event_id: `event_dogfood_history_${String(transaction)}_${String(offset)}`,
        event_type: "OperationStarted",
        project_id: "project_transparency_dogfood",
        iteration_id: "iteration_dogfood_history",
        workflow_operation_id: "workflow_dogfood_history",
        ledger_operation_id: operationId,
        sequence: (transaction - 1) * HISTORY_EVENTS_PER_TRANSACTION + offset + 1,
        timestamp: new Date(historyBase + transaction * 1000 + offset).toISOString(),
        payload: { nonce: `history_${String(transaction)}_${String(offset)}` },
      }));
      const result = await repository.commit({
        ledger_operation_id: operationId,
        workflow_operation_id: "workflow_dogfood_history",
        attempt_id: `attempt_dogfood_history_${String(transaction)}`,
        expected_baseline: head(),
        events,
      });
      if (result.status !== "committed") fail(`history transaction ${operationId} not committed`);
    }

    const deps = {
      projectRoot,
      readBaseline: head,
      vcs,
      interpret: runtime.createGenericInterpreter(),
      // Deterministic no-op direct executor: the dogfood measures approval
      // decision visibility, not agent execution, and implementation work
      // never defaults (executor_required otherwise blocks the pipeline).
      execution: {
        kind: "workflow",
        name: "dogfood-direct-workflow",
        deterministic: true,
        execute: runtime.createDirectExecutor(),
      },
    };

    let openOperation;
    let approvalCounter = 0;
    const nextApproval = async () => {
      for (let hop = 0; hop < 20; hop += 1) {
        if (openOperation === undefined) {
          approvalCounter += 1;
          const started = await runtime.runIteration(deps, {
            intent: `transparency dogfood decision sample ${String(approvalCounter)}`,
            intentShape: "pack-converted",
          });
          if (started.status !== "approval_required") {
            fail(`runIteration returned ${String(started.status)} instead of approval_required`);
          }
          openOperation = started.required.workflow_operation_id;
          return started.required;
        }
        const outcome = await runtime.resumeIteration(deps, openOperation, undefined);
        if (outcome.status === "approval_required") return outcome.required;
        if (outcome.status === "completed") {
          openOperation = undefined;
          continue;
        }
        fail(`resumeIteration returned ${String(outcome.status)}`);
      }
      fail("no further approval gate within 20 pipeline hops");
      return undefined;
    };

    // The first approval exists before serve starts, so the cold-start
    // catch-up covers the long history plus a live pending card.
    let pending = await nextApproval();

    server = await startServe(projectRoot);
    const origin = new URL(server.bootstrapUrl).origin;

    // Match playwright.dashboard.config.ts: the system Chrome channel avoids a
    // Playwright browser download and is what the dashboard e2e suite runs.
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const records = [];
      Object.defineProperty(window, "__dogfoodFrames", { value: records });
      const NativeEventSource = window.EventSource;
      const nativeAdd = NativeEventSource.prototype.addEventListener;
      NativeEventSource.prototype.addEventListener = function patched(type, listener, options) {
        nativeAdd.call(this, type, (event) => {
          try {
            records.push({
              type,
              id: event.lastEventId,
              at: Date.now(),
              data: JSON.parse(event.data),
            });
          } catch {
            records.push({ type, id: event.lastEventId, at: Date.now(), data: null });
          }
        });
        return nativeAdd.call(this, type, listener, options);
      };
    });
    const page = await context.newPage();

    // Cold start / first catch-up: measured once, reported separately. The
    // dashboard opens its EventSource only on the Live view (see
    // tests/e2e/dashboard-live-approval.test.ts), so visit Live before
    // Approvals; catch-up ends when the pending card is visible there.
    const coldStartBegin = Date.now();
    await page.goto(server.bootstrapUrl);
    await page.getByRole("link", { name: /Live/u }).click();
    await page.getByRole("link", { name: /Approvals/u }).click();
    await page.waitForSelector(`#approval-queue [data-request-id="${pending.request_id}"]`, {
      timeout: 30_000,
    });
    const coldStartMs = Date.now() - coldStartBegin;
    await drainFrames(page);
    partial.cold_start = {
      catch_up_ms: coldStartMs,
      history_manifest_files: HISTORY_TRANSACTIONS,
      pending_request_visible: true,
      note: "首次追平含长历史全量读取；不纳入稳态预算",
    };

    // Stalled-client group: a subscriber that never drains must not delay the
    // browser; the bounded Hub closes it. Reported separately.
    const cookies = await context.cookies(origin);
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const stalled = await attachStalledClient(origin, cookieHeader);
    stalledClient = stalled;
    const slowDecisions = [];
    for (let index = 0; index < SLOW_CLIENT_DECISIONS; index += 1) {
      const sample = await measureDecision(page, projectRoot, pending.request_id, "approve", index);
      slowDecisions.push(sample);
      pending = await nextApproval();
    }
    // Close after buffer fill + the Hub drain budget (10s) with margin; the
    // stalled socket only blocks once TCP/kernel buffers are full.
    const stallDeadline = Date.now() + 45_000;
    while (!stalled.closed && Date.now() < stallDeadline) await sleep(100);
    partial.slow_client = {
      attached: stalled.status === 200,
      closed_by_server: stalled.closed,
      close_after_ms: stalled.closedAt === null ? null : stalled.closedAt - stalled.attachedAt,
      decisions: slowDecisions.map((sample) => ({
        request_id: sample.request_id,
        latency_ms: sample.latency_ms,
        frame_bound: sample.frame_bound,
      })),
      browser_unaffected: slowDecisions.every((sample) => sample.latency_ms < STEADY_BUDGET_MS),
      note: "慢客户端从不读取响应体；其关闭与浏览器延迟单独报告，不纳入稳态预算",
    };

    // Steady-state group: exactly `samples` real CLI decisions, every sixth a
    // defer immediately followed by the terminal approve on the same request.
    const steady = [];
    let index = 0;
    while (steady.length < samples) {
      index += 1;
      const decision = index % 6 === 0 ? "defer" : "approve";
      steady.push(await measureDecision(page, projectRoot, pending.request_id, decision, index));
      if (decision !== "defer") pending = await nextApproval();
    }
    const summary = summarize(steady);
    partial.steady_state = {
      budget_ms: STEADY_BUDGET_MS,
      samples: steady,
      ...summary,
      within_budget: summary.p95_ms < STEADY_BUDGET_MS,
    };
    partial.layout = {
      history_transactions: HISTORY_TRANSACTIONS,
      ...countLayout(projectRoot),
    };

    const unbound = steady.filter((sample) => !sample.frame_bound);
    if (unbound.length > 0) {
      fail(
        `${String(unbound.length)} steady samples lack an SSE frame bound to the Decision digest`,
      );
    }
    if (partial.slow_client.decisions.some((sample) => !sample.frame_bound)) {
      fail("a slow-client sample lacks an SSE frame bound to the Decision digest");
    }
    if (summary.p95_ms >= STEADY_BUDGET_MS) {
      fail(`steady-state p95 ${String(summary.p95_ms)}ms exceeds the 1s budget`);
    }

    return {
      schema_version: "harness.transparency-dogfood/1",
      implementation_commit: implementationCommit,
      command,
      exit_code: 0,
      status: "passed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      samples_requested: samples,
      clock:
        "single host; manifest mtime marks the committed boundary, Date.now() marks CLI/observation and browser render; catch-up declared once the first pending card is visible",
      layout: partial.layout,
      cold_start: partial.cold_start,
      slow_client: partial.slow_client,
      steady_state: partial.steady_state,
    };
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : String(error), parent);
    return {
      schema_version: "harness.transparency-dogfood/1",
      implementation_commit: implementationCommit,
      command,
      exit_code: 1,
      status: "failed",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      samples_requested: samples,
      error: message,
      clock: "single host",
      layout: partial.layout,
      cold_start: partial.cold_start,
      slow_client: partial.slow_client,
      steady_state: partial.steady_state,
    };
  } finally {
    if (stalledClient !== undefined) {
      // The stalled socket would otherwise keep this process's event loop alive.
      stalledClient.response?.destroy();
      stalledClient.request?.destroy();
    }
    if (browser !== undefined) await browser.close().catch(() => undefined);
    if (server !== undefined) {
      server.child.kill("SIGTERM");
      await new Promise((resolvePromise) => {
        server.child.once("exit", resolvePromise);
        setTimeout(resolvePromise, 5_000);
      });
    }
    rmSync(parent, { recursive: true, force: true });
  }
}

const report = await main();
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (report.status === "passed") {
  const steady = report.steady_state;
  console.log(
    `transparency dogfood passed: ${String(steady.samples.length)} steady decisions, ` +
      `p50=${String(steady.p50_ms)}ms p95=${String(steady.p95_ms)}ms max=${String(steady.max_ms)}ms; ` +
      `cold start ${String(report.cold_start.catch_up_ms)}ms; ` +
      `slow client closed=${String(report.slow_client.closed_by_server)}`,
  );
  console.log(`report written to .reports/acceptance/transparency-dogfood.json`);
} else {
  console.error(`transparency dogfood failed: ${report.error ?? "unknown"}`);
  process.exitCode = 1;
}
