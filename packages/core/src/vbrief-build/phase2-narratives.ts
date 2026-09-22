import { existsSync } from "node:fs";
import {
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  MIGRATED_INFO_ROOT_KEY,
  VBRIEF_VERSION,
} from "../xbrief-migrate/constants.js";
import { projectDefinitionArtifactLabel } from "./project-definition-io.js";
import type { ProjectDefinitionMutation } from "./project-definition-mutation.js";
import type { JsonObject } from "./types.js";

/** Phase 2 interview narrative keys. Policy keys are not in this set. */
export const PHASE2_NARRATIVE_KEYS = [
  "Overview",
  "TechStack",
  "Strategy",
  "Quality",
  "ProjectRules",
  "Branching",
] as const;

export type Phase2NarrativeKey = (typeof PHASE2_NARRATIVE_KEYS)[number];

export type Phase2Narratives = Record<Phase2NarrativeKey, string>;

/** Narrative payload for the Phase 2 writer. Title is not a policy key. */
export interface Phase2NarrativeWrite {
  readonly narratives: Phase2Narratives;
  readonly title?: string;
}

export type Phase2ApplyResult =
  | { readonly ok: true; readonly data: JsonObject; readonly message: string }
  | { readonly ok: false; readonly message: string };

function asRecord(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Read a flat six-key object, or a PROJECT-DEFINITION-shaped document.
 * Nested `plan.narratives` wins when present. Policy blocks are ignored.
 */
export function parsePhase2NarrativeDocument(
  value: unknown,
): { narratives: Phase2Narratives; title?: string } | { error: string } {
  const root = asRecord(value);
  if (root === null) return { error: "Phase 2 narratives file must be a JSON object" };
  const plan = asRecord(root.plan);
  const nested = plan === null ? null : asRecord(plan.narratives);
  const source = nested ?? root;
  const narratives = {} as Phase2Narratives;
  for (const key of PHASE2_NARRATIVE_KEYS) {
    const field = source[key];
    if (typeof field !== "string") {
      return { error: `Phase 2 narrative ${key} must be a string` };
    }
    narratives[key] = field;
  }
  const title = plan !== null && typeof plan.title === "string" ? plan.title : undefined;
  return title === undefined ? { narratives } : { narratives, title };
}

function envelopeFor(artifactPath: string): { key: string; version: string } {
  if (artifactPath.endsWith(LEGACY_ARTIFACT_SUFFIX)) {
    return { key: LEGACY_INFO_ROOT_KEY, version: VBRIEF_VERSION };
  }
  return { key: MIGRATED_INFO_ROOT_KEY, version: VBRIEF_VERSION };
}

function createIdentity(artifactPath: string, write: Phase2NarrativeWrite): JsonObject {
  const envelope = envelopeFor(artifactPath);
  const now = isoNow();
  const plan: JsonObject = {
    title: write.title ?? "PROJECT-DEFINITION",
    status: "running",
    narratives: { ...write.narratives },
    items: [],
  };
  return {
    [envelope.key]: {
      version: envelope.version,
      description: "Project identity gestalt",
      created: now,
    },
    plan,
  };
}

/**
 * Build the next PROJECT-DEFINITION object with the six Phase 2 strings.
 * Does not persist, and does not assign policy keys.
 */
export function applyPhase2Narratives(
  mutation: ProjectDefinitionMutation,
  write: Phase2NarrativeWrite,
): Phase2ApplyResult {
  const label = projectDefinitionArtifactLabel(mutation.artifactPath);
  if (!existsSync(mutation.artifactPath)) {
    return {
      ok: true,
      data: createIdentity(mutation.artifactPath, write),
      message: `stored Phase 2 narratives (created) at ${label}`,
    };
  }

  let data: JsonObject;
  try {
    data = mutation.load();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }

  let plan = asRecord(data.plan);
  if (plan === null) {
    if (data.plan !== undefined) {
      return { ok: false, message: "PROJECT-DEFINITION plan is not an object" };
    }
    plan = {};
    data.plan = plan;
  }

  let narratives = asRecord(plan.narratives);
  if (narratives === null) {
    if (plan.narratives !== undefined) {
      return { ok: false, message: "PROJECT-DEFINITION narratives is not an object" };
    }
    narratives = {};
    plan.narratives = narratives;
  }

  for (const key of PHASE2_NARRATIVE_KEYS) {
    narratives[key] = write.narratives[key];
  }
  if (write.title !== undefined) {
    plan.title = write.title;
  }
  return {
    ok: true,
    data,
    message: `stored Phase 2 narratives (updated) at ${label}`,
  };
}
