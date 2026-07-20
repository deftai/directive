const PRE_KIND_MAP: Record<string, string> = {
  alpha: "a",
  beta: "b",
  rc: "rc",
};

const NON_PUBLISHABLE_KINDS = new Set(["test"]);

const PRERELEASE_RANK: Record<string, number> = {
  alpha: 0,
  beta: 1,
  rc: 2,
  "": 3,
};

export class NonPublishableVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonPublishableVersionError";
  }
}

interface ParsedReleaseTag {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly kind: string | null;
  readonly num: number | null;
}

/** Parse `[v]X.Y.Z[-(rc|alpha|beta|test).N]` via linear scan. */
function parseReleaseTag(version: string): ParsedReleaseTag | null {
  let i = 0;
  if (version[i] === "v" || version[i] === "V") i += 1;
  const readInt = (): number | null => {
    const ch = version[i] ?? "";
    if (i >= version.length || ch < "0" || ch > "9") return null;
    let n = 0;
    while (i < version.length) {
      const digit = version[i] ?? "";
      if (digit < "0" || digit > "9") break;
      n = n * 10 + Number(digit);
      i += 1;
    }
    return n;
  };
  const major = readInt();
  if (major === null || version[i] !== ".") return null;
  i += 1;
  const minor = readInt();
  if (minor === null || version[i] !== ".") return null;
  i += 1;
  const patch = readInt();
  if (patch === null) return null;
  if (i >= version.length) return { major, minor, patch, kind: null, num: null };
  if (version[i] !== "-") return null;
  i += 1;
  const kindStart = i;
  while (i < version.length && version[i] !== ".") i += 1;
  if (i >= version.length || version[i] !== ".") return null;
  const kind = version.slice(kindStart, i);
  if (!["rc", "alpha", "beta", "test"].includes(kind)) return null;
  i += 1;
  const num = readInt();
  if (num === null || i !== version.length) return null;
  return { major, minor, patch, kind, num };
}

/** Raise Error when version does not match strict X.Y.Z semver. */
export function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version '${version}'. Expected strict semver X.Y.Z ` +
        "(no leading 'v', no pre-release suffix).",
    );
  }
}

/** Return true when version carries a SemVer pre-release suffix (#425). */
export function isPrereleaseTag(version: string): boolean {
  let candidate = version.trim();
  if (candidate.startsWith("v") || candidate.startsWith("V")) {
    candidate = candidate.slice(1);
  }
  return candidate.includes("-");
}

/** Normalize a semver-shaped release tag to a PEP 440 version string (#771). */
export function toPep440(version: string): string {
  if (typeof version !== "string") {
    throw new Error(`version must be a string, got ${typeof version}`);
  }
  const candidate = version.trim();
  if (!candidate) {
    throw new Error("version must be a non-empty string");
  }
  const parsed = parseReleaseTag(candidate);
  if (parsed === null) {
    throw new Error(
      `Cannot normalize '${candidate}' to PEP 440: expected ` +
        "[v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta|test).N",
    );
  }
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (parsed.kind === null) return base;
  if (NON_PUBLISHABLE_KINDS.has(parsed.kind)) {
    throw new NonPublishableVersionError(
      `Version '${candidate}' carries non-publishable pre-release ` +
        `tag '${parsed.kind}'.${parsed.num} -- release pipeline MUST ` +
        "skip pyproject.toml [project].version sync for this tag.",
    );
  }
  const pepKind = PRE_KIND_MAP[parsed.kind];
  if (pepKind === undefined) {
    throw new Error(
      `Unmapped pre-release kind '${parsed.kind}' for version '${candidate}'; ` +
        "add it to PRE_KIND_MAP or NON_PUBLISHABLE_KINDS to keep the parser " +
        "in lockstep with the publishability classifier.",
    );
  }
  return `${base}${pepKind}${parsed.num}`;
}

export function isPublishable(version: string): boolean {
  try {
    toPep440(version);
    return true;
  } catch {
    return false;
  }
}

function publishableVersionSortKey(
  version: string,
): readonly [number, number, number, number, number] {
  const candidate = version.trim();
  const parsed = parseReleaseTag(candidate);
  if (parsed === null) {
    throw new Error(
      `Cannot compare '${candidate}': expected [v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta).N`,
    );
  }
  if (parsed.kind !== null && NON_PUBLISHABLE_KINDS.has(parsed.kind)) {
    throw new NonPublishableVersionError(
      `Version '${candidate}' carries non-publishable pre-release tag '${parsed.kind}'.${parsed.num}.`,
    );
  }
  const kind = parsed.kind ?? "";
  const rank = PRERELEASE_RANK[kind];
  if (rank === undefined) {
    throw new Error(`Cannot compare '${candidate}': unsupported pre-release kind '${kind}'.`);
  }
  return [parsed.major, parsed.minor, parsed.patch, rank, parsed.num ?? 0];
}

/** Compare two publishable Deft release versions using stable/prerelease ordering. */
export function comparePublishableVersions(left: string, right: string): -1 | 0 | 1 {
  const leftKey = publishableVersionSortKey(left);
  const rightKey = publishableVersionSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const leftPart = leftKey[index] ?? 0;
    const rightPart = rightKey[index] ?? 0;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}
