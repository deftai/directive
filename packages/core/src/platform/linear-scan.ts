/** ReDoS-safe linear scanners shared by platform parsers. */

/** Return true when `ch` is ASCII word character [A-Za-z0-9_]. */
export function isWordChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** Case-insensitive compare of `text.slice(pos, pos+needle.length)` to `needle`. */
export function matchAt(text: string, pos: number, needle: string): boolean {
  if (pos + needle.length > text.length) return false;
  return text.slice(pos, pos + needle.length).toLowerCase() === needle.toLowerCase();
}

/** Find first case-insensitive occurrence of `needle` starting at `from`. */
export function indexOfIgnoreCase(text: string, needle: string, from = 0): number {
  const lower = text.toLowerCase();
  const nLower = needle.toLowerCase();
  return lower.indexOf(nLower, from);
}

/** Word-boundary match for `term` at `pos` in `text` (ASCII heuristic). */
export function wordBoundaryMatch(text: string, pos: number, term: string): boolean {
  if (!matchAt(text, pos, term)) return false;
  const before = pos > 0 ? (text[pos - 1] ?? "") : "";
  const after = pos + term.length < text.length ? (text[pos + term.length] ?? "") : "";
  if (before && isWordChar(before)) return false;
  if (after && isWordChar(after)) return false;
  return true;
}

/** Scan `text` for the first word-boundary occurrence of any `term`. */
export function findFirstTerm(
  text: string,
  terms: readonly string[],
  from = 0,
): { term: string; index: number } | null {
  let best: { term: string; index: number } | null = null;
  for (const term of terms) {
    let pos = from;
    while (pos <= text.length - term.length) {
      const idx = indexOfIgnoreCase(text, term, pos);
      if (idx < 0) break;
      if (wordBoundaryMatch(text, idx, term)) {
        if (best === null || idx < best.index) {
          best = { term: text.slice(idx, idx + term.length), index: idx };
        }
        break;
      }
      pos = idx + 1;
    }
  }
  return best;
}

/** Parse `<!-- deft:managed-section vN [attrs] -->` at `startIdx` (must point at '<'). */
export function parseManagedOpenMarker(
  text: string,
  startIdx: number,
): { end: number; version: number; attrsRaw: string } | null {
  if (text.slice(startIdx, startIdx + 4) !== "<!--") return null;
  let i = startIdx + 4;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  const marker = "deft:managed-section";
  if (!matchAt(text, i, marker)) return null;
  i += marker.length;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  if (text[i] !== "v") return null;
  i += 1;
  const versionChar = text[i];
  if (versionChar !== "1" && versionChar !== "2" && versionChar !== "3") return null;
  const version = Number(versionChar);
  i += 1;
  const attrsStart = i;
  while (i < text.length) {
    if (text[i] === "-" && text[i + 1] === "-" && text[i + 2] === ">") {
      const attrsRaw = text.slice(attrsStart, i).trim();
      return { end: i + 3, version, attrsRaw };
    }
    i += 1;
  }
  return null;
}

/** Find next managed-section open marker from `from`. */
export function findManagedOpenMarker(
  text: string,
  from = 0,
): { start: number; version: number; attrsRaw: string; end: number } | null {
  let pos = from;
  while (pos < text.length) {
    const idx = text.indexOf("<!--", pos);
    if (idx < 0) return null;
    const parsed = parseManagedOpenMarker(text, idx);
    if (parsed !== null) {
      return { start: idx, version: parsed.version, attrsRaw: parsed.attrsRaw, end: parsed.end };
    }
    pos = idx + 1;
  }
  return null;
}

/** Match line against `^## [name]` without regex backtracking. */
export function parseSectionHeader(line: string): string | null {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  if (line.slice(i, i + 3) !== "## ") return null;
  i += 3;
  if (line[i] !== "[") return null;
  i += 1;
  const start = i;
  while (i < line.length && line[i] !== "]") i += 1;
  if (i >= line.length) return null;
  return line.slice(start, i);
}

/** Match line against `^### name` without regex. */
export function parseSubsectionHeader(line: string): string | null {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  if (line.slice(i, i + 4) !== "### ") return null;
  i += 4;
  const start = i;
  while (i < line.length && line[i] !== "\r" && line[i] !== "\n") i += 1;
  const name = line.slice(start, i).trim();
  return name.length > 0 ? name : null;
}

/** True when line starts a bullet entry (`-` or `*` with optional indent). */
export function isEntryBulletLine(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (line[i] !== "-" && line[i] !== "*") return false;
  i += 1;
  if (i >= line.length) return false;
  return line[i] === " " || line[i] === "\t";
}

/** Extract all `(#NNN)` issue numbers from text via linear scan. */
export function extractIssueNumbers(text: string): Set<string> {
  const nums = new Set<string>();
  let i = 0;
  while (i < text.length) {
    if (text[i] === "(" && text[i + 1] === "#") {
      let j = i + 2;
      let digits = "";
      while (j < text.length) {
        const ch = text[j] ?? "";
        if (ch >= "0" && ch <= "9") {
          digits += ch;
          j += 1;
        } else {
          break;
        }
      }
      if (digits.length > 0 && text[j] === ")") {
        nums.add(digits);
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return nums;
}
