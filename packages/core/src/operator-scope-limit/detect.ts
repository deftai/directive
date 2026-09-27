import { SCOPE_LIMIT_PHRASES } from "./lexicon.js";

export interface DetectedScopeLimit {
  /** Matched lexicon phrase (canonical lowercase form). */
  readonly phrase: string;
  /** Index of the match in the lowercased prompt. */
  readonly index: number;
}

/**
 * Find the first (longest-preferred) scope-limit phrase in operator prompt text.
 * Returns null when none match — a returned miss, not a throw.
 */
export function detectScopeLimitPhrase(prompt: string): DetectedScopeLimit | null {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return null;
  }
  const lower = prompt.toLowerCase();
  let best: DetectedScopeLimit | null = null;
  for (const phrase of SCOPE_LIMIT_PHRASES) {
    const index = lower.indexOf(phrase);
    if (index < 0) continue;
    if (best === null || phrase.length > best.phrase.length) {
      best = { phrase, index };
    }
  }
  return best;
}

/**
 * Extract requirement lines from an operator prompt shaped like the #4545
 * greenfield fixture: bullets / numbered lines / plain "add|update|…" lines.
 *
 * Scans the whole prompt so an early ceiling phrase (`Initial version only:`
 * then `- add vehicle`) still keeps requirements that follow it. Scope-limit
 * sentences themselves are filtered out. Lines under exclusion headers
 * (`Out of scope:`, `Excluded:`, …) are not recorded as requirements, so a
 * shipped excluded action still warns. `beforeIndex` is accepted for call
 * compatibility and ignored for truncation.
 */
export function extractRequirementLines(
  prompt: string,
  _options: { readonly beforeIndex?: number } = {},
): string[] {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return [];
  }
  const lines = prompt.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  let inExclusionBlock = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const section = classifySectionHeader(trimmed);
    if (section === "exclusion") {
      inExclusionBlock = true;
      continue;
    }
    if (section === "inclusion") {
      inExclusionBlock = false;
      // Fall through — a header like "Requirements: add vehicle" is rare;
      // normally the header itself is not a requirement line.
    }

    if (inExclusionBlock) continue;

    const bullet = trimmed.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
    const candidate = bullet.trim();
    if (!looksLikeRequirementLine(candidate)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

const REQUIREMENT_VERB =
  /^(add|update|create|delete|remove|list|view|get|set|edit|record|track)\b/i;

/** Section headers that mark excluded / not-required content. */
const EXCLUSION_HEADER =
  /^(out of scope|excluded|exclusions|not in scope|do not include|beyond scope|non[- ]goals?)\b/i;

/** Section headers that resume recording requirements. */
const INCLUSION_HEADER = /^(requirements?|in scope|must|scope|accepted|include|features?)\b/i;

function classifySectionHeader(line: string): "exclusion" | "inclusion" | null {
  // Only treat short header-shaped lines (optional trailing colon).
  const header = line.replace(/:\s*$/, "").trim();
  if (header.length === 0 || header.length > 40) return null;
  // Bullet bodies are never section headers.
  if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) return null;
  if (EXCLUSION_HEADER.test(header)) return "exclusion";
  if (INCLUSION_HEADER.test(header)) return "inclusion";
  return null;
}

function looksLikeRequirementLine(line: string): boolean {
  if (line.length < 3 || line.length > 200) return false;
  // Skip the scope-limit sentences themselves if they leak into the slice.
  const lower = line.toLowerCase();
  if (lower.includes("do not add") || lower.includes("initial version only")) {
    return false;
  }
  if (lower.includes("nothing beyond") || lower.includes("requirements above")) {
    return false;
  }
  return REQUIREMENT_VERB.test(line);
}
