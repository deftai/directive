/** Parse a semver prefix from a deft version marker or manifest tag. */
export function parseSemverPrefix(version: string): [number, number, number] | null {
  const normalized = version.trim().replace(/^v/i, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when `to` is a strict patch bump over `from` (same major/minor, higher patch).
 * Non-semver inputs are treated as not patch-only (#2034 patch-inert rule).
 */
export function isPatchOnlyUpgrade(from: string | null, to: string): boolean {
  if (from === null) {
    return false;
  }
  const a = parseSemverPrefix(from);
  const b = parseSemverPrefix(to);
  if (a === null || b === null) {
    return false;
  }
  return a[0] === b[0] && a[1] === b[1] && b[2] > a[2];
}
