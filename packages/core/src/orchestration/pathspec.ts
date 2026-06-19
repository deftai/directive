/**
 * Minimal gitignore-style glob matcher (#1419). Linear segment scanner — no
 * backtracking regex (CodeQL js/polynomial-redos safe).
 */

/** Normalise path separators to forward slashes. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function matchSegmentPattern(pattern: string, segment: string): boolean {
  let pi = 0;
  let si = 0;
  while (pi < pattern.length) {
    const pc = pattern[pi];
    if (pc === "*") {
      if (pattern[pi + 1] === "*") {
        return false;
      }
      pi += 1;
      while (si < segment.length) {
        if (matchSegmentPattern(pattern.slice(pi), segment.slice(si))) {
          return true;
        }
        si += 1;
      }
      return matchSegmentPattern(pattern.slice(pi), "");
    }
    if (pc === "?") {
      if (si >= segment.length) {
        return false;
      }
      pi += 1;
      si += 1;
      continue;
    }
    if (si >= segment.length || segment[si] !== pc) {
      return false;
    }
    pi += 1;
    si += 1;
  }
  return si === segment.length;
}

function splitSegments(path: string): string[] {
  const norm = normalizePath(path);
  if (norm.length === 0) {
    return [];
  }
  return norm.split("/").filter((s) => s.length > 0);
}

function matchSegments(
  patternSegs: string[],
  pathSegs: string[],
  pIdx: number,
  sIdx: number,
): boolean {
  if (pIdx >= patternSegs.length) {
    return sIdx >= pathSegs.length;
  }
  const pat = patternSegs[pIdx];
  if (pat === "**") {
    for (let skip = sIdx; skip <= pathSegs.length; skip += 1) {
      if (matchSegments(patternSegs, pathSegs, pIdx + 1, skip)) {
        return true;
      }
    }
    return false;
  }
  if (sIdx >= pathSegs.length) {
    return false;
  }
  if (!matchSegmentPattern(pat as string, pathSegs[sIdx] as string)) {
    return false;
  }
  return matchSegments(patternSegs, pathSegs, pIdx + 1, sIdx + 1);
}

/** True when *path* matches the glob *pattern* (anchored full-path match). */
export function matchPath(pattern: string, path: string): boolean {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return false;
  }
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  const patternSegs = splitSegments(pattern);
  const pathSegs = splitSegments(path);
  return matchSegments(patternSegs, pathSegs, 0, 0);
}

/** True when *path* matches any glob in *patterns*. */
export function matchAny(patterns: unknown, path: string): boolean {
  if (!Array.isArray(patterns)) {
    return false;
  }
  for (const p of patterns) {
    if (typeof p === "string" && p.length > 0 && matchPath(p, path)) {
      return true;
    }
  }
  return false;
}
