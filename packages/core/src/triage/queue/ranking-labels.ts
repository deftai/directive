import { DEFAULT_TRIAGE_RANKING_LABELS, PROJECT_DEFINITION_REL_PATH } from "./constants.js";
import { loadProjectDefinition } from "./project.js";

/** Resolve effective plan.policy.triageRankingLabels list. */
export function resolveRankingLabels(projectRoot: string): readonly string[] {
  const data = loadProjectDefinition(projectRoot);
  if (data === null) {
    return [...DEFAULT_TRIAGE_RANKING_LABELS];
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null) {
    return [...DEFAULT_TRIAGE_RANKING_LABELS];
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null) {
    return [...DEFAULT_TRIAGE_RANKING_LABELS];
  }
  const value = (policy as Record<string, unknown>).triageRankingLabels;
  if (!Array.isArray(value) || value.length === 0) {
    return [...DEFAULT_TRIAGE_RANKING_LABELS];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** Validate plan.policy.triageRankingLabels payload. */
export function validateRankingLabels(value: unknown): {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (value === null || value === undefined) {
    return { errors, warnings };
  }
  if (!Array.isArray(value)) {
    errors.push(`plan.policy.triageRankingLabels must be a list of strings; got ${typeof value}`);
    return { errors, warnings };
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    const prefix = `plan.policy.triageRankingLabels[${i}]`;
    if (typeof entry !== "string") {
      errors.push(`${prefix} must be a string, got ${typeof entry}`);
      continue;
    }
    if (entry.trim().length === 0) {
      errors.push(`${prefix} must be a non-empty string`);
      continue;
    }
    if (seen.has(entry)) {
      warnings.push(`${prefix} duplicate label '${entry}'; only the first occurrence ranks`);
    }
    seen.add(entry);
  }
  return { errors, warnings };
}

export { PROJECT_DEFINITION_REL_PATH };
