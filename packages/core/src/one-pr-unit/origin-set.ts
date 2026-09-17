import type { OriginRef } from "./types.js";

/** Strip trailing slashes without a trailing-plus regex (CodeQL js/polynomial-redos). */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function normalizeRepo(repo: string): string {
  return stripTrailingSlashes(repo.trim()).toLowerCase();
}

export function originKey(origin: OriginRef): string {
  return `${normalizeRepo(origin.repo)}#${origin.issueId}`;
}

export function normalizeOrigin(repo: string, issueId: number): OriginRef {
  return { repo: normalizeRepo(repo), issueId };
}

export function uniqueOrigins(origins: readonly OriginRef[]): OriginRef[] {
  const seen = new Set<string>();
  const out: OriginRef[] = [];
  for (const origin of origins) {
    if (!Number.isInteger(origin.issueId) || origin.issueId < 1) {
      continue;
    }
    const normalized = normalizeOrigin(origin.repo, origin.issueId);
    const key = originKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }
  return out.sort((a, b) => originKey(a).localeCompare(originKey(b)));
}

/** Exact-set equality (not authz overlap matching). */
export function exactOriginSetEquals(
  left: readonly OriginRef[],
  right: readonly OriginRef[],
): boolean {
  const a = uniqueOrigins(left);
  const b = uniqueOrigins(right);
  if (a.length !== b.length) {
    return false;
  }
  return a.every((origin, idx) => originKey(origin) === originKey(b[idx] as OriginRef));
}

export function formatOriginSet(origins: readonly OriginRef[]): string {
  const unique = uniqueOrigins(origins);
  if (unique.length === 0) {
    return "(none)";
  }
  return unique.map(originKey).join(", ");
}
