/**
 * Catalog chip ensure-on-write + deposit/judgmentGates helpers (#5326 Prefer-A Bound).
 *
 * Miss classes: missing-repo-label (recoverable ensure) vs auth-or-permission
 * (non-blocking). Ensure-refuse falls through as ensure-failed without blocking ingest.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_CRITIQUE_GATE_ID,
  DESIGN_CRITIQUE_MARKER_LABEL,
  resolveJudgmentGates,
} from "../orchestration/judgment-policy.js";
import { GhRestError, type GhRestSeams, restCreateLabel, restGetLabel } from "../scm/gh-rest.js";
import {
  DESIGN_CRITIQUE_CATALOG_CHIPS,
  type DesignCritiqueCatalogChip,
  isDesignCritiqueCatalogChip,
} from "./exclusive-chip.js";

/** Closed chip-apply miss classes (#5326). */
export type ChipApplyMissClass = "missing-repo-label" | "auth-or-permission" | "ensure-failed";

export const CHIP_MISS_CLASS_MISSING_REPO_LABEL = "missing-repo-label" as const;
export const CHIP_MISS_CLASS_AUTH_OR_PERMISSION = "auth-or-permission" as const;
export const CHIP_MISS_CLASS_ENSURE_FAILED = "ensure-failed" as const;

/** Fixed create table for the three catalog chips (D20 restCreateLabel precedent). */
export const DESIGN_CRITIQUE_CATALOG_CHIP_CREATE_TABLE: Readonly<
  Record<
    DesignCritiqueCatalogChip,
    {
      readonly name: DesignCritiqueCatalogChip;
      readonly color: string;
      readonly description: string;
    }
  >
> = {
  "design-critique:mechanism-shaped": {
    name: "design-critique:mechanism-shaped",
    color: "5319E7",
    description: "Design-critique in-flight; judgmentGates match (ADR-005)",
  },
  "design-critique:in-progress": {
    name: "design-critique:in-progress",
    color: "FBCA04",
    description: "Design-critique live after panel-deposit or critic; not gate-matched",
  },
  "design-critique:ingest-ready": {
    name: "design-critique:ingest-ready",
    color: "0E8A16",
    description:
      "Design-critique bind chip after complete completed-arc record; not ingest clearance",
  },
};

export const DESIGN_CRITIQUE_JUDGMENT_GATE_ENTRY = {
  id: DESIGN_CRITIQUE_GATE_ID,
  class: "declared",
  tier: "review",
  reason:
    "Triage author stamped mechanism-shaped (ADR-005). Record clearance line " +
    "design-critique: warranted | not warranted, because ... Presence, shape, and " +
    "authority only; never content. Advisory/observe; requiredHumanReviewers reserved " +
    "for block tier post-observe.",
  match: {
    labels: {
      "any-of": [DESIGN_CRITIQUE_MARKER_LABEL],
    },
  },
} as const;

const DEPOSIT_SKILL_RELS = [
  "content/skills/deft-directive-design-critique/SKILL.md",
  ".deft/core/skills/deft-directive-design-critique/SKILL.md",
  ".deft/core/.agents/skills/deft-directive-design-critique/SKILL.md",
] as const;

const DEPOSIT_CONTRACT_RELS = [
  "content/contracts/design-critique.md",
  ".deft/core/contracts/design-critique.md",
] as const;

const DEPOSIT_ADR_RELS = [
  "docs/decisions/ADR-005-design-critique-judgment-gate.md",
  ".deft/core/docs/decisions/ADR-005-design-critique-judgment-gate.md",
] as const;

/** Closed deposit predicate (#5326 Bound item 6). */
export function isDesignCritiqueDeposited(projectRoot: string): boolean {
  for (const rel of [...DEPOSIT_SKILL_RELS, ...DEPOSIT_CONTRACT_RELS, ...DEPOSIT_ADR_RELS]) {
    if (existsSync(join(projectRoot, rel))) {
      return true;
    }
  }
  return false;
}

/**
 * True when typed judgmentGates includes design-critique matching
 * mechanism-shaped on labels.any-of / labels.all-of — not body-text.
 */
export function hasDesignCritiqueJudgmentGate(projectRoot: string): boolean {
  const policy = resolveJudgmentGates(projectRoot);
  return policy.gates.some((g) => {
    if (g.gate_id !== DESIGN_CRITIQUE_GATE_ID) {
      return false;
    }
    const labelsPred = g.match.labels;
    if (typeof labelsPred !== "object" || labelsPred === null || Array.isArray(labelsPred)) {
      return false;
    }
    const lp = labelsPred as Record<string, unknown>;
    const selected = lp["any-of"] ?? lp["all-of"];
    if (!Array.isArray(selected)) {
      return false;
    }
    return selected.some(
      (label) => typeof label === "string" && label === DESIGN_CRITIQUE_MARKER_LABEL,
    );
  });
}

export function formatDesignCritiqueJudgmentGatesRemediation(): string {
  return (
    `design-critique judgmentGates dark: add plan.policy.judgmentGates entry ` +
    `id=${DESIGN_CRITIQUE_GATE_ID} matching labels.any-of ` +
    `${DESIGN_CRITIQUE_MARKER_LABEL} (maintainer PROJECT-DEFINITION shape). ` +
    `No pin-present durable policy writer for judgmentGates in v1; doctor/setup ` +
    `advisory names this remediation. Chips stay convenience; completed-arc remains ingest SoT.`
  );
}

/**
 * gh api exits process status 1 for HTTP 404 (not exit=404). Detect the HTTP
 * status from stderr; exitCode 404 remains accepted for seams/tests.
 */
export function isMissingLabelHttp404(exitCode: number, stderr = ""): boolean {
  if (exitCode === 404) {
    return true;
  }
  if (exitCode !== 1) {
    return false;
  }
  const lower = stderr.toLowerCase();
  return (
    lower.includes("(http 404)") ||
    lower.includes("http 404") ||
    /"status"\s*:\s*"?404"?/.test(stderr)
  );
}

/**
 * Classify a preflight label GET outcome. HTTP 404 → missing-repo-label;
 * 401/403/other → auth-or-permission. Real `gh api` missing-label path is
 * exit 1 + HTTP 404 in stderr (#5326 Greptile P1).
 */
export function classifyLabelProbeStatus(exitCode: number, stderr = ""): ChipApplyMissClass {
  if (isMissingLabelHttp404(exitCode, stderr)) {
    return CHIP_MISS_CLASS_MISSING_REPO_LABEL;
  }
  return CHIP_MISS_CLASS_AUTH_OR_PERMISSION;
}

export function classifyLabelProbeError(err: unknown): ChipApplyMissClass {
  if (err instanceof GhRestError) {
    return classifyLabelProbeStatus(err.exitCode, err.stderr);
  }
  return CHIP_MISS_CLASS_AUTH_OR_PERMISSION;
}

export type LabelProbeResult =
  | { readonly present: true }
  | { readonly present: false; readonly missClass: ChipApplyMissClass };

export function probeCatalogChipLabel(
  repo: string,
  chip: DesignCritiqueCatalogChip,
  seams: GhRestSeams = {},
): LabelProbeResult {
  try {
    restGetLabel(repo, chip, seams);
    return { present: true };
  } catch (err: unknown) {
    return { present: false, missClass: classifyLabelProbeError(err) };
  }
}

export type EnsureCatalogChipResult =
  | { readonly ok: true; readonly created: boolean; readonly skippedExisting: boolean }
  | {
      readonly ok: false;
      readonly missClass:
        | typeof CHIP_MISS_CLASS_AUTH_OR_PERMISSION
        | typeof CHIP_MISS_CLASS_ENSURE_FAILED;
      readonly error: string;
    };

/**
 * Preflight GET then restCreateLabel for a closed catalog chip in the add set.
 * Idempotent 422 / already_exists → skip. Auth/permission create fail → ensure-failed.
 */
export function ensureCatalogChipLabel(
  repo: string,
  chip: string,
  seams: GhRestSeams = {},
): EnsureCatalogChipResult {
  if (!isDesignCritiqueCatalogChip(chip)) {
    return {
      ok: false,
      missClass: CHIP_MISS_CLASS_AUTH_OR_PERMISSION,
      error: `not a design-critique catalog chip: ${chip}`,
    };
  }
  const probe = probeCatalogChipLabel(repo, chip, seams);
  if (probe.present) {
    return { ok: true, created: false, skippedExisting: true };
  }
  if (probe.missClass !== CHIP_MISS_CLASS_MISSING_REPO_LABEL) {
    return {
      ok: false,
      missClass: CHIP_MISS_CLASS_AUTH_OR_PERMISSION,
      error: `label probe ${probe.missClass} for ${chip}`,
    };
  }
  const row = DESIGN_CRITIQUE_CATALOG_CHIP_CREATE_TABLE[chip];
  try {
    restCreateLabel(repo, row.name, row.color, row.description, seams);
    return { ok: true, created: true, skippedExisting: false };
  } catch (err: unknown) {
    if (err instanceof GhRestError) {
      const stderr = err.stderr.toLowerCase();
      if (stderr.includes("already_exists") || err.exitCode === 422) {
        return { ok: true, created: false, skippedExisting: true };
      }
      return {
        ok: false,
        missClass: CHIP_MISS_CLASS_ENSURE_FAILED,
        error: err.stderr || err.message,
      };
    }
    return {
      ok: false,
      missClass: CHIP_MISS_CLASS_ENSURE_FAILED,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Catalog chips covered by the create table (fixture lock). */
export function catalogChipCreateTableNames(): readonly DesignCritiqueCatalogChip[] {
  return DESIGN_CRITIQUE_CATALOG_CHIPS;
}
