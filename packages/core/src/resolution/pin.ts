/**
 * Version pin + reconciliation for the resolution spine (#2264, absorbs #2199).
 *
 * The committed `package.json` devDependency on `@deftai/directive` (exact,
 * `"private": true`) is the CANONICAL pin — read before directive runs, npm-native
 * so the engine ladder stays plain npm. This module reads that pin and reconciles
 * it against the reachable engine version, the `.deft/core/VERSION` content marker,
 * and the AGENTS.md managed-section `sha=`.
 *
 * Semver helpers here are the single comparison primitive reused by the skew
 * policy and the engine ladder so version ordering is defined in exactly one place.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The canonical committed dependency the pin lives on. */
export const PIN_DEPENDENCY_NAME = "@deftai/directive";

/** A parsed semver triple (prerelease / build metadata dropped). */
export type SemverTriple = readonly [number, number, number];

const BARE_SEMVER_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const EXACT_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/** Parse a semver prefix (`major.minor.patch`); null when not exact semver. */
export function parseSemver(version: string | null | undefined): SemverTriple | null {
  if (typeof version !== "string") return null;
  const normalized = version.trim().replace(/^v/i, "");
  const match = EXACT_SEMVER_RE.exec(normalized);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `version` is an EXACT pin (no range operators like `^` / `~` / `*`). */
export function isExactPin(version: string | null | undefined): boolean {
  if (typeof version !== "string") return false;
  return BARE_SEMVER_RE.test(version.trim().replace(/^v/i, ""));
}

/** Compare two versions: -1 (a<b), 0 (a==b), 1 (a>b); null when either is unparseable. */
export function compareSemver(a: string | null, b: string | null): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

/** True when `a >= b` under semver ordering; false when either is unparseable. */
export function semverGte(a: string | null, b: string | null): boolean {
  const cmp = compareSemver(a, b);
  return cmp === 0 || cmp === 1;
}

export interface PinReadSeams {
  readonly isFile?: (p: string) => boolean;
  readonly readText?: (p: string) => string | null;
}

export interface PinReadResult {
  /** Exact pinned version (no `v` prefix), or null when absent / non-exact. */
  readonly pinVersion: string | null;
  /** Raw devDependency spec string as written, or null. */
  readonly rawSpec: string | null;
  /** `package.json` declares `"private": true`. */
  readonly isPrivate: boolean;
  /** The pin spec is present but NOT an exact version (range operator used). */
  readonly nonExact: boolean;
}

function defaultIsFile(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function defaultReadText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readDependencySpec(pkg: Record<string, unknown>): string | null {
  for (const block of ["devDependencies", "dependencies"] as const) {
    const deps = pkg[block];
    if (typeof deps === "object" && deps !== null && !Array.isArray(deps)) {
      const spec = (deps as Record<string, unknown>)[PIN_DEPENDENCY_NAME];
      if (typeof spec === "string" && spec.trim().length > 0) {
        return spec.trim();
      }
    }
  }
  return null;
}

/**
 * Read the committed `package.json` pin on `@deftai/directive`. The pin is
 * canonical only when it is an EXACT version; a range spec is reported via
 * `nonExact` so callers can warn rather than silently trusting a floating range.
 */
export function readPin(projectRoot: string, seams: PinReadSeams = {}): PinReadResult {
  const isFile = seams.isFile ?? defaultIsFile;
  const readText = seams.readText ?? defaultReadText;
  const absent: PinReadResult = {
    pinVersion: null,
    rawSpec: null,
    isPrivate: false,
    nonExact: false,
  };
  const path = join(projectRoot, "package.json");
  if (!isFile(path)) return absent;
  const text = readText(path);
  if (text === null) return absent;
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return absent;
    pkg = parsed as Record<string, unknown>;
  } catch {
    return absent;
  }
  const isPrivate = pkg.private === true;
  const rawSpec = readDependencySpec(pkg);
  if (rawSpec === null) return { pinVersion: null, rawSpec: null, isPrivate, nonExact: false };
  if (!isExactPin(rawSpec)) {
    return { pinVersion: null, rawSpec, isPrivate, nonExact: true };
  }
  return {
    pinVersion: rawSpec.replace(/^v/i, ""),
    rawSpec,
    isPrivate,
    nonExact: false,
  };
}

export interface ReconcileInputs {
  /** Canonical pin from `package.json`. */
  readonly pinVersion: string | null;
  /** Reachable engine version, or null when unreachable. */
  readonly engineVersion: string | null;
  /** `.deft/core/VERSION` content marker, or null. */
  readonly contentVersion: string | null;
  /** AGENTS.md managed-section `sha=`, or null. */
  readonly managedSectionSha: string | null;
  /** The sha the engine would stamp for the current payload, when known. */
  readonly expectedManagedSectionSha?: string | null;
}

export interface ReconcileResult {
  /** No mismatches detected against the pin. */
  readonly consistent: boolean;
  /** Deposited content (`VERSION`) is behind the pin (needs forward-migration). */
  readonly contentBehindPin: boolean;
  /** The managed-section sha is present but disagrees with the expected sha. */
  readonly managedShaMismatch: boolean;
  /** Human-facing mismatch reasons (empty when consistent). */
  readonly mismatches: readonly string[];
}

/**
 * Reconcile the pin against the engine, the deposited content marker, and the
 * AGENTS managed-section sha. The managed-section `sha=` is part of the
 * reconciliation, not just `VERSION` (per the #2264 acceptance).
 */
export function reconcileVersions(inputs: ReconcileInputs): ReconcileResult {
  const { pinVersion, engineVersion, contentVersion, managedSectionSha } = inputs;
  const mismatches: string[] = [];

  const contentCmp = compareSemver(contentVersion, pinVersion);
  const contentBehindPin = contentCmp === -1;
  if (contentBehindPin) {
    mismatches.push(
      `.deft/core/VERSION (${contentVersion}) is behind the package.json pin (${pinVersion}); content forward-migration required`,
    );
  } else if (contentCmp === 1) {
    mismatches.push(
      `.deft/core/VERSION (${contentVersion}) is ahead of the package.json pin (${pinVersion})`,
    );
  }

  if (engineVersion !== null && pinVersion !== null) {
    const engineCmp = compareSemver(engineVersion, pinVersion);
    if (engineCmp === -1) {
      mismatches.push(`engine (${engineVersion}) is behind the package.json pin (${pinVersion})`);
    }
  }

  let managedShaMismatch = false;
  const expected = inputs.expectedManagedSectionSha;
  if (typeof expected === "string" && expected.length > 0) {
    if (managedSectionSha === null) {
      managedShaMismatch = true;
      mismatches.push("AGENTS.md managed-section sha is absent but an expected sha is known");
    } else if (managedSectionSha !== expected) {
      managedShaMismatch = true;
      mismatches.push(
        `AGENTS.md managed-section sha (${managedSectionSha}) does not match expected (${expected})`,
      );
    }
  }

  return {
    consistent: mismatches.length === 0,
    contentBehindPin,
    managedShaMismatch,
    mismatches,
  };
}
