/**
 * Changelog fragment format (#6314 / #6286 item 2).
 *
 * A fragment is a regular file `changelog.d/<issue>-<slug>.md`. Its first line
 * is `section:` followed by one Keep a Changelog subsection name. Then come one
 * or more entries; each entry starts with `- ` and may have indented
 * continuation lines. Blank lines between entries are allowed.
 *
 * Invalid: an empty file, a missing or unknown section, a line that starts
 * with `#`, any other unindented line, no entries, a symlink, a non-regular
 * file, or a file name outside `<issue>-<slug>.md`.
 *
 * This module reads and validates only. It never writes or deletes.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG_FRAGMENT_DIR, isChangelogFragmentPath } from "./entry-path.js";

/** Keep a Changelog subsections, in the fixed assembly order. */
export const CHANGELOG_SUBSECTIONS = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;

export type ChangelogSubsection = (typeof CHANGELOG_SUBSECTIONS)[number];

/** File name rule: `<issue>-<slug>.md` (issue is a positive number). */
export const FRAGMENT_FILE_NAME_RE = /^[1-9][0-9]*-[a-z0-9][a-z0-9._-]*\.md$/;

export type FragmentInvalidReason =
  | "empty"
  | "section-line"
  | "unknown-section"
  | "heading-line"
  | "unindented-line"
  | "no-entries"
  | "symlink"
  | "not-regular"
  | "file-name"
  | "unreadable";

export type FragmentParse =
  | {
      readonly ok: true;
      readonly section: ChangelogSubsection;
      /** Each entry: first line `- ...` plus its continuation lines, joined with `\n`. */
      readonly entries: readonly string[];
    }
  | { readonly ok: false; readonly reason: FragmentInvalidReason; readonly detail: string };

export interface ChangelogFragment {
  /** Repository-relative path, `changelog.d/<name>.md`. */
  readonly path: string;
  readonly section: ChangelogSubsection;
  readonly entries: readonly string[];
}

export interface InvalidChangelogFragment {
  readonly path: string;
  readonly reason: FragmentInvalidReason;
  readonly detail: string;
}

export interface ChangelogFragmentSet {
  /** Valid fragments, sorted by file name. */
  readonly valid: readonly ChangelogFragment[];
  /** Invalid fragments, sorted by file name. */
  readonly invalid: readonly InvalidChangelogFragment[];
}

/** File-system seam (tests). */
export interface FragmentFs {
  readonly readdir: (absDir: string) => string[];
  readonly lstat: (absPath: string) => {
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
  };
  readonly readFile: (absPath: string) => string;
}

const nodeFs: FragmentFs = {
  readdir: (absDir) => readdirSync(absDir),
  lstat: (absPath) => lstatSync(absPath),
  readFile: (absPath) => readFileSync(absPath, "utf8"),
};

const SECTION_LINE_RE = /^section:[ \t]*(\S(?:.*\S)?)[ \t]*$/;

export function isChangelogSubsection(value: string): value is ChangelogSubsection {
  return (CHANGELOG_SUBSECTIONS as readonly string[]).includes(value);
}

function invalid(reason: FragmentInvalidReason, detail: string): FragmentParse {
  return { ok: false, reason, detail };
}

/** Parse fragment text (pure). CRLF is read as LF; a leading BOM is ignored. */
export function parseFragmentText(text: string): FragmentParse {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return invalid("empty", "fragment is empty");
  }
  const lines = normalized.split("\n");
  const first = lines[0] ?? "";
  const sectionMatch = SECTION_LINE_RE.exec(first);
  if (sectionMatch === null) {
    return invalid("section-line", "first line must be `section: <Subsection>`");
  }
  const section = sectionMatch[1] ?? "";
  if (!isChangelogSubsection(section)) {
    return invalid(
      "unknown-section",
      `unknown section ${JSON.stringify(section)}; expected one of ${CHANGELOG_SUBSECTIONS.join(", ")}`,
    );
  }
  const entries: string[] = [];
  let current: string[] | null = null;
  // Blank lines seen since the last content line. Kept inside an entry when an
  // indented continuation follows (they can end a blockquote); dropped at an
  // entry boundary, where the merge supplies its own separator.
  let pendingBlanks = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("#")) {
      return invalid("heading-line", `line ${String(i + 1)} starts with '#'`);
    }
    if (line.trim().length === 0) {
      pendingBlanks += 1;
      continue;
    }
    if (line.startsWith("- ")) {
      if (current !== null) entries.push(current.join("\n"));
      current = [line.trimEnd()];
      pendingBlanks = 0;
      continue;
    }
    if (/^[ \t]/.test(line) && current !== null) {
      for (; pendingBlanks > 0; pendingBlanks -= 1) current.push("");
      current.push(line.trimEnd());
      continue;
    }
    return invalid(
      "unindented-line",
      `line ${String(i + 1)} is neither a '- ' entry nor an indented continuation`,
    );
  }
  if (current !== null) entries.push(current.join("\n"));
  if (entries.length === 0) {
    return invalid("no-entries", "fragment has no '- ' entries");
  }
  return { ok: true, section, entries };
}

/**
 * Read and validate one fragment. `relPath` is `changelog.d/<name>.md`.
 * A symlink or non-regular file is invalid and is never read.
 */
export function readChangelogFragment(
  projectRoot: string,
  relPath: string,
  fs: FragmentFs = nodeFs,
): ChangelogFragment | InvalidChangelogFragment {
  const name = relPath.slice(CHANGELOG_FRAGMENT_DIR.length + 1);
  const abs = join(projectRoot, CHANGELOG_FRAGMENT_DIR, name);
  let st: ReturnType<FragmentFs["lstat"]>;
  try {
    st = fs.lstat(abs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: relPath, reason: "unreadable", detail: msg };
  }
  if (st.isSymbolicLink()) {
    return { path: relPath, reason: "symlink", detail: "fragment is a symlink" };
  }
  if (!st.isFile()) {
    return { path: relPath, reason: "not-regular", detail: "fragment is not a regular file" };
  }
  if (!FRAGMENT_FILE_NAME_RE.test(name)) {
    return {
      path: relPath,
      reason: "file-name",
      detail: "fragment file name must be <issue>-<slug>.md",
    };
  }
  let text: string;
  try {
    text = fs.readFile(abs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: relPath, reason: "unreadable", detail: msg };
  }
  const parsed = parseFragmentText(text);
  if (!parsed.ok) {
    return { path: relPath, reason: parsed.reason, detail: parsed.detail };
  }
  return { path: relPath, section: parsed.section, entries: parsed.entries };
}

export function isValidChangelogFragment(
  value: ChangelogFragment | InvalidChangelogFragment,
): value is ChangelogFragment {
  return "section" in value;
}

/**
 * List every fragment entry path under `changelog.d/` (one level deep), sorted
 * by file name, split into valid and invalid. Names that are not changelog
 * entry paths (for example `.gitkeep`, `X.md`, sub-directories with other
 * names) are not fragments and are skipped. A missing directory is no fragments.
 * A `changelog.d` that is a symlink (or not a directory) is never listed, so
 * files outside the project cannot become fragments; it is reported invalid.
 */
export function readChangelogFragments(
  projectRoot: string,
  fs: FragmentFs = nodeFs,
): ChangelogFragmentSet {
  const absDir = join(projectRoot, CHANGELOG_FRAGMENT_DIR);
  let dirStat: ReturnType<FragmentFs["lstat"]>;
  try {
    dirStat = fs.lstat(absDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) {
    return {
      valid: [],
      invalid: [
        {
          path: CHANGELOG_FRAGMENT_DIR,
          reason: "symlink",
          detail: "changelog.d is a symlink; fragments are not read",
        },
      ],
    };
  }
  if (!dirStat.isDirectory()) {
    return {
      valid: [],
      invalid: [
        {
          path: CHANGELOG_FRAGMENT_DIR,
          reason: "not-regular",
          detail: "changelog.d is not a directory",
        },
      ],
    };
  }
  let names: string[];
  try {
    names = fs.readdir(absDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  const valid: ChangelogFragment[] = [];
  const bad: InvalidChangelogFragment[] = [];
  for (const name of [...names].sort()) {
    const rel = `${CHANGELOG_FRAGMENT_DIR}/${name}`;
    if (!isChangelogFragmentPath(rel)) continue;
    const read = readChangelogFragment(projectRoot, rel, fs);
    if (isValidChangelogFragment(read)) valid.push(read);
    else bad.push(read);
  }
  return { valid, invalid: bad };
}
