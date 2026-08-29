export const PROTOCOL_VERSION = "1.0.0" as const;
export const PROTOCOL_MAJOR_VERSION = 1 as const;

/**
 * Single semver core shared by every protocol-version check. The wire
 * compatibility pattern below additionally tolerates pre-release/build
 * suffixes; `parseProtocolVersion` is the strict form used by reader gates,
 * which fail closed on anything beyond `major.minor.patch`.
 */
const SEMVER_CORE_PATTERN = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" as const;

const semanticVersionPattern = new RegExp(
  `^${SEMVER_CORE_PATTERN}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$`,
  "u",
);

const strictVersionPattern = new RegExp(`^${SEMVER_CORE_PATTERN}$`, "u");

/** Strict `x.y.z` parse; returns undefined for any other shape. */
export function parseProtocolVersion(
  version: string,
): readonly [number, number, number] | undefined {
  const match = strictVersionPattern.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isProtocolCompatible(version: string): boolean {
  const match = semanticVersionPattern.exec(version);
  return match !== null && Number(match[1]) === PROTOCOL_MAJOR_VERSION;
}

export function assertProtocolCompatible(version: string): void {
  if (!isProtocolCompatible(version)) {
    throw new Error(
      `Unsupported protocol major version: ${version}; this runtime supports ${PROTOCOL_MAJOR_VERSION}.x`,
    );
  }
}
