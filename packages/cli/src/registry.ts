/**
 * Registry target resolution for install/upgrade (AC6.1 / AC7.2).
 * Resolves latest stable via `npm view`; rejects ranges/tags as user specs.
 * Contract preflight reads published package.json metadata before pin mutation.
 */
import { spawnSync } from "node:child_process";
import { RUNTIME_PACKAGE_NAME } from "./constants.js";
import { isExactSemver, isPrereleaseVersion } from "./pm.js";

function parseExactVersionParts(version: string): {
  major: number;
  minor: number;
  patch: number;
  pre: string[] | null;
} | null {
  const trimmed = version.trim();
  if (!isExactSemver(trimmed)) return null;
  const dash = trimmed.indexOf("-");
  const core = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const pre = dash === -1 ? null : trimmed.slice(dash + 1).split(".");
  const [majS, minS, patS] = core.split(".");
  const major = Number(majS);
  const minor = Number(minS);
  const patch = Number(patS);
  if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) return null;
  return { major, minor, patch, pre };
}

function comparePreParts(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNum = /^\d+$/.test(left) ? Number(left) : null;
    const rightNum = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNum !== null && rightNum !== null) {
      if (leftNum !== rightNum) return leftNum < rightNum ? -1 : 1;
      continue;
    }
    if (leftNum !== null) return -1;
    if (rightNum !== null) return 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two exact SemVer strings (incl. prerelease). Returns -1 / 0 / 1.
 * Invalid inputs compare as equal to avoid accidental downgrade acceptance.
 */
export function compareExactVersions(a: string, b: string): number {
  const left = parseExactVersionParts(a);
  const right = parseExactVersionParts(b);
  if (left === null || right === null) return 0;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.pre === null && right.pre === null) return 0;
  // SemVer: release > any prerelease of same core
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return comparePreParts(left.pre, right.pre);
}

export type ValidateTargetResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string };

/** User-supplied --target-version must already be an exact SemVer (incl. prerelease). */
export function validateTargetVersionSpec(raw: string): ValidateTargetResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "--target-version requires an exact version." };
  }
  if (trimmed === "latest" || trimmed === "next" || trimmed === "canary") {
    return {
      ok: false,
      message: `--target-version rejects tags (${trimmed}); pass an exact version.`,
    };
  }
  if (!isExactSemver(trimmed)) {
    return {
      ok: false,
      message: `--target-version must be an exact SemVer (got ${trimmed}). Ranges and tags are rejected.`,
    };
  }
  return { ok: true, version: trimmed };
}

export type ResolveLatestResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the registry "latest" tag to an exact version, then reject prereleases
 * unless the caller already passed --target-version (AC6.1).
 * Runs with cwd=projectRoot so project `.npmrc` registry/auth apply.
 */
export function resolveLatestStableVersion(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
): ResolveLatestResult {
  const result = spawnSync(
    "npm",
    ["view", RUNTIME_PACKAGE_NAME, "version", "--json"],
    {
      encoding: "utf8",
      env,
      cwd: projectRoot,
      shell: process.platform === "win32",
    },
  );
  if (result.error) {
    return {
      ok: false,
      message: `Failed to query registry for ${RUNTIME_PACKAGE_NAME}: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message:
        `npm view ${RUNTIME_PACKAGE_NAME} version failed` +
        (result.stderr ? `: ${result.stderr.trim()}` : ""),
    };
  }
  let version = (result.stdout ?? "").trim();
  // --json may quote the string
  if (version.startsWith('"') && version.endsWith('"')) {
    try {
      version = JSON.parse(version) as string;
    } catch {
      /* keep trimmed */
    }
  }
  if (!isExactSemver(version)) {
    return {
      ok: false,
      message: `Registry latest is not an exact SemVer (${version}).`,
    };
  }
  if (isPrereleaseVersion(version)) {
    return {
      ok: false,
      message:
        `Registry latest (${version}) is a prerelease. Pass --target-version <exact> to install it (AC6.1).`,
    };
  }
  return { ok: true, version };
}

export type ResolveContractResult =
  | { readonly ok: true; readonly contract: number }
  | { readonly ok: false; readonly message: string };

/**
 * Read published `directive.contract` for an exact runtime version (AC7.2 preflight).
 * Uses registry/tarball package.json metadata only — no install, no pin change.
 */
export function resolvePublishedContract(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
): ResolveContractResult {
  const result = spawnSync(
    "npm",
    ["view", `${RUNTIME_PACKAGE_NAME}@${version}`, "directive", "--json"],
    {
      encoding: "utf8",
      env,
      cwd: projectRoot,
      shell: process.platform === "win32",
    },
  );
  if (result.error) {
    return {
      ok: false,
      message: `Failed to query published contract for ${RUNTIME_PACKAGE_NAME}@${version}: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message:
        `npm view ${RUNTIME_PACKAGE_NAME}@${version} directive failed` +
        (result.stderr ? `: ${result.stderr.trim()}` : ""),
    };
  }
  let raw = (result.stdout ?? "").trim();
  if (raw.length === 0) {
    return {
      ok: false,
      message: `Published ${RUNTIME_PACKAGE_NAME}@${version} has no directive.contract metadata.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `Could not parse directive metadata for ${RUNTIME_PACKAGE_NAME}@${version}.`,
    };
  }
  // npm may return the object or nest under a version key for some queries
  let directive = parsed;
  if (
    directive !== null &&
    typeof directive === "object" &&
    !Array.isArray(directive) &&
    !("contract" in (directive as object))
  ) {
    const values = Object.values(directive as Record<string, unknown>);
    if (values.length === 1) directive = values[0];
  }
  if (directive === null || typeof directive !== "object" || Array.isArray(directive)) {
    return {
      ok: false,
      message: `Published ${RUNTIME_PACKAGE_NAME}@${version} directive metadata is not an object.`,
    };
  }
  const contract = (directive as { contract?: unknown }).contract;
  if (typeof contract !== "number" || !Number.isInteger(contract) || contract < 1) {
    return {
      ok: false,
      message: `Published ${RUNTIME_PACKAGE_NAME}@${version} has invalid directive.contract.`,
    };
  }
  return { ok: true, contract };
}
