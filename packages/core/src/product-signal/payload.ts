import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ActorNameSource } from "./actor-name.js";
import type { ProductSignalHarness } from "./install-context.js";

export const PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION = 1 as const;
export const LOCAL_SIGNAL_SUMMARY_SCHEMA_VERSION = 1 as const;
export const SKILLS_SUMMARY_SCHEMA_VERSION = 1 as const;

export const MAX_PAYLOAD_JSON_BYTES = 64_000;
export const MAX_HUMAN_ANSWERS = 3;
export const MAX_ANSWER_LENGTH = 2_000;
export const MAX_FREE_TEXT_LENGTH = 4_000;
export const MAX_AGENT_NOTES_LENGTH = 2_000;

export type ProductSignalSurface = "pulse" | "portrait";

export interface HumanAnswer {
  readonly q: string;
  readonly a: string;
}

export interface ProductSignalHuman {
  readonly nps: number | null;
  readonly answers: readonly HumanAnswer[];
  readonly freeText: string | null;
}

export interface ValueFeedbackSummary {
  readonly enabled: boolean;
  readonly total: number;
  readonly byClass: {
    readonly value: number;
    readonly bypass: number;
    readonly adoption: number;
    readonly friction: number;
  };
  readonly topEvents: readonly { readonly name: string; readonly count: number }[];
}

export interface EvalHealthSummary {
  readonly score: number | null;
  readonly contradictionCount: number | null;
  readonly collectedAt: string | null;
}

export interface HelpedHealthSummary {
  readonly helpedCount: number | null;
  readonly healthEntryCount: number | null;
  readonly window: string;
}

export interface LocalSignalSummary {
  readonly schemaVersion: typeof LOCAL_SIGNAL_SUMMARY_SCHEMA_VERSION;
  readonly window: string;
  readonly valueFeedback: ValueFeedbackSummary | null;
  readonly evalHealth: EvalHealthSummary | null;
  readonly helpedHealth: HelpedHealthSummary | null;
}

export interface SkillsSummaryEntry {
  readonly skill: string;
  readonly useCount: number;
  readonly viewCount: number;
  readonly lastUsed: string | null;
}

export interface SkillsSummary {
  readonly schemaVersion: typeof SKILLS_SUMMARY_SCHEMA_VERSION;
  readonly top: readonly SkillsSummaryEntry[];
  readonly skillCount: number;
}

export interface ProductSignalPayload {
  readonly schemaVersion: typeof PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION;
  readonly surface: ProductSignalSurface;
  readonly installId: string;
  readonly actorName: string;
  readonly actorNameSource: ActorNameSource;
  readonly directiveVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly shell: string;
  readonly harness: ProductSignalHarness;
  readonly harnessVersion: string | null;
  readonly consentTier: string;
  readonly consentSource: "user" | "org-policy" | "typed-override";
  readonly consentVersion: string;
  readonly human: ProductSignalHuman;
  readonly agentNotes: string | null;
  readonly localSignalSummary: LocalSignalSummary | null;
  readonly skillsSummary: SkillsSummary | null;
  readonly collectedAt: string;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  /\bBEGIN (?:RSA |EC )?PRIVATE KEY\b/,
  /\b\.env\b/,
];

function containsSecretHygieneViolation(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

function isValidNps(value: unknown): value is number | null {
  if (value === null) {
    return true;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10;
}

/** Client-side payload validation before submit (#2693 D7). */
export function validateProductSignalPayload(payload: ProductSignalPayload): string[] {
  const errors: string[] = [];
  if (payload.schemaVersion !== PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION}`);
  }
  if (payload.surface !== "pulse" && payload.surface !== "portrait") {
    errors.push("surface must be pulse or portrait");
  }
  if (payload.installId.trim().length === 0) {
    errors.push("installId is required");
  }
  if (payload.actorName.trim().length === 0) {
    errors.push("actorName is required");
  }
  if (!isValidNps(payload.human.nps)) {
    errors.push("human.nps must be null or integer 0-10");
  }
  if (payload.human.answers.length > MAX_HUMAN_ANSWERS) {
    errors.push(`human.answers exceeds max ${MAX_HUMAN_ANSWERS}`);
  }
  for (const answer of payload.human.answers) {
    if (answer.q.length === 0 || answer.a.length === 0) {
      errors.push("human.answers entries require non-empty q and a");
    }
    if (answer.a.length > MAX_ANSWER_LENGTH) {
      errors.push(`human answer exceeds max length ${MAX_ANSWER_LENGTH}`);
    }
  }
  if (payload.human.freeText !== null && payload.human.freeText.length > MAX_FREE_TEXT_LENGTH) {
    errors.push(`human.freeText exceeds max length ${MAX_FREE_TEXT_LENGTH}`);
  }
  if (payload.agentNotes !== null && payload.agentNotes.length > MAX_AGENT_NOTES_LENGTH) {
    errors.push(`agentNotes exceeds max length ${MAX_AGENT_NOTES_LENGTH}`);
  }

  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    errors.push(`payload exceeds max size ${MAX_PAYLOAD_JSON_BYTES} bytes`);
  }
  if (containsSecretHygieneViolation(serialized)) {
    errors.push("payload failed secret-hygiene scan");
  }
  return errors;
}

/** Optional #829 sidecar path (read-only attach; emit not implemented here). */
export const SKILLS_TELEMETRY_SIDECAR_REL = join(".deft-cache", "skills-telemetry.json");

/** Read minimized skillsSummary when local sidecar exists (#2693 D14). */
export function readSkillsSummarySidecar(projectRoot: string): SkillsSummary | null {
  const path = resolve(projectRoot, SKILLS_TELEMETRY_SIDECAR_REL);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    const topRaw = rec.top;
    if (!Array.isArray(topRaw)) {
      return null;
    }
    const top: SkillsSummaryEntry[] = [];
    for (const item of topRaw.slice(0, 10)) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const skill = typeof row.skill === "string" ? row.skill.trim() : "";
      if (skill.length === 0) {
        continue;
      }
      top.push({
        skill,
        useCount: typeof row.useCount === "number" ? row.useCount : 0,
        viewCount: typeof row.viewCount === "number" ? row.viewCount : 0,
        lastUsed: typeof row.lastUsed === "string" ? row.lastUsed : null,
      });
    }
    const skillCount = typeof rec.skillCount === "number" ? rec.skillCount : top.length;
    return {
      schemaVersion: SKILLS_SUMMARY_SCHEMA_VERSION,
      top,
      skillCount,
    };
  } catch {
    return null;
  }
}
