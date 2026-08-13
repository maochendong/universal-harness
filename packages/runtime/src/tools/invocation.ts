import { contentDigest } from "@universal-harness-internal/core";

import { grantDenialReason, type CapabilityGrant } from "../policy/capability-grant.js";
import type { PolicyAction } from "../policy/action.js";
import { redactSecretValues, resolveSecretParameters } from "../secrets/environment-reference.js";
import {
  requestDigest,
  type ActionIntentJournal,
  type ActionIntentRecord,
} from "./action-intent.js";
import { ToolError, resourceMatchesPatterns, type ToolDefinition } from "./definition.js";
import type { RegisteredTool, ToolRegistry } from "./registry.js";

/**
 * Three-phase invocation pipeline (design 13.5).
 *
 * Before: registration, input schema, phase grant, resource scope, parameter
 * bounds, capability grant, approval binding, quota and idempotency key are
 * all validated; a violation throws a typed ToolError before the handler can
 * run, so no authority change and no side effect is ever produced by a
 * rejected call.
 *
 * During: the handler runs under the declared timeout; implementation errors
 * become structured ToolErrors.
 *
 * After: the output is schema-validated, declared fields and any resolved
 * secret values are redacted, and the normalized evidence carries only
 * digests and redacted content. External side effects open an Action Intent
 * before the call and close it completed or uncertain afterwards; an
 * uncertain result is never blindly retried.
 */
export interface ToolInvocationRequest {
  /** Caller-minted stable id, unique per logical call. */
  readonly intent_id: string;
  readonly tool: string;
  readonly version?: string;
  readonly phase: string;
  readonly resource?: string;
  /** Plain-JSON parameters; declared secret parameters hold `{ $env: NAME }`. */
  readonly parameters: Record<string, unknown>;
  readonly approval_digest?: string;
  /** Mandatory for tools with an external side-effect class. */
  readonly idempotency_key?: string;
}

export interface ToolInvocationContext {
  /** Intent journal; required when invoking external side-effect tools. */
  readonly journal?: ActionIntentJournal;
  /** Active task capability grant the invocation must stay within. */
  readonly grant?: CapabilityGrant;
  /**
   * Approval binding check: the approval must cover exactly this normalized
   * request. A stale or drifted approval fails here, never silently.
   */
  readonly validateApproval?: (approvalDigest: string, requestDigest: string) => boolean;
  /** Environment for secret resolution; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ToolInvocationEvidence {
  readonly tool: string;
  readonly request_digest: string;
  /** Redacted, schema-validated output; never contains secret values. */
  readonly output: unknown;
  readonly output_digest: string;
  readonly attempts: number;
  /** True when declared fields or secret values were redacted. */
  readonly redacted: boolean;
  /** True when a completed intent was replayed without re-executing. */
  readonly replayed: boolean;
  /** The intent record for external side-effect calls, else null. */
  readonly intent: ActionIntentRecord | null;
}

function toolKey(definition: ToolDefinition): string {
  return `${definition.name}@${definition.version}`;
}

function requireEntry(registry: ToolRegistry, request: ToolInvocationRequest): RegisteredTool {
  const entry = registry.get(request.tool, request.version);
  if (entry === undefined) {
    throw new ToolError(
      "unknown_tool",
      `tool "${request.tool}${request.version === undefined ? "" : `@${request.version}`}" is ` +
        "not registered; every capability, including provider-exposed MCP tools, must be " +
        "registered as an ordinary ToolDefinition before use",
    );
  }
  return entry;
}

function checkPhase(definition: ToolDefinition, phase: string): void {
  if (!definition.allowed_phases.includes(phase)) {
    throw new ToolError(
      "phase_not_allowed",
      `tool ${definition.name} may not run in phase "${phase}"; allowed: ${definition.allowed_phases.join(", ")}`,
    );
  }
}

function checkResource(definition: ToolDefinition, resource: string | undefined): void {
  if (definition.resource_patterns.length === 0) {
    if (resource !== undefined) {
      throw new ToolError(
        "resource_not_allowed",
        `tool ${definition.name} declares no resource scope but was given "${resource}"`,
      );
    }
    return;
  }
  if (resource === undefined || !resourceMatchesPatterns(definition.resource_patterns, resource)) {
    throw new ToolError(
      "resource_not_allowed",
      `resource "${resource ?? ""}" is outside the declared scope of tool ${definition.name}`,
    );
  }
}

function checkParameterBounds(
  definition: ToolDefinition,
  parameters: Record<string, unknown>,
): void {
  for (const [key, allowed] of Object.entries(definition.parameter_bounds)) {
    const value = parameters[key];
    if (
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
      !allowed.includes(value)
    ) {
      throw new ToolError(
        "parameter_out_of_bounds",
        `parameter ${definition.name}.${key}=${JSON.stringify(value)} is outside the declared bounds`,
      );
    }
  }
}

function checkGrant(
  definition: ToolDefinition,
  request: ToolInvocationRequest,
  grant?: CapabilityGrant,
): void {
  if (grant === undefined) return;
  const action: PolicyAction = {
    kind: "invoke_tool",
    actor: "harness",
    actor_kind: "harness",
    origin: "control_plane",
    phase: request.phase,
    resource: definition.name,
    parameters: request.parameters,
    risk: definition.risk,
  };
  const reason = grantDenialReason(grant, action);
  if (reason !== undefined) {
    throw new ToolError("grant_violation", `invocation of ${definition.name} denied: ${reason}`);
  }
}

function checkApproval(
  definition: ToolDefinition,
  request: ToolInvocationRequest,
  digest: string,
  context: ToolInvocationContext,
): void {
  if (!definition.requires_approval) return;
  if (request.approval_digest === undefined) {
    throw new ToolError(
      "approval_required",
      `tool ${definition.name} requires an approval for ${definition.risk} risk invocations`,
    );
  }
  if (context.validateApproval === undefined) {
    throw new ToolError(
      "approval_invalid",
      `tool ${definition.name} requires an approval but no approval validator is bound`,
    );
  }
  if (!context.validateApproval(request.approval_digest, digest)) {
    throw new ToolError(
      "approval_invalid",
      `approval ${request.approval_digest} does not bind this normalized request; ` +
        "a stale or drifted approval never authorizes an invocation",
    );
  }
  if (
    context.grant !== undefined &&
    !context.grant.approval_digests.includes(request.approval_digest)
  ) {
    throw new ToolError(
      "approval_invalid",
      `approval ${request.approval_digest} is outside the approvals granted to this task`,
    );
  }
}

class TimeoutSignal extends Error {
  constructor() {
    super("tool invocation timed out");
    this.name = "TimeoutSignal";
  }
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutSignal());
    }, timeoutMs);
    run(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function redactOutput(
  definition: ToolDefinition,
  output: unknown,
  secrets: ReadonlyMap<string, string>,
): { output: unknown; redacted: boolean } {
  let redacted = output;
  let changed = false;
  if (
    definition.redacted_output_fields.length > 0 &&
    typeof redacted === "object" &&
    redacted !== null &&
    !Array.isArray(redacted)
  ) {
    const clone: Record<string, unknown> = { ...(redacted as Record<string, unknown>) };
    for (const field of definition.redacted_output_fields) {
      if (field in clone) {
        clone[field] = "[redacted]";
        changed = true;
      }
    }
    redacted = clone;
  }
  const scrubbed = redactSecretValues(redacted, secrets);
  if (scrubbed !== redacted) changed = true;
  return { output: scrubbed, redacted: changed };
}

function evidenceOf(
  definition: ToolDefinition,
  digest: string,
  output: unknown,
  attempts: number,
  redacted: boolean,
  replayed: boolean,
  intent: ActionIntentRecord | null,
): ToolInvocationEvidence {
  return {
    tool: toolKey(definition),
    request_digest: digest,
    output,
    output_digest: contentDigest(output ?? null),
    attempts,
    redacted,
    replayed,
    intent,
  };
}

/**
 * Invoke a registered tool through the three-phase pipeline. Deterministic
 * given the same registry, journal and handler behavior; never persists
 * secret values, and never re-executes a completed idempotency key.
 */
export async function invokeTool(
  registry: ToolRegistry,
  request: ToolInvocationRequest,
  context: ToolInvocationContext = {},
): Promise<ToolInvocationEvidence> {
  const entry = requireEntry(registry, request);
  const { definition } = entry;

  const secrets = resolveSecretParameters(
    request.parameters,
    definition.secret_parameters,
    context.env ?? process.env,
  );
  const digest = requestDigest(toolKey(definition), request.parameters, request.resource);

  const input = entry.validateInput(secrets.parameters);
  if (!input.valid) {
    throw new ToolError("invalid_input", `input for tool ${definition.name} failed its schema`, {
      issues: input.errors.map((issue) => `${issue.instancePath}: ${issue.message}`),
    });
  }

  checkPhase(definition, request.phase);
  checkResource(definition, request.resource);
  checkParameterBounds(definition, secrets.parameters);
  checkGrant(definition, request, context.grant);
  checkApproval(definition, request, digest, context);

  const external = definition.side_effect_class === "external";
  let journal: ActionIntentJournal | undefined;
  if (external) {
    if (request.idempotency_key === undefined || request.idempotency_key === "") {
      throw new ToolError(
        "idempotency_key_required",
        `tool ${definition.name} has an external side-effect class; an idempotency key is required`,
      );
    }
    if (context.journal === undefined) {
      throw new ToolError(
        "idempotency_key_required",
        `tool ${definition.name} has an external side-effect class; an intent journal is required`,
      );
    }
    journal = context.journal;
    const existing = journal.findByIdempotencyKey(toolKey(definition), request.idempotency_key);
    if (existing !== undefined) {
      if (existing.status === "completed") {
        return evidenceOf(
          definition,
          digest,
          journal.outputOf(existing.intent_id) ?? null,
          0,
          false,
          true,
          existing,
        );
      }
      throw new ToolError(
        "reconciliation_required",
        `idempotency key "${request.idempotency_key}" has an unresolved intent ` +
          `${existing.intent_id} (${existing.status}); reconcile before retrying -- a timeout ` +
          "never implies the external action did not happen",
      );
    }
  }

  registry.consumeQuota(definition);
  const intent =
    journal === undefined
      ? null
      : journal.open({
          intent_id: request.intent_id,
          tool: toolKey(definition),
          request_digest: digest,
          ...(request.resource === undefined ? {} : { resource: request.resource }),
          ...(request.approval_digest === undefined
            ? {}
            : { approval_digest: request.approval_digest }),
          idempotency_key: request.idempotency_key as string,
        });

  const retryable = definition.retry_class !== "none";
  const maxAttempts = retryable ? 1 + definition.max_retries : 1;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const raw = await withTimeout(
        (signal) =>
          Promise.resolve(
            entry.handler({
              parameters: secrets.parameters,
              ...(request.resource === undefined ? {} : { resource: request.resource }),
              signal,
            }),
          ),
        definition.timeout_ms,
      );
      const output = entry.validateOutput(raw);
      if (!output.valid) {
        // The provider responded: the external effect applied, so the intent
        // completes; the protocol violation itself is not retryable blindly.
        if (intent !== null && journal !== undefined) {
          journal.complete(intent, contentDigest(raw ?? null));
        }
        throw new ToolError(
          "invalid_output",
          `output of tool ${definition.name} failed its schema`,
          { issues: output.errors.map((issue) => `${issue.instancePath}: ${issue.message}`) },
        );
      }
      const { output: redacted, redacted: wasRedacted } = redactOutput(
        definition,
        raw,
        secrets.values,
      );
      const closed =
        intent !== null && journal !== undefined
          ? journal.complete(intent, contentDigest(redacted ?? null))
          : null;
      if (closed !== null && journal !== undefined) {
        journal.rememberOutput(closed.intent_id, redacted);
      }
      return evidenceOf(definition, digest, redacted, attempts, wasRedacted, false, closed);
    } catch (error) {
      if (error instanceof ToolError && error.kind === "invalid_output") throw error;
      const timedOut = error instanceof TimeoutSignal;
      if (external) {
        // The provider may have applied the effect; never retry blindly.
        if (intent !== null && journal !== undefined) journal.markUncertain(intent);
        throw new ToolError(
          "uncertain_result",
          `tool ${definition.name} ${timedOut ? "timed out" : "failed"} after the external ` +
            "side effect may have been applied; the intent stays uncertain until reconciled",
          { intent_id: request.intent_id },
        );
      }
      if (timedOut) {
        if (retryable && attempts < maxAttempts) continue;
        throw new ToolError(
          "timeout",
          `tool ${definition.name} exceeded its timeout of ${String(definition.timeout_ms)}ms`,
          { attempts },
        );
      }
      if (retryable && attempts < maxAttempts) continue;
      const message = redactSecretValues(
        error instanceof Error ? error.message : String(error),
        secrets.values,
      );
      throw new ToolError("tool_failed", `tool ${definition.name} failed: ${message}`, {
        attempts,
      });
    }
  }
}
