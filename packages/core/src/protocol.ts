import { PROTOCOL_MAJOR_VERSION, PROTOCOL_VERSION, parseProtocolVersion } from "./version.js";

/**
 * Registry of the protocol versions this runtime knows about. Membership in
 * the registry is a stronger statement than `isProtocolCompatible`: any 1.x
 * version is wire-compatible, but only registered versions may be written to
 * or accepted from the Ledger. Lookups fail closed — an unregistered version
 * is rejected, never silently treated as the nearest known one.
 *
 * `development` marks a version whose records are being introduced by the
 * in-flight 1.1/1.2/1.3 work; it is valid for new records but not yet a stable
 * publication contract.
 */
export const PROTOCOL_1_1_VERSION = "1.1.0" as const;
export const PROTOCOL_1_2_VERSION = "1.2.0" as const;
export const PROTOCOL_1_3_VERSION = "1.3.0" as const;

export type ProtocolStatus = "stable" | "development";

export interface ProtocolRegistration {
  readonly version: string;
  readonly major: number;
  readonly status: ProtocolStatus;
}

export const PROTOCOL_REGISTRY: readonly ProtocolRegistration[] = [
  { version: PROTOCOL_VERSION, major: PROTOCOL_MAJOR_VERSION, status: "stable" },
  { version: PROTOCOL_1_1_VERSION, major: PROTOCOL_MAJOR_VERSION, status: "development" },
  { version: PROTOCOL_1_2_VERSION, major: PROTOCOL_MAJOR_VERSION, status: "development" },
  { version: PROTOCOL_1_3_VERSION, major: PROTOCOL_MAJOR_VERSION, status: "development" },
];

export class ProtocolRegistryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Unknown protocol version: ${reason}`);
    this.name = "ProtocolRegistryError";
    this.reason = reason;
  }
}

export function lookupProtocol(version: string): ProtocolRegistration | undefined {
  return PROTOCOL_REGISTRY.find((entry) => entry.version === version);
}

export function isKnownProtocol(version: string): boolean {
  return lookupProtocol(version) !== undefined;
}

export function assertKnownProtocol(version: string): ProtocolRegistration {
  const registration = lookupProtocol(version);
  if (registration === undefined) {
    throw new ProtocolRegistryError(version);
  }
  return registration;
}

/** Typed fail-closed error for readers that cannot project a newer record. */
export class ProtocolProjectionError extends Error {
  readonly kind = "protocol_upgrade_required" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProtocolProjectionError";
  }
}

/**
 * Strict semver comparison over the shared `parseProtocolVersion`. Anything
 * beyond `major.minor.patch` fails closed with `protocol_upgrade_required`:
 * a reader gate must never guess at the ordering of a version it cannot parse.
 */
export function compareProtocolVersions(left: string, right: string): number {
  const leftParts = parseProtocolVersion(left);
  const rightParts = parseProtocolVersion(right);
  if (leftParts === undefined || rightParts === undefined) {
    throw new ProtocolProjectionError(
      `protocol_upgrade_required: unparseable protocol version ${JSON.stringify(
        leftParts === undefined ? left : right,
      )}`,
    );
  }
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] as number;
    const rightPart = rightParts[index] as number;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * Reader gate for Protocol 1.2 compatibility (design §19.1): a reader always
 * projects records at or below its own version, and an older reader fails
 * closed with `protocol_upgrade_required` only when the newer record is
 * authoritative. Non-authoritative newer data (derived read models) never
 * blocks an old reader.
 */
export function assertProtocolReaderCanProject(options: {
  readonly readerVersion: string;
  readonly recordVersion: string;
  readonly authoritative: boolean;
}): void {
  if (!options.authoritative) return;
  if (compareProtocolVersions(options.recordVersion, options.readerVersion) > 0) {
    throw new ProtocolProjectionError(
      `protocol_upgrade_required: record requires reader ${options.recordVersion}, active reader is ${options.readerVersion}`,
    );
  }
}
