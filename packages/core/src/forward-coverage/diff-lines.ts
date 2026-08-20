/**
 * Parse unified diffs into added/modified new-file line numbers (#3514).
 */

/** Repo-relative path -> 1-indexed new-file line numbers introduced by the diff. */
export type ChangedLineMap = Map<string, Set<number>>;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Strip git `a/` `b/` prefixes and quotes from a `+++` path. */
export function stripGitDiffPath(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  const prefixed = /^[abiwc]\/(.*)$/.exec(s);
  if (prefixed?.[1] !== undefined) {
    return prefixed[1].replace(/\\/g, "/");
  }
  return s.replace(/\\/g, "/");
}

/**
 * Collect 1-indexed lines added on the new side of a unified diff (`-U0` ok).
 * Deletions-only hunks contribute nothing. `/dev/null` destinations are skipped.
 */
export function parseUnifiedDiffAddedLines(diffText: string): ChangedLineMap {
  const result: ChangedLineMap = new Map();
  let current: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diffText.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      current = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      if (rest === "/dev/null") {
        current = null;
        inHunk = false;
        continue;
      }
      current = stripGitDiffPath(rest);
      if (!result.has(current)) {
        result.set(current, new Set());
      }
      inHunk = false;
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = current !== null;
      continue;
    }
    if (!inHunk || current === null) {
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
    const lines = result.get(current);
    if (lines === undefined) {
      continue;
    }
    if (line.startsWith("+")) {
      lines.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // old-file deletion; new-file cursor stays
    } else {
      newLine += 1;
    }
  }
  return result;
}

/** Count physical lines in file content (no trailing empty split artifact). */
export function countFileLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const parts = content.split(/\r\n|\n/);
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.length;
}

/** Treat every line of an untracked file as added. */
export function allLinesChanged(lineCount: number): Set<number> {
  const lines = new Set<number>();
  for (let i = 1; i <= lineCount; i += 1) {
    lines.add(i);
  }
  return lines;
}
