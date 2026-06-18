export const ALLOCATION_HEADING = "## Allocation context";

export const SOLO_KIND = "solo";
export const SWARM_COHORT_KIND = "swarm-cohort";

export const VALID_DISPATCH_KINDS = new Set([SOLO_KIND, SWARM_COHORT_KIND]);

const NULL_TOKENS = new Set(["", "null", "none", "n/a"]);

/** Strip a parsed field value; return null for null-equivalent tokens. */
export function normaliseValue(raw: string): string | null {
  let value = raw.trim();
  for (const pair of ["``", "`", '"', "'"] as const) {
    if (value.length >= 2 * pair.length && value.startsWith(pair) && value.endsWith(pair)) {
      value = value.slice(pair.length, value.length - pair.length).trim();
      break;
    }
  }
  if (NULL_TOKENS.has(value.toLowerCase())) {
    return null;
  }
  return value;
}

export type AllocationFields = Record<string, string | null>;

export type ParsedAllocation = readonly [found: boolean, fields: AllocationFields];

/**
 * Parse the `## Allocation context` section from a dispatch envelope.
 * Pure — no I/O. Never throws.
 */
export function parseAllocationSection(text: string | null | undefined): ParsedAllocation {
  if (text === null || text === undefined) {
    return [false, {}];
  }
  const lines = text.split(/\r?\n/);
  let headingIdx: number | null = null;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx]?.trim() === ALLOCATION_HEADING) {
      headingIdx = idx;
      break;
    }
  }
  if (headingIdx === null) {
    return [false, {}];
  }

  const fields: AllocationFields = {};
  for (const line of lines.slice(headingIdx + 1)) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      break;
    }
    if (!stripped.startsWith("- ") && !stripped.startsWith("* ")) {
      continue;
    }
    const body = stripped.slice(2);
    const colonIdx = body.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const key = body.slice(0, colonIdx).trim().replace(/`/g, "").trim();
    const value = body.slice(colonIdx + 1);
    if (key.length > 0) {
      fields[key] = normaliseValue(value);
    }
  }
  return [true, fields];
}
