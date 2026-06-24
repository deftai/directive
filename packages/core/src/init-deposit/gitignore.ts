/**
 * Greenfield init `.gitignore` upkeep + deposit reconstitution (#1942 S4).
 *
 * Writes the canonical deft-install baseline (mirroring cmd/deft-install/setup.go
 * EnsureGitignoreLines) and, for greenfield installs, appends `.deft/core/` so the
 * deposit is born ignored (node_modules model). Existing tracked deposits are left
 * alone — the vendored→hybrid un-commit is owned by #1941.
 *
 * Refs #1942, #1941, #1015, #1464, #1672.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORBIDDEN_BLANKET_EVAL_LINES,
  stripGitignoreInlineComment,
} from "../triage/bootstrap/gitignore.js";
import type { InitDepositIo } from "./scaffold.js";

/** Directory ignore entry for the hybrid deposit (greenfield only). */
export const GITIGNORE_DEFT_CORE_LINE = ".deft/core/";

/** Alternate spellings that already cover the deposit ignore entry. */
const DEFT_CORE_COVERING_LINES = new Set([".deft/core/", ".deft/core"]);

/**
 * Canonical baseline mirrored from cmd/deft-install/setup.go::canonicalGitignoreLines
 * (excluding `.deft/core/` — that line is greenfield-only per Option B / #1941 split).
 */
export const CANONICAL_GITIGNORE_BASELINE: readonly string[] = [
  ".deft-cache/",
  ".deft/ritual-state.json",
  ".deft/last-session.json",
  ".deft/routing.local.json",
  "vbrief/.eval/candidates.jsonl",
  "vbrief/.eval/summary-history.jsonl",
  "vbrief/.eval/scope-lifecycle.jsonl",
  "vbrief/.eval/decompositions/",
  "vbrief/.eval/doctor-state.json",
  "vbrief/*.lock",
  ".deft/core.bak-*/",
  ".deft/*.bak-*",
  "*.premigrate.*",
];

const DEFT_FRAMEWORK_GITIGNORE_HEADER =
  "# Deft framework: ignore local-only caches and scratch directories\n";

const DEFT_CORE_GITIGNORE_RATIONALE =
  "# Hybrid deposit (#1942): reconstituted by `directive init` like node_modules.\n" +
  "# The vendored→hybrid un-commit for existing tracked deposits is #1941.\n";

export interface EnsureInitGitignoreResult {
  readonly changed: boolean;
  readonly deftCoreIgnored: boolean;
  readonly skippedDeftCoreBecauseTracked: boolean;
}

export interface ReconstituteDepositResult {
  readonly reconstituted: boolean;
}

export type GitLsFiles = (projectDir: string, paths: readonly string[]) => string | null;

function defaultGitLsFiles(projectDir: string, paths: readonly string[]): string | null {
  try {
    return execFileSync("git", ["ls-files", "--", ...paths], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

function isForbiddenBlanketEvalLine(line: string): boolean {
  return FORBIDDEN_BLANKET_EVAL_LINES.includes(line);
}

function gitignoreCoversLine(present: ReadonlySet<string>, line: string): boolean {
  if (present.has(line)) return true;
  if (line === GITIGNORE_DEFT_CORE_LINE) {
    return [...DEFT_CORE_COVERING_LINES].some((candidate) => present.has(candidate));
  }
  return false;
}

function collectPresentGitignoreLines(existing: string): Set<string> {
  const present = new Set<string>();
  for (const raw of existing.split("\n")) {
    const stripped = stripGitignoreInlineComment(raw);
    if (stripped) present.add(stripped);
  }
  return present;
}

/**
 * Reports whether `.deft/core` is tracked in git. Returns `null` when git is
 * unavailable or the tree is not a repository (treated as greenfield).
 */
export function isDepositTrackedInGit(
  projectDir: string,
  gitLsFiles: GitLsFiles = defaultGitLsFiles,
): boolean | null {
  const tracked = gitLsFiles(projectDir, [".deft/core", ".deft/core/"]);
  if (tracked === null) return null;
  return tracked.trim().length > 0;
}

/** Build the canonical line set for this init, honoring the Option B journey split. */
export function resolveInitGitignoreLines(
  projectDir: string,
  gitLsFiles: GitLsFiles = defaultGitLsFiles,
): { readonly lines: readonly string[]; readonly includeDeftCore: boolean } {
  const tracked = isDepositTrackedInGit(projectDir, gitLsFiles);
  const includeDeftCore = tracked !== true;
  return {
    lines: includeDeftCore
      ? [...CANONICAL_GITIGNORE_BASELINE, GITIGNORE_DEFT_CORE_LINE]
      : CANONICAL_GITIGNORE_BASELINE,
    includeDeftCore,
  };
}

/**
 * Ensure the consumer `.gitignore` carries the canonical baseline plus, for
 * greenfield installs, the `.deft/core/` ignore entry. Heals forbidden blanket
 * `vbrief/.eval/` lines (#1464). Never un-commits a tracked deposit (#1941).
 */
export function ensureInitGitignoreLines(
  projectDir: string,
  io: InitDepositIo,
  options: { gitLsFiles?: GitLsFiles } = {},
): EnsureInitGitignoreResult {
  const gitLsFiles = options.gitLsFiles ?? defaultGitLsFiles;
  const { lines: targetLines, includeDeftCore } = resolveInitGitignoreLines(projectDir, gitLsFiles);
  const tracked = isDepositTrackedInGit(projectDir, gitLsFiles);
  const path = join(projectDir, ".gitignore");

  let existing = "";
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, { encoding: "utf8" });
    } catch (cause) {
      throw new Error(`could not read .gitignore: ${String(cause)}`);
    }
  }

  let rawLines = existing.split("\n");
  let trailingNewline = false;
  if (existing.endsWith("\n") && rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    trailingNewline = true;
    rawLines = rawLines.slice(0, -1);
  }

  const kept: string[] = [];
  let blanketRemoved = false;
  const present = new Set<string>();
  for (const raw of rawLines) {
    const stripped = stripGitignoreInlineComment(raw);
    if (isForbiddenBlanketEvalLine(stripped)) {
      blanketRemoved = true;
      continue;
    }
    kept.push(raw);
    if (stripped) present.add(stripped);
  }

  const additions: string[] = [];
  for (const line of targetLines) {
    if (!gitignoreCoversLine(present, line)) {
      additions.push(line);
    }
  }

  if (!blanketRemoved && additions.length === 0) {
    io.printf(".gitignore already covers the canonical deft entries — skipping.\n");
    return {
      changed: false,
      deftCoreIgnored: gitignoreCoversLine(present, GITIGNORE_DEFT_CORE_LINE),
      skippedDeftCoreBecauseTracked: tracked === true,
    };
  }

  let healed = kept.join("\n");
  if (kept.length > 0 && trailingNewline) {
    healed += "\n";
  }

  let body = healed;
  if (additions.length > 0) {
    if (healed !== "" && !healed.endsWith("\n")) {
      body += "\n";
    }
    if (healed !== "" && !healed.endsWith("\n\n")) {
      body += "\n";
    }
    body += DEFT_FRAMEWORK_GITIGNORE_HEADER;
    if (includeDeftCore && additions.includes(GITIGNORE_DEFT_CORE_LINE)) {
      body += DEFT_CORE_GITIGNORE_RATIONALE;
    }
    for (const add of additions) {
      body += `${add}\n`;
    }
  }

  try {
    writeFileSync(path, body, { encoding: "utf8", mode: 0o644 });
  } catch (cause) {
    throw new Error(`could not write .gitignore: ${String(cause)}`);
  }

  if (additions.length > 0) {
    io.printf(`.gitignore updated with canonical entries: ${additions.join(", ")}\n`);
  }
  if (blanketRemoved) {
    io.printf(".gitignore healed: removed forbidden blanket vbrief/.eval/ line (#1464).\n");
  }
  if (tracked === true) {
    io.printf(
      ".deft/core is tracked in git — leaving it tracked; vendored→hybrid un-commit is #1941.\n",
    );
  }

  const finalPresent = collectPresentGitignoreLines(body);
  return {
    changed: true,
    deftCoreIgnored: gitignoreCoversLine(finalPresent, GITIGNORE_DEFT_CORE_LINE),
    skippedDeftCoreBecauseTracked: tracked === true,
  };
}

/**
 * Copy the content package into `.deft/core`, reporting whether the deposit was
 * absent before copy (reconstitution). Always refreshes when present.
 */
export async function reconstituteDepositFromContent(
  contentRoot: string,
  deftDir: string,
  copyContent: (src: string, dst: string) => Promise<void>,
): Promise<ReconstituteDepositResult> {
  const wasAbsent = !existsSync(deftDir);
  await copyContent(contentRoot, deftDir);
  return { reconstituted: wasAbsent };
}
