import { assertKnownProtocol } from "../protocol.js";
import { canonicalizeJson } from "./canonical-json.js";
import { identityNamespace, uuidv5 } from "./node-id.js";

const FIELD_SEPARATOR = "\u001f";
const DOMAIN_TAG_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ID_PREFIX_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class RecordIdentityError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Cannot derive record identity: ${reason}`);
    this.name = "RecordIdentityError";
    this.reason = reason;
  }
}

export interface DomainRecordIdentity {
  /** Snake_case tag of the owning domain, e.g. `profile_decision`. */
  readonly domain_tag: string;
  /** Kebab-case prefix of the emitted identifier, e.g. `profile-decision`. */
  readonly id_prefix: string;
  readonly protocol_version: string;
  /** JSON value canonicalized into the identity name. */
  readonly canonical_input: unknown;
}

/**
 * Deterministic identity for Protocol 1.1 domain records:
 * `UUIDv5(domain tag namespace, protocol version + canonical JSON input)`.
 * The domain tag scopes its own UUIDv5 namespace and the protocol version is
 * part of the hashed name, so the same canonical input under a different
 * domain or version never collides. Unknown protocol versions fail closed.
 */
export function domainRecordId(identity: DomainRecordIdentity): string {
  if (!DOMAIN_TAG_PATTERN.test(identity.domain_tag)) {
    throw new RecordIdentityError(`domain tag must be snake_case: ${identity.domain_tag}`);
  }
  if (!ID_PREFIX_PATTERN.test(identity.id_prefix)) {
    throw new RecordIdentityError(`id prefix must be kebab-case: ${identity.id_prefix}`);
  }
  assertKnownProtocol(identity.protocol_version);
  const domainNamespace = uuidv5(identityNamespace(), `domain/${identity.domain_tag}`);
  const name = [identity.protocol_version, canonicalizeJson(identity.canonical_input)].join(
    FIELD_SEPARATOR,
  );
  return `${identity.id_prefix}_${uuidv5(domainNamespace, name)}`;
}
