import {
  AMBIENT_NONE,
  CONFLICT_HEAD_PREFIX,
  CONFLICT_SEP,
  CONFLICT_TAIL_PREFIX,
  CONTENT_PREFIX_LEN,
} from "./constants.js";
import {
  extractIssueNumbers,
  isEntryBulletLine,
  parseSectionHeader,
  parseSubsectionHeader,
} from "./linear-scan.js";

export interface ResolveChangelogResult {
  readonly content: string | null;
  readonly message: string;
  readonly warnings: readonly string[];
}

function stripBulletPrefix(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (line[i] === "-" || line[i] === "*") i += 1;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  return line.slice(i);
}

export function findUnreleasedBounds(lines: string[]): [number, number] | [null, null] {
  let start: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const name = parseSectionHeader(lines[i] ?? "");
    if (name !== null && name.trim().toLowerCase() === "unreleased") {
      start = i;
      break;
    }
  }
  if (start === null) return [null, null];
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (parseSectionHeader(lines[j] ?? "") !== null) {
      end = j;
      break;
    }
  }
  return [start, end];
}

export function findConflictBlocks(
  lines: string[],
  start: number,
  end: number,
): Array<[number, number, number]> | null {
  const blocks: Array<[number, number, number]> = [];
  let i = start;
  while (i < end) {
    const line = lines[i] ?? "";
    if (line.startsWith(CONFLICT_HEAD_PREFIX)) {
      const headIdx = i;
      let sepIdx: number | null = null;
      let tailIdx: number | null = null;
      let j = i + 1;
      while (j < end) {
        const inner = lines[j] ?? "";
        if (inner.startsWith(CONFLICT_HEAD_PREFIX)) return null;
        if (inner === CONFLICT_SEP && sepIdx === null) sepIdx = j;
        else if (inner.startsWith(CONFLICT_TAIL_PREFIX) && sepIdx !== null) {
          tailIdx = j;
          break;
        }
        j += 1;
      }
      if (sepIdx === null || tailIdx === null) return null;
      blocks.push([headIdx, sepIdx, tailIdx]);
      i = tailIdx + 1;
    } else if (line === CONFLICT_SEP || line.startsWith(CONFLICT_TAIL_PREFIX)) {
      return null;
    } else {
      i += 1;
    }
  }
  return blocks;
}

export function findAmbientSubsection(
  lines: string[],
  conflictStart: number,
  unreleasedStart: number,
): string {
  for (let i = conflictStart - 1; i > unreleasedStart; i -= 1) {
    const name = parseSubsectionHeader(lines[i] ?? "");
    if (name !== null) return name;
  }
  return AMBIENT_NONE;
}

export function parseSide(
  sideLines: string[],
  ambientSubsection: string,
): Array<[string, string[]]> {
  const sections: Array<[string, string[]]> = [];
  let currentName = ambientSubsection;
  let currentEntries: string[] = [];
  let currentEntryLines: string[] = [];

  const flushEntry = (): void => {
    if (currentEntryLines.length > 0) {
      currentEntries.push(currentEntryLines.join("\n"));
      currentEntryLines = [];
    }
  };

  const flushSection = (): void => {
    flushEntry();
    if (currentEntries.length > 0 || currentName !== AMBIENT_NONE) {
      sections.push([currentName, currentEntries]);
    }
    currentEntries = [];
  };

  for (const rawLine of sideLines) {
    const line = rawLine.replace(/\n$/, "");
    const subName = parseSubsectionHeader(line);
    if (subName !== null) {
      flushSection();
      currentName = subName;
      continue;
    }
    if (isEntryBulletLine(line)) {
      flushEntry();
      currentEntryLines = [line];
      continue;
    }
    if (currentEntryLines.length > 0) {
      const stripped = line.trim();
      if (stripped === "") flushEntry();
      else if (line.startsWith(" ") || line.startsWith("\t")) currentEntryLines.push(line);
      else flushEntry();
    }
  }
  flushSection();
  return sections;
}

export function issueNumbers(entryText: string): Set<string> {
  return extractIssueNumbers(entryText);
}

function countBoldMarkers(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    if (line[i] === "*" && line[i + 1] === "*") count += 1;
  }
  return count;
}

function entryBoldOpen(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (line[i] !== "-" && line[i] !== "*") return false;
  i += 1;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  return line[i] === "*" && line[i + 1] === "*";
}

export function isOrphanHeader(entryText: string): boolean {
  const firstLine = entryText.split("\n", 1)[0] ?? "";
  if (!entryBoldOpen(firstLine)) return false;
  if (countBoldMarkers(firstLine) >= 2) return false;
  return issueNumbers(entryText).size === 0;
}

export function contentPrefix(entryText: string): string {
  const firstLine = entryText.split("\n", 1)[0] ?? "";
  let stripped = stripBulletPrefix(firstLine);
  stripped = stripped.replace(/\*\*/g, "");
  for (const num of issueNumbers(stripped)) {
    stripped = stripped.split(`(#${num})`).join("");
  }
  stripped = stripped.split(/\s+/).filter(Boolean).join(" ");
  return stripped.slice(0, CONTENT_PREFIX_LEN).toLowerCase();
}

export function unionMerge(
  headSections: Array<[string, string[]]>,
  branchSections: Array<[string, string[]]>,
  warnings: string[] = [],
): Array<[string, string[]]> {
  const warn = (side: string, name: string, entryText: string): void => {
    const firstLine = entryText.split("\n", 1)[0] ?? "";
    const subsection = name || "(ambient)";
    warnings.push(
      `dropped truncated orphan header from ${side} side under '${subsection}': ${JSON.stringify(firstLine)}`,
    );
  };

  const headDict = new Map<string, string[]>();
  const headOrder: string[] = [];

  for (const [name, entries] of headSections) {
    const kept: string[] = [];
    for (const e of entries) {
      if (isOrphanHeader(e)) {
        warn("HEAD", name, e);
        continue;
      }
      kept.push(e);
    }
    if (headDict.has(name)) headDict.get(name)?.push(...kept);
    else {
      headDict.set(name, [...kept]);
      headOrder.push(name);
    }
  }

  for (const [name, entries] of branchSections) {
    if (!headDict.has(name)) {
      headDict.set(name, []);
      headOrder.push(name);
    }
    const existingNums = new Set<string>();
    const existingPrefixes = new Set<string>();
    for (const e of headDict.get(name) ?? []) {
      for (const n of issueNumbers(e)) existingNums.add(n);
      existingPrefixes.add(contentPrefix(e));
    }
    const newEntries: string[] = [];
    for (const e of entries) {
      if (isOrphanHeader(e)) {
        warn("branch", name, e);
        continue;
      }
      const nums = issueNumbers(e);
      if (nums.size > 0) {
        let overlap = false;
        for (const n of nums) {
          if (existingNums.has(n)) {
            overlap = true;
            break;
          }
        }
        if (overlap) continue;
      } else if (existingPrefixes.has(contentPrefix(e))) {
        continue;
      }
      newEntries.push(e);
      for (const n of nums) existingNums.add(n);
      existingPrefixes.add(contentPrefix(e));
    }
    headDict.set(name, [...newEntries, ...(headDict.get(name) ?? [])]);
  }

  return headOrder.map((name) => [name, headDict.get(name) ?? []]);
}

export function renderResolved(
  merged: Array<[string, string[]]>,
  ambientSubsection: string,
): string[] {
  const out: string[] = [];
  for (const [name, entries] of merged) {
    if (name !== ambientSubsection) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(`### ${name}`);
      out.push("");
    }
    for (const entry of entries) {
      for (const entryLine of entry.split("\n")) out.push(entryLine);
    }
  }
  return out;
}

function hasConflictMarker(line: string): boolean {
  return (
    line.startsWith(CONFLICT_HEAD_PREFIX) ||
    line.startsWith(CONFLICT_TAIL_PREFIX) ||
    line === CONFLICT_SEP
  );
}

/** Pure union-merge of CHANGELOG [Unreleased] conflicts (mirrors Python oracle). */
export function resolveChangelog(content: string): ResolveChangelogResult {
  const hadTrailingNewline = content.endsWith("\n");
  let lines = content.split("\n");
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  const [unreleasedStart, unreleasedEnd] = findUnreleasedBounds(lines);
  if (unreleasedStart === null) {
    if (lines.some(hasConflictMarker)) {
      return {
        content: null,
        message: "unresolvable: conflict markers present but no [Unreleased] section found",
        warnings: [],
      };
    }
    return {
      content,
      message: "no-op: no [Unreleased] section, no conflict markers",
      warnings: [],
    };
  }

  const blocks = findConflictBlocks(lines, unreleasedStart, unreleasedEnd);
  if (blocks === null) {
    return {
      content: null,
      message:
        "unresolvable: malformed conflict markers (nested / missing separator / orphan tail) inside [Unreleased]",
      warnings: [],
    };
  }

  const hasOutsideMarker = lines.some(
    (line, i) => (i < unreleasedStart || i >= unreleasedEnd) && hasConflictMarker(line),
  );

  if (blocks.length === 0) {
    if (hasOutsideMarker) {
      return {
        content: null,
        message:
          "unresolvable: conflict markers present outside [Unreleased] section -- resolve manually with edit_files",
        warnings: [],
      };
    }
    return { content, message: "no-op: no conflict markers in [Unreleased]", warnings: [] };
  }

  const newLines = [...lines];
  const warnings: string[] = [];
  for (const [headIdx, sepIdx, tailIdx] of [...blocks].reverse()) {
    const headSide = newLines.slice(headIdx + 1, sepIdx);
    const branchSide = newLines.slice(sepIdx + 1, tailIdx);
    const ambient = findAmbientSubsection(newLines, headIdx, unreleasedStart);
    const headParsed = parseSide(headSide, ambient);
    const branchParsed = parseSide(branchSide, ambient);
    const merged = unionMerge(headParsed, branchParsed, warnings);
    const rendered = renderResolved(merged, ambient);
    newLines.splice(headIdx, tailIdx - headIdx + 1, ...rendered);
  }

  for (const line of newLines) {
    if (hasConflictMarker(line)) {
      if (hasOutsideMarker) {
        return {
          content: null,
          message:
            "unresolvable: conflict markers remain outside [Unreleased] -- resolve manually with edit_files",
          warnings,
        };
      }
      return {
        content: null,
        message:
          "unresolvable: conflict markers remain after resolve (internal error -- please file an issue)",
        warnings,
      };
    }
  }

  let newContent = newLines.join("\n");
  if (hadTrailingNewline) newContent += "\n";
  return {
    content: newContent,
    message: `resolved: union-merged ${blocks.length} conflict block(s)`,
    warnings,
  };
}

export function evaluateChangelogPath(
  changelogPath: string,
  options: {
    readonly exists?: boolean;
    readonly isFile?: boolean;
    readonly readText?: () => string;
    readonly dryRun?: boolean;
    readonly writeText?: (content: string) => void;
  } = {},
): [number, string, readonly string[]] {
  const exists = options.exists ?? true;
  const isFile = options.isFile ?? true;
  if (!exists) {
    return [
      2,
      `config error: CHANGELOG path does not exist: ${changelogPath}\n  Recovery: pass --changelog-path pointing at an existing file.`,
      [],
    ];
  }
  if (!isFile) {
    return [2, `config error: CHANGELOG path is not a regular file: ${changelogPath}`, []];
  }
  let content: string;
  try {
    content = options.readText?.() ?? "";
  } catch (exc) {
    return [2, `config error: cannot read ${changelogPath}: ${exc}`, []];
  }

  const { content: newContent, message, warnings } = resolveChangelog(content);
  if (newContent === null) {
    return [1, `${message}\n  Path: ${changelogPath}`, warnings];
  }
  if (newContent === content) {
    return [0, `OK ${changelogPath}: ${message}`, warnings];
  }
  if (options.dryRun) {
    return [0, `OK (dry-run) ${changelogPath}: ${message}`, warnings];
  }
  try {
    options.writeText?.(newContent);
  } catch (exc) {
    return [2, `config error: cannot write ${changelogPath}: ${exc}`, warnings];
  }
  return [0, `OK ${changelogPath}: ${message}`, warnings];
}
