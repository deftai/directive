/**
 * Human plan/progress/report presentation (UNIFIED §C9 Examples A–F / F-002 UX-PRESENT).
 * Wave 3g: F-009 plain shop English, F-011 TTY word-wrap, F-014 uninstall summaries.
 * Default stdout is prose + labels; keyed machine dumps stay behind verbosity ≥1.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageManager } from "./pm.js";
import { INSTALL_SCRIPT_POLICY_PLAN_LINE } from "./pm.js";

/**
 * Repair-plan bullet when host-hook opt-out rewrite/remove may run (#7349 P3).
 * Kept in sync with core `hostHookRepairOptOutDisclosureBullet` (entry-guard-style
 * CLI local copy — CLI production sources do not import core package deep paths).
 */
export function hostHookRepairOptOutDisclosureBullet(
  host: "claude" | "cursor" | "codex" | "grok" | "agy" = "claude",
): string {
  const registration =
    host === "cursor"
      ? ".cursor/hooks.json"
      : host === "codex"
        ? ".codex/hooks.json"
        : host === "grok"
          ? ".grok/hooks/deft.json"
          : host === "agy"
            ? ".agents/hooks.json"
            : ".claude/settings.json";
  const outerGlob =
    host === "cursor"
      ? ".cursor/deft-hook-*.mjs"
      : host === "codex"
        ? ".codex/deft-hook-*.mjs"
        : host === "grok"
          ? ".grok/hooks/deft-hook-*.mjs"
          : host === "agy"
            ? ".agents/deft-hook-*.mjs"
            : ".claude/deft-hook-*.mjs";
  return `rewrite or remove Directive host hooks when plan.policy.hostHooks opts out (${registration}, ${outerGlob})`;
}

/** Local IO shape (matches bookends BookendIo; avoid circular import). */
export interface PresentIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/** 0 = human default; 1 = -v/--verbose; 2 = -vv/--debug */
export type Verbosity = 0 | 1 | 2;

/** Prefer readable paragraph width even on ultra-wide TTYs. */
export const WRAP_FLOOR = 40;
export const WRAP_CEILING = 100;
export const WRAP_FALLBACK = 80;

/**
 * Insider script-policy sentence — kept for tests / -v dumps only (wave 4g).
 * Default plans describe PM effect in plain bullets; exact argv lives at -v.
 */
export const HUMAN_INSTALL_SCRIPT_LINE =
  "Installation skips package lifecycle scripts for the Directive pin add; other project registry, authentication, proxy, and lockfile settings still apply.";

/** Plain -v script note (wave 4g approved copy). */
export const HUMAN_INSTALL_SCRIPT_SETTINGS_LINE =
  "Directive skips lifecycle scripts on that add. Other project install settings still apply.";

/** @deprecated wave 4g — default plans no longer hero this label; kept for test imports. */
export const INSTALL_COMMAND_LABEL = "Install command:";

/** -v label for the actual PM command (AC5.1 evidence). */
export const PM_WILL_RUN_LABEL = "Package manager will run:";

/** Plain no-git disclosure (F-009 / F-010 voice) — incomplete install / precondition. */
export const HUMAN_GIT_HOOKS_INACTIVE_LINE =
  "Incomplete install: this folder is not a git repository yet, so git hooks will not be installed. After you run git init, run directive install --repair so hooks get installed.";

/** Directive's git hooks, in the order setup writes them (D-023). */
export const DIRECTIVE_GIT_HOOK_PATHS: readonly string[] = [
  ".githooks/_directive-run.sh",
  ".githooks/pre-commit",
  ".githooks/pre-push",
];

/** The old git-hook helper that setup removes once no hook uses it. */
export const LEGACY_GIT_HOOK_HELPER = ".githooks/_deft-run.sh";

/** Git hooks a setup run will write, replace or remove (D-023). */
export interface GitHookPlan {
  readonly write: readonly string[];
  readonly replace: readonly string[];
  readonly remove: readonly string[];
}

/** Read which Directive git hooks exist, to list them in the plan (D-023). */
export function readGitHookPlan(projectRoot: string): GitHookPlan {
  const present = (rel: string): boolean => {
    try {
      return existsSync(join(projectRoot, rel));
    } catch {
      return false;
    }
  };
  return {
    write: DIRECTIVE_GIT_HOOK_PATHS.filter((rel) => !present(rel)),
    replace: DIRECTIVE_GIT_HOOK_PATHS.filter((rel) => present(rel)),
    remove: present(LEGACY_GIT_HOOK_HELPER) ? [LEGACY_GIT_HOOK_HELPER] : [],
  };
}

function writeGitHookPlanBullets(io: PresentIo, plan: GitHookPlan): void {
  if (plan.write.length > 0) {
    writeBullet(io, `write git hooks ${plan.write.join(", ")}`);
  }
  if (plan.replace.length > 0) {
    writeBullet(
      io,
      `replace git hooks ${plan.replace.join(", ")} where they differ from this version, even if edited (a hook that is not Directive's is left as it is and reported)`,
    );
  }
  for (const rel of plan.remove) {
    writeBullet(io, `remove the old git-hook helper ${rel} if no other hook uses it`);
  }
}

/**
 * #4960 / ledger Problem 20 — Git hooks that Directive's `.githooks` would replace.
 * `scope` is the Git config scope of `core.hooksPath` (`global`, `system`, `local`,
 * `worktree`), or `default` when it is unset and Git's own hooks folder has hooks.
 */
export interface HooksTakeover {
  readonly previous: string;
  readonly scope: string | null;
  /** Hook file names found in Git's default hooks folder (scope `default` only). */
  readonly hooks: readonly string[];
}

function describeHooksSource(t: HooksTakeover): string {
  switch (t.scope) {
    case "default":
      return `this repository's own hooks folder (${t.previous}: ${t.hooks.join(", ")})`;
    case "global":
      return `${t.previous} (set in your global Git config)`;
    case "system":
      return `${t.previous} (set in your system Git config)`;
    case "local":
    case "worktree":
      return `${t.previous} (set in this repository's Git config)`;
    default:
      return `${t.previous} (set in your Git config)`;
  }
}

/** Plan warning (same plan, same approval; no second prompt — Problem 20). */
export function formatHooksTakeoverPlanWarning(t: HooksTakeover): string {
  return (
    `Git hooks: this repository currently runs Git hooks from ${describeHooksSource(t)}. ` +
    "Git runs hooks from one folder only. If you approve, this repository will use " +
    "Directive's .githooks folder instead, so those earlier hooks (for example commit-msg, " +
    "pre-commit or pre-push) will not run here unless you move them into .githooks or use " +
    "a hook manager. To keep things as they are, decline."
  );
}

/** Post-op statement after a takeover. */
export function formatHooksTakeoverDone(t: HooksTakeover): string {
  return (
    "This repository now uses Directive's .githooks folder. Hooks from " +
    `${describeHooksSource(t)} no longer run here.`
  );
}

/** Optional one-line tip (Problem 20: link only; Directive never installs these). */
export const HOOK_MANAGER_TIP_LINE =
  "Tip: to run hooks from several tools together, use a hook manager such as Husky (https://typicode.github.io/husky/) or Lefthook (https://github.com/evilmartians/lefthook).";

export function lockfileNameFor(pm: PackageManager): string {
  return pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
}

export function parseVerbosityFlags(argv: readonly string[]): {
  verbosity: Verbosity;
  rest: string[];
} {
  const rest: string[] = [];
  let verbosity: Verbosity = 0;
  for (const a of argv) {
    if (a === "-v" || a === "--verbose") {
      verbosity = Math.max(verbosity, 1) as Verbosity;
      continue;
    }
    if (a === "-vv" || a === "--debug") {
      verbosity = 2;
      continue;
    }
    // curl-like: -vvv treated as debug
    if (/^-v{2,}$/.test(a)) {
      verbosity = 2;
      continue;
    }
    rest.push(a);
  }
  return { verbosity, rest };
}

export interface CommonPlanFields {
  readonly projectRoot: string;
  readonly pm: PackageManager;
  readonly pmEvidence: string;
  readonly version: string;
  readonly gitHooksInactive: boolean;
  readonly nodeWarning: string | null;
  readonly verbosity: Verbosity;
  /** Git hooks setup will write, replace or remove; read from the project when absent. */
  readonly gitHooks?: GitHookPlan;
}

function gitHookPlanFor(fields: CommonPlanFields): GitHookPlan {
  return fields.gitHooks ?? readGitHookPlan(fields.projectRoot);
}

export interface FirstInstallPlanFields extends CommonPlanFields {
  readonly pmCommand: string;
  readonly willCreatePkg: boolean;
  /** #4960: hooks this install would replace; null/absent when none. */
  readonly hooksTakeover?: HooksTakeover | null;
}

export interface RepairPlanFields extends CommonPlanFields {
  readonly needsPmRestore: boolean;
  readonly pmCommand: string | null;
  readonly restoreReason: string | null;
  /** #4960: hooks this repair would replace; null/absent when none. */
  readonly hooksTakeover?: HooksTakeover | null;
}

export interface UpgradePlanFields extends CommonPlanFields {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly versionChange: boolean;
  readonly pmCommand: string | null;
  readonly needSetup: boolean;
  readonly needMigrate: boolean;
  readonly oldStyle: boolean;
  /** WAVE3-V2 convert-via-removals shape id when upgrading a historical layout. */
  readonly convertShapeId?: string | null;
  /** Convert shape with no package.json: upgrade creates `{ "private": true }` (#5965). */
  readonly willCreatePkg?: boolean;
  /**
   * Paths Git reports as modified or untracked under `.deft/core` (AC10.6 /
   * RC-03, #6002). Listed in the conversion plan before removal; no prompt.
   */
  readonly deftCoreGitEdits?: readonly string[] | null;
  /** #7056: legacy vbrief/ tree the migration would process; null/absent when none. */
  readonly legacyVbrief?: LegacyVbriefTree | null;
  /** #7056: `--migrate-xbrief` was passed. */
  readonly migrateXbrief?: boolean;
}

/** Legacy `vbrief/` tree found before an upgrade migration (#7056). */
export interface LegacyVbriefTree {
  /** Files found under vbrief/ (recursive; symlinks counted, not followed). */
  readonly files: number;
  /** Files Git tracks under vbrief/; null when Git could not be read. */
  readonly tracked: number | null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Quote a path that holds C0 or C1 control characters, escaping each one as
 * `\uXXXX`, so it cannot rewrite the terminal.
 */
function printablePath(path: string): string {
  if (!CONTROL_CHARS.test(path)) return path;
  let out = "";
  for (const ch of path) {
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (CONTROL_CHARS.test(ch)) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

/** Most `.deft/core` edit paths the upgrade plan lists before a count (AC10.6). */
export const DEFT_CORE_EDIT_LIST_LIMIT = 20;

/**
 * List Git-reported edits under `.deft/core` that conversion removes (AC10.6 /
 * RC-03, #6002). Information only: no prompt, no refusal.
 */
export function writeDeftCoreGitEdits(
  io: PresentIo,
  paths: readonly string[] | null | undefined,
): void {
  if (!paths || paths.length === 0) return;
  const count = paths.length;
  writeHumanParagraph(
    io,
    `Git reports ${count} modified or untracked ${count === 1 ? "file" : "files"} under .deft/core. ` +
      "They are removed with it. Save any you need before you approve:",
  );
  for (const path of paths.slice(0, DEFT_CORE_EDIT_LIST_LIMIT)) {
    io.writeOut(`    ${printablePath(path)}\n`);
  }
  if (count > DEFT_CORE_EDIT_LIST_LIMIT) {
    io.writeOut(`    ...and ${count - DEFT_CORE_EDIT_LIST_LIMIT} more\n`);
  }
  writeBlank(io);
}

/** Path of the retired copy-model CI guard workflow old Directive wrote (#5835). */
export const RETIRED_CORE_GUARD_WORKFLOW_REL = ".github/workflows/deft-core-guard.yml";

/**
 * Retired deft-core-guard workflow found at plan time (#5835): `managed` is
 * removed by upgrade setup; `kept` does not look like Directive's file and stays.
 */
export type RetiredCoreGuardState = "managed" | "kept";

/**
 * Plan-time probe for the retired deft-core-guard workflow (#5835). Mirrors the
 * runtime removal step's ownership test (regular file with `name: deft-core-guard`)
 * so the plan says what setup will do. Read-only.
 */
export function detectRetiredCoreGuard(projectRoot: string): RetiredCoreGuardState | null {
  const abs = join(projectRoot, RETIRED_CORE_GUARD_WORKFLOW_REL);
  try {
    if (!lstatSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8").includes("name: deft-core-guard") ? "managed" : "kept";
  } catch {
    return null;
  }
}

/** Success-output line after setup removed the retired guard (#5835). */
export const RETIRED_CORE_GUARD_REMOVED_LINE =
  "Removed the retired deft-core-guard workflow. If deft-core-guard is a required " +
  "status check in branch protection, remove it there, or this PR cannot merge.";

/**
 * Report what setup did with the retired guard (#5835): listed as deleted plus the
 * branch-protection step, or named as kept. Writes nothing when it was not there.
 * Called right after the "Review and commit:" list.
 */
function writeRetiredCoreGuardOutcome(io: PresentIo, summary: SetupSummary | null): void {
  if (summary?.removed.includes(RETIRED_CORE_GUARD_WORKFLOW_REL)) {
    io.writeOut(`  ${RETIRED_CORE_GUARD_WORKFLOW_REL} (deleted)\n`);
    writeBlank(io);
    writeHumanParagraph(io, RETIRED_CORE_GUARD_REMOVED_LINE);
  } else if (summary?.preserved?.includes(RETIRED_CORE_GUARD_WORKFLOW_REL)) {
    writeBlank(io);
    writeHumanParagraph(io, RETIRED_CORE_GUARD_KEPT_LINE);
  }
}

/** Success-output line when a user-edited file at the guard path was left alone (#5835). */
export const RETIRED_CORE_GUARD_KEPT_LINE =
  `Kept ${RETIRED_CORE_GUARD_WORKFLOW_REL}: it does not look like the file Directive ` +
  "wrote, so it was not removed. Delete it yourself if you no longer need it.";

export interface UninstallRemovalSummary {
  readonly skillPointers: number;
  readonly hostHooks: number;
  readonly gitHooks: number;
  readonly projectWiring: number;
  readonly other: number;
  readonly legacyCore: boolean;
  readonly willRemovePin: boolean;
  readonly pathInventory: readonly string[];
  readonly preserveLabels: readonly string[];
}

export interface UninstallPlanFields {
  readonly projectRoot: string;
  readonly pm: PackageManager | null;
  readonly pmEvidence: string | null;
  readonly pinVersion: string | null;
  readonly pmCommand: string | null;
  readonly verbosity: Verbosity;
  readonly removal?: UninstallRemovalSummary | null;
  /** @deprecated Prefer removal summary; kept for callers that still pass prose lines at -v. */
  readonly extraHumanLines?: readonly string[];
  /** Shared files that hold lines Directive wrote (`.gitattributes`, `greptile.json`, …). */
  readonly directiveLineFiles?: readonly string[];
  /** Directive data uninstall keeps (D-025). */
  readonly keptData?: readonly string[];
  /** Registered git worktrees inside the project folder (#6007 / D-025). */
  readonly worktrees?: readonly string[];
}

/** core.hooksPath outcome for the uninstall report (AC11.6 / #6007). */
export interface UninstallHooksPathOutcome {
  readonly result: "unset" | "preserved-sibling" | "preserved-foreign" | "absent" | "unchanged";
  /** Other worktrees that still use Directive hooks (for `preserved-sibling`). */
  readonly siblings?: readonly string[];
}

/** "a, b, c and 4 more" (keeps long lists readable). */
function formatShortList(items: readonly string[], max = 8): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

const SCRATCH_DIR = ".deft-scratch/";

function writeWorktreeNames(io: PresentIo, worktrees: readonly string[]): void {
  writeHumanParagraph(
    io,
    `Uninstall does not touch these ${worktrees.length} registered Git worktree${worktrees.length === 1 ? "" : "s"} inside this project. They may hold uncommitted work:`,
  );
  for (const wt of worktrees) io.writeOut(`  ${wt}\n`);
  if (worktrees.some((wt) => wt.startsWith(SCRATCH_DIR))) {
    writeHumanParagraph(
      io,
      "Don't delete .deft-scratch/ while these worktrees are registered. Remove a worktree with: git worktree remove <path>",
    );
  }
}

function writeBlank(io: PresentIo): void {
  io.writeOut("\n");
}

function writeLabeled(io: PresentIo, label: string, value: string, width = 18): void {
  const pad = label.length >= width ? `${label} ` : `${label}${" ".repeat(width - label.length)}`;
  io.writeOut(`${pad}${value}\n`);
}

/**
 * Resolve wrap width for human paragraphs.
 * Non-TTY → null (do not invent wraps for pipes/CI).
 * TTY → columns clamped to [WRAP_FLOOR, WRAP_CEILING]; unknown → WRAP_FALLBACK.
 */
export function resolveWrapWidth(opts?: {
  columns?: number | null;
  isTTY?: boolean;
}): number | null {
  const isTTY = opts?.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return null;
  let cols = opts?.columns;
  if (cols == null || !Number.isFinite(cols) || cols <= 0) {
    const fromStdout = process.stdout.columns;
    const fromEnv = Number(process.env.COLUMNS);
    if (typeof fromStdout === "number" && fromStdout > 0) cols = fromStdout;
    else if (Number.isFinite(fromEnv) && fromEnv > 0) cols = fromEnv;
    else cols = WRAP_FALLBACK;
  }
  return Math.max(WRAP_FLOOR, Math.min(WRAP_CEILING, Math.floor(cols)));
}

/** Soft-wrap a single paragraph on word boundaries. Preserves the word sequence. */
export function wrapWords(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "";
  if (width < 1) return normalized;
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.join("\n");
}

/** Write a human paragraph; wraps on TTY only. */
export function writeHumanParagraph(
  io: PresentIo,
  text: string,
  wrapOpts?: { columns?: number | null; isTTY?: boolean },
): void {
  const width = resolveWrapWidth(wrapOpts);
  const body = width == null ? text.replace(/\s+/g, " ").trim() : wrapWords(text, width);
  if (body.length === 0) return;
  io.writeOut(`${body}\n`);
}

function writeBullet(io: PresentIo, text: string): void {
  const width = resolveWrapWidth();
  if (width == null) {
    io.writeOut(`  • ${text}\n`);
    return;
  }
  const inner = Math.max(WRAP_FLOOR - 4, width - 4);
  const wrapped = wrapWords(text, inner);
  const parts = wrapped.split("\n");
  io.writeOut(`  • ${parts[0]}\n`);
  for (let i = 1; i < parts.length; i++) {
    io.writeOut(`    ${parts[i]}\n`);
  }
}

function writeGitHooksDisclosure(io: PresentIo, inactive: boolean): void {
  if (!inactive) return;
  writeHumanParagraph(io, HUMAN_GIT_HOOKS_INACTIVE_LINE);
}

function writeHooksTakeoverWarning(io: PresentIo, t: HooksTakeover | null | undefined): void {
  if (!t) return;
  writeHumanParagraph(io, formatHooksTakeoverPlanWarning(t));
  writeBlank(io);
}

function writeNodeWarning(io: PresentIo, warning: string | null): void {
  if (!warning) return;
  writeHumanParagraph(io, warning);
}

function writeDisclosures(
  io: PresentIo,
  fields: Pick<CommonPlanFields, "gitHooksInactive" | "nodeWarning" | "verbosity">,
): void {
  // Default: plain git/node only. Insider install-script policy stays in -v keyed dump.
  writeGitHooksDisclosure(io, fields.gitHooksInactive);
  writeNodeWarning(io, fields.nodeWarning);
}

function writeKeyedBlock(io: PresentIo, lines: readonly string[]): void {
  io.writeOut("Plan (verbose):\n");
  for (const line of lines) {
    io.writeOut(`  ${line}\n`);
  }
}

/**
 * AC5.1 evidence at -v only (wave 4g / wave 3g): exact PM argv + plain script note.
 * Default plans use bullets for the practical effect instead.
 */
function writePmCommandAndScriptVerbose(
  io: PresentIo,
  command: string | null,
  verbosity: Verbosity,
): void {
  if (verbosity < 1 || !command) return;
  writeBlank(io);
  io.writeOut(`${PM_WILL_RUN_LABEL}\n`);
  io.writeOut(`  ${command}\n`);
  writeBlank(io);
  io.writeOut(`${HUMAN_INSTALL_SCRIPT_SETTINGS_LINE}\n`);
}

/** Uninstall -v-only PM command (F-014; wave 4g label). */
function writePmCommandVerbose(
  io: PresentIo,
  label: string,
  command: string | null,
  verbosity: Verbosity,
): void {
  if (verbosity < 1 || !command) return;
  writeBlank(io);
  io.writeOut(`${label}\n`);
  io.writeOut(`  ${command}\n`);
}

/** §C9 Example A — first initialization plan (wave 4g plain English). */
export function presentFirstInstallPlan(io: PresentIo, fields: FirstInstallPlanFields): void {
  const lock = lockfileNameFor(fields.pm);
  io.writeOut("Set up Deft Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  writeLabeled(io, "Directive version:", fields.version);
  writeBlank(io);
  io.writeOut("If you approve, Directive will:\n");
  if (fields.willCreatePkg) {
    writeBullet(io, "create a minimal package.json for this project");
  }
  writeBullet(
    io,
    `add Directive ${fields.version} to this project's development tools with ${fields.pm}`,
  );
  writeBullet(io, `update ${lock}`);
  writeBullet(io, "create Directive's project files for this folder");
  writeGitHookPlanBullets(io, gitHookPlanFor(fields));
  writeBlank(io);
  writeHumanParagraph(io, "Your other project files stay as they are.");
  writeBlank(io);
  writeHooksTakeoverWarning(io, fields.hooksTakeover);
  writeDisclosures(io, fields);
  writePmCommandAndScriptVerbose(io, fields.pmCommand, fields.verbosity);

  if (fields.verbosity >= 1) {
    writeBlank(io);
    const keyed = [
      `operation: install (first-time)`,
      `root: ${fields.projectRoot}`,
      `package manager: ${fields.pm} (${fields.pmEvidence})`,
      `target: @deftai/directive-runtime@${fields.version}`,
      fields.willCreatePkg
        ? `manifest: create package.json { "private": true }`
        : `manifest: add exact pin to existing package.json`,
      `PM command: ${fields.pmCommand}`,
      `expected: package.json pin + lockfile update via PM`,
      `setup: runtime setup --operation install --from none (wiring, GENERATION.json, readiness; may create missing seed placeholders)`,
      INSTALL_SCRIPT_POLICY_PLAN_LINE,
    ];
    if (fields.gitHooksInactive) {
      keyed.push(
        "Git hooks: not installed until git init + directive install --repair (cannot set core.hooksPath=.githooks yet)",
      );
    }
    if (fields.hooksTakeover) keyed.push(hooksTakeoverKeyedLine(fields.hooksTakeover));
    if (fields.nodeWarning) keyed.push(`node: ${fields.nodeWarning}`);
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

function hooksTakeoverKeyedLine(t: HooksTakeover): string {
  return `git hooks: set core.hooksPath=.githooks in repository config (replaces ${t.previous}; ${t.scope ?? "unknown"} scope)`;
}

/** §C9 Example B — repair plan (wave 4g). */
export function presentRepairPlan(io: PresentIo, fields: RepairPlanFields): void {
  io.writeOut("Repair Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  writeLabeled(io, "Directive version:", `${fields.version} (unchanged)`);
  writeBlank(io);
  if (!fields.needsPmRestore) {
    writeHumanParagraph(io, "The installed package looks fine. No reinstall is needed.");
    writeBlank(io);
    writeHumanParagraph(io, "You may still refresh the setup. If you approve, Directive will:");
    writeBullet(io, `check this project's Directive-managed files for ${fields.version}`);
    writeBullet(io, "write only what is missing or out of date");
    writeGitHookPlanBullets(io, gitHookPlanFor(fields));
    // #7349 Prefer-A Bound P3: name host-hook paths before approval when opt-out rewrite may run.
    writeBullet(io, hostHookRepairOptOutDisclosureBullet());
    writeBullet(io, hostHookRepairOptOutDisclosureBullet("agy"));
    writeBullet(io, "leave matching files and your other project files alone");
  } else {
    writeHumanParagraph(
      io,
      "The installed package needs to be restored (missing or wrong version on disk).",
    );
    writeBlank(io);
    io.writeOut("If you approve, Directive will:\n");
    writeBullet(io, `reinstall Directive ${fields.version} with ${fields.pm}`);
    writeBullet(io, "rerun project setup");
    writeGitHookPlanBullets(io, gitHookPlanFor(fields));
    writeBullet(io, hostHookRepairOptOutDisclosureBullet());
    writeBullet(io, hostHookRepairOptOutDisclosureBullet("agy"));
    writeBlank(io);
    writeHumanParagraph(io, "Your existing settings and other files stay as they are.");
  }
  writeBlank(io);
  writeHooksTakeoverWarning(io, fields.hooksTakeover);
  writeDisclosures(io, fields);
  writePmCommandAndScriptVerbose(io, fields.pmCommand, fields.verbosity);

  if (fields.verbosity >= 1) {
    writeBlank(io);
    const keyed = [
      `operation: repair`,
      `root: ${fields.projectRoot}`,
      `package manager: ${fields.pm} (${fields.pmEvidence})`,
      `pin (unchanged): @deftai/directive-runtime@${fields.version}`,
      fields.needsPmRestore
        ? `PM: restore pin via exact add (${fields.restoreReason ?? "needed"})`
        : `PM: none (lockfile records pin; installed package matches)`,
      fields.needsPmRestore && fields.pmCommand
        ? `PM command: ${fields.pmCommand}`
        : `PM command: (none)`,
      `setup: runtime setup --operation repair --from ${fields.version} (wiring/GENERATION/readiness; does not create seed files; never migrates xbrief)`,
      INSTALL_SCRIPT_POLICY_PLAN_LINE,
    ];
    if (fields.gitHooksInactive) {
      keyed.push(
        "Git hooks: not installed until git init + directive install --repair (cannot set core.hooksPath=.githooks yet)",
      );
    }
    if (fields.hooksTakeover) keyed.push(hooksTakeoverKeyedLine(fields.hooksTakeover));
    if (fields.nodeWarning) keyed.push(`node: ${fields.nodeWarning}`);
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

/** Plain-language upgrade plan bullet for a project with no package.json (#5965 / AC5.10). */
export const UPGRADE_CREATE_PKG_BULLET =
  "create a minimal package.json for this project (Directive needs one even when the project is not a JavaScript project)";

/** §C9 Example C — upgrade plan (wave 4g). */
export function presentUpgradePlan(io: PresentIo, fields: UpgradePlanFields): void {
  const lock = lockfileNameFor(fields.pm);
  // #5835: upgrade setup deletes the retired guard; say so whenever setup runs.
  const retiredCoreGuard = fields.needSetup ? detectRetiredCoreGuard(fields.projectRoot) : null;
  io.writeOut("Upgrade Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  writeLabeled(io, "Current version:", fields.currentVersion);
  writeLabeled(io, "Target version:", fields.targetVersion);
  writeBlank(io);
  if (fields.oldStyle || fields.convertShapeId) {
    writeHumanParagraph(io, "This project still uses an older Directive layout.");
    writeHumanParagraph(io, "A copied tree of Directive files may sit under .deft/core.");
    writeHumanParagraph(
      io,
      "The project version is still recorded as the old @deftai/directive package.",
    );
    writeBlank(io);
    io.writeOut("If you approve, Directive will:\n");
    if (fields.willCreatePkg) writeBullet(io, UPGRADE_CREATE_PKG_BULLET);
    writeBullet(io, "remove the copied .deft/core tree (including any local edits there)");
    writeBullet(
      io,
      `switch the project to Directive ${fields.targetVersion} as a normal project dependency`,
    );
    writeBullet(io, `update ${lock}`);
    writeBullet(io, "run setup and any needed data updates for that version");
    writeGitHookPlanBullets(io, gitHookPlanFor(fields));
    writeBlank(io);
    writeDeftCoreGitEdits(io, fields.deftCoreGitEdits);
    writeHumanParagraph(io, "Your existing project settings stay as they are.");
    writeHumanParagraph(io, "Your notes and briefs under xbrief/ stay as they are.");
  } else if (fields.versionChange) {
    io.writeOut("If you approve, Directive will:\n");
    writeBullet(io, `change this project's Directive version to ${fields.targetVersion}`);
    writeBullet(io, `update ${lock}`);
    writeBullet(io, "run project setup and any needed data updates for that version");
    writeGitHookPlanBullets(io, gitHookPlanFor(fields));
    writeBlank(io);
    writeHumanParagraph(io, "Your existing project settings stay as they are.");
  } else {
    io.writeOut("If you approve, Directive will:\n");
    writeBullet(
      io,
      `finish equal-version work for Directive ${fields.targetVersion}` +
        (fields.needSetup ? " (setup, then migration as needed)" : " (migration as needed)"),
    );
    if (fields.needSetup) writeGitHookPlanBullets(io, gitHookPlanFor(fields));
    writeBlank(io);
    writeHumanParagraph(io, "Your existing project settings stay as they are.");
  }
  if (retiredCoreGuard === "managed") {
    writeHumanParagraph(
      io,
      `Directive will also remove the retired ${RETIRED_CORE_GUARD_WORKFLOW_REL} workflow.`,
    );
  } else if (retiredCoreGuard === "kept") {
    writeHumanParagraph(
      io,
      `${RETIRED_CORE_GUARD_WORKFLOW_REL} does not look like the file Directive wrote, so it stays.`,
    );
  }
  writeBlank(io);
  if (fields.legacyVbrief) {
    writeLegacyVbriefNotice(io, fields.legacyVbrief, fields.migrateXbrief === true);
  }
  writeDisclosures(io, fields);
  if (fields.versionChange) {
    writePmCommandAndScriptVerbose(io, fields.pmCommand, fields.verbosity);
  }

  if (fields.verbosity >= 1) {
    writeBlank(io);
    const migrateGate =
      fields.legacyVbrief && fields.migrateXbrief !== true
        ? ` (vbrief/ migration waits for --migrate-xbrief or a yes)`
        : "";
    const keyed = [
      `operation: upgrade`,
      `root: ${fields.projectRoot}`,
      `package manager: ${fields.pm} (${fields.pmEvidence})`,
      `current: @deftai/directive-runtime@${fields.currentVersion}${fields.oldStyle ? " (older layout)" : ""}`,
      `target: @deftai/directive-runtime@${fields.targetVersion}`,
      fields.versionChange
        ? `PM: exact add target (pin + lockfile change)`
        : `PM: none (equal version; package already matches pin)`,
      fields.versionChange && fields.pmCommand
        ? `PM command: ${fields.pmCommand}`
        : `PM command: (none)`,
      fields.needSetup
        ? `setup: runtime setup --operation upgrade --from ${fields.currentVersion}`
        : `setup: none (wiring current for pin)`,
      fields.needMigrate
        ? `migrate: runtime migrate --from ${fields.currentVersion}${migrateGate}`
        : `migrate: none`,
      `disclosure: target runtime performs required setup/migrations; project settings/data preserved`,
      `global launcher: unchanged`,
      INSTALL_SCRIPT_POLICY_PLAN_LINE,
    ];
    if (fields.oldStyle || fields.convertShapeId) {
      keyed.splice(
        5,
        0,
        `remove: .deft/core (copied content tree, even if edited)`,
        `replace: @deftai/directive pin → @deftai/directive-runtime@${fields.targetVersion}`,
      );
      const edits = fields.deftCoreGitEdits?.length ?? 0;
      if (edits > 0) {
        keyed.splice(7, 0, `.deft/core Git edits: ${edits} (listed above; removed with it)`);
      }
    }
    if (retiredCoreGuard === "managed") {
      keyed.push(`remove: ${RETIRED_CORE_GUARD_WORKFLOW_REL} (retired workflow)`);
    } else if (retiredCoreGuard === "kept") {
      keyed.push(`keep: ${RETIRED_CORE_GUARD_WORKFLOW_REL} (not Directive's file)`);
    }
    if (fields.willCreatePkg) {
      keyed.splice(5, 0, `manifest: create package.json { "private": true }`);
    }
    if (fields.gitHooksInactive) {
      keyed.push(
        "Git hooks: not installed until git init + directive install --repair (cannot set core.hooksPath=.githooks yet)",
      );
    }
    if (fields.nodeWarning) keyed.push(`node: ${fields.nodeWarning}`);
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

export type UninstallPathCategory =
  | "skill"
  | "host-hook"
  | "git-hook"
  | "wiring"
  | "legacy-core"
  | "other";

/** Classify a removable path label for uninstall category counts (F-014). */
export function classifyUninstallPath(pathLabel: string): UninstallPathCategory {
  const p = pathLabel.replace(/\s*\(.*\)$/, "");
  if (p === ".deft/core" || p.startsWith(".deft/core/")) return "legacy-core";
  if (p.includes("/skills/") || /\/SKILL\.md$/i.test(p)) return "skill";
  if (
    p === ".claude/settings.json" ||
    p === ".cursor/hooks.json" ||
    p === ".codex/hooks.json" ||
    p === ".grok/hooks/deft.json" ||
    p === ".agents/hooks.json" ||
    /^\.agents\/deft-hook-[a-f0-9]{8}\.mjs$/.test(p) ||
    p.endsWith("/hooks.json") ||
    p.includes("/hooks/")
  ) {
    return "host-hook";
  }
  if (p.startsWith(".githooks/") || p.includes("githooks")) return "git-hook";
  if (
    p === ".deft/GENERATION.json" ||
    p.startsWith(".deft/directive/") ||
    p === "AGENTS.md" ||
    p.startsWith("AGENTS.md") ||
    p === "Taskfile.yml" ||
    p.startsWith("Taskfile.yml") ||
    p === ".gitignore"
  ) {
    return "wiring";
  }
  return "other";
}

export function summarizeUninstallRemovals(
  pathInventory: readonly string[],
  opts: {
    willRemovePin: boolean;
    legacyCore?: boolean;
    preserveLabels?: readonly string[];
  },
): UninstallRemovalSummary {
  let skillPointers = 0;
  let hostHooks = 0;
  let gitHooks = 0;
  let projectWiring = 0;
  let other = 0;
  let legacyCore = Boolean(opts.legacyCore);
  for (const p of pathInventory) {
    switch (classifyUninstallPath(p)) {
      case "skill":
        skillPointers += 1;
        break;
      case "host-hook":
        hostHooks += 1;
        break;
      case "git-hook":
        gitHooks += 1;
        break;
      case "wiring":
        projectWiring += 1;
        break;
      case "legacy-core":
        legacyCore = true;
        break;
      default:
        other += 1;
        break;
    }
  }
  return {
    skillPointers,
    hostHooks,
    gitHooks,
    projectWiring,
    other,
    legacyCore,
    willRemovePin: opts.willRemovePin,
    pathInventory: [...pathInventory],
    preserveLabels: [...(opts.preserveLabels ?? [])],
  };
}

function writeUninstallActionBullets(
  io: PresentIo,
  removal: UninstallRemovalSummary,
  pm: string | null,
): void {
  io.writeOut("If you approve, Directive will:\n");
  if (removal.skillPointers > 0) {
    writeBullet(
      io,
      `remove ${removal.skillPointers} skill pointer${removal.skillPointers === 1 ? "" : "s"} across agent hosts`,
    );
  }
  if (removal.hostHooks > 0) {
    writeBullet(
      io,
      `clear Directive entries from ${removal.hostHooks} host hook config${removal.hostHooks === 1 ? "" : "s"}`,
    );
  }
  const gitHookPaths = removal.pathInventory
    .map((p) => p.replace(/\s*\(.*\)$/, ""))
    .filter((p) => classifyUninstallPath(p) === "git-hook");
  if (gitHookPaths.length > 0) {
    writeBullet(io, `remove git hooks ${gitHookPaths.join(", ")}`);
  }
  const wiringBits: string[] = [];
  if (removal.gitHooks > 0 && gitHookPaths.length === 0) wiringBits.push("git hooks");
  if (removal.projectWiring > 0) wiringBits.push("GENERATION and project wiring");
  if (removal.legacyCore) wiringBits.push("legacy .deft/core");
  if (wiringBits.length > 0) {
    writeBullet(io, `remove ${wiringBits.join(", ")}`);
  } else if (removal.other > 0) {
    writeBullet(
      io,
      `remove ${removal.other} other Directive-owned path${removal.other === 1 ? "" : "s"}`,
    );
  }
  if (removal.willRemovePin) {
    writeBullet(
      io,
      pm
        ? `remove the Directive version from this project's development tools with ${pm}`
        : "remove the Directive version from this project's package.json",
    );
  }
  if (
    removal.skillPointers === 0 &&
    removal.hostHooks === 0 &&
    gitHookPaths.length === 0 &&
    wiringBits.length === 0 &&
    !removal.willRemovePin &&
    removal.other === 0
  ) {
    writeBullet(io, "remove remaining Directive-owned wiring from this project");
  }
}

/** Uninstall plan — category summary by default; path inventory at -v (F-014). */
export function presentUninstallPlan(io: PresentIo, fields: UninstallPlanFields): void {
  io.writeOut("Uninstall Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  if (fields.pm && fields.pmEvidence) {
    writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  }
  if (fields.pinVersion) {
    writeLabeled(io, "Pinned version:", fields.pinVersion);
  }
  writeBlank(io);

  if (fields.removal) {
    writeUninstallActionBullets(io, fields.removal, fields.pm);
    if (fields.directiveLineFiles && fields.directiveLineFiles.length > 0) {
      writeBullet(
        io,
        `remove the lines Directive wrote in ${fields.directiveLineFiles.join(", ")} (the files stay)`,
      );
    }
    writeBlank(io);
    const keep =
      fields.removal.preserveLabels.length > 0
        ? fields.removal.preserveLabels.join(", ")
        : "xbrief/ project data and unrelated files";
    writeHumanParagraph(io, `Your ${keep} stay in place.`);
  } else {
    writeHumanParagraph(
      io,
      "I'll remove Directive-owned wiring and the runtime pin from this project. Your xbrief/ project data and unrelated files stay in place.",
    );
  }
  if (fields.keptData && fields.keptData.length > 0) {
    writeHumanParagraph(
      io,
      `Kept (Directive data that uninstall does not delete): ${formatShortList(fields.keptData)}.`,
    );
  }
  if (fields.worktrees && fields.worktrees.length > 0) {
    writeBlank(io);
    writeWorktreeNames(io, fields.worktrees);
  }
  writeBlank(io);
  writePmCommandVerbose(io, PM_WILL_RUN_LABEL, fields.pmCommand, fields.verbosity);

  if (fields.verbosity >= 1) {
    writeBlank(io);
    if (fields.removal && fields.removal.pathInventory.length > 0) {
      io.writeOut("Remove paths:\n");
      for (const p of fields.removal.pathInventory) {
        io.writeOut(`  ${p}\n`);
      }
      writeBlank(io);
    }
    if (fields.extraHumanLines) {
      for (const line of fields.extraHumanLines) {
        io.writeOut(`${line}\n`);
      }
      writeBlank(io);
    }
    const keyed = [
      `operation: uninstall`,
      `root: ${fields.projectRoot}`,
      fields.pm
        ? `package manager: ${fields.pm} (${fields.pmEvidence})`
        : `package manager: (none)`,
      fields.pinVersion ? `pin: ${fields.pinVersion}` : `pin: (none)`,
      fields.pmCommand ? `PM command: ${fields.pmCommand}` : `PM command: (none)`,
    ];
    if (fields.removal) {
      keyed.push(
        `counts: skills=${fields.removal.skillPointers} hostHooks=${fields.removal.hostHooks} gitHooks=${fields.removal.gitHooks} wiring=${fields.removal.projectWiring} other=${fields.removal.other}`,
      );
    }
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

export interface SetupSummary {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
  readonly migrated?: readonly string[];
  /** Unknowable / corrupt envelopes copied under xbrief/archive/ (F-017). */
  readonly archived?: readonly string[];
  readonly conflicts?: readonly string[];
  /** One line per existing Directive git hook setup replaced or removed (D-023). */
  readonly gitHookUpdates?: readonly string[];
  /** Files setup kept in place (non-failure). */
  readonly preserved?: readonly string[];
  /** Setup replaced another core.hooksPath with .githooks (#4960). */
  readonly hooksPathTakenOver?: { readonly previous: string; readonly scope: string | null };
  /** Why Git hooks are not active, when they are not. */
  readonly gitHooksInactive?: string;
  readonly message?: string;
}

/** Name each git hook setup replaced or removed (D-023). */
function writeGitHookUpdates(io: PresentIo, summary: SetupSummary | null | undefined): void {
  const lines = summary?.gitHookUpdates ?? [];
  if (lines.length === 0) return;
  writeBlank(io);
  for (const line of lines) io.writeOut(`${line}\n`);
}

/** Default: short human summary; -v counts; -vv full JSON arrays. */
export function presentPathSummary(
  io: PresentIo,
  label: string,
  summary: SetupSummary,
  verbosity: Verbosity,
): void {
  const created = summary.created ?? [];
  const modified = summary.modified ?? [];
  const removed = summary.removed ?? [];
  const migrated = summary.migrated ?? [];
  const archived = summary.archived ?? [];
  if (verbosity >= 2) {
    io.writeOut(
      `${label}: ` +
        `created=${JSON.stringify(created)} ` +
        `modified=${JSON.stringify(modified)} ` +
        `removed=${JSON.stringify(removed)}` +
        (migrated.length > 0 ? ` migrated=${JSON.stringify(migrated)}` : "") +
        (archived.length > 0 ? ` archived=${JSON.stringify(archived)}` : "") +
        (summary.conflicts && summary.conflicts.length > 0
          ? ` conflicts=${JSON.stringify(summary.conflicts)}`
          : "") +
        "\n",
    );
  } else if (verbosity >= 1) {
    io.writeOut(
      `${label}: created=${created.length} modified=${modified.length} removed=${removed.length}` +
        (migrated.length > 0 ? ` migrated=${migrated.length}` : "") +
        (archived.length > 0 ? ` archived=${archived.length}` : "") +
        "\n",
    );
  }
  // verbosity 0: path dump omitted; checkmarks / ready block carry the story
  if (summary.message && verbosity >= 1) {
    io.writeOut(`${summary.message}\n`);
  }
}

/**
 * Disclosure when Git hooks stay inactive because another hooks folder is set
 * (#4960 / #5846); null otherwise. Names `directive install --repair`.
 */
export function foreignHooksInactiveFromSummary(
  summary: SetupSummary | null | undefined,
): string | null {
  const text = summary?.gitHooksInactive ?? "";
  return /core\.hooksPath is (still )?'|could not set core\.hooksPath/.test(text) ? text : null;
}

/** No-`.git` case only (F-010); the other-hooks-folder case has its own text. */
function gitHooksInactiveFromSummary(summary: SetupSummary | null | undefined): boolean {
  if (foreignHooksInactiveFromSummary(summary) !== null) return false;
  const msg = summary?.message ?? "";
  return /Git hooks inactive/i.test(msg);
}

/**
 * Post-op after install/repair: the takeover statement plus the hook-manager tip
 * (#4960, Problem 20), or the inactive disclosure when hooks are still not active.
 */
function writeHooksPostOp(
  io: PresentIo,
  summary: SetupSummary | null | undefined,
  planned: HooksTakeover | null | undefined,
): void {
  const foreign = foreignHooksInactiveFromSummary(summary);
  if (foreign !== null) {
    writeBlank(io);
    writeHumanParagraph(io, foreign);
    return;
  }
  if (gitHooksInactiveFromSummary(summary)) return;
  // The plan's view names default-folder hook files; the runtime's confirms a
  // core.hooksPath replacement even if the plan saw none.
  const fromRuntime = summary?.hooksPathTakenOver;
  const taken: HooksTakeover | null =
    planned ??
    (fromRuntime ? { previous: fromRuntime.previous, scope: fromRuntime.scope, hooks: [] } : null);
  if (taken === null) return;
  writeBlank(io);
  writeHumanParagraph(io, formatHooksTakeoverDone(taken));
  writeHumanParagraph(io, HOOK_MANAGER_TIP_LINE);
}

/**
 * "Review and commit" entry when pnpm itself changed pnpm-workspace.yaml during the
 * PM add (#5854 / #6006). Directive never writes that file; it only reports the change.
 */
export const PNPM_WORKSPACE_REVIEW_LINE = "pnpm-workspace.yaml (updated by pnpm)";

/** §C9 Example A completion after successful first install. */
export function presentInstallSuccess(
  io: PresentIo,
  opts: {
    version: string;
    projectRoot: string;
    pm: PackageManager;
    summary: SetupSummary | null;
    verbosity: Verbosity;
    pnpmWorkspaceChanged?: boolean;
    /** #4960: takeover disclosed in the approved plan. */
    hooksTakeover?: HooksTakeover | null;
  },
): void {
  const lock = lockfileNameFor(opts.pm);
  const hooksInactive = gitHooksInactiveFromSummary(opts.summary);
  io.writeOut(`✓ Installed Directive ${opts.version}\n`);
  io.writeOut(`✓ Created Directive's project files\n`);
  if (hooksInactive) {
    io.writeOut(`✓ Verified the project-local installation (git hooks not installed yet)\n`);
  } else {
    io.writeOut(`✓ Verified the project-local installation\n`);
  }
  writeBlank(io);
  if (hooksInactive) {
    writeHumanParagraph(io, `Directive ${opts.version} is installed in ${opts.projectRoot}.`);
    writeHumanParagraph(io, HUMAN_GIT_HOOKS_INACTIVE_LINE);
  } else if (foreignHooksInactiveFromSummary(opts.summary) !== null) {
    writeHumanParagraph(io, `Directive ${opts.version} is installed in ${opts.projectRoot}.`);
  } else {
    writeHumanParagraph(io, `Directive ${opts.version} is ready in ${opts.projectRoot}.`);
  }
  writeHooksPostOp(io, opts.summary, opts.hooksTakeover);
  writeBlank(io);
  io.writeOut("Next:\n");
  if (hooksInactive) {
    io.writeOut("  git init\n");
    io.writeOut("  directive install --repair\n");
  } else if (foreignHooksInactiveFromSummary(opts.summary) !== null) {
    io.writeOut("  directive install --repair\n");
  } else {
    io.writeOut("  directive --help\n");
  }
  writeGitHookUpdates(io, opts.summary);
  writeBlank(io);
  io.writeOut("Review and commit:\n");
  io.writeOut("  package.json\n");
  io.writeOut(`  ${lock}\n`);
  if (opts.pnpmWorkspaceChanged) io.writeOut(`  ${PNPM_WORKSPACE_REVIEW_LINE}\n`);
  const review = collectReviewPaths(
    [opts.summary],
    opts.pnpmWorkspaceChanged
      ? ["package.json", lock, "pnpm-workspace.yaml"]
      : ["package.json", lock],
  );
  for (const p of review) {
    io.writeOut(`  ${p}\n`);
  }
  // Install can convert an old layout; say what happened to the retired guard (#5835).
  writeRetiredCoreGuardOutcome(io, opts.summary);
  writeBlank(io);
  writeHumanParagraph(io, "Commands in this project use its pinned Directive version.");
  writeHumanParagraph(io, "Updating the global launcher will not upgrade this project.");
  if (opts.verbosity >= 1 && opts.summary) {
    writeBlank(io);
    presentPathSummary(io, "setup install", opts.summary, opts.verbosity);
  }
}

/** §C9 Example B completion after repair. */
export function presentRepairSuccess(
  io: PresentIo,
  opts: {
    version: string;
    restoredPackage: boolean;
    summary: SetupSummary | null;
    verbosity: Verbosity;
    pm?: PackageManager;
    pnpmWorkspaceChanged?: boolean;
    /** #4960: takeover disclosed in the approved plan. */
    hooksTakeover?: HooksTakeover | null;
  },
): void {
  const hooksInactive = gitHooksInactiveFromSummary(opts.summary);
  const foreignInactive = foreignHooksInactiveFromSummary(opts.summary);
  if (opts.restoredPackage) {
    io.writeOut(`✓ Restored the installed Directive ${opts.version} package\n`);
  } else {
    io.writeOut(`✓ Verified the installed Directive ${opts.version} package\n`);
  }
  io.writeOut(`✓ Reran project setup\n`);
  if (opts.summary && opts.summary.created.length + opts.summary.modified.length > 0) {
    io.writeOut(`✓ Restored managed project files\n`);
  }
  writeBlank(io);
  if (hooksInactive) {
    writeHumanParagraph(io, `Directive ${opts.version} setup finished.`);
    writeHumanParagraph(io, HUMAN_GIT_HOOKS_INACTIVE_LINE);
    writeBlank(io);
    io.writeOut("Next:\n");
    io.writeOut("  git init\n");
    io.writeOut("  directive install --repair\n");
  } else if (foreignInactive !== null) {
    writeHumanParagraph(io, `Directive ${opts.version} setup finished.`);
  } else {
    writeHumanParagraph(io, `Directive ${opts.version} is ready.`);
  }
  writeHumanParagraph(io, "The project version has not changed.");
  writeGitHookUpdates(io, opts.summary);
  writeHooksPostOp(io, opts.summary, opts.hooksTakeover);
  const pkgFiles =
    opts.restoredPackage && opts.pm ? ["package.json", lockfileNameFor(opts.pm)] : [];
  const review = [
    ...pkgFiles,
    ...collectReviewPaths(
      [opts.summary],
      opts.pnpmWorkspaceChanged ? [...pkgFiles, "pnpm-workspace.yaml"] : pkgFiles,
    ),
  ];
  if (opts.pnpmWorkspaceChanged) review.push(PNPM_WORKSPACE_REVIEW_LINE);
  if (review.length > 0) {
    writeBlank(io);
    io.writeOut("Review and commit:\n");
    for (const p of review) {
      io.writeOut(`  ${p}\n`);
    }
  }
  if (opts.verbosity >= 1 && opts.summary) {
    writeBlank(io);
    presentPathSummary(io, "setup repair", opts.summary, opts.verbosity);
  }
}

/** §C9 Example C completion after upgrade. */
export function presentUpgradeSuccess(
  io: PresentIo,
  opts: {
    version: string;
    versionChange: boolean;
    pm: PackageManager;
    summary: SetupSummary | null;
    migrateSummary: SetupSummary | null;
    verbosity: Verbosity;
    pnpmWorkspaceChanged?: boolean;
    /** #7056: legacy vbrief/ tree found before migrate; null/absent when none. */
    legacyVbrief?: LegacyVbriefTree | null;
    /** #7056: the migrate entry ran (consent given); false = pending. */
    migrationRan?: boolean;
  },
): void {
  if (opts.versionChange) {
    io.writeOut(`✓ Installed Directive ${opts.version}\n`);
  }
  io.writeOut(`✓ Completed project setup\n`);
  if (opts.legacyVbrief && opts.migrationRan === true) {
    io.writeOut(
      `✓ Ran the vbrief → xbrief migration (vbrief/ had ${fileCount(opts.legacyVbrief.files)})\n`,
    );
  }
  // #5846 / P20: upgrade never takes over another hooks folder; it names the fix.
  const foreignInactive = foreignHooksInactiveFromSummary(opts.summary);
  if (foreignInactive !== null) {
    io.writeOut(`✓ Verified the project-local installation (git hooks not active)\n`);
  } else {
    io.writeOut(`✓ Verified the project-local installation\n`);
  }
  writeBlank(io);
  if (opts.versionChange) {
    writeHumanParagraph(io, `This project now uses Directive ${opts.version}.`);
    writeHumanParagraph(io, "The global launcher was not changed.");
  } else if (foreignInactive !== null) {
    writeHumanParagraph(io, `Directive ${opts.version} setup finished.`);
    writeHumanParagraph(io, "The project version has not changed.");
  } else {
    writeHumanParagraph(io, `Directive ${opts.version} is ready.`);
    writeHumanParagraph(io, "The project version has not changed.");
  }
  writeGitHookUpdates(io, opts.summary);
  if (foreignInactive !== null) {
    writeBlank(io);
    writeHumanParagraph(io, foreignInactive);
    writeBlank(io);
    io.writeOut("Next:\n");
    io.writeOut("  directive install --repair\n");
  }
  writeBlank(io);
  io.writeOut("Review and commit:\n");
  const printed: string[] = [];
  if (opts.versionChange) {
    printed.push("package.json", lockfileNameFor(opts.pm));
    io.writeOut("  package.json\n");
    io.writeOut(`  ${lockfileNameFor(opts.pm)}\n`);
  }
  if (opts.pnpmWorkspaceChanged) {
    printed.push("pnpm-workspace.yaml");
    io.writeOut(`  ${PNPM_WORKSPACE_REVIEW_LINE}\n`);
  }
  for (const p of collectReviewPaths([opts.summary, opts.migrateSummary], printed)) {
    io.writeOut(`  ${p}\n`);
  }
  writeRetiredCoreGuardOutcome(io, opts.summary);
  if (opts.legacyVbrief && opts.migrationRan !== true) {
    writeBlank(io);
    presentMigrationPending(io, opts.legacyVbrief, opts.version);
  }
  if (opts.verbosity >= 1) {
    writeBlank(io);
    if (opts.summary) presentPathSummary(io, "setup upgrade", opts.summary, opts.verbosity);
    if (opts.migrateSummary) {
      presentPathSummary(io, "migrate", opts.migrateSummary, opts.verbosity);
    }
  }
}

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

function filesFound(n: number): string {
  return `${fileCount(n)} found under vbrief/`;
}

/**
 * #7056: the upgrade plan names the vbrief→xbrief migration before any approval.
 * The count is files found, not records moved; Git tracking is not a recovery promise.
 */
export function writeLegacyVbriefNotice(
  io: PresentIo,
  legacy: LegacyVbriefTree,
  migrateXbrief: boolean,
): void {
  io.writeOut("Legacy data migration (vbrief → xbrief):\n");
  writeBullet(
    io,
    `${filesFound(legacy.files)}. The migration processes this tree into xbrief/ and deletes vbrief/.`,
  );
  if (legacy.tracked === null) {
    writeBullet(io, "Git could not be read, so how many of these files Git tracks is unknown.");
  } else {
    writeBullet(io, `${legacy.tracked} of ${legacy.files} are tracked by Git.`);
  }
  writeBullet(io, "Git restores only committed contents: commit or back up vbrief/ first.");
  if (migrateXbrief) {
    writeBullet(io, "You passed --migrate-xbrief, so the migration runs with this upgrade.");
  } else {
    writeBullet(
      io,
      "This runs only with --migrate-xbrief, or if you answer yes to the migration question. --yes alone does not run it.",
    );
  }
  writeBlank(io);
}

/** #7056: the pending vbrief→xbrief migration and the commands that run it later. */
export function presentMigrationPending(
  io: PresentIo,
  legacy: LegacyVbriefTree,
  version: string,
): void {
  io.writeOut(`Not done: the vbrief → xbrief migration (${filesFound(legacy.files)}).\n`);
  writeHumanParagraph(io, "vbrief/ was left as it is; project data is still behind.");
  io.writeOut("To run it later:\n");
  io.writeOut("  deft migrate:xbrief\n");
  io.writeOut(
    `  directive upgrade --target-version ${version} --migrate-xbrief --yes   (also finishes the data update)\n`,
  );
}

/** Folders that hold the worktrees, with counts: ".deft-scratch/worktrees/ (60)". */
function worktreeFolders(worktrees: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const wt of worktrees) {
    const slash = wt.lastIndexOf("/");
    const parent = slash > 0 ? `${wt.slice(0, slash)}/` : "./";
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts].map(([dir, n]) => `${dir} (${n})`).join(", ");
}

function writeHooksPathOutcome(io: PresentIo, outcome: UninstallHooksPathOutcome): void {
  switch (outcome.result) {
    case "unset":
      writeHumanParagraph(io, "Unset core.hooksPath (it pointed at Directive's .githooks).");
      return;
    case "preserved-sibling": {
      const siblings = outcome.siblings ?? [];
      const n = siblings.length;
      // D-045: say what was kept and why; no unset advice (it would also
      // turn off Directive hooks in the other worktrees).
      const who =
        n > 0
          ? `${n} other worktree${n === 1 ? " still uses" : "s still use"} Directive (${formatShortList(siblings, 3)})`
          : "another worktree still uses Directive";
      writeHumanParagraph(
        io,
        `Kept the shared Git hooks setting because ${who}. Nothing else to do.`,
      );
      return;
    }
    case "preserved-foreign":
      writeHumanParagraph(
        io,
        "Left core.hooksPath as it is: it does not point at Directive's .githooks.",
      );
      return;
    case "unchanged":
      writeHumanParagraph(
        io,
        "Could not unset core.hooksPath. Run: git config --unset core.hooksPath",
      );
      return;
    case "absent":
      return;
  }
}

/** Uninstall completion — category voice; path inventory at -v (F-014). */
export function presentUninstallSuccess(
  io: PresentIo,
  opts: {
    projectRoot: string;
    complete: boolean;
    removal: UninstallRemovalSummary | null;
    removedPaths?: readonly string[];
    preserved?: readonly string[];
    leftovers?: readonly string[];
    /** Launcher-cleanup uncertainty (AC11.11). */
    uncertainty?: readonly string[];
    /** Actual package-manager result; overrides the plan's `removal.willRemovePin` (#5999). */
    pinRemoved?: boolean;
    /** Shared files whose Directive lines were removed. */
    directiveLineFiles?: readonly string[];
    hooksPath?: UninstallHooksPathOutcome;
    keptData?: readonly string[];
    worktrees?: readonly string[];
    verbosity: Verbosity;
  },
): void {
  if (opts.complete) {
    io.writeOut(`✓ Uninstalled Directive from ${opts.projectRoot}\n`);
  } else {
    io.writeOut(`⚠ Uninstall partially finished in ${opts.projectRoot}\n`);
  }
  writeBlank(io);

  const parts: string[] = [];
  if (opts.removal) {
    if (opts.removal.skillPointers > 0) parts.push("skill pointers");
    if (opts.removal.hostHooks > 0) parts.push("host hooks");
    if (opts.removal.gitHooks > 0 || opts.removal.projectWiring > 0) parts.push("project wiring");
    if (opts.removal.legacyCore) parts.push("legacy core");
  }
  if (opts.directiveLineFiles && opts.directiveLineFiles.length > 0) {
    parts.push(`Directive lines in ${opts.directiveLineFiles.join(", ")}`);
  }
  if (opts.pinRemoved ?? opts.removal?.willRemovePin ?? false) {
    parts.push("the Directive version from development tools");
  }
  if (parts.length > 0) {
    writeHumanParagraph(io, `Removed ${parts.join(", ")}.`);
  } else {
    writeHumanParagraph(io, "Removed Directive-owned wiring from this project.");
  }
  if (opts.hooksPath) writeHooksPathOutcome(io, opts.hooksPath);

  const preserved = opts.preserved ?? opts.removal?.preserveLabels ?? [];
  if (preserved.length > 0) {
    writeHumanParagraph(io, `Preserved: ${preserved.join(", ")}.`);
  } else {
    writeHumanParagraph(io, "Preserved xbrief/ project data and unrelated files.");
  }
  if (opts.keptData && opts.keptData.length > 0) {
    writeHumanParagraph(
      io,
      `Kept (Directive data that uninstall does not delete): ${formatShortList(opts.keptData)}.`,
    );
  }
  if (opts.worktrees && opts.worktrees.length > 0) {
    const n = opts.worktrees.length;
    writeHumanParagraph(
      io,
      `Not touched: ${n} registered Git worktree${n === 1 ? "" : "s"} in ${worktreeFolders(opts.worktrees)}. They may hold uncommitted work; remove them with git worktree remove, not by deleting the folder.`,
    );
  }

  if (opts.leftovers && opts.leftovers.length > 0) {
    writeBlank(io);
    writeHumanParagraph(io, `Known leftovers: ${opts.leftovers.join(", ")}.`);
  }
  if (opts.uncertainty && opts.uncertainty.length > 0) {
    writeHumanParagraph(io, `Not certain: ${opts.uncertainty.join("; ")}.`);
  }

  writeBlank(io);
  writeHumanParagraph(
    io,
    "To uninstall the global launcher (other repos may still need it), run: npm uninstall -g @deftai/directive",
  );

  if (opts.verbosity >= 1) {
    writeBlank(io);
    const paths = opts.removedPaths ?? opts.removal?.pathInventory ?? [];
    if (paths.length > 0) {
      io.writeOut("Removed paths:\n");
      for (const p of paths) io.writeOut(`  ${p}\n`);
    }
    if (preserved.length > 0) {
      io.writeOut(`preserved: ${JSON.stringify(preserved)}\n`);
    }
  }
}

/** §C9 Example E — ambiguous automated rerun. */
export function presentAmbiguousYes(io: PresentIo, pinVersion: string): void {
  io.writeErr(
    `Directive is already configured at version ${pinVersion}.\n` +
      `To repair this installation, select repair explicitly:\n` +
      `\n` +
      `  directive install --repair --yes\n` +
      `\n` +
      `For a deliberate version or data upgrade, use directive upgrade --yes.\n` +
      `No project files were changed.\n`,
  );
}

/** §C9 Example F — installation succeeded, setup failed (wave 4g). */
export function presentSetupFailedAfterInstall(
  io: PresentIo,
  opts: {
    version: string;
    operation: "install" | "repair" | "upgrade";
    failedPaths?: readonly string[];
    reason?: string | null;
  },
): void {
  if (opts.operation === "install" || opts.operation === "upgrade") {
    io.writeErr(`Directive ${opts.version} is installed, but project setup did not finish.\n`);
  } else {
    io.writeErr(`Directive ${opts.version} repair ran, but project setup did not finish.\n`);
  }
  writeBlankErr(io);
  if (opts.failedPaths && opts.failedPaths.length > 0) {
    io.writeErr("Setup could not update:\n");
    for (const p of opts.failedPaths) {
      io.writeErr(`  ${p}\n`);
    }
    writeBlankErr(io);
  }
  if (opts.reason) {
    io.writeErr("Reason:\n");
    io.writeErr(`  ${opts.reason}\n`);
    writeBlankErr(io);
  }
  if (opts.operation === "install" || opts.operation === "upgrade") {
    io.writeErr(`The project version and lockfile already reference Directive ${opts.version}.\n`);
    writeBlankErr(io);
  }
  io.writeErr("Fix the cause, then run:\n");
  io.writeErr("  directive install --repair\n");
  if (opts.operation === "upgrade") {
    io.writeErr("  (or directive upgrade again for data migration)\n");
  }
  writeBlankErr(io);
  io.writeErr("Review the existing changes before you commit.\n");
}

/**
 * AC14.18 / AC7.9 migrate half — pin may already be on the new version; default
 * verbosity must name the failed file, list migrated files, and `directive upgrade`.
 */
export function presentMigrateFailedAfterUpgrade(
  io: PresentIo,
  opts: {
    version: string;
    versionChange: boolean;
    summary: SetupSummary | null;
    reason?: string | null;
  },
): void {
  if (opts.versionChange) {
    io.writeErr(
      `Directive ${opts.version} is installed, but project data migration did not finish.\n`,
    );
  } else {
    io.writeErr(`Directive ${opts.version} data migration did not finish.\n`);
  }
  writeBlankErr(io);

  const failed = opts.summary?.conflicts ?? [];
  const migrated = opts.summary?.migrated ?? [];
  if (failed.length > 0) {
    io.writeErr("Migration could not update:\n");
    for (const p of failed) {
      io.writeErr(`  ${p}\n`);
    }
    writeBlankErr(io);
  }
  if (migrated.length > 0) {
    io.writeErr("Migrated:\n");
    for (const p of migrated) {
      io.writeErr(`  ${p}\n`);
    }
    writeBlankErr(io);
  }
  const reason = opts.reason ?? opts.summary?.message ?? null;
  if (reason) {
    io.writeErr("Reason:\n");
    io.writeErr(`  ${reason}\n`);
    writeBlankErr(io);
  }
  if (opts.versionChange) {
    io.writeErr(`The project pin and lockfile now reference Directive ${opts.version}.\n`);
    writeBlankErr(io);
  }
  io.writeErr("Correct the cause, then run:\n");
  io.writeErr("  directive upgrade\n");
  writeBlankErr(io);
  io.writeErr("Review the existing changes before committing.\n");
}

function writeBlankErr(io: PresentIo): void {
  io.writeErr("\n");
}

/** Headline files listed first in "Review and commit" (AC5.16). */
const REVIEW_HEADLINE_PATHS = ["AGENTS.md", ".gitignore", "Taskfile.yml", ".deft/GENERATION.json"];

/** A folder with more than this many changed files is shown as one grouped line. */
const REVIEW_GROUP_THRESHOLD = 3;

/** Never offered for commit: installed packages and ignored readiness markers (AC5.16). */
function isNeverReviewPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  if (
    norm === "node_modules" ||
    norm.startsWith("node_modules/") ||
    norm.includes("/node_modules/")
  ) {
    return true;
  }
  return /^\.deft\/directive\/wiring-ready\.[^/]*\.json$/.test(norm);
}

function commonFolder(paths: readonly string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  let prefix = dirs[0] ?? [];
  for (const d of dirs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < d.length && prefix[i] === d[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return `${prefix.join("/")}/`;
}

/**
 * Complete "Review and commit" list (AC5.16 / #6006): every created, modified, removed,
 * migrated and archived path, with the headline files first. Removed paths are listed
 * too, so the deletions (for example an old `.deft/core` or a replaced `.githooks/` file)
 * get committed with the rest. A top-level folder with more than a few changed files
 * prints as one line (`.agents/skills/ (12 files)`), so nothing is hidden and skill
 * folders stay short. `skip` holds paths the caller already printed.
 */
export function collectReviewPaths(
  summaries: readonly (SetupSummary | null | undefined)[],
  skip: readonly string[] = [],
): string[] {
  const seen = new Set<string>(skip);
  const all: string[] = [];
  for (const summary of summaries) {
    if (!summary) continue;
    for (const raw of [
      ...summary.created,
      ...summary.modified,
      ...(summary.removed ?? []),
      ...(summary.migrated ?? []),
      ...(summary.archived ?? []),
    ]) {
      const p = raw.replace(/\\/g, "/");
      if (seen.has(p) || isNeverReviewPath(p)) continue;
      seen.add(p);
      all.push(p);
    }
  }
  const out: string[] = REVIEW_HEADLINE_PATHS.filter((p) => all.includes(p));
  const rest = all.filter((p) => !REVIEW_HEADLINE_PATHS.includes(p));
  const byTop = new Map<string, string[]>();
  for (const p of rest) {
    const slash = p.indexOf("/");
    const key = slash === -1 ? p : p.slice(0, slash + 1);
    const members = byTop.get(key) ?? [];
    members.push(p);
    byTop.set(key, members);
  }
  for (const [key, members] of byTop) {
    if (key.endsWith("/") && members.length > REVIEW_GROUP_THRESHOLD) {
      out.push(`${commonFolder(members)} (${members.length} files)`);
    } else {
      out.push(...members);
    }
  }
  return out;
}

function parseHooksPathTakenOver(
  raw: unknown,
): { previous: string; scope: string | null } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.previous !== "string") return undefined;
  return { previous: rec.previous, scope: typeof rec.scope === "string" ? rec.scope : null };
}

export function tryParseSetupSummary(stdout: string): SetupSummary | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const last = trimmed.split("\n").filter(Boolean).pop() ?? "";
    const parsed: unknown = JSON.parse(last);
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    return {
      created: Array.isArray(rec.created) ? (rec.created as string[]) : [],
      modified: Array.isArray(rec.modified) ? (rec.modified as string[]) : [],
      removed: Array.isArray(rec.removed) ? (rec.removed as string[]) : [],
      migrated: Array.isArray(rec.migrated) ? (rec.migrated as string[]) : undefined,
      archived: Array.isArray(rec.archived) ? (rec.archived as string[]) : undefined,
      conflicts: Array.isArray(rec.conflicts) ? (rec.conflicts as string[]) : undefined,
      gitHookUpdates: Array.isArray(rec.gitHookUpdates)
        ? (rec.gitHookUpdates as string[])
        : undefined,
      preserved: Array.isArray(rec.preserved) ? (rec.preserved as string[]) : undefined,
      hooksPathTakenOver: parseHooksPathTakenOver(rec.hooksPathTakenOver),
      gitHooksInactive: typeof rec.gitHooksInactive === "string" ? rec.gitHooksInactive : undefined,
      message: typeof rec.message === "string" ? rec.message : undefined,
    };
  } catch {
    return null;
  }
}
