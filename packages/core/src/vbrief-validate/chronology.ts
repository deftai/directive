/**
 * created/updated chronology lint (#4423).
 *
 * Envelope and plan clocks are optional author-asserted fields. When both
 * parse as datetimes and updated predates created, emit a warning. Does not
 * walk plan.items: lifecycle never writes item created/updated/completed.
 */
import { VALID_INFO_ROOT_KEYS } from "./constants.js";
import type { JsonObject } from "./schema.js";

function parseDateTime(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function warnIfUpdatedPredatesCreated(
  displayPath: string,
  location: string,
  obj: JsonObject,
  warnings: string[],
): void {
  const createdRaw = obj.created;
  const updatedRaw = obj.updated;
  const createdAt = parseDateTime(createdRaw);
  const updatedAt = parseDateTime(updatedRaw);
  if (createdAt === null || updatedAt === null) {
    return;
  }
  if (updatedAt.getTime() < createdAt.getTime()) {
    warnings.push(
      `${displayPath}: ${location}.updated (${String(updatedRaw)}) predates ` +
        `${location}.created (${String(createdRaw)})`,
    );
  }
}

/** Warn when envelope or plan `updated` predates `created`. Never inspects items. */
export function validateCreatedUpdatedChronology(data: JsonObject, displayPath: string): string[] {
  const warnings: string[] = [];
  for (const key of VALID_INFO_ROOT_KEYS) {
    const env = data[key];
    if (typeof env === "object" && env !== null && !Array.isArray(env)) {
      warnIfUpdatedPredatesCreated(displayPath, key, env as JsonObject, warnings);
    }
  }
  const plan = data.plan;
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    warnIfUpdatedPredatesCreated(displayPath, "plan", plan as JsonObject, warnings);
  }
  return warnings;
}
