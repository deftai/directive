/**
 * Typed hotfix classifier (#1193 R2 / Wave 2 of #2948).
 *
 * Hard structural predicates — not agent judgement. Agent may propose the
 * label `hotfix-candidate` only; a human promotes to `hotfix`. Pipeline keys
 * off `hotfix` exclusively; `hotfix-candidate` has zero pipeline meaning.
 */

import type { HotfixCriteria } from "@deftai/directive-types";
import { matchAny } from "../orchestration/pathspec.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_HOTFIX_CRITERIA = "plan.policy.hotfixCriteria";
export const FIELD_HOTFIX_CRITERIA_CLI_ALIAS = "hotfixCriteria";

/** Agent-proposed beacon only — never pipeline-authorizing. */
export const HOTFIX_CANDIDATE_LABEL = "hotfix-candidate" as const;
/** Human-promoted label; deploy pipeline keys off this exclusively. */
export const HOTFIX_LABEL = "hotfix" as const;

export const DEFAULT_HOTFIX_MAX_LINES = 10;
export const DEFAULT_HOTFIX_MAX_FILES = 2;

/** Paths that never qualify as hotfix (deploy / CI / migrations / secrets). */
export const DEFAULT_FORBIDDEN_PATH_GLOBS: readonly string[] = [
  "Dockerfile",
  "**/Dockerfile",
  "fly.toml",
  "**/fly.toml",
  ".github/workflows/**",
  "migrations/**",
  "**/migrations/**",
  "**/*secret*",
  "**/*billing*",
  "**/.env",
  "**/.env.*",
  "**/auth/**",
  "**/secrets/**",
];

export const DEFAULT_HOTFIX_CRITERIA: Required<HotfixCriteria> = {
  maxLines: DEFAULT_HOTFIX_MAX_LINES,
  maxFiles: DEFAULT_HOTFIX_MAX_FILES,
  forbiddenPathGlobs: DEFAULT_FORBIDDEN_PATH_GLOBS,
};

export interface HotfixEligibilityInput {
  /** Total lines added+removed (or equivalent structural line count). */
  readonly linesChanged: number;
  /** Distinct files touched. */
  readonly filesChanged: number;
  /** Project-relative POSIX paths in the diff. */
  readonly paths: readonly string[];
  /** Pure revert of a prior change — always eligible. */
  readonly isPureRevert?: boolean;
  /** One-character / trivial edit signal (always eligible when true with restoresGreen). */
  readonly isOneCharacterEdit?: boolean;
  /** Refactors of any size are never hotfix. */
  readonly isRefactor?: boolean;
  /** New package / dependency entries. */
  readonly addsNewDependency?: boolean;
  /** Adds, removes, or renames an exported symbol/surface. */
  readonly changesExportedSurface?: boolean;
  /** Schema or migration changes. */
  readonly touchesSchemaOrMigration?: boolean;
  /** New handler/route/media-type surface. */
  readonly addsNewHandlerOrRoute?: boolean;
  /** Build was green on main; this change restores green. */
  readonly restoresGreen?: boolean;
  /** Criteria override (defaults + project typed policy). */
  readonly criteria?: HotfixCriteria | null;
}

export type HotfixDenyReason =
  | "refactor"
  | "new-export"
  | "new-dependency"
  | "schema-migration"
  | "new-handler-route"
  | "forbidden-path"
  | "too-many-lines"
  | "too-many-files"
  | "not-restoring-green";

export interface HotfixEligibilityResult {
  readonly eligible: boolean;
  /** When eligible, the agent may apply this label only. */
  readonly proposedLabel: typeof HOTFIX_CANDIDATE_LABEL | null;
  readonly reasons: readonly string[];
  readonly denyCodes: readonly HotfixDenyReason[];
  readonly criteria: Required<HotfixCriteria>;
}

function normalizeCriteria(raw: HotfixCriteria | null | undefined): Required<HotfixCriteria> {
  const maxLines =
    typeof raw?.maxLines === "number" && Number.isInteger(raw.maxLines) && raw.maxLines >= 0
      ? raw.maxLines
      : DEFAULT_HOTFIX_MAX_LINES;
  const maxFiles =
    typeof raw?.maxFiles === "number" && Number.isInteger(raw.maxFiles) && raw.maxFiles >= 0
      ? raw.maxFiles
      : DEFAULT_HOTFIX_MAX_FILES;
  const forbidden =
    Array.isArray(raw?.forbiddenPathGlobs) && raw.forbiddenPathGlobs.length > 0
      ? raw.forbiddenPathGlobs.filter((g): g is string => typeof g === "string" && g.length > 0)
      : DEFAULT_FORBIDDEN_PATH_GLOBS;
  return { maxLines, maxFiles, forbiddenPathGlobs: forbidden };
}

function pathIsForbidden(path: string, globs: readonly string[]): boolean {
  const posix = path.replace(/\\/g, "/");
  // Basename-only defaults (Dockerfile, fly.toml) match any depth.
  const base = posix.includes("/") ? posix.slice(posix.lastIndexOf("/") + 1) : posix;
  for (const g of globs) {
    if (!g.includes("/") && !g.includes("*") && base === g) return true;
  }
  return matchAny(globs, posix);
}

/**
 * Pure hotfix eligibility evaluator (#1193 R2).
 *
 * Eligible (agent may propose `hotfix-candidate`):
 * - pure revert always
 * - one-character edit that restores green
 * - small fix: ≤ maxLines AND ≤ maxFiles, no new deps/exports/schema, no forbidden
 *   paths, not a refactor, restores green
 *
 * Never eligible: refactors, new handlers/routes, export surface changes, forbidden paths.
 */
export function evaluateHotfixEligibility(input: HotfixEligibilityInput): HotfixEligibilityResult {
  const criteria = normalizeCriteria(input.criteria);
  const denyCodes: HotfixDenyReason[] = [];
  const reasons: string[] = [];

  if (input.isPureRevert === true) {
    return {
      eligible: true,
      proposedLabel: HOTFIX_CANDIDATE_LABEL,
      reasons: ["pure-revert always qualifies as hotfix-candidate"],
      denyCodes: [],
      criteria,
    };
  }

  if (input.isOneCharacterEdit === true && input.restoresGreen !== false) {
    return {
      eligible: true,
      proposedLabel: HOTFIX_CANDIDATE_LABEL,
      reasons: ["one-character edit that restores green qualifies as hotfix-candidate"],
      denyCodes: [],
      criteria,
    };
  }

  if (input.isRefactor === true) {
    denyCodes.push("refactor");
    reasons.push("refactors of any size are never hotfix");
  }
  if (input.changesExportedSurface === true) {
    denyCodes.push("new-export");
    reasons.push("exported surface add/remove/rename is never hotfix");
  }
  if (input.addsNewDependency === true) {
    denyCodes.push("new-dependency");
    reasons.push("new dependencies are never hotfix");
  }
  if (input.touchesSchemaOrMigration === true) {
    denyCodes.push("schema-migration");
    reasons.push("schema/migration changes are never hotfix");
  }
  if (input.addsNewHandlerOrRoute === true) {
    denyCodes.push("new-handler-route");
    reasons.push("new handlers/routes/media types are never hotfix");
  }

  for (const p of input.paths) {
    if (pathIsForbidden(p, criteria.forbiddenPathGlobs)) {
      denyCodes.push("forbidden-path");
      reasons.push(`forbidden path: ${p}`);
      break;
    }
  }

  if (input.linesChanged > criteria.maxLines) {
    denyCodes.push("too-many-lines");
    reasons.push(`linesChanged ${input.linesChanged} > maxLines ${criteria.maxLines}`);
  }
  if (input.filesChanged > criteria.maxFiles) {
    denyCodes.push("too-many-files");
    reasons.push(`filesChanged ${input.filesChanged} > maxFiles ${criteria.maxFiles}`);
  }

  // Small-fix path requires restoring green unless pure-revert/one-char already returned.
  if (input.restoresGreen === false) {
    denyCodes.push("not-restoring-green");
    reasons.push("change does not restore green on main");
  }

  if (denyCodes.length > 0) {
    return {
      eligible: false,
      proposedLabel: null,
      reasons,
      denyCodes,
      criteria,
    };
  }

  return {
    eligible: true,
    proposedLabel: HOTFIX_CANDIDATE_LABEL,
    reasons: [
      `small fix within limits (≤${criteria.maxLines} lines, ≤${criteria.maxFiles} files); ` +
        "agent may apply hotfix-candidate only — human promotes hotfix",
    ],
    denyCodes: [],
    criteria,
  };
}

/** Resolve typed hotfixCriteria from a raw policy block value. */
export function resolveHotfixCriteria(raw: unknown): Required<HotfixCriteria> {
  if (raw === null || raw === undefined) return { ...DEFAULT_HOTFIX_CRITERIA };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_HOTFIX_CRITERIA };
  return normalizeCriteria(raw as HotfixCriteria);
}

export interface HotfixCriteriaPolicyField {
  readonly name: string;
  readonly current: Required<HotfixCriteria>;
  readonly default: Required<HotfixCriteria>;
  readonly source: string;
}

/** Inspector row for `policy:show --field=hotfixCriteria`. */
export function inspectHotfixCriteria(
  data: Record<string, unknown> | null,
): HotfixCriteriaPolicyField {
  const defaults = { ...DEFAULT_HOTFIX_CRITERIA };
  if (data === null) {
    return { name: FIELD_HOTFIX_CRITERIA, current: defaults, default: defaults, source: "default" };
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hotfixCriteria" in (policyBlock as Record<string, unknown>))
  ) {
    return { name: FIELD_HOTFIX_CRITERIA, current: defaults, default: defaults, source: "default" };
  }
  return {
    name: FIELD_HOTFIX_CRITERIA,
    current: resolveHotfixCriteria((policyBlock as Record<string, unknown>).hotfixCriteria),
    default: defaults,
    source: "typed",
  };
}

/** Load hotfix criteria from project root. */
export function loadHotfixCriteriaFromProject(projectRoot: string): Required<HotfixCriteria> {
  const [data] = loadProjectDefinition(projectRoot);
  if (data === null) return { ...DEFAULT_HOTFIX_CRITERIA };
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("hotfixCriteria" in (policyBlock as Record<string, unknown>))
  ) {
    return { ...DEFAULT_HOTFIX_CRITERIA };
  }
  return resolveHotfixCriteria((policyBlock as Record<string, unknown>).hotfixCriteria);
}
