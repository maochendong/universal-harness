#!/usr/bin/env node
/**
 * M3 real-platform dogfood driver (plan M3 Task 9 step 4).
 *
 * Runs the full remote-collaboration loop against ONE disposable repository
 * on a real hosting platform, exercising the production platform identity
 * adapters, the production Git control store and the production SQLite
 * projection end to end:
 *
 *   discover → authenticate → Control Ref protection gate → connect →
 *   two Operation Leases → parallel staged candidates → fenced publish →
 *   remote Approval → integrate A → deterministic Ledger re-sequence of B
 *   (§21.4 "clean Integration / Ledger sequence 重排") → integrate B →
 *   Target CAS audit → release → disconnect →
 *   rebuild the SQLite projection from Git
 *
 * Documented deviation: the browser OAuth dance is replaced by a Personal
 * Access Token. The injected fetch only intercepts the token-endpoint POST
 * (returning the PAT as the access token) and the authorize callback is
 * answered locally with the session state; every other request — user
 * identity, repository permission and branch protection — hits the real
 * platform API through `createNodeHttpsFetch`, so permission resolution and
 * protection inspection are the production adapter behavior. The host clock
 * is advanced past the Lease TTL before disconnect instead of sleeping for
 * five minutes (the clock is an injected coordinator dependency, same as in
 * the e2e suite).
 *
 * Known tradeoff: the PAT rides the git child-process command line as a
 * userinfo URL, so it is visible to `ps` on the host while git runs. That
 * is inherent to PAT-over-HTTPS transport. The script never prints command
 * lines, and every evidence bundle is passed through the redactor in
 * `dogfood-m3-redaction.mjs` so a failing git invocation cannot leak the
 * token into `docs/evidence/` (covered by
 * `tests/security/m3-dogfood-redaction.test.ts`).
 *
 * The git/ledger helpers below intentionally mirror
 * `tests/e2e/m3-remote-collaboration.test.ts`. They are duplicated rather
 * than shared because this driver is a dependency-light .mjs running
 * against the built `dist/` artifacts while the e2e suite deliberately
 * exercises the TypeScript sources; keep both copies in sync when the
 * fixture shapes change.
 *
 * Prerequisites (environment, with a gitignored repo-root `.env` fallback):
 *   HARNESS_DOGFOOD_<P>_TOKEN                 PAT with repo scope
 *   HARNESS_DOGFOOD_<P>_REPO                  owner/repo disposable repository
 *   HARNESS_DOGFOOD_<P>_COORDINATOR_IDENTITY  platform login allowed to push
 *                                             the protected Control Ref
 *   HARNESS_DOGFOOD_<P>_REMOTE_URL (optional) explicit credentialed transport
 *                                             URL overriding the default
 *                                             template (the credential only
 *                                             ever reaches git transport)
 * where <P> is GITHUB, GITLAB or GITEE. The repository must have
 * `refs/heads/harness/control` protection configured so that ONLY the
 * coordinator identity may push it; when protection is not provable the run
 * is reported blocked, never completed.
 *
 * Usage: node scripts/dogfood-m3-platform.mjs --provider github [--out path]
 * Exits 2 with a blocked evidence bundle when prerequisites or protection
 * are missing; exits 1 on a failed step; exits 0 with a passed bundle.
 * The bundle never contains tokens, usernames or emails.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { createGitControlStoreAdapter } from "../adapters/vcs-git/dist/index.js";
import {
  buildManifest,
  canonicalizeJson,
  edgeShardRelativePath,
  eventShardRelativePath,
  harnessRootFor,
  replayLedger,
  sha256Hex,
} from "../packages/core/dist/index.js";
import {
  buildApprovalRequest,
  createCollaborationCoordinator,
  createNodeHttpsFetch,
  createOAuthSessionStore,
  createPlatformIdentityRegistry,
  resumeCollaborationCoordinator,
  SqliteCoordinatorProjection,
} from "../packages/runtime/dist/index.js";

import { redactSecrets } from "./dogfood-m3-redaction.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match === null || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
  }
}

loadDotEnvFile(join(repositoryRoot, ".env"));

// --- Arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const PROVIDERS = {
  github: {
    provider: "github",
    host: "github.com",
    api_base_url: "https://api.github.com",
    authorize_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    transportUrl: (token, repo) => `https://x-access-token:${token}@github.com/${repo}.git`,
  },
  gitlab: {
    provider: "gitlab",
    host: "gitlab.com",
    api_base_url: "https://gitlab.com/api/v4",
    authorize_url: "https://gitlab.com/oauth/authorize",
    token_url: "https://gitlab.com/oauth/token",
    transportUrl: (token, repo) => `https://oauth2:${token}@gitlab.com/${repo}.git`,
  },
  gitee: {
    provider: "gitee",
    host: "gitee.com",
    api_base_url: "https://gitee.com/api/v5",
    authorize_url: "https://gitee.com/oauth/authorize",
    token_url: "https://gitee.com/oauth/token",
    transportUrl: (token, repo) => `https://oauth2:${token}@gitee.com/${repo}.git`,
  },
};

const providerName = argValue("--provider");
const provider = PROVIDERS[providerName ?? ""];
if (provider === undefined) {
  console.error(
    "usage: node scripts/dogfood-m3-platform.mjs --provider github|gitlab|gitee [--out path]",
  );
  process.exit(2);
}

const ENV_PREFIX = `HARNESS_DOGFOOD_${provider.provider.toUpperCase()}_`;
const OUT_PATH =
  argValue("--out") ??
  join(repositoryRoot, "docs", "evidence", `m3-dogfood-${provider.provider}.json`);
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

// Prerequisites are read before any bundle write so the redactor always has
// the secret material, including on the prerequisites-missing blocked path.
const token = process.env[`${ENV_PREFIX}TOKEN`];
const repo = process.env[`${ENV_PREFIX}REPO`];
const coordinatorIdentity = process.env[`${ENV_PREFIX}COORDINATOR_IDENTITY`];
const TRANSPORT_URL =
  process.env[`${ENV_PREFIX}REMOTE_URL`] ??
  (token !== undefined && token !== "" && repo !== undefined && repo !== ""
    ? provider.transportUrl(token, repo)
    : undefined);

function writeBundle(bundle) {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const text = redactSecrets(`${JSON.stringify(bundle, null, 2)}\n`, [token, TRANSPORT_URL]);
  writeFileSync(OUT_PATH, text, "utf8");
  console.log(`evidence bundle written to ${OUT_PATH}`);
}

function blocked(reason, extra = {}) {
  writeBundle({
    provider: provider.provider,
    status: "blocked",
    reason,
    commit: HEAD,
    generated_at: new Date().toISOString(),
    ...extra,
  });
  process.exit(2);
}

// --- Prerequisites -----------------------------------------------------------

const missing = [
  ...(token === undefined || token === "" ? [`${ENV_PREFIX}TOKEN`] : []),
  ...(repo === undefined || repo === "" ? [`${ENV_PREFIX}REPO`] : []),
  ...(coordinatorIdentity === undefined || coordinatorIdentity === ""
    ? [`${ENV_PREFIX}COORDINATOR_IDENTITY`]
    : []),
];
if (missing.length > 0) {
  console.error(`missing prerequisites: ${missing.join(", ")}`);
  blocked("prerequisites_missing", { missing });
}

const REDIRECT_URI = "https://harness.example.com/oauth/callback";
const CANONICAL_REMOTE = `https://${provider.host}/${repo}`;

// --- Platform registry with the PAT token-endpoint substitution --------------

const realFetch = createNodeHttpsFetch({ timeout_ms: 30_000 });
const patFetch = (request) => {
  if (request.method === "POST" && request.url === provider.token_url) {
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({ access_token: token, token_type: "bearer" }),
    });
  }
  return realFetch(request);
};

const registry = createPlatformIdentityRegistry(
  [
    {
      provider: provider.provider,
      host: provider.host,
      api_base_url: provider.api_base_url,
      authorize_url: provider.authorize_url,
      token_url: provider.token_url,
      client_id: "dogfood-pat-substitution",
      redirect_uri: REDIRECT_URI,
      coordinator_identity: coordinatorIdentity,
    },
  ],
  {
    fetch: patFetch,
    sessions: createOAuthSessionStore({ now: () => new Date().toISOString() }),
    // No browser in CI: the authorize step is answered locally with the
    // session state, which the token-endpoint interception then exchanges.
    authorize: (url) => {
      const state = new URL(url).searchParams.get("state") ?? "";
      return Promise.resolve(`${REDIRECT_URI}?code=pat&state=${state}`);
    },
    now: () => new Date().toISOString(),
  },
);

// --- Scratch space -----------------------------------------------------------

const scratchRoot = realpathSync(
  mkdtempSync(join(tmpdir(), `harness-m3-dogfood-${provider.provider}-`)),
);
process.on("exit", () => {
  rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function git(cwd, ...gitArgs) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "gc.auto=0", ...gitArgs], {
    cwd,
    encoding: "utf8",
  });
}

function configureClone(clone) {
  git(clone, "config", "user.name", "Harness Dogfood");
  git(clone, "config", "user.email", "harness-dogfood@example.invalid");
  git(clone, "config", "commit.gpgsign", "false");
}

function cloneRemote(destination) {
  git(scratchRoot, "clone", TRANSPORT_URL, destination);
  configureClone(destination);
  return destination;
}

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** One fixture LedgerOperation manifest plus every shard byte it references. */
function ledgerOpFiles(input) {
  const month = input.committedAt.slice(0, 7);
  const manifest = buildManifest({
    ledger_operation_id: input.id,
    workflow_operation_id: `workflow_${input.id}`,
    attempt_id: `attempt_${input.id}`,
    baseline_commit: input.baseline,
    sequence: input.sequence,
    artifact_digests: [],
    edge_file: edgeShardRelativePath(month, input.id),
    event_file: eventShardRelativePath(month, input.id),
    edge_file_digest: sha256Hex(""),
    event_file_digest: sha256Hex(""),
    committed_at: input.committedAt,
  });
  return {
    [`.harness/ledger/operations/${input.id}.json`]: `${canonicalizeJson(manifest)}\n`,
    [`.harness/${manifest.edge_file}`]: "",
    [`.harness/${manifest.event_file}`]: "",
  };
}

const PROJECT_ID = `project_dogfood_${provider.provider}`;
const TARGET_REF = "refs/heads/main";
const OPERATION_A = "op_dogfood_a";
const OPERATION_B = "op_dogfood_b";
const BASELINE_DIGEST = "0".repeat(64);

const steps = [];
function recordStep(name, evidence) {
  steps.push({ name, ...evidence });
  console.log(`[${provider.provider}] ${name}: ${evidence.status}`);
}

// --- Run ---------------------------------------------------------------------

try {
  // discover + authenticate (probe once to learn the derived principal id).
  const discovery = await registry.discover(CANONICAL_REMOTE);
  if (discovery.status !== "resolved") {
    throw new Error(`discover failed: ${JSON.stringify(discovery)}`);
  }
  const probe = await registry.authenticate({
    provider: provider.provider,
    host: provider.host,
    repository_id: repo,
    principal_id: "principal_dogfood_probe",
  });
  if (probe.status !== "authenticated") {
    throw new Error(`authenticate failed: ${JSON.stringify(probe.failure)}`);
  }
  const operator = {
    principal_id: probe.snapshot.principal_id,
    client_instance_id: "instance_dogfood",
  };
  recordStep("authenticate", {
    status: "authenticated",
    permission: probe.snapshot.permission,
    observed_at: probe.snapshot.observed_at,
  });

  // Fail-closed protection gate: unprovable protection blocks the run.
  const protection = await registry.inspectControlRefProtection({
    provider: provider.provider,
    host: provider.host,
    repository_id: repo,
    control_ref: "refs/heads/harness/control",
  });
  if (protection.status !== "protected") {
    console.error("control ref protection is not provable; refusing to connect");
    blocked("control_ref_unprotected", {
      protection,
      steps,
    });
  }
  recordStep("control_ref_protection", { status: "protected" });

  // Seed the disposable repository with one baseline LedgerOperation.
  const seed = join(scratchRoot, "seed");
  try {
    cloneRemote(seed);
  } catch {
    // An empty disposable repository has no default branch to clone yet.
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-b", "main");
    configureClone(seed);
    git(seed, "remote", "add", "origin", TRANSPORT_URL);
  }
  const seedTime = new Date().toISOString();
  writeFiles(seed, {
    "README.md": "disposable m3 dogfood repository\n",
    ...ledgerOpFiles({
      id: "operation_base_1",
      sequence: 1,
      baseline: BASELINE_DIGEST,
      committedAt: seedTime,
    }),
  });
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "m3 dogfood baseline");
  git(seed, "push", "origin", "main");
  const baseline = git(seed, "rev-parse", "HEAD").trim();
  recordStep("seed", { status: "pushed", baseline });

  // Production stack: Git control store + SQLite projection + coordinator.
  const controlStore = createGitControlStoreAdapter({
    remote: TRANSPORT_URL,
    mirror_root: join(scratchRoot, "mirror", "mirror"),
  });
  const projectionPath = join(scratchRoot, "db", "coordinator.sqlite");
  mkdirSync(dirname(projectionPath), { recursive: true });
  const projection = new SqliteCoordinatorProjection(projectionPath);
  let clockOffsetMs = 0;
  const deps = {
    platform: registry,
    controlStore,
    projection,
    now: () => new Date(Date.now() + clockOffsetMs).toISOString(),
  };
  const coordinator = createCollaborationCoordinator(deps);

  const connect = await coordinator.execute(
    {
      kind: "connect",
      command_id: "command_connect_dogfood",
      project_id: PROJECT_ID,
      canonical_remote: CANONICAL_REMOTE,
      target_ref: TARGET_REF,
      coordinator_origin: "https://harness.example.com",
      policy_digest: sha256Hex("m3 dogfood policy"),
    },
    operator,
  );
  if (connect.status === "failed" && connect.failure.code === "control_ref_unprotected") {
    blocked("control_ref_unprotected", { steps });
  }
  if (connect.status !== "connected") {
    throw new Error(`connect failed: ${JSON.stringify(connect)}`);
  }
  recordStep("connect", { status: "connected", replayed: connect.replayed });

  // Two replicas hold leases for different operations in parallel.
  const acquireLease = async (commandId, operationId) => {
    const outcome = await coordinator.execute(
      {
        kind: "acquire_operation_lease",
        command_id: commandId,
        project_id: PROJECT_ID,
        operation_id: operationId,
      },
      operator,
    );
    if (outcome.status !== "lease" || outcome.lease.state !== "granted") {
      throw new Error(`lease failed: ${JSON.stringify(outcome)}`);
    }
    return outcome.lease;
  };
  const leaseA = await acquireLease("command_lease_a", OPERATION_A);
  const leaseB = await acquireLease("command_lease_b", OPERATION_B);
  recordStep("acquire_leases", {
    status: "granted",
    fencing_tokens: [leaseA.fencing_token, leaseB.fencing_token],
  });

  // Both candidates fork the same post-connect Target head at Ledger
  // sequence 2, like two replicas preparing in parallel.
  const lsRemote = (ref) => git(scratchRoot, "ls-remote", TRANSPORT_URL, ref).split(/\s+/u)[0];
  const forkPoint = lsRemote(TARGET_REF);
  const stageCandidate = (operationId, ledgerOperationId) => {
    const work = cloneRemote(join(scratchRoot, `work-${operationId}`));
    git(work, "checkout", "-b", `work-${operationId}`, forkPoint);
    writeFiles(
      work,
      ledgerOpFiles({
        id: ledgerOperationId,
        sequence: 2,
        baseline,
        committedAt: new Date().toISOString(),
      }),
    );
    git(work, "add", "-A");
    git(work, "commit", "-m", `m3 dogfood candidate ${operationId}`);
    const head = git(work, "rev-parse", "HEAD").trim();
    git(work, "push", "origin", `HEAD:refs/heads/harness/candidate/${operationId}`);
    return head;
  };
  const candidateA = stageCandidate(OPERATION_A, "operation_dogfood_a2");
  const candidateB = stageCandidate(OPERATION_B, "operation_dogfood_b2");

  const publish = (commandId, operationId, candidateCommit, fencingToken) =>
    coordinator.execute(
      {
        kind: "publish_operation_candidate",
        command_id: commandId,
        project_id: PROJECT_ID,
        operation_id: operationId,
        candidate_commit: candidateCommit,
        fencing_token: fencingToken,
      },
      operator,
    );

  // A stale fencing token is fenced before any Operation Ref CAS.
  const fenced = await publish(
    "command_publish_fenced",
    OPERATION_A,
    candidateA,
    leaseA.fencing_token + 100,
  );
  if (fenced.status !== "failed" || fenced.failure.code !== "lease_fenced") {
    throw new Error(`expected the stale token to be fenced: ${JSON.stringify(fenced)}`);
  }
  const fencedRef = git(
    scratchRoot,
    "ls-remote",
    TRANSPORT_URL,
    `refs/heads/operation/${OPERATION_A}`,
  ).trim();
  if (fencedRef !== "") {
    throw new Error("the fenced publish must not create the operation ref");
  }
  recordStep("stale_token_fenced", { status: "failed", code: fenced.failure.code });

  const publishedA = await publish(
    "command_publish_a",
    OPERATION_A,
    candidateA,
    leaseA.fencing_token,
  );
  if (publishedA.status !== "published") {
    throw new Error(`publish A failed: ${JSON.stringify(publishedA)}`);
  }
  const publishedB = await publish(
    "command_publish_b",
    OPERATION_B,
    candidateB,
    leaseB.fencing_token,
  );
  if (publishedB.status !== "published") {
    throw new Error(`publish B failed: ${JSON.stringify(publishedB)}`);
  }
  recordStep("publish_candidates", {
    status: "published",
    head_a: publishedA.head_oid,
    head_b: publishedB.head_oid,
  });

  // Remote approval: the ApprovalRequest is an in-memory fixture (the Local
  // Kernel side of the loop is covered by the e2e suite); the requester is a
  // distinct fixture principal so the operator is not approving its own
  // request. The decision is written by the production coordinator to the
  // real protected Control Ref.
  const request = buildApprovalRequest({
    requestId: "approval_request_dogfood",
    workflowOperationId: "workflow_operation_dogfood_a2",
    objectId: "requirement_baseline",
    objectType: "RequirementBaseline",
    objectDigest: sha256Hex("m3 dogfood object"),
    baselineDigest: sha256Hex("m3 dogfood baseline"),
    policyDigest: sha256Hex("m3 dogfood policy"),
    impactPath: ["intent_dogfood"],
    risk: "medium",
    reason: "approve the requirement baseline",
    allowedDecisions: ["approve", "reject", "defer"],
    createdAt: new Date().toISOString(),
    resumePhase: "capture",
    proposedBy: "agent:harness",
    requesterPrincipal: {
      principal_id: "principal_dogfood_requester_fixture",
      principal_snapshot_digest: sha256Hex("m3 dogfood requester"),
    },
  });
  const coordinatorWithRequests = createCollaborationCoordinator({
    ...deps,
    readApprovalRequest: (input) =>
      Promise.resolve(input.request_id === request.request_id ? request : undefined),
  });
  const approval = await coordinatorWithRequests.execute(
    {
      kind: "submit_remote_approval",
      command_id: "command_decision_dogfood",
      project_id: PROJECT_ID,
      request_id: request.request_id,
      decision: "approve",
    },
    operator,
  );
  if (approval.status !== "remote_approval") {
    throw new Error(`remote approval failed: ${JSON.stringify(approval)}`);
  }
  recordStep("remote_approval", { status: "remote_approval", decision: "approve" });

  // Integrate A first: no Ledger fork has landed yet, so no re-sequencing.
  const integrate = async (commandTag, operationId) => {
    const prepare = await coordinatorWithRequests.execute(
      {
        kind: "prepare_integration",
        command_id: `command_prepare_${commandTag}`,
        project_id: PROJECT_ID,
        operation_id: operationId,
      },
      operator,
    );
    if (prepare.status !== "prepared") {
      throw new Error(`prepare ${commandTag} failed: ${JSON.stringify(prepare)}`);
    }
    const accept = await coordinatorWithRequests.execute(
      {
        kind: "accept_integration",
        command_id: `command_accept_${commandTag}`,
        project_id: PROJECT_ID,
        integration_id: prepare.integration_record.integration_id,
        expected_target_commit: prepare.integration_record.expected_target_commit,
      },
      operator,
    );
    if (accept.status !== "accepted") {
      throw new Error(`accept ${commandTag} failed: ${JSON.stringify(accept)}`);
    }
    return prepare.integration_record;
  };
  const integrationA = await integrate("a", OPERATION_A);
  if (integrationA.ledger_sequence_rewrites.length !== 0) {
    throw new Error(
      `integration A must not rewrite sequences: ${JSON.stringify(integrationA.ledger_sequence_rewrites)}`,
    );
  }
  recordStep("integration_a", {
    status: "accepted",
    integration_id: integrationA.integration_id,
    ledger_sequence_rewrites: [],
  });

  // §21.4 exercise: B forked the same Ledger sequence 2 as A, so its clean
  // integration must deterministically re-sequence the candidate (2 → 4)
  // before the Target CAS.
  const integratedA = lsRemote(TARGET_REF);
  const integrationB = await integrate("b", OPERATION_B);
  if (integrationB.expected_target_commit !== integratedA) {
    throw new Error("integration B must re-validate against the drifted Target head");
  }
  const rewrite = integrationB.ledger_sequence_rewrites.find(
    (entry) => entry.ledger_operation_id === "operation_dogfood_b2",
  );
  if (rewrite === undefined || rewrite.old_sequence !== 2 || rewrite.new_sequence !== 4) {
    throw new Error(
      `expected B to be re-sequenced 2 -> 4: ${JSON.stringify(integrationB.ledger_sequence_rewrites)}`,
    );
  }
  recordStep("integration_b_resequenced", {
    status: "accepted",
    integration_id: integrationB.integration_id,
    ledger_sequence_rewrites: integrationB.ledger_sequence_rewrites,
  });

  // Target CAS audit: the accepted Target replays as a contiguous Ledger
  // starting at sequence 1 (seed, A, A's Integration record, re-sequenced B,
  // B's Integration record).
  const acceptedClone = cloneRemote(join(scratchRoot, "accepted"));
  const sequences = replayLedger(harnessRootFor(acceptedClone)).operations.map(
    (operation) => operation.manifest.sequence,
  );
  const contiguous = sequences.every((sequence, index) => sequence === index + 1);
  if (!contiguous || sequences.length !== 5) {
    throw new Error(`accepted ledger does not replay contiguously: ${JSON.stringify(sequences)}`);
  }
  recordStep("target_audit", { status: "contiguous", sequences });

  const releaseLease = async (commandId, leaseId) => {
    const outcome = await coordinatorWithRequests.execute(
      {
        kind: "release_operation_lease",
        command_id: commandId,
        project_id: PROJECT_ID,
        lease_id: leaseId,
      },
      operator,
    );
    if (outcome.status !== "lease" || outcome.lease.state !== "released") {
      throw new Error(`release failed: ${JSON.stringify(outcome)}`);
    }
  };
  await releaseLease("command_release_a", leaseA.lease_id);
  await releaseLease("command_release_b", leaseB.lease_id);
  recordStep("release_leases", { status: "released" });

  // Advance the host clock past the Lease TTL: disconnect refuses while any
  // granted Lease record is still live, and sleeping five minutes in CI is
  // not an option (the clock is an injected coordinator dependency).
  clockOffsetMs = 6 * 60 * 1000;
  const disconnect = await coordinatorWithRequests.execute(
    { kind: "disconnect", command_id: "command_disconnect_dogfood", project_id: PROJECT_ID },
    operator,
  );
  if (disconnect.status !== "disconnected") {
    throw new Error(`disconnect failed: ${JSON.stringify(disconnect)}`);
  }
  recordStep("disconnect", { status: "disconnected", clock_advanced_ms: clockOffsetMs });

  // Rebuild the disposable projection from Git: identical digest twice.
  const digestBeforeDelete = projection.projectionDigest();
  projection.close();
  rmSync(projectionPath);
  const rebuilt = new SqliteCoordinatorProjection(projectionPath);
  const resumed = await resumeCollaborationCoordinator(
    { ...deps, projection: rebuilt },
    PROJECT_ID,
  );
  if (resumed.status !== "ready") {
    throw new Error(`rebuild failed: ${JSON.stringify(resumed)}`);
  }
  const rebuiltDigest = rebuilt.projectionDigest();
  if (rebuiltDigest !== digestBeforeDelete) {
    throw new Error("projection rebuild is not deterministic");
  }
  const control = await controlStore.readControl({
    project_id: PROJECT_ID,
    control_ref: "refs/heads/harness/control",
  });
  if (control.status !== "ok") {
    throw new Error("control ref unreadable after disconnect");
  }
  recordStep("projection_rebuild", {
    status: "ready",
    projection_digest: rebuiltDigest,
    control_records: control.snapshot.control_records.length,
  });
  rebuilt.close();

  writeBundle({
    provider: provider.provider,
    status: "passed",
    commit: HEAD,
    generated_at: new Date().toISOString(),
    deviations: [
      "browser OAuth replaced by a PAT via token-endpoint interception; identity, permission and protection queries hit the real platform API",
      "remote approval request is an in-memory fixture with a distinct fixture requester (the Local Kernel side is covered by the e2e suite)",
      "host clock advanced 6 minutes before disconnect instead of sleeping out the lease TTL",
    ],
    steps,
  });
} catch (error) {
  writeBundle({
    provider: provider.provider,
    status: "failed",
    reason: error instanceof Error ? error.message : String(error),
    commit: HEAD,
    generated_at: new Date().toISOString(),
    steps,
  });
  process.exit(1);
}
