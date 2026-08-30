import type { AcceptanceClause } from "../verify-ac/clauses.js";

/**
 * Product-first done-gate (#3284): stated acceptance criteria run FIRST and are
 * never skippable; hygiene gates run second and may degrade under pressure.
 *
 * Architecture for #3267 (literal acceptance-command mechanism). Composes
 * #3214 ceremony dial (rapid = AC-only) and #3266 bank-the-pass.
 */

/** Three-rung AC-source ladder (probe lock on #3284). */
export type AcSourceRung = "stated" | "derived" | "project_floor";

/**
 * One executable acceptance command (verbatim when source_rung=stated).
 * Mirrors literal-acceptance command shape for interoperability.
 */
export interface AcceptanceCommand {
  readonly command: string;
  readonly cwd?: string | null;
  readonly expectedStdout?: string | null;
  readonly expectedExitCode?: number;
}

/**
 * Canonical plan.acceptance block (#3284).
 *
 * - Empty `commands` is allowed only when `none_stated: true` (absence is a decision).
 * - `none_stated: true` never means "no AC" — it means AC is derived/floor and flagged.
 * - `source_rung` records which ladder rung was locked at intake / promote.
 */
export interface PlanAcceptance {
  readonly commands: readonly AcceptanceCommand[];
  /** Explicit marker when the task statement stated no shell commands. */
  readonly none_stated: boolean;
  readonly source_rung: AcSourceRung;
  /** Why derived/floor was chosen (required for derived when recorded). */
  readonly derived_reason?: string | null;
  /** Rung-2 independently testable clauses (#3323). Parallel to commands[]. */
  readonly clauses?: readonly AcceptanceClause[];
}

/** How `task check` composes product vs hygiene gates under pressure (#3284). */
export type ProductFirstCheckMode =
  /** Full graph: AC first (fail-fast), then hygiene (hard), then suite. */
  | "full"
  /**
   * Budget pressure / degraded env: AC still mandatory; hygiene runs but is
   * advisory (non-zero does not fail check). Suite still runs after AC when present.
   */
  | "pressure"
  /**
   * Ceremony dial rapid/minimal positive content: only AC verification
   * (no hygiene, no suite) before declaring done via check.
   */
  | "rapid";

/** Canonical product AC gate id used in check gate lists. */
export const PRODUCT_AC_GATE_ID = "verify:ac" as const;

/** plan.acceptance object key on the plan root. */
export const PLAN_ACCEPTANCE_KEY = "acceptance" as const;

/** Env override for check mode (full|pressure|rapid|degraded→pressure). */
export const ENV_CHECK_MODE = "DEFT_CHECK_MODE";

/** Explicit hygiene-advisory flag (truthy → pressure mode floor). */
export const ENV_HYGIENE_ADVISORY = "DEFT_HYGIENE_ADVISORY";

/** Explicit rapid AC-only flag (truthy → rapid mode). */
export const ENV_CHECK_AC_ONLY = "DEFT_CHECK_AC_ONLY";

/**
 * Hygiene gate ids (framework + consumer). Failures may become advisory under
 * pressure; AC never does. Suite gates are separate (#3188).
 */
export const HYGIENE_GATE_ID_PREFIXES: readonly string[] = [
  "verify:branch",
  "verify:encoding",
  "verify:cache-fresh",
  "verify:orphan-active",
  "verify:license-sync",
  "verify:contract-drift",
  "toolchain:check",
  "toolchain:check-consumer",
  "verify:stubs",
  "verify:links",
  "verify:rule-ownership",
  "verify:biome-config",
  "verify:content-manifest",
  "verify:deposit-closure",
  "verify:skill-external-fetch-gate",
  "verify:semantic-single-source",
  "verify:cursor-tier1",
  "verify:openclaw-tier1",
  "verify:go-freeze",
  "verify:bridge-drift",
  "verify:forward-coverage",
  "verify:test-boundary",
  "verify:scope-provenance",
  "verify:consumer-check-contract",
  "verify:vbrief-conformance",
  "verify:destructive-gh-verbs",
  "verify:scm-boundary",
  "verify:xbrief-drift",
  "verify:no-task-runtime",
  "verify:pack-drift",
  "verify:wip-cap",
  "verify:agents-md-budget",
  "verify:eval-health-relocation",
  "verify:eval-triggers-relocation",
  "vbrief:validate",
  "codebase:validate-structure",
  "verify:codebase-map-fresh",
  "verify-strategy-output",
  "doctor",
];
