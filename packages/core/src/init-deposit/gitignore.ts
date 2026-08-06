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
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE } from "../policy/deft-directive-disable.js";
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
  ".deft/cache/",
  ".deft/.cli/",
  ".deft/ritual-state.json",
  ".deft/last-session.json",
  ".deft/routing.local.json",
  // Temporary test/local kill-switch — must stay untracked (#3039).
  DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE,
  "vbrief/.triage-cache/candidates.jsonl",
  "vbrief/.triage-cache/summary-history.jsonl",
  "vbrief/.triage-cache/scope-lifecycle.jsonl",
  "vbrief/.triage-cache/decompositions/",
  "vbrief/.triage-cache/doctor-state.json",
  // Per-clone session state (#3146): throttle / release-availability JSON
  // written under the lifecycle .triage-cache; selective ignore only (hybrid
  // #1144 — never blanket-ignore the whole .triage-cache directory).
  "vbrief/.triage-cache/staleness-tickler-state.json",
  "vbrief/.triage-cache/release-availability-state.json",
  // Symmetric `xbrief/` layout entries (#2348). On the migrated `xbrief/` tree
  // the engine writes operator-private triage-cache files to
  // `xbrief/.triage-cache/`; without these the paths are trackable, violating
  // the #1144 hybrid policy. Both layouts are emitted (harmless extra lines on
  // the layout not in use) to match the both-layout `.eval/` treatment.
  "xbrief/.triage-cache/candidates.jsonl",
  "xbrief/.triage-cache/summary-history.jsonl",
  "xbrief/.triage-cache/scope-lifecycle.jsonl",
  "xbrief/.triage-cache/decompositions/",
  "xbrief/.triage-cache/doctor-state.json",
  "xbrief/.triage-cache/staleness-tickler-state.json",
  "xbrief/.triage-cache/release-availability-state.json",
  "vbrief/*.lock",
  ".deft/core.bak-*/",
  ".deft/*.bak-*",
  // xBRIEF-era migration-backup directories created by `deft migrate:xbrief` (#2206).
  ".deft/xbrief-migrate-backup-*/",
  "*.premigrate.*",
  // Generated version-eval results live under `.eval/results/` (NOT triage-cache)
  // for both the legacy `vbrief/` tree and the post-#2034 `xbrief/` tree (#2206).
  "vbrief/.eval/results/",
  "xbrief/.eval/results/",
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
 * Ignore entries the deft framework MUST NEVER add to `.gitignore`. The
 * committed `package.json` pin (#2264) is the reconstitution anchor for the
 * un-committed deposit; ignoring it would silently drop the pin from version
 * control and break `migrate --untrack-core`'s reconstitution guarantee (#2269).
 */
const NEVER_IGNORE_LINES = new Set(["package.json", "/package.json"]);

interface GitignoreReconciliation {
  readonly changed: boolean;
  readonly additions: string[];
  readonly blanketRemoved: boolean;
  readonly deftCoreIgnored: boolean;
  readonly alreadyCovered: boolean;
}

/**
 * Read, heal, and reconcile `.gitignore` against `targetLines`. Shared by the
 * greenfield-init and the vendored→hybrid un-commit reconcilers so the
 * read/heal/append/write path lives in exactly one place. Pure of any caller
 * messaging — the callers decide what to print from the returned record. The
 * `package.json` pin is filtered out unconditionally (#2269 invariant).
 */
function reconcileGitignoreFile(
  projectDir: string,
  targetLines: readonly string[],
  includeDeftCoreRationale: boolean,
): GitignoreReconciliation {
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
    // Invariant (#2269): never ignore the committed package.json pin.
    if (NEVER_IGNORE_LINES.has(line.trim())) continue;
    if (!gitignoreCoversLine(present, line)) {
      additions.push(line);
    }
  }

  if (!blanketRemoved && additions.length === 0) {
    return {
      changed: false,
      additions,
      blanketRemoved,
      deftCoreIgnored: gitignoreCoversLine(present, GITIGNORE_DEFT_CORE_LINE),
      alreadyCovered: true,
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
    if (includeDeftCoreRationale && additions.includes(GITIGNORE_DEFT_CORE_LINE)) {
      body += DEFT_CORE_GITIGNORE_RATIONALE;
    }
    for (const add of additions) {
      body += `${add}\n`;
    }
  }

  try {
    // Keep early containment so ProjectionContainmentError type is preserved for callers/tests.
    assertWriteTargetSafe(projectDir, path);
    // #2980 wave A: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectDir),
      target: path,
      data: body,
      mode: "replace",
    });
  } catch (cause) {
    if (cause instanceof ProjectionContainmentError) {
      throw cause;
    }
    throw new Error(`could not write .gitignore: ${String(cause)}`);
  }

  const finalPresent = collectPresentGitignoreLines(body);
  return {
    changed: true,
    additions,
    blanketRemoved,
    deftCoreIgnored: gitignoreCoversLine(finalPresent, GITIGNORE_DEFT_CORE_LINE),
    alreadyCovered: false,
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

  const res = reconcileGitignoreFile(projectDir, targetLines, includeDeftCore);

  if (res.alreadyCovered) {
    io.printf(".gitignore already covers the canonical deft entries — skipping.\n");
    return {
      changed: false,
      deftCoreIgnored: res.deftCoreIgnored,
      skippedDeftCoreBecauseTracked: tracked === true,
    };
  }

  if (res.additions.length > 0) {
    io.printf(`.gitignore updated with canonical entries: ${res.additions.join(", ")}\n`);
  }
  if (res.blanketRemoved) {
    io.printf(".gitignore healed: removed forbidden blanket vbrief/.eval/ line (#1464).\n");
  }
  if (tracked === true) {
    io.printf(
      ".deft/core is tracked in git — leaving it tracked; vendored→hybrid un-commit is #1941.\n",
    );
  }

  return {
    changed: true,
    deftCoreIgnored: res.deftCoreIgnored,
    skippedDeftCoreBecauseTracked: tracked === true,
  };
}

/**
 * The reconciled ignore set for the vendored→hybrid un-commit (#2269): the
 * canonical baseline (which already covers `.deft/.cli/`, `.deft/ritual-state.json`,
 * and the `.deft-cache/` path) plus the `.deft/core/` deposit entry that
 * greenfield init born-ignores. `package.json` is deliberately absent — the
 * committed pin MUST stay tracked so content can be reconstituted after the
 * deposit is un-committed.
 */
export const UNTRACK_CORE_GITIGNORE_LINES: readonly string[] = [
  ...CANONICAL_GITIGNORE_BASELINE,
  GITIGNORE_DEFT_CORE_LINE,
];

/**
 * Reconcile `.gitignore` for the `migrate --untrack-core` path: force the
 * `.deft/core/` deposit entry (init leaves a tracked deposit alone, but
 * un-track has just removed it from the index, so it MUST now be ignored) plus
 * the canonical baseline, and never ignore the committed `package.json` pin.
 * Idempotent: a second run over an already-reconciled `.gitignore` makes no
 * change.
 */
export function ensureUntrackCoreGitignoreLines(
  projectDir: string,
  io: InitDepositIo,
): EnsureInitGitignoreResult {
  const res = reconcileGitignoreFile(projectDir, UNTRACK_CORE_GITIGNORE_LINES, false);

  if (res.alreadyCovered) {
    io.printf(
      ".gitignore already ignores .deft/core/ and the canonical deft entries — skipping.\n",
    );
    return {
      changed: false,
      deftCoreIgnored: res.deftCoreIgnored,
      skippedDeftCoreBecauseTracked: false,
    };
  }

  if (res.additions.length > 0) {
    io.printf(`.gitignore updated with canonical entries: ${res.additions.join(", ")}\n`);
  }
  if (res.blanketRemoved) {
    io.printf(".gitignore healed: removed forbidden blanket vbrief/.eval/ line (#1464).\n");
  }

  return {
    changed: true,
    deftCoreIgnored: res.deftCoreIgnored,
    skippedDeftCoreBecauseTracked: false,
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
