/**
 * Release line and release rule (#6296).
 *
 * A release writes one line back under `## [Unreleased]`:
 * `- [release-line] v<version>`. The line keeps `[Unreleased]` non-empty after
 * a release, so master's merge gate stays green with no change to the
 * empty-section rule. It is also the test for a release: a change set whose
 * `CHANGELOG.md` change adds a release line is a release attempt, and the
 * release rule below judges it instead of the ordinary changelog rules.
 *
 * Note preservation is line based, with no entry parser: a line is compared
 * after CRLF is read as LF and trailing whitespace is removed.
 */
import { isChangelogEntryPath, isChangelogFragmentPath } from "./entry-path.js";
import type { ChangelogChangeSetEntry } from "./fragment.js";

/** The one fixed form of the release line, before the version. */
export const RELEASE_LINE_PREFIX = "- [release-line] v";

/** Path of the roadmap a release rewrites (repository-relative). */
export const RELEASE_ROADMAP_REL = "ROADMAP.md";

const VERSION_TEXT = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const RELEASE_LINE_RE = new RegExp(
  `^${RELEASE_LINE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${VERSION_TEXT})$`,
);
const UNRELEASED_HEADING_RE = /^##\s+\[Unreleased\]\s*$/;
const NEXT_SECTION_RE = /^## \[/;
const LINK_FOOTER_RE = /^(?:\[Unreleased\]:|\[\d+\.\d+\.\d+[^\]]*\]:)/;
const SECTION_LINE_RE = /^section:/;

/** The release line for `version` (no leading `v` in `version`). */
export function releaseLine(version: string): string {
  return `${RELEASE_LINE_PREFIX}${version}`;
}

/** The version a release line carries, or null when `line` is not one. */
export function releaseLineVersion(line: string): string | null {
  return RELEASE_LINE_RE.exec(line.replace(/\r$/, "").trimEnd())?.[1] ?? null;
}

/** CRLF read as LF and trailing whitespace removed (the comparison form). */
export function normalizeReleaseRuleLine(line: string): string {
  return line.replace(/\r$/, "").trimEnd();
}

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** Lines above the link footer (`[Unreleased]: ...` / `[x.y.z]: ...`). */
export function linesAboveLinkFooter(text: string): string[] {
  const all = lines(text);
  const footer = all.findIndex((line) => LINK_FOOTER_RE.test(line));
  return footer < 0 ? all : all.slice(0, footer);
}

/** `- ` entry lines under `## [Unreleased]`, normalized, in file order. */
export function unreleasedEntryLines(text: string): string[] {
  const all = lines(text);
  const heading = all.findIndex((line) => UNRELEASED_HEADING_RE.test(line));
  if (heading < 0) return [];
  const out: string[] = [];
  for (let i = heading + 1; i < all.length; i += 1) {
    const line = all[i] ?? "";
    if (NEXT_SECTION_RE.test(line)) break;
    if (line.startsWith("- ")) out.push(normalizeReleaseRuleLine(line));
  }
  return out;
}

/** Release lines anywhere above the link footer, normalized, in file order. */
export function releaseLinesIn(text: string): string[] {
  return linesAboveLinkFooter(text)
    .map(normalizeReleaseRuleLine)
    .filter((line) => releaseLineVersion(line) !== null);
}

/** True when `text` holds a `## [<version>]` heading. */
export function hasReleaseVersionHeading(text: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+\\[${escaped}\\]`, "m").test(text.replace(/\r\n?/g, "\n"));
}

/** Lines of the `## [<version>]` section body (to the next `## [` heading). */
export function versionSectionLines(text: string, version: string): string[] {
  const all = lines(text);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+\\[${escaped}\\]`);
  const start = all.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < all.length; i += 1) {
    const line = all[i] ?? "";
    if (NEXT_SECTION_RE.test(line) || LINK_FOOTER_RE.test(line)) break;
    out.push(line);
  }
  return out;
}

/** Remove every release line from `text` (keeps the rest byte for byte). */
export function stripReleaseLines(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i] ?? "";
    if (releaseLineVersion(line) === null) {
      kept.push(line);
      continue;
    }
    // Drop one blank line that followed the release line, so the section
    // keeps its shape when the line goes.
    if (i + 1 < all.length && (all[i + 1] ?? "").trim().length === 0) i += 1;
  }
  return kept.join(eol);
}

function countLines(source: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of source) {
    const line = normalizeReleaseRuleLine(raw);
    if (line.length === 0) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** Lines `need` holds more often than `have` (each listed once). */
function missingLines(need: Map<string, number>, have: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [line, count] of need) {
    if ((have.get(line) ?? 0) < count) out.push(line);
  }
  return out;
}

function listLines(found: readonly string[]): string {
  // Every line is named, so the operator sees each note that would be lost.
  return found.map((line) => JSON.stringify(line)).join(", ");
}

/** Fragment body lines after the `section:` line (the comparison input of (e)). */
export function fragmentBodyLines(fragmentText: string): string[] {
  const all = lines(fragmentText.replace(/^﻿/, ""));
  const section = all.findIndex((line) => SECTION_LINE_RE.test(line));
  return section < 0 ? all : all.slice(section + 1);
}

/** True for `CHANGELOG.md` (an entry path that is not a fragment). */
function isChangelogFile(path: string): boolean {
  return isChangelogEntryPath(path) && !isChangelogFragmentPath(path);
}

/**
 * Rows outside the release files, as `<status> <path>`: anything but
 * `CHANGELOG.md`, `ROADMAP.md` and a deleted `changelog.d/` fragment.
 */
export function pathsOutsideRelease(rows: readonly ChangelogChangeSetEntry[]): string[] {
  return rows
    .filter((row) => {
      if (isChangelogFile(row.path) || row.path === RELEASE_ROADMAP_REL) return false;
      return !(isChangelogFragmentPath(row.path) && row.status.startsWith("D"));
    })
    .map((row) => `${row.status} ${row.path}`);
}

export interface ReleaseRuleInput {
  /** `git diff --name-status --no-renames <merge-base>...HEAD` rows. */
  readonly changeSet: readonly ChangelogChangeSetEntry[];
  /** `CHANGELOG.md` at the merge base (null when absent). */
  readonly baseChangelog: string | null;
  /** `CHANGELOG.md` in the tree under check. */
  readonly headChangelog: string;
  /** Text of a fragment at the merge base (for deleted fragments), or null. */
  readonly readBaseFragment: (relPath: string) => string | null;
  /** Fragment paths present in the tree under check (`changelog.d/<name>.md`). */
  readonly treeFragmentPaths: readonly string[];
}

export type ReleaseRuleVerdict =
  /** No release line added or removed: judge by the ordinary rules. */
  | { readonly kind: "ordinary" }
  /** A release attempt: never judged by the ordinary rules. */
  | {
      readonly kind: "release";
      readonly ok: boolean;
      readonly version: string | null;
      readonly problems: readonly string[];
    }
  /** An ordinary change set that removes or changes a release line. */
  | { readonly kind: "release-line-removed"; readonly problems: readonly string[] };

/** Multiset difference `a - b` over normalized lines. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of b) left.set(line, (left.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of a) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else out.push(line);
  }
  return out;
}

/**
 * Release rule (#6296 Bound item 5). Pure.
 *
 * A change set whose `CHANGELOG.md` change adds a release line is a release
 * attempt. It passes only when (a) every changed path is `CHANGELOG.md`,
 * `ROADMAP.md` or a deleted fragment; (b) it adds the matching `## [<version>]`
 * heading; (c) the release line is the only `[Unreleased]` entry and the tree
 * holds no fragment; (d) every non-blank merge-base line above the link footer,
 * other than an earlier release line, is still there as often; (e) every
 * non-blank line of the deleted fragments is in the new version section as
 * often. A change set that removes a release line without adding one fails.
 */
export function evaluateReleaseRule(input: ReleaseRuleInput): ReleaseRuleVerdict {
  const base = input.baseChangelog ?? "";
  const baseRelease = releaseLinesIn(base);
  const headRelease = releaseLinesIn(input.headChangelog);
  const added = minus(headRelease, baseRelease);
  const removed = minus(baseRelease, headRelease);

  if (added.length === 0) {
    if (removed.length === 0) return { kind: "ordinary" };
    return {
      kind: "release-line-removed",
      problems: [
        `change set removes or changes the release line ${listLines(removed)} without adding a ` +
          "new one; only a release replaces the release line (#6296)",
      ],
    };
  }

  const problems: string[] = [];
  if (added.length > 1) {
    problems.push(`change set adds ${String(added.length)} release lines: ${listLines(added)}`);
  }
  const version = releaseLineVersion(added[0] ?? "");
  const line = releaseLine(version ?? "");

  // (a) release files only.
  const outside = pathsOutsideRelease(input.changeSet);
  if (outside.length > 0) {
    problems.push(
      "a release change set may change only CHANGELOG.md and ROADMAP.md and delete " +
        `changelog.d/ fragments; it also changes: ${outside.join(", ")}`,
    );
  }

  // (b) matching new version heading.
  if (version !== null) {
    const headHas = hasReleaseVersionHeading(input.headChangelog, version);
    const baseHas = hasReleaseVersionHeading(base, version);
    if (!headHas || baseHas) {
      problems.push(
        `the release line names v${version} but the change set adds no new ## [${version}] heading`,
      );
    }
  }

  // (c) the release line alone; no fragment left.
  const others = unreleasedEntryLines(input.headChangelog).filter((entry) => entry !== line);
  if (others.length > 0) {
    problems.push(
      `[Unreleased] must hold only the release line after a release; it also holds ${listLines(others)}`,
    );
  }
  if (input.treeFragmentPaths.length > 0) {
    problems.push(
      "changelog.d/ must hold no fragment after a release; it holds " +
        `${[...input.treeFragmentPaths].sort().join(", ")} (a note that landed ahead of the release: ` +
        "close the release PR, delete the release branch and run the cut again)",
    );
  }

  // (d) no merge-base line lost.
  const baseKept = linesAboveLinkFooter(base).filter((raw) => releaseLineVersion(raw) === null);
  const lostBase = missingLines(
    countLines(baseKept),
    countLines(linesAboveLinkFooter(input.headChangelog)),
  );
  if (lostBase.length > 0) {
    problems.push(
      `CHANGELOG.md lines at the merge base are missing at HEAD: ${listLines(lostBase)}`,
    );
  }

  // (e) every deleted fragment line in the new version section.
  const fragmentLines: string[] = [];
  const unreadable: string[] = [];
  for (const row of input.changeSet) {
    if (!isChangelogFragmentPath(row.path) || !row.status.startsWith("D")) continue;
    const text = input.readBaseFragment(row.path);
    if (text === null) unreadable.push(row.path);
    else fragmentLines.push(...fragmentBodyLines(text));
  }
  if (unreadable.length > 0) {
    problems.push(`could not read deleted fragment(s) at the merge base: ${unreadable.join(", ")}`);
  }
  const section = version === null ? [] : versionSectionLines(input.headChangelog, version);
  const lostFragment = missingLines(countLines(fragmentLines), countLines(section));
  if (lostFragment.length > 0) {
    problems.push(
      `lines of deleted fragments are missing from the ## [${version ?? "?"}] section: ${listLines(lostFragment)}`,
    );
  }

  return { kind: "release", ok: problems.length === 0, version, problems };
}
