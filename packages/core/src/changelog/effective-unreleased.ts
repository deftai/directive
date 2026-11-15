/**
 * One effective view of unreleased changelog entries (#6314 / #6286 item 5).
 *
 * The effective unreleased entries are the `[Unreleased]` entries of
 * `CHANGELOG.md` plus the entries of every valid fragment under
 * `changelog.d/`, by subsection. Every reader of the unreleased section reads
 * through this module: either the structured view ({@link readEffectiveUnreleased})
 * or the effective changelog text ({@link effectiveChangelogText}), which is the
 * changelog with fragment entries merged into `[Unreleased]`.
 *
 * With no valid fragment the effective text is the changelog text, unchanged,
 * so every reader returns the same result as before fragments existed.
 *
 * Read-only: nothing here writes or deletes a file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG_FILE_REL } from "./entry-path.js";
import {
  CHANGELOG_SUBSECTIONS,
  type ChangelogFragment,
  type ChangelogFragmentSet,
  type FragmentFs,
  type InvalidChangelogFragment,
  readChangelogFragments,
} from "./fragment.js";

export interface UnreleasedEntry {
  /** Subsection name (`### <name>`), or null when the entry sits above any subsection. */
  readonly section: string | null;
  /** Entry text: `- ...` plus indented continuation lines, joined with `\n`. */
  readonly text: string;
  /** `CHANGELOG.md` or the fragment path. */
  readonly source: string;
}

export interface UnreleasedSubsection {
  readonly section: string | null;
  readonly entries: readonly UnreleasedEntry[];
}

export interface EffectiveUnreleased {
  /** Raw `CHANGELOG.md` text, or null when it could not be read. */
  readonly changelogText: string | null;
  /** Changelog text with valid fragment entries merged into `[Unreleased]`. */
  readonly effectiveText: string | null;
  readonly hasUnreleasedHeading: boolean;
  /** Entries in `CHANGELOG.md` `[Unreleased]` only. */
  readonly changelogEntries: readonly UnreleasedEntry[];
  /** All effective entries: changelog first, then fragments by file name. */
  readonly entries: readonly UnreleasedEntry[];
  /** Effective entries grouped by subsection (Keep a Changelog order, then others, then none). */
  readonly sections: readonly UnreleasedSubsection[];
  readonly fragments: readonly ChangelogFragment[];
  readonly invalidFragments: readonly InvalidChangelogFragment[];
}

export interface ReadEffectiveUnreleasedOptions {
  /** Use this changelog text instead of reading the file (null = absent). */
  readonly changelogText?: string | null;
  /** Changelog path relative to the project root (default `CHANGELOG.md`). */
  readonly changelogPath?: string;
  readonly fs?: FragmentFs;
}

const UNRELEASED_HEADING_RE = /^##\s+\[Unreleased\]\s*$/;
const NEXT_SECTION_RE = /^## \[/;
const SUBSECTION_RE = /^###\s+(.+?)\s*$/;

function splitLines(text: string): { lines: string[]; eol: string } {
  return { lines: text.split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** [start, end) line indexes of the `[Unreleased]` body, or null without a heading. */
function unreleasedBounds(lines: readonly string[]): { heading: number; end: number } | null {
  const heading = lines.findIndex((line) => UNRELEASED_HEADING_RE.test(line));
  if (heading < 0) return null;
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (NEXT_SECTION_RE.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { heading, end };
}

/** Entries of `CHANGELOG.md` `[Unreleased]`, with their subsection (pure). */
export function parseUnreleasedEntries(changelogText: string): UnreleasedEntry[] {
  const { lines } = splitLines(changelogText);
  const bounds = unreleasedBounds(lines);
  if (bounds === null) return [];
  const out: UnreleasedEntry[] = [];
  let section: string | null = null;
  let current: { section: string | null; lines: string[] } | null = null;
  const flush = (): void => {
    if (current !== null) {
      out.push({
        section: current.section,
        text: current.lines.join("\n"),
        source: CHANGELOG_FILE_REL,
      });
      current = null;
    }
  };
  for (let i = bounds.heading + 1; i < bounds.end; i += 1) {
    const line = lines[i] ?? "";
    const sub = SUBSECTION_RE.exec(line);
    if (sub !== null) {
      flush();
      section = sub[1] ?? null;
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      current = { section, lines: [line.trimEnd()] };
      continue;
    }
    if (current !== null && line.trim().length > 0 && /^[ \t]/.test(line)) {
      current.lines.push(line.trimEnd());
      continue;
    }
    flush();
  }
  flush();
  return out;
}

function fragmentEntries(fragments: readonly ChangelogFragment[]): UnreleasedEntry[] {
  const out: UnreleasedEntry[] = [];
  for (const fragment of fragments) {
    for (const text of fragment.entries) {
      out.push({ section: fragment.section, text, source: fragment.path });
    }
  }
  return out;
}

function groupBySubsection(entries: readonly UnreleasedEntry[]): UnreleasedSubsection[] {
  const order: (string | null)[] = [...CHANGELOG_SUBSECTIONS];
  for (const entry of entries) {
    if (entry.section !== null && !order.includes(entry.section)) order.push(entry.section);
  }
  order.push(null);
  const groups: UnreleasedSubsection[] = [];
  for (const section of order) {
    const inSection = entries.filter((entry) => entry.section === section);
    if (inSection.length > 0) groups.push({ section, entries: inSection });
  }
  return groups;
}

/**
 * Merge valid fragment entries into the `[Unreleased]` section (pure).
 * Each entry lands at the end of its `### <Subsection>` block; a missing block
 * is added at the end of `[Unreleased]`. Fragments are taken in the given order
 * (callers pass them sorted by file name). Returns the text unchanged when there
 * are no fragment entries or no `[Unreleased]` heading.
 */
export function mergeFragmentsIntoChangelogText(
  changelogText: string,
  fragments: readonly ChangelogFragment[],
): string {
  if (fragments.every((fragment) => fragment.entries.length === 0)) return changelogText;
  const { lines, eol } = splitLines(changelogText);
  if (unreleasedBounds(lines) === null) return changelogText;
  for (const section of CHANGELOG_SUBSECTIONS) {
    const entryLines = fragments
      .filter((fragment) => fragment.section === section)
      .flatMap((fragment) => fragment.entries.flatMap((entry) => entry.split("\n")));
    if (entryLines.length === 0) continue;
    const bounds = unreleasedBounds(lines);
    if (bounds === null) return changelogText;
    let sub = -1;
    for (let i = bounds.heading + 1; i < bounds.end; i += 1) {
      if (SUBSECTION_RE.exec(lines[i] ?? "")?.[1] === section) {
        sub = i;
        break;
      }
    }
    if (sub >= 0) {
      let subEnd = bounds.end;
      for (let i = sub + 1; i < bounds.end; i += 1) {
        if ((lines[i] ?? "").startsWith("### ")) {
          subEnd = i;
          break;
        }
      }
      let last = -1;
      for (let i = sub + 1; i < subEnd; i += 1) {
        if ((lines[i] ?? "").trim().length > 0) last = i;
      }
      if (last >= 0) {
        lines.splice(last + 1, 0, ...entryLines);
      } else {
        const insert = ["", ...entryLines];
        if (sub + 1 >= lines.length || (lines[sub + 1] ?? "").trim().length > 0) insert.push("");
        lines.splice(sub + 1, 0, ...insert);
      }
      continue;
    }
    let last = bounds.heading;
    for (let i = bounds.heading + 1; i < bounds.end; i += 1) {
      if ((lines[i] ?? "").trim().length > 0) last = i;
    }
    const insert = ["", `### ${section}`, "", ...entryLines];
    if (last + 1 < lines.length && (lines[last + 1] ?? "").trim().length > 0) insert.push("");
    lines.splice(last + 1, 0, ...insert);
  }
  return lines.join(eol);
}

/** Compose the effective view from changelog text and a fragment set (pure). */
export function composeEffectiveUnreleased(
  changelogText: string | null,
  fragmentSet: ChangelogFragmentSet,
): EffectiveUnreleased {
  const changelogEntries = changelogText === null ? [] : parseUnreleasedEntries(changelogText);
  const entries = [...changelogEntries, ...fragmentEntries(fragmentSet.valid)];
  const hasUnreleasedHeading =
    changelogText !== null && unreleasedBounds(splitLines(changelogText).lines) !== null;
  return {
    changelogText,
    effectiveText:
      changelogText === null
        ? null
        : mergeFragmentsIntoChangelogText(changelogText, fragmentSet.valid),
    hasUnreleasedHeading,
    changelogEntries,
    entries,
    sections: groupBySubsection(entries),
    fragments: fragmentSet.valid,
    invalidFragments: fragmentSet.invalid,
  };
}

/** Read `CHANGELOG.md` and `changelog.d/` under `projectRoot` and compose the effective view. */
export function readEffectiveUnreleased(
  projectRoot: string,
  options: ReadEffectiveUnreleasedOptions = {},
): EffectiveUnreleased {
  let changelogText: string | null;
  if (options.changelogText !== undefined) {
    changelogText = options.changelogText;
  } else {
    try {
      changelogText = readFileSync(
        join(projectRoot, options.changelogPath ?? CHANGELOG_FILE_REL),
        "utf8",
      );
    } catch {
      changelogText = null;
    }
  }
  return composeEffectiveUnreleased(changelogText, readChangelogFragments(projectRoot, options.fs));
}

/**
 * Effective changelog text for a reader that already holds the changelog text:
 * the same text with valid fragment entries under `projectRoot` merged into
 * `[Unreleased]`. Unchanged when no valid fragment exists.
 */
export function effectiveChangelogText(
  projectRoot: string,
  changelogText: string,
  fs?: FragmentFs,
): string {
  const view = readEffectiveUnreleased(projectRoot, { changelogText, ...(fs ? { fs } : {}) });
  return view.effectiveText ?? changelogText;
}
