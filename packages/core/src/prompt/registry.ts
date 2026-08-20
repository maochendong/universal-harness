import {
  PromptContractError,
  promptContractDigest,
  registeredOutputSchemaDigest,
} from "./contracts.js";
import { PromptContractSchema, type PromptContract } from "../schema/prompt.js";
import { compileSchemaValidator } from "../schema/validator.js";

/**
 * The read-only PromptContractRegistry (prompt governance addendum design
 * 4/5.1). Domains register static, versioned contracts at composition time;
 * the registry freezes on construction and offers no runtime mutation API.
 * The same `(contract_id, version)` registering different content fails
 * startup — “same version, amended content” is never a compatible update.
 * Resolution is exact: a port/purpose/prompt_version selector maps to exactly
 * one contract id/version/digest/output schema, and unknown or ambiguous
 * selectors fail closed with `prompt_contract_version_mismatch`.
 */
export class PromptRegistryError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "PromptRegistryError";
    this.kind = kind;
  }
}

/** The selector compilers use: the human-readable alias plus the port scope. */
export interface PromptContractSelector {
  readonly port_id: string;
  readonly purpose?: string;
  readonly prompt_version: string;
}

/** The contract identity fields a binding pins (addendum design 5.2). */
export interface PromptContractBinding {
  readonly prompt_contract_id: string;
  readonly prompt_contract_version: string;
  readonly prompt_contract_digest: string;
  readonly output_schema_digest: string;
}

/** The resolved contract plus the output schema identity it compiles against. */
export interface PromptContractResolution extends PromptContractBinding {
  readonly output_schema_id: string;
}

export interface PromptContractResolver {
  resolve(selector: PromptContractSelector): PromptContractResolution;
}

export interface PromptContractRegistration {
  readonly contract: PromptContract;
  /** Human-readable aliases (`prompt_version` in bindings) for this contract. */
  readonly prompt_versions: readonly string[];
}

export interface PromptContractRegistry extends PromptContractResolver {
  readonly contracts: readonly PromptContract[];
}

interface ContractEntry {
  readonly contract: PromptContract;
  readonly promptVersions: readonly string[];
}

const validatePromptContract = compileSchemaValidator(PromptContractSchema);

function contractKey(contract: PromptContract): string {
  return `${contract.contract_id}@${contract.version}`;
}

function scopeOf(contract: PromptContract): string {
  return `${contract.port_id}:${contract.purpose ?? ""}`;
}

export function createPromptContractRegistry(
  registrations: readonly PromptContractRegistration[],
): PromptContractRegistry {
  const entries = new Map<string, ContractEntry>();
  // Aliases are scoped by port/purpose: two grounded purposes may share one
  // alias string, but one scope may never map an alias to two contracts.
  const aliases = new Map<string, string>();

  for (const registration of registrations) {
    const contract = registration.contract;
    const validation = validatePromptContract(contract);
    if (!validation.valid) {
      throw new PromptRegistryError(
        "invalid_contract",
        `prompt contract ${contract.contract_id} failed its schema: ${validation.errors
          .map((error) => `${error.instancePath}: ${error.message}`)
          .join("; ")}`,
      );
    }
    const outputSchemaDigest = registeredOutputSchemaDigest(contract.output_schema_id);
    if (contract.output_schema_digest !== outputSchemaDigest) {
      throw new PromptRegistryError(
        "output_schema_digest_mismatch",
        `prompt contract ${contract.contract_id} pins output schema digest ${contract.output_schema_digest}, but the registered ${contract.output_schema_id} document digests to ${outputSchemaDigest}`,
      );
    }
    const contractContent: Record<string, unknown> = { ...contract };
    delete contractContent["contract_digest"];
    const expectedDigest = promptContractDigest(
      contractContent as Omit<PromptContract, "contract_digest">,
    );
    if (contract.contract_digest !== expectedDigest) {
      throw new PromptRegistryError(
        "contract_digest_mismatch",
        `prompt contract ${contract.contract_id}@${contract.version} carries a digest that does not match its canonical content`,
      );
    }

    const key = contractKey(contract);
    const existing = entries.get(key);
    if (existing !== undefined) {
      throw new PromptRegistryError(
        existing.contract.contract_digest === contract.contract_digest
          ? "duplicate_contract"
          : "contract_content_conflict",
        existing.contract.contract_digest === contract.contract_digest
          ? `prompt contract ${key} registered twice`
          : `prompt contract ${key} registered with different content; immutable versions must not be amended`,
      );
    }

    for (const promptVersion of registration.prompt_versions) {
      const aliasKey = `${scopeOf(contract)}|${promptVersion}`;
      const aliasTarget = aliases.get(aliasKey);
      if (aliasTarget !== undefined && aliasTarget !== key) {
        throw new PromptRegistryError(
          "prompt_version_conflict",
          `prompt_version ${promptVersion} maps to both ${aliasTarget} and ${key} in scope ${scopeOf(contract)}`,
        );
      }
      aliases.set(aliasKey, key);
    }
    entries.set(key, { contract, promptVersions: [...registration.prompt_versions] });
  }

  const contracts = Object.freeze([...entries.values()].map((entry) => entry.contract));

  return {
    contracts,
    resolve(selector: PromptContractSelector): PromptContractResolution {
      const scope = `${selector.port_id}:${selector.purpose ?? ""}`;
      const key = aliases.get(`${scope}|${selector.prompt_version}`);
      const entry = key === undefined ? undefined : entries.get(key);
      if (entry === undefined) {
        throw new PromptContractError(
          "prompt_contract_version_mismatch",
          `no prompt contract resolves ${scope} at prompt_version ${selector.prompt_version}`,
        );
      }
      const { contract } = entry;
      return {
        prompt_contract_id: contract.contract_id,
        prompt_contract_version: contract.version,
        prompt_contract_digest: contract.contract_digest,
        output_schema_id: contract.output_schema_id,
        output_schema_digest: contract.output_schema_digest,
      };
    },
  };
}

/**
 * Fail-closed consistency check between a committed binding and a fresh
 * resolution (addendum design 5.2): any drift between the pinned fields and
 * the registry resolution is a version mismatch, never a warning.
 */
export function assertBindingMatchesResolution(
  binding: PromptContractBinding,
  resolution: PromptContractResolution,
): void {
  const mismatches: string[] = [];
  if (binding.prompt_contract_id !== resolution.prompt_contract_id) {
    mismatches.push("prompt_contract_id");
  }
  if (binding.prompt_contract_version !== resolution.prompt_contract_version) {
    mismatches.push("prompt_contract_version");
  }
  if (binding.prompt_contract_digest !== resolution.prompt_contract_digest) {
    mismatches.push("prompt_contract_digest");
  }
  if (binding.output_schema_digest !== resolution.output_schema_digest) {
    mismatches.push("output_schema_digest");
  }
  if (mismatches.length > 0) {
    throw new PromptContractError(
      "prompt_contract_version_mismatch",
      `binding drifted from the registry resolution on: ${mismatches.sort().join(", ")}`,
    );
  }
}
