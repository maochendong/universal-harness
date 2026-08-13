import {
  compileSchemaValidator,
  type CompiledSchemaValidator,
} from "@universal-harness-internal/core";

import {
  ToolError,
  compareToolVersions,
  normalizeToolDefinition,
  type ToolDefinition,
} from "./definition.js";

/**
 * Tool Registry (design 13.5; port sketch in design 18 `ToolRegistryPort`).
 * Holds versioned, immutable descriptors with their compiled input/output
 * validators and provider handlers, and tracks the per-run invocation quota.
 * Registration is the only way a capability becomes invocable; re-registering
 * identical content is idempotent, re-registering a name+version with
 * different content is a typed refusal.
 */
export interface ToolHandlerInput {
  /** Validated parameters with declared secret references already resolved. */
  readonly parameters: Record<string, unknown>;
  readonly resource?: string;
  readonly signal: AbortSignal;
}

export type ToolHandler = (input: ToolHandlerInput) => unknown | Promise<unknown>;

export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
  readonly validateInput: CompiledSchemaValidator;
  readonly validateOutput: CompiledSchemaValidator;
}

export interface ToolInvocationSummary {
  readonly tool: string;
  readonly version: string;
  readonly invocations: number;
  readonly quota: number;
}

function keyOf(name: string, version: string): string {
  return `${name}@${version}`;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Map<string, RegisteredTool>>();
  private readonly invocations = new Map<string, number>();

  /**
   * Register one versioned descriptor with its handler. The descriptor is
   * normalized and both schemas compiled up front, so an illegal definition
   * fails here, never at invocation time. Returns the stored definition.
   */
  register(raw: unknown, handler: ToolHandler): ToolDefinition {
    const definition = normalizeToolDefinition(raw);
    if (typeof handler !== "function") {
      throw new ToolError("invalid_definition", `tool ${definition.name} requires a handler`);
    }
    let validateInput: CompiledSchemaValidator;
    let validateOutput: CompiledSchemaValidator;
    try {
      validateInput = compileSchemaValidator(definition.input_schema);
      validateOutput = compileSchemaValidator(definition.output_schema);
    } catch (error) {
      throw new ToolError(
        "invalid_definition",
        `tool ${definition.name} declares a schema that does not compile: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const entry: RegisteredTool = { definition, handler, validateInput, validateOutput };
    let versions = this.tools.get(definition.name);
    if (versions === undefined) {
      versions = new Map<string, RegisteredTool>();
      this.tools.set(definition.name, versions);
    }
    const existing = versions.get(definition.version);
    if (existing !== undefined) {
      if (existing.definition.digest !== definition.digest) {
        throw new ToolError(
          "invalid_definition",
          `tool ${keyOf(definition.name, definition.version)} is already registered with ` +
            "different content; descriptors are immutable",
        );
      }
      return existing.definition;
    }
    versions.set(definition.version, entry);
    return definition;
  }

  /**
   * Look up a registered tool. Without an explicit version the highest
   * registered version wins, by deterministic semver ordering.
   */
  get(name: string, version?: string): RegisteredTool | undefined {
    const versions = this.tools.get(name);
    if (versions === undefined) return undefined;
    if (version !== undefined) return versions.get(version);
    const ordered = [...versions.keys()].sort(compareToolVersions);
    const latest = ordered[ordered.length - 1];
    return latest === undefined ? undefined : versions.get(latest);
  }

  /** All registered descriptors, sorted by name then version. */
  list(): ToolDefinition[] {
    return [...this.tools.values()]
      .flatMap((versions) => [...versions.values()])
      .map((entry) => entry.definition)
      .sort((left, right) =>
        left.name === right.name
          ? compareToolVersions(left.version, right.version)
          : left.name < right.name
            ? -1
            : 1,
      );
  }

  quotaRemaining(definition: ToolDefinition): number {
    const used = this.invocations.get(keyOf(definition.name, definition.version)) ?? 0;
    return definition.max_invocations_per_run - used;
  }

  /** Consume one quota unit; throws quota_exceeded when the run quota is spent. */
  consumeQuota(definition: ToolDefinition): void {
    if (this.quotaRemaining(definition) <= 0) {
      throw new ToolError(
        "quota_exceeded",
        `tool ${keyOf(definition.name, definition.version)} exhausted its per-run quota of ` +
          `${String(definition.max_invocations_per_run)}`,
      );
    }
    const key = keyOf(definition.name, definition.version);
    this.invocations.set(key, (this.invocations.get(key) ?? 0) + 1);
  }

  /** Per-tool invocation counts for the ToolRegistryPort summary. */
  invocationSummaries(): ToolInvocationSummary[] {
    return this.list().map((definition) => ({
      tool: definition.name,
      version: definition.version,
      invocations: this.invocations.get(keyOf(definition.name, definition.version)) ?? 0,
      quota: definition.max_invocations_per_run,
    }));
  }
}
