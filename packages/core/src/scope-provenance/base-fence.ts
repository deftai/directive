/**
 * Merge-base file_scope fence + production allowance (#4956), plus change-set
 * membership against merge-base approved-scope (#4774).
 *
 * Proceed writes no approved-scope digest for the #4956 production fence. That
 * fence is the active brief's file_scope on the merge base (agent-authored
 * precommitment). Test-root paths pass free. Production extras spend a small
 * concrete-file allowance (floor 2, cap 5). Past the cap → split remediation,
 * never remint.
 *
 * Separately, #4774 membership compares the PR change set to a declared
 * allowlist. Prefer merge-base `.deft/approved-scope/<plan-id>.json` fileScope
 * when present; otherwise the merge-base brief file_scope; otherwise (first
 * introduction) the PR brief's non-empty file_scope. Empty/omitted file_scope
 * with no mint fails closed — not undeclared-by-design attestation. Peer
 * allowlists union only for peers whose xBRIEF also changed; peer coverage
 * never clears a missing own allowlist.
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
    // Prefix form: root/** already covered; also allow bare root → root/...
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

export type ApprovedScopeMembershipKind =
  | "active-xbrief-modified-without-digest"
  | "change-set-outside-approved-scope";

export interface ApprovedScopeMembershipInput {
  readonly xbriefRelPath: string;
  readonly planId: string;
  /** True when the bound active xBRIEF path is in the change set. */
  readonly xbriefModifiedInChangeSet: boolean;
  /**
   * Declared membership allowlist (caller resolves mint → base brief →
   * first-intro head brief). Null or empty means no declared allowlist.
   */
  readonly baseApprovedFileScope: readonly string[] | null;
  readonly changedFiles: readonly string[];
  /** Peer active xBRIEF paths that also changed; exempt from this story's extras. */
  readonly peerXbriefRelPaths?: readonly string[];
  /**
   * Peer declared allowlists for peers whose xBRIEF also changed. Unioned into
   * the allowlist only when this story already has its own non-empty allowlist.
   */
  readonly peerApprovedFileScopes?: readonly (readonly string[])[];
}

export interface ApprovedScopeMembershipFinding {
  readonly xbriefRelPath: string;
  readonly planId: string;
  readonly kind: ApprovedScopeMembershipKind;
  readonly expandedPaths: readonly string[];
  readonly detail: string;
  readonly remediation: string;
}

function normalizeMembershipRel(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function remediationForMissingApprovedScope(planId: string): string {
  return (
    "Declare a non-empty plan.metadata.swarm.file_scope on the active xBRIEF " +
    `(first-story delivery) or land a human-stamped .deft/approved-scope/<plan-id>.json ` +
    `on the merge base (planId=${planId}) before changing product paths with the active xBRIEF. ` +
    "Omitting file_scope is not undeclared-by-design attestation (#4774). " +
    "Same-PR approval rewrite stays fail-closed (#3145 / #3205)."
  );
}

function remediationForOutsideApprovedScope(extras: readonly string[]): string {
  return (
    "Remove or split paths outside the declared membership allowlist (merge-base " +
    "approved-scope when present, else merge-base / first-intro brief file_scope), or land a " +
    "renewed merge-base approval before widening. Live HEAD file_scope cannot authorize " +
    `extras once a merge-base brief exists (#4774). Outside paths: ${extras.join(", ")}.`
  );
}

/**
 * PR change-set membership against a declared allowlist (#4774).
 *
 * Caller supplies the resolved allowlist (mint preferred, else brief
 * file_scope). Closed exemptions: the bound active xBRIEF path, peer active
 * xBRIEF paths that also changed, plus CHANGELOG.md. No declared allowlist
 * fails closed; peer coverage must not clear that miss. Peer allowlists union
 * only when this story already has its own non-empty allowlist.
 */
export function evaluateApprovedScopeMembership(
  input: ApprovedScopeMembershipInput,
): ApprovedScopeMembershipFinding | null {
  if (!input.xbriefModifiedInChangeSet) {
    return null;
  }

  const xbriefRel = normalizeMembershipRel(input.xbriefRelPath);
  const peerXbriefs = new Set(
    (input.peerXbriefRelPaths ?? [])
      .map((p) => normalizeMembershipRel(p))
      .filter((p) => p.length > 0),
  );
  const ownAllow = normalizeFileScope(input.baseApprovedFileScope ?? []);
  const peerAllow = normalizeFileScope((input.peerApprovedFileScopes ?? []).flat());

  if (ownAllow.length === 0) {
    // No declared allowlist: fail closed. Peer scopes must not authorize.
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.changedFiles) {
      const rel = normalizeMembershipRel(raw);
      if (rel.length === 0 || seen.has(rel)) continue;
      seen.add(rel);
      if (rel === xbriefRel) continue;
      if (rel === CHANGELOG_REL) continue;
      if (peerXbriefs.has(rel)) continue;
      offenders.push(rel);
    }
    return {
      xbriefRelPath: xbriefRel,
      planId: input.planId,
      kind: "active-xbrief-modified-without-digest",
      expandedPaths: offenders,
      detail:
        offenders.length > 0
          ? "active xBRIEF in change set without declared membership allowlist and " +
            `non-exempt paths present (${offenders.join(", ")}); fail closed (#4774 C24)`
          : "active xBRIEF in change set without declared membership allowlist " +
            "(empty/omitted file_scope and no merge-base approved-scope); fail closed (#4774 C24)",
      remediation: remediationForMissingApprovedScope(input.planId),
    };
  }

  const allow = normalizeFileScope([...ownAllow, ...peerAllow]);
  const extras: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.changedFiles) {
    const rel = normalizeMembershipRel(raw);
    if (rel.length === 0 || seen.has(rel)) continue;
    seen.add(rel);
    if (rel === xbriefRel) continue;
    if (rel === CHANGELOG_REL) continue;
    if (peerXbriefs.has(rel)) continue;
    if (pathMatchesFileScope(rel, allow)) continue;
    extras.push(rel);
  }

  if (extras.length === 0) {
    return null;
  }

  return {
    xbriefRelPath: xbriefRel,
    planId: input.planId,
    kind: "change-set-outside-approved-scope",
    expandedPaths: extras,
    detail: `changed paths outside declared membership allowlist (#4774): ${extras.join(", ")}`,
    remediation: remediationForOutsideApprovedScope(extras),
  };
}
