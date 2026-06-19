import { DEFAULT_MAX_LEN, WINDOWS_RESERVED } from "./constants.js";

export { DEFAULT_MAX_LEN, WINDOWS_RESERVED };

function stripCheckboxMarkers(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const atBoundary = i === 0 || text[i - 1] === " " || text[i - 1] === "\t";
    if (atBoundary && text[i] === "[" && i + 2 < text.length && text[i + 2] === "]") {
      const mid = text[i + 1];
      if (mid === " " || mid === "x" || mid === "X") {
        out += " ";
        i += 3;
        continue;
      }
    }
    out += text[i] ?? "";
    i += 1;
  }
  return out;
}

function collapseNonAlnum(text: string): string {
  let out = "";
  let lastHyphen = false;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const isAlnum = (lower >= "a" && lower <= "z") || (lower >= "0" && lower <= "9");
    if (isAlnum) {
      out += lower;
      lastHyphen = false;
    } else if (!lastHyphen) {
      out += "-";
      lastHyphen = true;
    }
  }
  return out;
}

function stripEdgeHyphens(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "-") start += 1;
  while (end > start && text[end - 1] === "-") end -= 1;
  return text.slice(start, end);
}

function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let truncated = text.slice(0, maxLen);
  const nextChar = text[maxLen];
  if (nextChar !== "-") {
    const lastHyphen = truncated.lastIndexOf("-");
    if (lastHyphen > Math.floor(maxLen / 2)) {
      truncated = truncated.slice(0, lastHyphen);
    }
  }
  return stripEdgeHyphens(truncated);
}

/** Return a filesystem-safe slug (mirrors scripts/slug_normalize.py). */
export function normalizeSlug(text: string | null | undefined, maxLen = DEFAULT_MAX_LEN): string {
  if (!text) return "untitled";
  let limit = maxLen;
  if (limit < 1) limit = DEFAULT_MAX_LEN;

  const decomposed = text.normalize("NFKD");
  let asciiOnly = "";
  for (const ch of decomposed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0300 && code <= 0x036f) continue;
    if (code <= 0x7f) asciiOnly += ch;
  }

  const lowered = asciiOnly.toLowerCase();
  const stripped = stripCheckboxMarkers(lowered);
  const hyphenated = collapseNonAlnum(stripped);
  let trimmed = stripEdgeHyphens(hyphenated);
  if (trimmed.length > limit) trimmed = truncateAtWordBoundary(trimmed, limit);
  if (!trimmed) return "untitled";
  if (WINDOWS_RESERVED.has(trimmed)) return `${trimmed}-scope`;
  return trimmed;
}

/** Return a collision-free slug relative to `existing`. */
export function disambiguateSlug(
  slug: string,
  existing: ReadonlySet<string> | readonly string[],
  options: { maxLen?: number } = {},
): string {
  const maxLen = options.maxLen ?? DEFAULT_MAX_LEN;
  const taken = existing instanceof Set ? existing : new Set(existing);
  if (!taken.has(slug)) return slug;

  const base = slug;
  let n = 2;
  while (n <= 10_000) {
    const suffix = `-${n}`;
    let candidate = base + suffix;
    if (candidate.length > maxLen) {
      const bodyBudget = Math.max(1, maxLen - suffix.length);
      const trimmed = stripEdgeHyphens(base.slice(0, bodyBudget)) || base.slice(0, bodyBudget);
      candidate = trimmed + suffix;
    }
    if (!taken.has(candidate)) return candidate;
    n += 1;
  }
  throw new Error(
    `disambiguateSlug: unable to resolve collision for ${JSON.stringify(slug)} after ${n} attempts`,
  );
}
