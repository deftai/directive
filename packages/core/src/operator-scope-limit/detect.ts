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
 * greenfield fixture: bullets / numbered lines / plain "add|update|…" lines
 * that appear before the scope-limit sentence (or the whole prompt when no
 * phrase is present — callers that need a ceiling still gate on detect).
 */
export function extractRequirementLines(
  prompt: string,
  options: { readonly beforeIndex?: number } = {},
): string[] {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return [];
  }
  const slice =
    typeof options.beforeIndex === "number" && options.beforeIndex >= 0
      ? prompt.slice(0, options.beforeIndex)
      : prompt;
  const lines = slice.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
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
