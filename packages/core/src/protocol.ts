import { PROTOCOL_MAJOR_VERSION, PROTOCOL_VERSION } from "./version.js";

/**
 * Registry of the protocol versions this runtime knows about. Membership in
 * the registry is a stronger statement than `isProtocolCompatible`: any 1.x
 * version is wire-compatible, but only registered versions may be written to
 * or accepted from the Ledger. Lookups fail closed — an unregistered version
 * is rejected, never silently treated as the nearest known one.
 *
 * `development` marks a version whose records are being introduced by the
 * in-flight 1.1/1.2 work; it is valid for new records but not yet a stable
 * publication contract.
 */
export const PROTOCOL_1_1_VERSION = "1.1.0" as const;
export const PROTOCOL_1_2_VERSION = "1.2.0" as const;

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
