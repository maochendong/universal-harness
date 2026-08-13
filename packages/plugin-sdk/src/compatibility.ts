import { isProtocolCompatible, PROTOCOL_VERSION } from "@universal-harness-internal/core";

/**
 * Protocol compatibility negotiation (design 13, plan Task 24). Every versioned
 * port speaks the M1 protocol: a plugin declaring an incompatible major
 * version must fail before execution, never mid-run. The check is a typed
 * result so hosts can surface the reason; `manifest.ts` turns it into a typed
 * error at the execution boundary.
 */

export type ProtocolCompatibility =
  | {
      readonly compatible: true;
      readonly protocol_version: string;
      readonly host_version: string;
    }
  | {
      readonly compatible: false;
      readonly protocol_version: string;
      readonly host_version: string;
      readonly reason: string;
    };

/**
 * Whether a plugin-declared protocol version can execute against this host.
 * Compatibility is major-version bound: the plugin's major must equal the
 * host major. Anything unparseable is incompatible.
 */
export function checkProtocolCompatibility(version: string): ProtocolCompatibility {
  if (isProtocolCompatible(version)) {
    return { compatible: true, protocol_version: version, host_version: PROTOCOL_VERSION };
  }
  return {
    compatible: false,
    protocol_version: version,
    host_version: PROTOCOL_VERSION,
    reason: `plugin protocol ${JSON.stringify(version)} does not share the host major version; the host speaks ${PROTOCOL_VERSION}`,
  };
}
