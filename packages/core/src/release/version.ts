const PEP440_TAG_RE =
  /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<kind>rc|alpha|beta|test)\.(?<num>\d+))?$/;

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
  if (candidate.startsWith("v")) {
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
  const match = PEP440_TAG_RE.exec(candidate);
  if (match?.groups === undefined) {
    throw new Error(
      `Cannot normalize '${candidate}' to PEP 440: expected ` +
        "[v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta|test).N",
    );
  }
  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);
  const base = `${major}.${minor}.${patch}`;
  const kind = match.groups.kind;
  if (kind === undefined) {
    return base;
  }
  if (NON_PUBLISHABLE_KINDS.has(kind)) {
    throw new NonPublishableVersionError(
      `Version '${candidate}' carries non-publishable pre-release ` +
        `tag '${kind}'.${match.groups.num} -- release pipeline MUST ` +
        "skip pyproject.toml [project].version sync for this tag.",
    );
  }
  const pepKind = PRE_KIND_MAP[kind];
  if (pepKind === undefined) {
    throw new Error(
      `Unmapped pre-release kind '${kind}' for version '${candidate}'; ` +
        "add it to _PRE_KIND_MAP or _NON_PUBLISHABLE_KINDS to keep " +
        "_PEP440_TAG_RE in lockstep with the publishability classifier.",
    );
  }
  const pepNum = Number(match.groups.num);
  return `${base}${pepKind}${pepNum}`;
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
  const match = PEP440_TAG_RE.exec(candidate);
  if (match?.groups === undefined) {
    throw new Error(
      `Cannot compare '${candidate}': expected ` + "[v]X.Y.Z or [v]X.Y.Z-(rc|alpha|beta).N",
    );
  }
  const kind = match.groups.kind ?? "";
  if (NON_PUBLISHABLE_KINDS.has(kind)) {
    throw new NonPublishableVersionError(
      `Version '${candidate}' carries non-publishable pre-release tag '${kind}'.${match.groups.num}.`,
    );
  }
  const rank = PRERELEASE_RANK[kind];
  if (rank === undefined) {
    throw new Error(`Cannot compare '${candidate}': unsupported pre-release kind '${kind}'.`);
  }
  return [
    Number(match.groups.major),
    Number(match.groups.minor),
    Number(match.groups.patch),
    rank,
    Number(match.groups.num ?? 0),
  ];
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
