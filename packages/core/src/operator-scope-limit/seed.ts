import { detectScopeLimitPhrase, extractRequirementLines } from "./detect.js";
import {
  OPERATOR_SCOPE_CEILING_PLAN_KEY,
  OPERATOR_SCOPE_CEILING_SCHEMA,
  type OperatorScopeCeiling,
  type SeedCeilingResult,
} from "./types.js";

/**
 * Record an explicit operator scope-limit phrase as a hard ceiling, even when
 * rapid/greenfield has no prior xbrief/active brief (#4545 item 1).
 *
 * On hit: returns a durable ceiling artifact and, when `brief` is supplied,
 * a copy of that brief with the ceiling under plan.metadata and requirement
 * lines preserved for the surface check to read.
 * On miss: returned failure (no throw).
 */
export function seedOperatorScopeCeiling(
  prompt: string,
  brief: Record<string, unknown> | null = null,
): SeedCeilingResult {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return {
      ok: false,
      reason: "empty-prompt",
      detail: "operator prompt is empty; no scope-limit ceiling recorded",
    };
  }

  const detected = detectScopeLimitPhrase(prompt);
  if (detected === null) {
    return {
      ok: false,
      reason: "no-scope-limit-phrase",
      detail:
        "operator prompt has no closed-lexicon scope-limit phrase " +
        '("do not add", "nothing beyond", "initial version only", …)',
    };
  }

  const requirementLines = extractRequirementLines(prompt, {
    beforeIndex: detected.index,
  });

  const ceiling: OperatorScopeCeiling = {
    schema: OPERATOR_SCOPE_CEILING_SCHEMA,
    matchedPhrase: detected.phrase,
    requirementLines,
    source: "operator-prompt",
  };

  if (brief === null) {
    return { ok: true, ceiling, brief: null, artifact: ceiling };
  }

  return {
    ok: true,
    ceiling,
    brief: applyCeilingToBrief(brief, ceiling),
    artifact: ceiling,
  };
}

/**
 * Write ceiling + requirement lines onto a brief plan.metadata copy.
 * Does not mutate the input object.
 */
export function applyCeilingToBrief(
  brief: Record<string, unknown>,
  ceiling: OperatorScopeCeiling,
): Record<string, unknown> {
  const planRaw = brief.plan;
  const plan =
    planRaw !== null && typeof planRaw === "object" && !Array.isArray(planRaw)
      ? { ...(planRaw as Record<string, unknown>) }
      : {};
  const metaRaw = plan.metadata;
  const metadata =
    metaRaw !== null && typeof metaRaw === "object" && !Array.isArray(metaRaw)
      ? { ...(metaRaw as Record<string, unknown>) }
      : {};

  metadata[OPERATOR_SCOPE_CEILING_PLAN_KEY] = {
    schema: ceiling.schema,
    matchedPhrase: ceiling.matchedPhrase,
    requirementLines: [...ceiling.requirementLines],
    source: ceiling.source,
  };

  // Keep requirement lines where the surface check (and agents) can read them
  // without a second extractor — pain-audit sharpening on #4545.
  if (ceiling.requirementLines.length > 0) {
    const narrativesRaw = plan.narratives;
    const narratives =
      narrativesRaw !== null &&
      typeof narrativesRaw === "object" &&
      !Array.isArray(narrativesRaw)
        ? { ...(narrativesRaw as Record<string, unknown>) }
        : {};
    if (
      typeof narratives.Requirements !== "string" ||
      narratives.Requirements.trim().length === 0
    ) {
      narratives.Requirements = ceiling.requirementLines.map((line) => `- ${line}`).join("\n");
    }
    plan.narratives = narratives;
  }

  plan.metadata = metadata;
  return { ...brief, plan };
}

/** Read a previously seeded ceiling from brief plan.metadata, or null. */
export function readCeilingFromBrief(
  brief: Record<string, unknown> | null | undefined,
): OperatorScopeCeiling | null {
  if (brief === null || brief === undefined) return null;
  const plan = brief.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return null;
  const metadata = (plan as Record<string, unknown>).metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Record<string, unknown>)[OPERATOR_SCOPE_CEILING_PLAN_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== OPERATOR_SCOPE_CEILING_SCHEMA) return null;
  if (typeof obj.matchedPhrase !== "string" || obj.matchedPhrase.trim().length === 0) {
    return null;
  }
  if (obj.source !== "operator-prompt") return null;
  const linesRaw = obj.requirementLines;
  if (!Array.isArray(linesRaw)) return null;
  const requirementLines = linesRaw.filter(
    (line): line is string => typeof line === "string" && line.trim().length > 0,
  );
  return {
    schema: OPERATOR_SCOPE_CEILING_SCHEMA,
    matchedPhrase: obj.matchedPhrase,
    requirementLines,
    source: "operator-prompt",
  };
}
