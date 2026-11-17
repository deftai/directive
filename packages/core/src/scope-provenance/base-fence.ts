/**
 * Merge-base file_scope fence + production allowance (#4956), plus change-set
 * membership against mint or concrete merge-base precommitment (#4774 / #5192).
 *
 * Proceed writes no approved-scope digest for the #4956 production fence. That
 * fence is the active brief's file_scope on the merge base (agent-authored
 * precommitment), or the merge-base mint when present. Extras follow the
 * shared rule in extra-path-admission.ts (#6221): source extras and test or
 * fixture modifies spend one allowance (floor 2, cap 5); other-class paths are
 * ignored on this check (named residual). Past the cap → split remediation,
 * never remint.
 *
 * Membership (#4774 / #5192 Path B): when the bound xBRIEF is in the change set,
 * the allowlist is a human-stamped merge-base mint when present for the
 * continuity-resolved story, else the merge-base brief's **concrete**
 * file_scope entries as agent precommitment. Empty mint is authoritative.
 * Glob entries admit only under a mint (F4). Free paths are the bound brief,
 * verified peers, CHANGELOG, caller-supplied lifecycle exempts, and the exact
 * spec-drift ledger under the completion-move shape only (#680 P5). Extras use
 * the same shared rule; other-class undeclared paths must match the allowlist.
 * Peer coverage never clears a missing own allowlist. Missing-mint remediation
 * is split or land a widened concrete brief — never renew mint.
 *
 * Forge approval (#6203): when no mint is present, a qualifying human forge
 * approval (see forge-approval.ts) may admit the head brief's concrete
 * file_scope for membership only (`forge-approval` authority, same rules as
 * precommitment). The production fence below stays merge-base.
 */

import { CHANGELOG_FILE_REL, isChangelogEntryPath } from "../changelog/entry-path.js";
import { matchAny, matchPath } from "../orchestration/pathspec.js";
import {
  isCompletionMoveShaped,
  isSpecDriftRowFilePath,
  SPEC_DRIFT_LEDGER_REL,
} from "../scope/delivery-evidence.js";
import {
  DEFAULT_FIXTURE_ROOTS,
  DEFAULT_SOURCE_ROOTS,
  DEFAULT_TEST_ROOTS,
} from "../test-boundary/policy.js";
import { normalizeFileScope } from "./digest.js";
import {
  assessExtraPaths,
  type ExtraPathAssessment,
  type ExtraPathChangeKind,
  extraPathRemedy,
  extraPathsAdmitted,
  formatExtraPathRefusal,
} from "./extra-path-admission.js";

/** Free path that never spends production allowance. */
/** Root changelog path; path tests use `isChangelogEntryPath` (#6314). */
export const CHANGELOG_REL = CHANGELOG_FILE_REL;

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
  /**
   * Allowlist under the story's authority (#6221): the merge-base mint when
   * present; absent or null means the merge-base brief's concrete entries.
   */
  readonly mintFileScope?: readonly string[] | null;
  /** Change kind of a path against the base (#6221); absent means unknown. */
  readonly changeKind?: (relPath: string) => ExtraPathChangeKind | null;
  /** Receives the shared assessment for the success report (#6221 P4). */
  readonly onAssessment?: (assessment: ExtraPathAssessment) => void;
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
 * Path-independent check (#4956 / #6221): compare the changed paths to the
 * story allowlist (the merge-base mint when present, else the merge-base
 * brief's concrete entries) through the shared extra-path rule. Source extras
 * and test or fixture modifies spend one allowance; other-class paths are
 * ignored here (named residual). An empty merge-base file_scope skips (#3715).
 * Does not read the head brief.
 */
export function evaluateProductionScopeFence(
  input: ProductionScopeFenceInput,
): ProductionScopeFenceFinding | null {
  const baseScope = normalizeFileScope(input.baseFileScope);
  if (baseScope.length === 0) {
    return null;
  }
  const mint = input.mintFileScope ?? null;
  // Under a mint a declared path must match the mint and the merge-base brief
  // (globs match under mint authority), so a broader mint does not widen this
  // fence (#5192). The allowance counts the merge-base brief.
  const assessment = assessExtraPaths({
    allowlist: mint ?? baseScope,
    ...(mint !== null ? { alsoAllowlist: baseScope } : {}),
    allowanceScope: baseScope,
    authority: mint !== null ? "mint" : "concrete",
    changedPaths: input.changedFiles,
    ...(input.changeKind !== undefined ? { changeKind: input.changeKind } : {}),
    // Brief records are not extras of a story (they are other-class here anyway).
    isFree: (rel) =>
      isChangelogEntryPath(rel) || rel.startsWith("xbrief/") || rel.startsWith("vbrief/"),
    otherClass: "ignore",
    ...(input.testRoots !== undefined ? { testRoots: input.testRoots } : {}),
    ...(input.fixtureRoots !== undefined ? { fixtureRoots: input.fixtureRoots } : {}),
    ...(input.sourceRoots !== undefined ? { sourceRoots: input.sourceRoots } : {}),
  });
  input.onAssessment?.(assessment);
  if (extraPathsAdmitted(assessment)) {
    return null;
  }

  return {
    xbriefRelPath: input.xbriefRelPath,
    planId: input.planId,
    kind: "production-scope-over-budget",
    expandedPaths: [...assessment.refused, ...assessment.spent],
    detail:
      `changed paths exceed merge-base file_scope allowance ` +
      `(extras=${String(assessment.spent.length)}, allowance=${String(assessment.allowance)}, ` +
      `concreteBase=${String(assessment.concreteBaseCount)}): ${formatExtraPathRefusal(assessment)}; ` +
      "head brief edits do not widen the fence (#4956 / #6221)",
    remediation:
      assessment.overflow.length > 0
        ? `${remediationForSplit(assessment.overflow)} ${extraPathRemedy(assessment)}`
        : extraPathRemedy(assessment),
    allowance: assessment.allowance,
    concreteBaseCount: assessment.concreteBaseCount,
  };
}

export type ApprovedScopeMembershipKind =
  | "active-xbrief-modified-without-digest"
  | "change-set-outside-approved-scope";

/**
 * How the membership allowlist was obtained (#5192 / #6203).
 * `forge-approval`: head brief concrete file_scope admitted by a qualifying
 * human forge approval (#6203). Same matching rules as precommitment.
 */
export type MembershipAllowlistAuthority = "mint" | "precommitment" | "missing" | "forge-approval";

/** Concrete-only authorities: globs never admit and empty is not authoritative (F4). */
function isConcreteOnlyAuthority(authority: MembershipAllowlistAuthority): boolean {
  return authority === "precommitment" || authority === "forge-approval";
}

export interface ApprovedScopeMembershipInput {
  readonly xbriefRelPath: string;
  readonly planId: string;
  /** True when the bound active xBRIEF path is in the change set. */
  readonly xbriefModifiedInChangeSet: boolean;
  /**
   * Declared membership allowlist.
   * - mint authority: merge-base approved-scope (incl. empty = authoritative)
   * - precommitment: concrete merge-base brief file_scope only
   * - null + missing: no declaration yet
   */
  readonly baseApprovedFileScope: readonly string[] | null;
  /**
   * mint: globs match; empty allowlist is authoritative.
   * precommitment: only concrete entries admit; globs never admit (F4).
   * missing: no allowlist (xBRIEF-only or C24).
   */
  readonly allowlistAuthority?: MembershipAllowlistAuthority;
  readonly changedFiles: readonly string[];
  /** Peer active xBRIEF paths that also changed; exempt from this story's extras. */
  readonly peerXbriefRelPaths?: readonly string[];
  /**
   * Peer declared allowlists for peers whose xBRIEF also changed. Unioned into
   * the allowlist only when this story already has its own non-empty allowlist.
   */
  readonly peerApprovedFileScopes?: readonly (readonly string[])[];
  /** Continuity-resolved lifecycle paths exempt in an xBRIEF-only / membership set. */
  readonly exemptRelPaths?: readonly string[];
  readonly testRoots?: readonly string[];
  readonly fixtureRoots?: readonly string[];
  readonly sourceRoots?: readonly string[];
  /**
   * When true (default), empty mint allowlist is authoritative (no brief fallback).
   * Precommitment never treats empty as a present mint.
   */
  readonly emptyAllowlistAuthoritative?: boolean;
  /** Change kind of a path against the base (#6221); absent means unknown. */
  readonly changeKind?: (relPath: string) => ExtraPathChangeKind | null;
  /** Receives the shared assessment for the success report (#6221 P4). */
  readonly onAssessment?: (assessment: ExtraPathAssessment) => void;
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

function remediationForMissingDeclaration(planId: string): string {
  return (
    `Land the continuity-resolved brief on the merge base with a concrete file_scope ` +
    `(planId=${planId}), or split non-exempt paths to a follow-up story (#5192 / #4774). ` +
    "PR-authored file_scope is not membership authority. Omitting approval is not " +
    "undeclared-by-design attestation. Same-PR approval rewrite stays fail-closed " +
    "(#3145 / #3205)."
  );
}

function remediationForOutsideMembership(
  extras: readonly string[],
  authority: MembershipAllowlistAuthority,
): string {
  const outside = `Outside paths: ${extras.join(", ")}.`;
  if (authority === "mint") {
    return (
      "Split paths outside the continuity-resolved mint allowlist to a follow-up story (#5192). " +
      "A present human mint is authoritative; widening the merge-base brief file_scope will not " +
      `clear this finding. Live HEAD file_scope cannot authorize extras. ${outside}`
    );
  }
  if (authority === "forge-approval") {
    return (
      "Split paths outside the forge-approved head brief file_scope to a follow-up story, or " +
      "widen the head brief and get a fresh qualifying human approval on the new head (#6203). " +
      outside
    );
  }
  return (
    "Split paths outside the membership allowlist to a follow-up story, or land a " +
    "widened concrete brief on the merge base before widening (#5192). Live HEAD " +
    `file_scope cannot authorize extras. ${outside}`
  );
}

/**
 * PR change-set membership (#4774 / #5192).
 *
 * Free: bound brief, verified peers, CHANGELOG, caller lifecycle exempts.
 * With a mint or concrete precommitment allowlist: source-root extras spend
 * production allowance (2–5); test/fixture and other undeclared paths must
 * match. Missing declaration + only free paths passes (xBRIEF-only). Missing
 * declaration + non-exempt paths fails closed (C24). Peer coverage never
 * clears a missing own allowlist.
 */
export function evaluateApprovedScopeMembership(
  input: ApprovedScopeMembershipInput,
): ApprovedScopeMembershipFinding | null {
  if (!input.xbriefModifiedInChangeSet) {
    return null;
  }

  const authority: MembershipAllowlistAuthority =
    input.allowlistAuthority ?? (input.baseApprovedFileScope === null ? "missing" : "mint");
  const testRoots = input.testRoots ?? DEFAULT_TEST_ROOTS;
  const fixtureRoots = input.fixtureRoots ?? DEFAULT_FIXTURE_ROOTS;
  const sourceRoots = input.sourceRoots ?? DEFAULT_SOURCE_ROOTS;

  const xbriefRel = normalizeMembershipRel(input.xbriefRelPath);
  const peerXbriefs = new Set(
    (input.peerXbriefRelPaths ?? [])
      .map((p) => normalizeMembershipRel(p))
      .filter((p) => p.length > 0),
  );
  const lifecycleExempt = new Set(
    (input.exemptRelPaths ?? []).map((p) => normalizeMembershipRel(p)).filter((p) => p.length > 0),
  );

  // #680 P5 / #6231: the spec-drift ledger is scope:complete verb output. It is
  // free only when the whole change set is a completion move (delivery-brief-land
  // paths with a completed/ brief), so it never carries other paths past membership.
  // The per-story row files under xbrief/.audit/spec-drift/ join it (#6335).
  const ledgerFree = isCompletionMoveShaped(
    input.changedFiles.map((raw) => normalizeMembershipRel(raw)).filter((rel) => rel.length > 0),
  );

  const isFreePath = (rel: string): boolean => {
    if (rel === xbriefRel) return true;
    if (isChangelogEntryPath(rel)) return true;
    if (peerXbriefs.has(rel)) return true;
    if (lifecycleExempt.has(rel)) return true;
    if (ledgerFree && (rel === SPEC_DRIFT_LEDGER_REL || isSpecDriftRowFilePath(rel))) return true;
    return false;
  };

  const rawOwn = input.baseApprovedFileScope;
  const ownAllow = isConcreteOnlyAuthority(authority)
    ? normalizeFileScope(rawOwn ?? []).filter((e) => isConcreteFileScopeEntry(e))
    : normalizeFileScope(rawOwn ?? []);
  const peerAllow = normalizeFileScope((input.peerApprovedFileScopes ?? []).flat());

  const emptyAuthoritative = input.emptyAllowlistAuthoritative ?? authority === "mint";
  const hasDeclaredAllowlist =
    rawOwn !== null && (ownAllow.length > 0 || (emptyAuthoritative && authority === "mint"));

  if (!hasDeclaredAllowlist) {
    // No usable allowlist: xBRIEF-only passes; non-exempt paths fail closed.
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.changedFiles) {
      const rel = normalizeMembershipRel(raw);
      if (rel.length === 0 || seen.has(rel)) continue;
      seen.add(rel);
      if (isFreePath(rel)) continue;
      offenders.push(rel);
    }
    if (offenders.length === 0) {
      return null;
    }
    return {
      xbriefRelPath: xbriefRel,
      planId: input.planId,
      kind: "active-xbrief-modified-without-digest",
      expandedPaths: offenders,
      detail:
        "active xBRIEF in change set without declared membership allowlist and " +
        `non-exempt paths present (${offenders.join(", ")}); fail closed (#4774 C24 / #5192)`,
      remediation: remediationForMissingDeclaration(input.planId),
    };
  }

  // Empty authoritative mint with no peer union: every non-free path is an offender.
  if (ownAllow.length === 0) {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.changedFiles) {
      const rel = normalizeMembershipRel(raw);
      if (rel.length === 0 || seen.has(rel)) continue;
      seen.add(rel);
      if (isFreePath(rel)) continue;
      offenders.push(rel);
    }
    if (offenders.length === 0) return null;
    return {
      xbriefRelPath: xbriefRel,
      planId: input.planId,
      kind: "active-xbrief-modified-without-digest",
      expandedPaths: offenders,
      detail:
        "active xBRIEF in change set with empty authoritative membership allowlist and " +
        `non-exempt paths present (${offenders.join(", ")}); fail closed (#4774 / #5192)`,
      remediation: remediationForOutsideMembership(offenders, authority),
    };
  }

  // Shared extra-path rule (#6221): source extras and test/fixture modifies of
  // a path on the base spend one allowance; other-class paths must match.
  const assessment = assessExtraPaths({
    allowlist: [...ownAllow, ...peerAllow],
    allowanceScope: ownAllow,
    authority: authority === "mint" ? "mint" : "concrete",
    changedPaths: input.changedFiles,
    ...(input.changeKind !== undefined ? { changeKind: input.changeKind } : {}),
    isFree: isFreePath,
    otherClass: "refuse",
    testRoots,
    fixtureRoots,
    sourceRoots,
  });
  input.onAssessment?.(assessment);
  const outside = [...assessment.refused, ...assessment.overflow];
  if (outside.length === 0) {
    return null;
  }

  return {
    xbriefRelPath: xbriefRel,
    planId: input.planId,
    kind: "change-set-outside-approved-scope",
    expandedPaths: outside,
    detail:
      `changed paths outside membership allowlist (#4774 / #5192` +
      `${authority === "precommitment" ? "; concrete precommitment" : ""}` +
      `${authority === "forge-approval" ? "; forge-approved head brief (#6203)" : ""}` +
      `${assessment.overflow.length > 0 ? `; extras past allowance ${String(assessment.allowance)}` : ""}` +
      `): ${outside.join(", ")}; ${formatExtraPathRefusal(assessment)}`,
    remediation: `${remediationForOutsideMembership(outside, authority)} ${extraPathRemedy(assessment)}`,
  };
}
