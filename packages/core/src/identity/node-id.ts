import { createHash, randomBytes } from "node:crypto";

import { NODE_TYPES } from "../schema/node.js";
import { canonicalizeLocator } from "./locator.js";

export type NodeTypeName = (typeof NODE_TYPES)[number];

const UUID_URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const IDENTITY_NAMESPACE_NAME = "universal-harness/identity/v1";
const FIELD_SEPARATOR = "\u001f";

/** RFC 4122 UUIDv5 (SHA-1, name-based), implemented without dependencies. */
export function uuidv5(namespace: string, name: string): string {
  const hash = createHash("sha1").update(uuidToBytes(namespace)).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let cachedIdentityNamespace: string | undefined;

function identityNamespace(): string {
  cachedIdentityNamespace ??= uuidv5(UUID_URL_NAMESPACE, IDENTITY_NAMESPACE_NAME);
  return cachedIdentityNamespace;
}

export function kebabNodeType(type: NodeTypeName): string {
  if (!(NODE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown node type: ${type}`);
  }
  return type.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "-").toLowerCase();
}

export interface ScannedNodeIdentity {
  project_id: string;
  repository_id: string;
  type: NodeTypeName;
  locator: string;
}

/**
 * Deterministic identity for scanner-created nodes:
 * `UUIDv5(project_id, repository_id + type + canonical_locator)`. The locator
 * is canonicalized first, so logically equal locators (separator or Unicode
 * variants) always map to the same node ID on every platform.
 */
export function scannedNodeId(identity: ScannedNodeIdentity): string {
  const type = kebabNodeType(identity.type);
  const canonicalLocator = canonicalizeLocator(identity.locator);
  const projectNamespace = uuidv5(identityNamespace(), identity.project_id);
  const name = [identity.repository_id, type, canonicalLocator].join(FIELD_SEPARATOR);
  return `${type}_${uuidv5(projectNamespace, name)}`;
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_BITS = 48n;
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;

/** Crockford-base32 ULID: 48-bit millisecond timestamp + 80-bit randomness. */
export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || BigInt(now) >= 1n << ULID_TIME_BITS) {
    throw new Error(`ULID timestamp out of 48-bit range: ${now}`);
  }
  const randomValue = randomBytes(10).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  return (
    encodeCrockford(BigInt(now), ULID_TIME_LENGTH) +
    encodeCrockford(randomValue, ULID_RANDOM_LENGTH)
  );
}

function encodeCrockford(value: bigint, length: number): string {
  let remaining = value;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = CROCKFORD_BASE32.charAt(Number(remaining % 32n)) + output;
    remaining /= 32n;
  }
  if (remaining > 0n) {
    throw new Error("ULID component overflow");
  }
  return output;
}

/** Human-created nodes use a type-prefixed ULID; identity is never reused. */
export function humanNodeId(type: NodeTypeName, now?: number): string {
  return `${kebabNodeType(type)}_${ulid(now)}`;
}
