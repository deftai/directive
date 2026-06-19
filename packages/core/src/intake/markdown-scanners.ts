/**
 * Linear-time markdown scanners for issue body parsing (#1784 / #1248).
 * Avoids nested/polynomial regex on issue bodies (ReDoS-safe).
 */

/** Strip fenced and inline code spans before cross-ref / plan-item extraction. */
export function stripCodeBlocks(body: string): string {
  if (body.length === 0) {
    return "";
  }
  let text = stripFencedCodeBlocks(body);
  text = stripInlineCode(text);
  return text;
}

function stripFencedCodeBlocks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const fence = detectFenceOpen(text, i);
    if (fence === null) {
      out += text[i];
      i += 1;
      continue;
    }
    const close = findFenceClose(text, fence.end, fence.delimiter);
    i = close >= 0 ? close : text.length;
  }
  return out;
}

function detectFenceOpen(text: string, index: number): { delimiter: string; end: number } | null {
  if (text.startsWith("```", index)) {
    return { delimiter: "```", end: index + 3 };
  }
  if (text.startsWith("~~~", index)) {
    return { delimiter: "~~~", end: index + 3 };
  }
  return null;
}

function findFenceClose(text: string, start: number, delimiter: string): number {
  let i = start;
  while (i < text.length) {
    if (text.startsWith(delimiter, i)) {
      return i + delimiter.length;
    }
    i += 1;
  }
  return -1;
}

function stripInlineCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0 || text.slice(i + 1, end).includes("\n")) {
        out += text[i];
        i += 1;
        continue;
      }
      i = end + 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

export interface CheckboxItem {
  readonly title: string;
  readonly status: "proposed" | "completed";
}

/** Parse GitHub-flavoured task-list checkboxes line-by-line. */
export function parseCheckboxItems(text: string): CheckboxItem[] {
  const items: CheckboxItem[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = matchCheckboxLine(line);
    if (match === null) {
      continue;
    }
    const title = match.title.trim();
    if (title.length === 0 || seen.has(title)) {
      continue;
    }
    seen.add(title);
    items.push({
      title,
      status: match.checked ? "completed" : "proposed",
    });
  }
  return items;
}

function matchCheckboxLine(line: string): { checked: boolean; title: string } | null {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  if (i >= line.length || !"-*+".includes(line[i] as string)) {
    return null;
  }
  i += 1;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  if (!line.startsWith("[", i)) {
    return null;
  }
  const close = line.indexOf("]", i + 1);
  if (close < 0) {
    return null;
  }
  const marker = line.slice(i + 1, close);
  if (marker !== " " && marker !== "x" && marker !== "X") {
    return null;
  }
  let rest = line.slice(close + 1);
  if (rest.startsWith(" ")) {
    rest = rest.slice(1);
  }
  rest = rest.trimEnd();
  return { checked: marker.toLowerCase() === "x", title: rest };
}

export interface AcHeadingMatch {
  readonly level: number;
  readonly sectionStart: number;
}

/** Find an Acceptance Criteria heading (case-insensitive). */
export function findAcHeading(text: string): AcHeadingMatch | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = matchAcHeadingLine(line);
    if (match !== null) {
      return { level: match.level, sectionStart: offset + match.end };
    }
    offset += line.length + 1;
  }
  return null;
}

function matchAcHeadingLine(line: string): { level: number; end: number } | null {
  if (!line.startsWith("#")) {
    return null;
  }
  let level = 0;
  while (level < line.length && line[level] === "#") {
    level += 1;
  }
  if (level < 1 || level > 6) {
    return null;
  }
  if (level >= line.length || line[level] !== " ") {
    return null;
  }
  const headingText = line
    .slice(level + 1)
    .trim()
    .toLowerCase();
  if (!/\bacceptance\s+criteria\b/.test(headingText)) {
    return null;
  }
  return { level, end: line.length };
}

/** Slice text until the next heading at the same or higher level. */
export function sliceAcSection(text: string, heading: AcHeadingMatch): string {
  const after = text.slice(heading.sectionStart);
  let offset = 0;
  for (const line of after.split("\n")) {
    if (offset > 0 && isHeadingAtOrAbove(line, heading.level)) {
      return after.slice(0, offset);
    }
    offset += line.length + 1;
  }
  return after;
}

function isHeadingAtOrAbove(line: string, level: number): boolean {
  if (!line.startsWith("#")) {
    return false;
  }
  let hashes = 0;
  while (hashes < line.length && line[hashes] === "#") {
    hashes += 1;
  }
  if (hashes < 1 || hashes > level) {
    return false;
  }
  return hashes <= level && (hashes >= line.length || line[hashes] === " ");
}

/** Parse bullet/numbered list items within a section. */
export function parseListItems(sectionText: string): CheckboxItem[] {
  const items: CheckboxItem[] = [];
  const seen = new Set<string>();
  for (const line of sectionText.split("\n")) {
    const bullet = matchListItemLine(line);
    if (bullet === null) {
      continue;
    }
    let title = bullet.trim();
    let status: "proposed" | "completed" = "proposed";
    const cb = matchLeadingCheckbox(title);
    if (cb !== null) {
      title = cb.title.trim();
      if (cb.checked) {
        status = "completed";
      }
    }
    if (title.length === 0 || seen.has(title)) {
      continue;
    }
    seen.add(title);
    items.push({ title, status });
  }
  return items;
}

function matchListItemLine(line: string): string | null {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  if (i >= line.length) {
    return null;
  }
  if ("-*+".includes(line[i] as string)) {
    i += 1;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) {
      i += 1;
    }
    return line.slice(i).trimEnd();
  }
  const numMatch = /^\d+[.)]/.exec(line.slice(i));
  if (numMatch === null) {
    return null;
  }
  i += numMatch[0].length;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  return line.slice(i).trimEnd();
}

function matchLeadingCheckbox(title: string): { checked: boolean; title: string } | null {
  if (!title.startsWith("[")) {
    return null;
  }
  const close = title.indexOf("]");
  if (close < 0) {
    return null;
  }
  const marker = title.slice(1, close);
  if (marker !== " " && marker !== "x" && marker !== "X") {
    return null;
  }
  let rest = title.slice(close + 1);
  if (rest.startsWith(" ")) {
    rest = rest.slice(1);
  }
  return { checked: marker.toLowerCase() === "x", title: rest };
}
