/**
 * Fail-closed non-empty PROJECT-DEFINITION planning narratives (#5176).
 *
 * Init may still seed empty SKELETON_NARRATIVES; parsePhase2NarrativeDocument
 * may still accept "". This evaluator is the unconditional empty-bag bar used
 * by setup Phase 2 verify. Check applies the same bag only with a durable
 * product-mutation completion conjunct (mirror #4544) — scaffold-fresh empty
 * seeds stay legal on check. External score: DCR R.4668 /
 * agent.setup_answers_persisted_in_pd.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** D3 / Prefer-A tracked bag: Overview + tech stack (normalized). */
export const TRACKED_PLANNING_NARRATIVE_KEYS = ["overview", "techstack"] as const;

export const EMPTY_PLANNING_NARRATIVES_CAUSE =
  "PROJECT-DEFINITION planning narratives are all empty";

export const EMPTY_PLANNING_NARRATIVES_REMEDY =
  "Confirm Overview or tech stack, then store with deft project:write-narratives --narratives-file <path>";

export const MISSING_PROJECT_DEFINITION_CAUSE = "PROJECT-DEFINITION is missing";

export const MISSING_PROJECT_DEFINITION_REMEDY =
  "Run setup Phase 2 / deft project:write-narratives, or scaffold via directive init then fill narratives";

const ENV_PROJECT_PATH = "DEFT_PROJECT_PATH";
const CONFIGURED_PROJECT_DEFINITION_LABEL = "<configured PROJECT-DEFINITION>";

function resolveLayoutProjectDefinitionPath(projectRoot: string): string {
  const migrated = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  if (existsSync(migrated)) return migrated;
  const legacy = join(projectRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json");
  if (existsSync(legacy)) return legacy;
  return migrated;
}

export type PersistedPlanningNarrativesResult =
  | {
      readonly ok: true;
      readonly code: 0;
      readonly message: string;
      readonly persistedFields: number;
      readonly artifactLabel: string;
    }
  | {
      readonly ok: false;
      readonly code: 1;
      readonly message: string;
      readonly cause: string;
      readonly remedy: string;
      readonly persistedFields: number;
      readonly artifactLabel: string;
    }
  | {
      readonly ok: false;
      readonly code: 2;
      readonly message: string;
      readonly cause: string;
      readonly remedy: string;
      readonly persistedFields: number;
      readonly artifactLabel: string;
    };

function normalizeNarrativeKey(key: string): string {
  return (key ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveArtifact(projectRoot: string): { path: string; label: string } {
  const override = process.env[ENV_PROJECT_PATH]?.trim();
  if (override) {
    const configuredPath = resolve(projectRoot, override);
    const path = existsSync(configuredPath) ? realpathSync(configuredPath) : configuredPath;
    return { path, label: CONFIGURED_PROJECT_DEFINITION_LABEL };
  }
  const path = resolveLayoutProjectDefinitionPath(resolve(projectRoot));
  return { path, label: path };
}

/** Count tracked Overview/tech-stack values that are non-empty after trim. */
export function countNonEmptyTrackedPlanningNarratives(
  narratives: Record<string, unknown> | null | undefined,
): number {
  if (narratives === null || narratives === undefined) return 0;
  let count = 0;
  for (const [key, value] of Object.entries(narratives)) {
    if (typeof value !== "string") continue;
    const normalized = normalizeNarrativeKey(key);
    if (!(TRACKED_PLANNING_NARRATIVE_KEYS as readonly string[]).includes(normalized)) continue;
    if (value.trim().length > 0) count += 1;
  }
  return count;
}

/** Pure bag evaluation used by fixtures and callers with an in-memory plan. */
export function evaluateTrackedPlanningNarrativesBag(input: {
  readonly narratives: Record<string, unknown> | null | undefined;
  readonly artifactLabel?: string;
}): PersistedPlanningNarrativesResult {
  const artifactLabel = input.artifactLabel ?? "PROJECT-DEFINITION";
  const persistedFields = countNonEmptyTrackedPlanningNarratives(input.narratives);
  if (persistedFields > 0) {
    return {
      ok: true,
      code: 0,
      message: `OK: ${persistedFields} non-empty tracked PROJECT-DEFINITION planning narrative(s) at ${artifactLabel}`,
      persistedFields,
      artifactLabel,
    };
  }
  return {
    ok: false,
    code: 1,
    message:
      `verify:persisted-planning-narratives: ${EMPTY_PLANNING_NARRATIVES_CAUSE} at ${artifactLabel} (#5176)\n` +
      `  remedy: ${EMPTY_PLANNING_NARRATIVES_REMEDY}`,
    cause: EMPTY_PLANNING_NARRATIVES_CAUSE,
    remedy: EMPTY_PLANNING_NARRATIVES_REMEDY,
    persistedFields: 0,
    artifactLabel,
  };
}

/**
 * Fail closed when every tracked PD planning narrative is empty/whitespace.
 * Missing artifact is config (exit 2). Mid-setup parse may still accept "".
 */
export function evaluatePersistedPlanningNarratives(
  projectRoot: string,
): PersistedPlanningNarrativesResult {
  const { path: artifactPath, label: artifactLabel } = resolveArtifact(resolve(projectRoot));

  if (!existsSync(artifactPath)) {
    return {
      ok: false,
      code: 2,
      message:
        `verify:persisted-planning-narratives: ${MISSING_PROJECT_DEFINITION_CAUSE} at ${artifactLabel} (#5176)\n` +
        `  remedy: ${MISSING_PROJECT_DEFINITION_REMEDY}`,
      cause: MISSING_PROJECT_DEFINITION_CAUSE,
      remedy: MISSING_PROJECT_DEFINITION_REMEDY,
      persistedFields: 0,
      artifactLabel,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 2,
      message:
        `verify:persisted-planning-narratives: PROJECT-DEFINITION is not valid JSON at ${artifactLabel}: ${detail}\n` +
        `  remedy: ${EMPTY_PLANNING_NARRATIVES_REMEDY}`,
      cause: "PROJECT-DEFINITION is not valid JSON",
      remedy: EMPTY_PLANNING_NARRATIVES_REMEDY,
      persistedFields: 0,
      artifactLabel,
    };
  }

  const rootObj = asRecord(parsed);
  const plan = rootObj === null ? null : asRecord(rootObj.plan);
  const narratives = plan === null ? null : asRecord(plan.narratives);
  return evaluateTrackedPlanningNarrativesBag({ narratives, artifactLabel });
}
