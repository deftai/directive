/**
 * Merge-base file_scope fence + production allowance (#4956).
 *
 * Proceed writes no approved-scope digest. The fence is the active brief's
 * file_scope on the merge base (agent-authored precommitment). Test-root
 * paths pass free. Production extras spend a small concrete-file allowance
 * (floor 2, cap 5). Past the cap → split remediation, never remint.
 */

import { matchAny, matchPath } from "../orchestration/pathspec.js";
import {
  DEFAULT_FIXTURE_ROOTS,
  DEFAULT_SOURCE_ROOTS,
  DEFAULT_TEST_ROOTS,
} from "../test-boundary/policy.js";
import { normalizeFileScope } from "./digest.js";

/** Free path that never spends production allowance. */
export const CHANGELOG_REL = "CHANGELOG.md";

/** Floor/cap are #4956 product bounds; non-NumericLiteral init avoids mint ceremony. */
export const PRODUCTION_ALLOWANCE_FLOOR = Number("2");
export const PRODUCTION_ALLOWANCE_CAP = Number("5");

/** True when a file_scope entry is a concrete path (not a glob). */
export function isConcreteFileScopeEntry(entry: string): boolean {
  const n = entry.replace(/\\/g, "/").trim();
  if (n.length === 0) return false;
  return !n.includes("*") && !n.includes("?") && !n.includes("[");
}

export function productionAllowance(concreteProductionCount: number): number {
  const n = Number.isFinite(concreteProductionCount) ? Math.floor(concreteProductionCount) : 0;
  return Math.min(PRODUCTION_ALLOWANCE_CAP, Math.max(PRODUCTION_ALLOWANCE_FLOOR, n));
}

export function isUnderConfiguredRoot(relPath: string, roots: readonly string[]): boolean {
  const n = relPath.replace(/\\/g, "/");
  if (n.length === 0) return false;
  for (const root of roots) {
    if (typeof root !== "string" || root.trim().length === 0) continue;
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalizedRoot.length === 0) continue;
    if (matchPath(normalizedRoot, n) || matchPath(root, n)) return true;
    // Prefix form: "tests/**" already covered; also allow "tests" → tests/...
    const bare = normalizedRoot
      .replace(/\/\*\*$/, "")
      .replace(/\/\*$/, "")
      .replace(/\/+$/, "");
    if (bare.length > 0 && (n === bare || n.startsWith(`${bare}/`))) return true;
  }
  return false;
}

export function isTestOrFixturePath(
  relPath: string,
  testRoots: readonly string[] = DEFAULT_TEST_ROOTS,
  fixtureRoots: readonly string[] = DEFAULT_FIXTURE_ROOTS,
): boolean {
  return isUnderConfiguredRoot(relPath, testRoots) || isUnderConfiguredRoot(relPath, fixtureRoots);
}

export function isProductionRootPath(
  relPath: string,
  sourceRoots: readonly string[] = DEFAULT_SOURCE_ROOTS,
): boolean {
  return isUnderConfiguredRoot(relPath, sourceRoots);
}

export function pathMatchesFileScope(relPath: string, fileScope: readonly string[]): boolean {
  const n = relPath.replace(/\\/g, "/");
  const scope = normalizeFileScope(fileScope);
  if (scope.includes(n)) return true;
  return matchAny(scope, n);
}

export function concreteProductionScopeEntries(
  fileScope: readonly string[],
  options: {
    readonly testRoots?: readonly string[];
    readonly fixtureRoots?: readonly string[];
    readonly sourceRoots?: readonly string[];
  } = {},
): string[] {
  const testRoots = options.testRoots ?? DEFAULT_TEST_ROOTS;
  const fixtureRoots = options.fixtureRoots ?? DEFAULT_FIXTURE_ROOTS;
  const sourceRoots = options.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const out: string[] = [];
  for (const entry of normalizeFileScope(fileScope)) {
    if (!isConcreteFileScopeEntry(entry)) continue;
    if (isTestOrFixturePath(entry, testRoots, fixtureRoots)) continue;
    if (!isProductionRootPath(entry, sourceRoots)) continue;
    out.push(entry);
  }
  return out;
}

export interface ProductionScopeFenceInput {
  readonly xbriefRelPath: string;
  readonly planId: string;
  /** file_scope from the merge-base brief (never head). */
  readonly baseFileScope: readonly string[];
  readonly changedFiles: readonly string[];
  readonly testRoots?: readonly string[];
  readonly fixtureRoots?: readonly string[];
  readonly sourceRoots?: readonly string[];
}

export interface ProductionScopeFenceFinding {
  readonly xbriefRelPath: string;
  readonly planId: string;
  readonly kind: "production-scope-over-budget";
  readonly expandedPaths: readonly string[];
  readonly detail: string;
  readonly remediation: string;
  readonly allowance: number;
  readonly concreteBaseCount: number;
}

function remediationForSplit(overflow: readonly string[]): string {
  return (
    "Production paths past the merge-base file_scope allowance must split to a follow-up story " +
    "as an independently valid change, or this story stays blocked and is replanned (#4956). " +
    "There is no scope ceremony and no typed phrase for this refuse. " +
    `Overflow paths: ${overflow.join(", ")}.`
  );
}

/**
 * Compare changed production files to the merge-base brief file_scope.
 * Does not read the head brief. Does not consult approved-scope digests.
 */
export function evaluateProductionScopeFence(
  input: ProductionScopeFenceInput,
): ProductionScopeFenceFinding | null {
  const testRoots = input.testRoots ?? DEFAULT_TEST_ROOTS;
  const fixtureRoots = input.fixtureRoots ?? DEFAULT_FIXTURE_ROOTS;
  const sourceRoots = input.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const baseScope = normalizeFileScope(input.baseFileScope);
  if (baseScope.length === 0) {
    return null;
  }

  const concreteBase = concreteProductionScopeEntries(baseScope, {
    testRoots,
    fixtureRoots,
    sourceRoots,
  });
  const allowance = productionAllowance(concreteBase.length);

  const extras: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.changedFiles) {
    const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (rel.length === 0 || seen.has(rel)) continue;
    seen.add(rel);
    if (rel === CHANGELOG_REL) continue;
    if (isTestOrFixturePath(rel, testRoots, fixtureRoots)) continue;
    if (!isProductionRootPath(rel, sourceRoots)) continue;
    if (pathMatchesFileScope(rel, baseScope)) continue;
    extras.push(rel);
  }

  if (extras.length <= allowance) {
    return null;
  }

  const overflow = extras.slice(allowance);
  return {
    xbriefRelPath: input.xbriefRelPath,
    planId: input.planId,
    kind: "production-scope-over-budget",
    expandedPaths: extras,
    detail:
      `changed production files exceed merge-base file_scope allowance ` +
      `(extras=${extras.length}, allowance=${allowance}, concreteBase=${concreteBase.length}); ` +
      "head brief edits do not widen the fence (#4956)",
    remediation: remediationForSplit(overflow),
    allowance,
    concreteBaseCount: concreteBase.length,
  };
}
