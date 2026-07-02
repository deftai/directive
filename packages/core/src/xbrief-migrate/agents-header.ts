import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { iterManagedSections } from "../platform/agents-md.js";
import { MIGRATED_ARTIFACT_DIR } from "./constants.js";
import { isDirectory } from "./fs-helpers.js";

/**
 * Bounded, ordered set of legacy crossover tokens rewritten in the UNMANAGED
 * region of a consumer AGENTS.md after `migrate:xbrief` (#2154 / Option A).
 *
 * Each entry is a mechanical path / verb literal — NOT freeform prose. The
 * casing-only `vBRIEF format` product-description token from the issue table is
 * intentionally excluded so freeform prose survives untouched. The tokens are
 * disjoint substrings (`.vbrief.json` has no trailing slash, `vbrief:preflight`
 * uses a colon, `vbrief/` requires a slash), so replacement order does not
 * change the result and a second pass is a guaranteed no-op (idempotent).
 */
export const LEGACY_HEADER_TOKENS: ReadonlyArray<{
  readonly legacy: string;
  readonly migrated: string;
}> = [
  { legacy: ".vbrief.json", migrated: ".xbrief.json" },
  { legacy: "vbrief:preflight", migrated: "xbrief:preflight" },
  { legacy: "vbrief/", migrated: "xbrief/" },
];

export interface HeaderTokenReplacement {
  readonly legacy: string;
  readonly migrated: string;
  readonly count: number;
}

export interface HeaderRewriteResult {
  readonly content: string;
  readonly changed: boolean;
  readonly replacements: HeaderTokenReplacement[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Rewrite the bounded legacy tokens inside a single unmanaged text slice. */
function rewriteSlice(slice: string, tally: Map<string, number>): string {
  let next = slice;
  for (const { legacy, migrated } of LEGACY_HEADER_TOKENS) {
    const occurrences = countOccurrences(next, legacy);
    if (occurrences === 0) continue;
    tally.set(legacy, (tally.get(legacy) ?? 0) + occurrences);
    next = next.replaceAll(legacy, migrated);
  }
  return next;
}

/**
 * Rewrite known legacy `vbrief` crossover tokens in the UNMANAGED region(s) of
 * an AGENTS.md document, leaving every `<!-- deft:managed-section ... -->` block
 * byte-for-byte intact. Idempotent: running on already-migrated content is a
 * no-op. Managed sections are located by literal markers on the raw text so no
 * line-ending normalisation is performed (UTF-8 / CRLF safe).
 */
export function rewriteUnmanagedHeaderTokens(content: string): HeaderRewriteResult {
  const managed = iterManagedSections(content);
  const tally = new Map<string, number>();

  let out = "";
  let cursor = 0;
  for (const [start, end] of managed) {
    // Unmanaged slice before this managed block: eligible for rewrite.
    out += rewriteSlice(content.slice(cursor, start), tally);
    // Managed block: preserved verbatim.
    out += content.slice(start, end);
    cursor = end;
  }
  // Trailing unmanaged slice after the last managed block (or the whole file
  // when there is no managed section at all).
  out += rewriteSlice(content.slice(cursor), tally);

  const replacements: HeaderTokenReplacement[] = LEGACY_HEADER_TOKENS.filter((t) =>
    tally.has(t.legacy),
  ).map((t) => ({
    legacy: t.legacy,
    migrated: t.migrated,
    count: tally.get(t.legacy) ?? 0,
  }));

  return { content: out, changed: out !== content, replacements };
}

export interface HeaderPatchOutcome {
  readonly kind: "patched" | "clean" | "absent" | "failed";
  readonly path: string;
  readonly replacements: HeaderTokenReplacement[];
  readonly error?: string;
}

/**
 * Read AGENTS.md at `projectRoot`, rewrite legacy tokens in the unmanaged
 * header, and write the result back only when something changed. Returns a
 * structured outcome so the caller can log a LEGACY-REPORT-style summary.
 *
 * Non-fatal: a write failure (read-only file, full disk) is captured as a
 * `failed` outcome rather than thrown, so a post-migration header patch can
 * never crash a migration that already succeeded.
 */
export function patchAgentsMdHeader(
  projectRoot: string,
  seams: {
    readText?: (path: string) => string | null;
    writeText?: (path: string, text: string) => void;
  } = {},
): HeaderPatchOutcome {
  const agentsPath = join(projectRoot, "AGENTS.md");
  const readText =
    seams.readText ??
    ((path: string) => {
      try {
        if (!existsSync(path)) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
  const writeText =
    seams.writeText ?? ((path: string, text: string) => writeFileSync(path, text, "utf8"));

  const existing = readText(agentsPath);
  if (existing === null) {
    return { kind: "absent", path: agentsPath, replacements: [] };
  }

  const result = rewriteUnmanagedHeaderTokens(existing);
  if (!result.changed) {
    return { kind: "clean", path: agentsPath, replacements: [] };
  }

  try {
    writeText(agentsPath, result.content);
  } catch (err) {
    return {
      kind: "failed",
      path: agentsPath,
      replacements: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: "patched", path: agentsPath, replacements: result.replacements };
}

/** Human-readable one-line summary of a header patch outcome (LEGACY-REPORT style). */
export function renderHeaderPatchSummary(outcome: HeaderPatchOutcome): string {
  if (outcome.kind === "absent") {
    return "AGENTS.md unmanaged header: no AGENTS.md present — nothing to patch.";
  }
  if (outcome.kind === "clean") {
    return "AGENTS.md unmanaged header: no legacy vbrief tokens found — nothing to patch.";
  }
  if (outcome.kind === "failed") {
    return (
      `AGENTS.md unmanaged header: patch failed (${outcome.error ?? "unknown error"}) — ` +
      "re-run `deft migrate:xbrief` (idempotent) or hand-edit the header."
    );
  }
  const total = outcome.replacements.reduce((sum, r) => sum + r.count, 0);
  const detail = outcome.replacements.map((r) => `${r.legacy} ×${r.count}`).join(", ");
  return `AGENTS.md unmanaged header: rewrote ${total} legacy vbrief token(s) -> xbrief (${detail}).`;
}

export interface StaleHeaderDetection {
  readonly stale: boolean;
  readonly matches: string[];
}

/**
 * Detect the #2154 half-migrated state: the `xbrief/` tree exists (lifecycle
 * migration + managed-section refresh already happened) yet the UNMANAGED
 * AGENTS.md header still references legacy `vbrief` path / verb literals — a
 * regression `deft doctor` cannot see because the managed-section byte compare
 * passes (#1308). Returns the matched legacy tokens for the signpost.
 */
export function detectStaleUnmanagedHeader(
  projectRoot: string,
  readText: (path: string) => string | null = (path) => {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
): StaleHeaderDetection {
  if (!isDirectory(join(projectRoot, MIGRATED_ARTIFACT_DIR))) {
    return { stale: false, matches: [] };
  }
  const content = readText(join(projectRoot, "AGENTS.md"));
  if (content === null) {
    return { stale: false, matches: [] };
  }

  const managed = iterManagedSections(content);
  let unmanaged = "";
  let cursor = 0;
  for (const [start, end] of managed) {
    unmanaged += content.slice(cursor, start);
    cursor = end;
  }
  unmanaged += content.slice(cursor);

  const matches = LEGACY_HEADER_TOKENS.filter((t) => unmanaged.includes(t.legacy)).map(
    (t) => t.legacy,
  );
  return { stale: matches.length > 0, matches };
}

/** One-line doctor / ritual signpost for the #2154 stale-header regression. */
export function renderStaleHeaderLine(
  projectRoot: string,
  readText?: (path: string) => string | null,
): string {
  const { stale, matches } = detectStaleUnmanagedHeader(projectRoot, readText);
  if (!stale) {
    return "AGENTS.md header drift: none -- unmanaged header has no legacy vbrief path literals.";
  }
  return (
    `AGENTS.md header drift: xbrief/ tree present but the unmanaged AGENTS.md header still ` +
    `references legacy token(s) ${matches.join(", ")}. ` +
    "Run `deft migrate:xbrief` (idempotent) to rewrite them, or hand-edit the header."
  );
}
