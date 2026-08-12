export const PROTOCOL_VERSION = "1.0.0" as const;
export const PROTOCOL_MAJOR_VERSION = 1 as const;

const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

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
