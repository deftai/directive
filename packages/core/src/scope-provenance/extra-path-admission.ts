/**
 * Shared extra-path admission (#6221).
 *
 * One rule for the three checks that read a story's `file_scope`: the story
 * write fence (PreToolUse), membership and the Path-independent production
 * fence of `verify:scope-provenance`. Each caller supplies the allowlist and
 * its authority:
 *
 * - `mint`: a human-stamped mint allowlist; glob entries match.
 * - `concrete`: agent precommitment (merge-base brief, forge-approved head
 *   brief); only concrete entries match, a glob match is an extra.
 *
 * Extras are classified as production, test, fixture or other. Production
 * extras spend the allowance (`productionAllowance`, floor 2, cap 5). Test and
 * fixture extras spend the same pool only when they modify a path that exists
 * on the base; an add, delete or rename (or an unknown change kind) is refused.
 * Other-class extras are refused at membership and the write fence and
 * ignored on the Path-independent check (named residual). Free paths never
 * spend. Past the allowance every check refuses with
 * {@link EXTRA_PATHS_OVER_BUDGET_TOKEN}.
 */

import { type DeclaredRefusalLine, formatDeclaredRefusal } from "../refusal-declarations/print.js";
import type { RefusalDeclaration } from "../refusal-declarations/table.js";
import {
  DEFAULT_FIXTURE_ROOTS,
  DEFAULT_SOURCE_ROOTS,
  DEFAULT_TEST_ROOTS,
} from "../test-boundary/policy.js";
import {
  concreteProductionScopeEntries,
  isConcreteFileScopeEntry,
  isProductionRootPath,
  isUnderConfiguredRoot,
  pathMatchesFileScope,
  productionAllowance,
} from "./base-fence.js";
import { normalizeFileScope } from "./digest.js";

/** Reason token for extras past the allowance, the same on every check (#6221). */
export const EXTRA_PATHS_OVER_BUDGET_TOKEN = "extra-paths-over-budget";
/** Reason token for an extra the budget never admits (#6221). */
export const EXTRA_PATH_NOT_ADMITTED_TOKEN = "extra-path-not-admitted";

/** Declared refusal rows for the two budget refusals (#6221 / #6281). */
export const EXTRA_PATH_NOT_ADMITTED_REFUSAL_ID = "extra-path-not-admitted";
export const EXTRA_PATHS_OVER_BUDGET_REFUSAL_ID = "extra-paths-over-budget";

export type ExtraPathClass = "production" | "test" | "fixture" | "other";
export type ExtraPathSpend = "spent" | "free" | "hard-refused";
export type ExtraPathAuthority = "mint" | "concrete";
/** Change of one path against the base. `null`: unknown (refused for test/fixture). */
export type ExtraPathChangeKind = "modify" | "add" | "delete";

export interface ExtraPathEntry {
  readonly path: string;
  readonly pathClass: ExtraPathClass;
  readonly spend: ExtraPathSpend;
  /** Short reason, e.g. `modify`, `add`, `ignored on the Path-independent check`. */
  readonly note: string;
}

export interface ExtraPathAssessment {
  readonly authority: ExtraPathAuthority;
  readonly allowance: number;
  readonly concreteBaseCount: number;
  readonly entries: readonly ExtraPathEntry[];
  /** Paths that spend the allowance, in change-set order. */
  readonly spent: readonly string[];
  /** Spending paths past the allowance. */
  readonly overflow: readonly string[];
  /** Paths the budget never admits. */
  readonly refused: readonly string[];
}

export interface AssessExtraPathsInput {
  /** Allowlist paths are matched against (own plus any peer union). */
  readonly allowlist: readonly string[];
  /**
   * Second list a declared path must also match, under the same authority
   * (#6221). The Path-independent check and the write fence pass the
   * merge-base brief here when a mint is present, so a broader mint does not
   * widen the merge-base brief fence (#5192).
   */
  readonly alsoAllowlist?: readonly string[];
  /** Entries whose concrete production count sets the allowance (default: allowlist). */
  readonly allowanceScope?: readonly string[];
  readonly authority: ExtraPathAuthority;
  readonly changedPaths: readonly string[];
  /** Change kind against the base; absent or null means unknown. */
  readonly changeKind?: (relPath: string) => ExtraPathChangeKind | null;
  /** Free paths never count as extras (bound brief, CHANGELOG, lifecycle exempts). */
  readonly isFree?: (relPath: string) => boolean;
  /** `refuse` at membership and the write fence; `ignore` on the Path-independent check. */
  readonly otherClass: "refuse" | "ignore";
  readonly testRoots?: readonly string[];
  readonly fixtureRoots?: readonly string[];
  readonly sourceRoots?: readonly string[];
}

function normalizeRel(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Class of one undeclared path; test and fixture win over source roots. */
export function classifyExtraPath(
  relPath: string,
  roots: {
    readonly testRoots?: readonly string[];
    readonly fixtureRoots?: readonly string[];
    readonly sourceRoots?: readonly string[];
  } = {},
): ExtraPathClass {
  const rel = normalizeRel(relPath);
  if (isUnderConfiguredRoot(rel, roots.fixtureRoots ?? DEFAULT_FIXTURE_ROOTS)) return "fixture";
  if (isUnderConfiguredRoot(rel, roots.testRoots ?? DEFAULT_TEST_ROOTS)) return "test";
  if (isProductionRootPath(rel, roots.sourceRoots ?? DEFAULT_SOURCE_ROOTS)) return "production";
  return "other";
}

function matchesOne(rel: string, list: readonly string[], authority: ExtraPathAuthority): boolean {
  if (authority === "mint") return pathMatchesFileScope(rel, list);
  for (const entry of list) {
    if (!isConcreteFileScopeEntry(entry)) continue;
    if (normalizeRel(entry) === rel) return true;
  }
  return false;
}

/**
 * True when `relPath` matches the allowlist under `authority` (and the
 * optional second list, under the same authority).
 */
export function matchesExtraPathAllowlist(
  relPath: string,
  allowlist: readonly string[],
  authority: ExtraPathAuthority,
  alsoAllowlist?: readonly string[],
): boolean {
  const rel = normalizeRel(relPath);
  if (!matchesOne(rel, allowlist, authority)) return false;
  return alsoAllowlist === undefined || matchesOne(rel, alsoAllowlist, authority);
}

/**
 * Assess the extra paths of one change set (#6221). Pure: callers supply the
 * change kind and free-path predicate.
 */
export function assessExtraPaths(input: AssessExtraPathsInput): ExtraPathAssessment {
  const allowlist = normalizeFileScope(input.allowlist);
  const also =
    input.alsoAllowlist !== undefined ? normalizeFileScope(input.alsoAllowlist) : undefined;
  const roots = {
    testRoots: input.testRoots ?? DEFAULT_TEST_ROOTS,
    fixtureRoots: input.fixtureRoots ?? DEFAULT_FIXTURE_ROOTS,
    sourceRoots: input.sourceRoots ?? DEFAULT_SOURCE_ROOTS,
  };
  const concreteBase = concreteProductionScopeEntries(
    normalizeFileScope(input.allowanceScope ?? input.allowlist),
    roots,
  );
  const allowance = productionAllowance(concreteBase.length);

  const entries: ExtraPathEntry[] = [];
  const spent: string[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.changedPaths) {
    const rel = normalizeRel(raw);
    if (rel.length === 0 || seen.has(rel)) continue;
    seen.add(rel);
    if (input.isFree?.(rel) === true) continue;
    if (matchesExtraPathAllowlist(rel, allowlist, input.authority, also)) continue;
    const pathClass = classifyExtraPath(rel, roots);
    if (pathClass === "production") {
      if (!isConcreteFileScopeEntry(rel)) {
        entries.push({
          path: rel,
          pathClass,
          spend: "hard-refused",
          note: "glob characters in path",
        });
        refused.push(rel);
        continue;
      }
      entries.push({ path: rel, pathClass, spend: "spent", note: "production extra" });
      spent.push(rel);
      continue;
    }
    if (pathClass === "test" || pathClass === "fixture") {
      const kind = input.changeKind?.(rel) ?? null;
      if (kind === "modify") {
        entries.push({
          path: rel,
          pathClass,
          spend: "spent",
          note: "modify of a path on the base",
        });
        spent.push(rel);
        continue;
      }
      const note =
        kind === null
          ? "change kind unknown (only a modify of a path on the base is admitted)"
          : `${kind} (only a modify of a path on the base is admitted)`;
      entries.push({ path: rel, pathClass, spend: "hard-refused", note });
      refused.push(rel);
      continue;
    }
    if (input.otherClass === "ignore") {
      entries.push({
        path: rel,
        pathClass,
        spend: "free",
        note: "ignored on the Path-independent check; refused at membership and the write fence",
      });
      continue;
    }
    entries.push({
      path: rel,
      pathClass,
      spend: "hard-refused",
      note: "not source, test or fixture",
    });
    refused.push(rel);
  }

  return {
    authority: input.authority,
    allowance,
    concreteBaseCount: concreteBase.length,
    entries,
    spent,
    overflow: spent.length > allowance ? spent.slice(allowance) : [],
    refused,
  };
}

/** True when the assessment admits every extra. */
export function extraPathsAdmitted(assessment: ExtraPathAssessment): boolean {
  return assessment.overflow.length === 0 && assessment.refused.length === 0;
}

/**
 * One refusal line shared by the three checks: the reason token, the paths and
 * what each would spend (#6221).
 */
export function formatExtraPathRefusal(assessment: ExtraPathAssessment): string {
  const parts: string[] = [];
  if (assessment.overflow.length > 0) {
    parts.push(
      `${EXTRA_PATHS_OVER_BUDGET_TOKEN}: ${String(assessment.spent.length)} extra path(s) spend ` +
        `the allowance ${String(assessment.allowance)} (concreteBase=${String(assessment.concreteBaseCount)}); ` +
        `past the allowance: ${assessment.overflow.join(", ")}`,
    );
  }
  if (assessment.refused.length > 0) {
    const detail = assessment.entries
      .filter((e) => e.spend === "hard-refused")
      .map((e) => `${e.path} (${e.pathClass}: ${e.note})`)
      .join(", ");
    parts.push(`${EXTRA_PATH_NOT_ADMITTED_TOKEN}: ${detail}`);
  }
  return parts.join("; ");
}

/** Remedy shared by the three checks (#6221). */
export function extraPathRemedy(assessment: ExtraPathAssessment): string {
  const glob =
    assessment.authority === "concrete" ? " or replace glob entries with concrete paths" : "";
  return (
    "Split the extra paths to a follow-up story, or land a widened concrete brief on the base" +
    `${glob} (#6221 / #5192). Only a modify of an existing test or fixture path spends the allowance; ` +
    "a new, deleted or renamed test or fixture path outside file_scope needs the brief to name it."
  );
}

/**
 * Declare the refusal through the shared #6281 helper. Both new #6221 refusals
 * (a path the budget never admits, extras past the allowance) are table rows
 * that warn for one release: `proceed` is true in `warn` mode and the caller
 * prints the line and lets the work continue. In `enforce` mode the same line is
 * the refusal.
 */
export function declaredExtraPathRefusal(
  assessment: ExtraPathAssessment,
  kind: "not-admitted" | "over-budget",
  detail: string,
  rows?: readonly RefusalDeclaration[],
  /** Write-fence override (#6914); membership and the Path-independent check keep the shared remedy. */
  remedy: string = extraPathRemedy(assessment),
): DeclaredRefusalLine {
  return formatDeclaredRefusal({
    id:
      kind === "not-admitted"
        ? EXTRA_PATH_NOT_ADMITTED_REFUSAL_ID
        : EXTRA_PATHS_OVER_BUDGET_REFUSAL_ID,
    detail: `${detail} ${remedy}`,
    ...(rows !== undefined ? { rows } : {}),
  });
}

/** Success-path lines: each extra with its class and spend (#6221 P4). */
export function formatExtraPathReport(
  label: string,
  surface: string,
  assessment: ExtraPathAssessment,
): string[] {
  const shown = assessment.entries.filter((e) => e.spend !== "hard-refused");
  if (shown.length === 0) return [];
  const spentCount = shown.filter((e) => e.spend === "spent").length;
  const head =
    `verify_scope_provenance: extra paths for ${label} (${surface}; ` +
    `${String(spentCount)} of allowance ${String(assessment.allowance)} spent):`;
  return [
    head,
    ...shown.map((e) => `  - ${e.path} class=${e.pathClass} spend=${e.spend} (${e.note})`),
  ];
}
