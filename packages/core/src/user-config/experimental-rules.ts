/**
 * Safe USER.md Experimental Rules toggle (#46).
 *
 * Pure string helpers that add/remove only the three canonical meta-philosophy
 * reference lines (SOUL / morals / code-field). Personal and Defaults section
 * bodies are never rewritten — only the `## Experimental Rules` region changes.
 *
 * Detection matches any line containing the deposit path (`meta/SOUL.md`, …);
 * enable writes the canonical setup-skill bullet. Custom bullets for other
 * topics in the same section are preserved.
 */

export type ExperimentalMetaId = "soul" | "morals" | "code-field";

export interface ExperimentalMetaEntry {
  readonly id: ExperimentalMetaId;
  /** Path fragment matched in USER.md lines (e.g. `meta/SOUL.md`). */
  readonly path: string;
  /** Canonical bullet written when enabling. */
  readonly line: string;
}

/** Canonical Experimental Rules entries (setup Phase 1 steps 5a–5c). */
export const EXPERIMENTAL_META_ENTRIES: readonly ExperimentalMetaEntry[] = [
  {
    id: "soul",
    path: "meta/SOUL.md",
    line: "- ! Use meta/SOUL.md for strategic context and purpose-driven guidance",
  },
  {
    id: "morals",
    path: "meta/morals.md",
    line: "- ! Use meta/morals.md for ethical AI development principles",
  },
  {
    id: "code-field",
    path: "meta/code-field.md",
    line: "- ~ Use meta/code-field.md for advanced architecture patterns",
  },
] as const;

export type ExperimentalRulesState = Record<ExperimentalMetaId, boolean>;

const SECTION_HEADING = "## Experimental Rules";

function detectNewline(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function lineMentionsPath(line: string, path: string): boolean {
  return line.includes(path);
}

/**
 * Parse on/off state for the three experimental meta entries.
 * A path is ON when any non-empty line in the file contains that path
 * (typically under `## Experimental Rules`, but path-only matching is enough
 * for display — setup always writes under that heading).
 */
export function parseExperimentalRulesState(userMdText: string): ExperimentalRulesState {
  const state: ExperimentalRulesState = {
    soul: false,
    morals: false,
    "code-field": false,
  };
  for (const line of userMdText.split(/\r?\n/)) {
    for (const entry of EXPERIMENTAL_META_ENTRIES) {
      if (lineMentionsPath(line, entry.path)) {
        state[entry.id] = true;
      }
    }
  }
  return state;
}

/** True when the document has an `## Experimental Rules` heading. */
export function hasExperimentalRulesSection(userMdText: string): boolean {
  return findExperimentalSection(userMdText) !== null;
}

interface SectionSpan {
  /** Index of `## Experimental Rules` heading start. */
  readonly start: number;
  /** Index just past the section (start of next `##` / `---` / EOF). */
  readonly end: number;
  /** Full section including heading. */
  readonly full: string;
  /** Body after the heading line (may include leading newline). */
  readonly body: string;
}

function findExperimentalSection(text: string): SectionSpan | null {
  const re = /^## Experimental Rules[ \t]*\r?\n?/m;
  const match = re.exec(text);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  const afterHeading = start + match[0].length;
  const rest = text.slice(afterHeading);
  // Next H2 or a horizontal rule at line start ends the section.
  const next = /^(## |---[ \t]*$)/m.exec(rest);
  const end = next && next.index !== undefined ? afterHeading + next.index : text.length;
  return {
    start,
    end,
    full: text.slice(start, end),
    body: text.slice(afterHeading, end),
  };
}

/**
 * Build section body lines: preserve non-meta custom bullets; apply desired
 * on/off for the three canonical paths; stable order soul → morals → code-field.
 */
function buildSectionBody(
  existingBody: string,
  desired: ExperimentalRulesState,
  nl: string,
): string {
  const rawLines = existingBody.split(/\r?\n/);
  const custom: string[] = [];
  for (const line of rawLines) {
    if (line.trim() === "") {
      continue;
    }
    const isMeta = EXPERIMENTAL_META_ENTRIES.some((e) => lineMentionsPath(line, e.path));
    if (!isMeta) {
      custom.push(line);
    }
  }

  const metaLines = EXPERIMENTAL_META_ENTRIES.filter((e) => desired[e.id]).map((e) => e.line);
  const bullets = [...metaLines, ...custom];
  if (bullets.length === 0) {
    return "";
  }
  // Heading + blank line + bullets + trailing blank line for clean separation.
  return `${SECTION_HEADING}${nl}${nl}${bullets.join(nl)}${nl}`;
}

/**
 * Insert a new Experimental Rules section before the trailing `---` / Note
 * block when present; otherwise append after the last non-empty content.
 */
function insertSection(text: string, section: string, nl: string): string {
  // Prefer before the trailing horizontal rule that precedes the USER.md Note
  // block (allow blank lines between `---` and `**Note**`).
  const noteRe = /\r?\n---[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*\*\*Note\*\*/;
  const noteMatch = noteRe.exec(text);
  if (noteMatch && noteMatch.index !== undefined) {
    const before = text.slice(0, noteMatch.index).replace(/[ \t]+$/u, "");
    const after = text.slice(noteMatch.index);
    const sep = before.endsWith(nl) ? nl : `${nl}${nl}`;
    return `${before}${sep}${section.replace(/\s+$/u, "")}${after}`;
  }

  const trimmed = text.replace(/\s+$/u, "");
  return `${trimmed}${nl}${nl}${section.replace(/\s+$/u, "")}${nl}`;
}

/**
 * Apply desired Experimental Rules on/off state.
 *
 * - Only mutates the `## Experimental Rules` region (or inserts/removes it).
 * - Personal / Defaults content is left byte-identical outside that region.
 * - Enabling uses the canonical setup-skill lines; disabling drops path matches.
 * - Custom non-meta bullets under the section are preserved.
 * - When all three are off and no custom bullets remain, the section is removed.
 */
export function applyExperimentalRulesState(
  userMdText: string,
  desired: ExperimentalRulesState,
): string {
  const nl = detectNewline(userMdText);
  const sectionText = buildSectionBody(
    findExperimentalSection(userMdText)?.body ?? "",
    desired,
    nl,
  );

  const existing = findExperimentalSection(userMdText);
  if (existing) {
    if (!sectionText) {
      // Remove section; tidy surrounding blank lines.
      const before = userMdText.slice(0, existing.start).replace(/[ \t]+$/u, "");
      let after = userMdText.slice(existing.end);
      // Collapse to at most two newlines at the join.
      const beforeCore = before.replace(/(\r?\n){2,}$/u, nl);
      after = after.replace(/^(\r?\n)+/u, nl);
      if (after.startsWith("---") || after.startsWith("## ")) {
        return `${beforeCore.replace(/(\r?\n)+$/u, nl)}${nl}${after}`;
      }
      return `${beforeCore}${after}`;
    }
    return userMdText.slice(0, existing.start) + sectionText + userMdText.slice(existing.end);
  }

  if (!sectionText) {
    return userMdText;
  }
  return insertSection(userMdText, sectionText, nl);
}

/**
 * Toggle a single experimental meta entry; leave the other two unchanged.
 */
export function setExperimentalRule(
  userMdText: string,
  id: ExperimentalMetaId,
  enabled: boolean,
): string {
  const current = parseExperimentalRulesState(userMdText);
  return applyExperimentalRulesState(userMdText, { ...current, [id]: enabled });
}

/**
 * Extract the byte-range of a named `##` section for non-clobber assertions.
 * Returns null when the heading is absent.
 */
export function extractMarkdownH2Section(userMdText: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}[ \\t]*\\r?\\n?`, "m");
  const match = re.exec(userMdText);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  const afterHeading = start + match[0].length;
  const rest = userMdText.slice(afterHeading);
  const next = /^(## )/m.exec(rest);
  const end = next && next.index !== undefined ? afterHeading + next.index : userMdText.length;
  return userMdText.slice(start, end);
}
