/**
 * Consumer-environment evidence for ceremony-dial escalation (#3358).
 *
 * Session:start left `taskSize` and `modelTier` null unless CLI flags or
 * provisional env/verb/file hints were set. Consumer runs then always
 * declined with "insufficient evidence (size=- modelTier=-)".
 *
 * This module fills at least one input the consumer environment can supply:
 *   1. stamped #3323 clause count on active/pending briefs (size proxy)
 *   2. host-supplied model-tier env (`DEFT_HOST_MODEL_TIER` and aliases)
 *   3. failing-gate count env (mid-session size proxy)
 *
 * ⊗ Change the rapid default or decline threshold when no evidence exists.
 * Explicit CLI / session inputs still win at the merge site.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CeremonyDialInputs,
  type CeremonyModelTier,
  type CeremonyTaskSize,
  ENV_CEREMONY_MODEL_HINT,
  ENV_CEREMONY_MODEL_TIER,
  normalizeCeremonyModelTier,
} from "../policy/ceremony-dial.js";

/** Host-supplied model-tier hint when `DEFT_CEREMONY_MODEL_TIER` is unset. */
export const ENV_HOST_MODEL_TIER = "DEFT_HOST_MODEL_TIER";
/** Mid-session failing-gate count the consumer/harness can supply. */
export const ENV_FAILING_GATE_COUNT = "DEFT_FAILING_GATE_COUNT";

const LIFECYCLE_DIRS = ["active", "pending"] as const;

export interface CeremonyDialConsumerEvidence {
  readonly taskSize: CeremonyTaskSize | null;
  readonly modelTier: CeremonyModelTier | null;
  readonly clauseCount: number | null;
  readonly failingGateCount: number | null;
  readonly reasons: readonly string[];
}

export function taskSizeFromClauseCount(count: number): CeremonyTaskSize | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) return "S";
  if (count <= 3) return "M";
  if (count <= 6) return "L";
  return "XL";
}

export function taskSizeFromFailingGateCount(count: number): CeremonyTaskSize | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count <= 2) return "M";
  return "L";
}

function rankSize(size: CeremonyTaskSize): number {
  switch (size) {
    case "S":
      return 0;
    case "M":
      return 1;
    case "L":
      return 2;
    case "XL":
      return 3;
    default:
      return 0;
  }
}

function maxSize(a: CeremonyTaskSize | null, b: CeremonyTaskSize | null): CeremonyTaskSize | null {
  if (a === null) return b;
  if (b === null) return a;
  return rankSize(a) >= rankSize(b) ? a : b;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function clauseCountFromBrief(raw: unknown): number | null {
  const root = asRecord(raw);
  const plan = asRecord(root?.plan);
  const acceptance = asRecord(plan?.acceptance);
  if (acceptance === null) return null;
  if (Array.isArray(acceptance.clauses) && acceptance.clauses.length > 0) {
    return acceptance.clauses.length;
  }
  const stamped = acceptance.clause_count;
  if (typeof stamped === "number" && Number.isFinite(stamped) && stamped > 0) {
    return stamped;
  }
  return null;
}

function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.trunc(raw);
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

/** Max stamped clause count across `xbrief/{active,pending}` (#3323). */
export function readStampedClauseCount(projectRoot: string): {
  readonly count: number;
  readonly source: string;
} | null {
  let best: { count: number; source: string } | null = null;
  for (const dir of LIFECYCLE_DIRS) {
    const folder = join(projectRoot, "xbrief", dir);
    if (!existsSync(folder)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".xbrief.json") || name === "PROJECT-DEFINITION.xbrief.json") {
        continue;
      }
      const path = join(folder, name);
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        const count = clauseCountFromBrief(parsed);
        if (count === null) continue;
        if (best === null || count > best.count) {
          best = { count, source: `xbrief/${dir}/${name}` };
        }
      } catch {
        // fail-open — a malformed brief is not an evidence source
      }
    }
  }
  return best;
}

export function collectCeremonyDialConsumerEvidence(
  projectRoot: string,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): CeremonyDialConsumerEvidence {
  const env = options.env ?? process.env;
  const reasons: string[] = [];

  const stamped = readStampedClauseCount(projectRoot);
  const clauseCount = stamped?.count ?? null;
  let taskSize: CeremonyTaskSize | null = null;
  if (stamped !== null) {
    const fromClauses = taskSizeFromClauseCount(stamped.count);
    if (fromClauses !== null) {
      taskSize = fromClauses;
      reasons.push(
        `taskSize=${fromClauses} from stamped clauseCount=${stamped.count} (${stamped.source})`,
      );
    }
  }

  const failingGateCount = parseNonNegativeInt(env[ENV_FAILING_GATE_COUNT]);
  if (failingGateCount !== null) {
    const fromGates = taskSizeFromFailingGateCount(failingGateCount);
    if (fromGates !== null) {
      const next = maxSize(taskSize, fromGates);
      if (next !== taskSize) {
        taskSize = next;
        reasons.push(`taskSize=${next} from failingGateCount=${failingGateCount}`);
      } else if (taskSize === fromGates) {
        reasons.push(`failingGateCount=${failingGateCount} (size already ${taskSize})`);
      }
    }
  }

  const modelTier = normalizeCeremonyModelTier(
    env[ENV_HOST_MODEL_TIER] ?? env[ENV_CEREMONY_MODEL_TIER] ?? env[ENV_CEREMONY_MODEL_HINT],
  );
  if (modelTier !== null) {
    reasons.push(`modelTier=${modelTier} from host env`);
  }

  return {
    taskSize,
    modelTier,
    clauseCount,
    failingGateCount,
    reasons,
  };
}

/** Explicit non-null wins; consumer evidence fills only missing fields. */
export function mergeCeremonyDialInputsWithConsumerEvidence(
  explicit: CeremonyDialInputs | undefined,
  evidence: CeremonyDialConsumerEvidence,
): CeremonyDialInputs {
  return {
    taskSize: explicit?.taskSize ?? evidence.taskSize ?? null,
    modelTier: explicit?.modelTier ?? evidence.modelTier ?? null,
    projectShape: explicit?.projectShape ?? null,
  };
}

export function formatCeremonyDialEvidenceLine(
  evidence: CeremonyDialConsumerEvidence,
): string | null {
  if (evidence.reasons.length === 0) return null;
  return `[deft ceremony-dial] evidence: ${evidence.reasons.join("; ")}`;
}

export function ceremonyDialEvidenceToDict(
  evidence: CeremonyDialConsumerEvidence,
): Record<string, unknown> {
  return {
    taskSize: evidence.taskSize,
    modelTier: evidence.modelTier,
    clauseCount: evidence.clauseCount,
    failingGateCount: evidence.failingGateCount,
    reasons: [...evidence.reasons],
  };
}
