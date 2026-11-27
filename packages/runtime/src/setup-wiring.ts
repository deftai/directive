/**
 * Package-relative wiring writers for Contract 1 setup (Wave 2c / R9 / AC13.1).
 * All managed pointers target node_modules/@deftai/directive-runtime/ — never .deft/core.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isFrameworkSourceCheckoutAt } from "@deftai/directive-core/dist/doctor/paths.js";
import {
  containedChmod,
  containedRemove,
  containedRename,
  containedWrite,
} from "@deftai/directive-core/dist/fs/contained-write.js";
import type { HookHost } from "@deftai/directive-core/dist/hooks/dispatcher.js";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "@deftai/directive-core/dist/hooks/tools.js";
import {
  AGY_HOOK_PATH,
  agyDepositAdmitted,
  GROK_PRETOOLUSE_WRAPPER_REL_PATH,
  hostHookEntryFields,
  hostHookEntryPrefix,
  hostHookEntryText,
  hostHookOuterCommand,
  hostHookOuterRelPath,
  hostHookOuterSha8,
  hostHookOuterSource,
  isGrokWrapperCommand,
  isHostHookOuterCommand,
  mergeAgyConfig,
} from "@deftai/directive-core/dist/init-deposit/agent-hooks.js";
import {
  referencedHostHookOuterNames,
  stripAgyHostHookConfig,
} from "@deftai/directive-core/dist/init-deposit/host-hook-outer.js";
import {
  DESIRED_GITATTRIBUTES_LINES,
  ensureGitattributes,
  RETIRED_GITATTRIBUTES_LINES,
} from "@deftai/directive-core/dist/init-deposit/scaffold.js";
import {
  ENTRY_GUARD_MESSAGES,
  RUNTIME_PACKAGE_PATH_PREFIX,
} from "@deftai/directive-core/dist/install-health/constants.js";
import {
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_OPEN_PREFIX,
  MINIMAL_TASKFILE,
} from "@deftai/directive-core/dist/install-health/index.js";
import { applyAgentsRefresh } from "@deftai/directive-core/dist/platform/agents-md.js";
import {
  type HostHooksPolicy,
  isHostHookDepositEnabled,
  loadHostHooksPolicyFromProject,
} from "@deftai/directive-core/dist/policy/host-hooks.js";
import {
  isHostSlashCommandDepositEnabled,
  loadHostSlashCommandsPolicyFromProject,
} from "@deftai/directive-core/dist/policy/host-slash-commands.js";
import {
  formatInvalidKillRecordWarning,
  KILL_SWITCH_BARE_FLAG_NAME,
  KILL_SWITCH_BARE_FLAG_WARNING,
  KILL_SWITCH_GITHOOK_MARKER,
  KILL_SWITCH_RECORD_GIT_DIR_PREFIX,
  KILL_SWITCH_RECORD_REL,
  KILL_SWITCH_RECORD_SCHEMA_LINE,
  type KillSwitchRecordInvalidReason,
} from "@deftai/directive-core/dist/policy/kill-switch-record.js";
import { depositOpenClawSoftRebindSkill } from "@deftai/directive-core/dist/session/openclaw-soft-rebind-deposit.js";
import {
  emitHostCommandFiles,
  type HostEmittedFile,
  listSlashEmitterHosts,
} from "@deftai/directive-core/dist/slash/emitters.js";
import { isThinWrapperMarkdown } from "@deftai/directive-core/dist/slash/generator.js";
import { depositOpenClawL2ProductCommands } from "@deftai/directive-core/dist/slash/openclaw-deposit.js";

export const RUNTIME_PREFIX = RUNTIME_PACKAGE_PATH_PREFIX;
export const HOOK_BIN_COMMAND = `node ${RUNTIME_PREFIX}dist/hook-bin.js`;
export const RUNTIME_BIN_REL = `${RUNTIME_PREFIX}dist/bin.js`;
export const RUNTIME_MAIN_MD = `${RUNTIME_PREFIX}main.md`;
export const RUNTIME_TASKFILE_INCLUDE = `taskfile: ./${RUNTIME_PREFIX}Taskfile.yml`;

export type TrackResult = {
  created: boolean;
  modified: boolean;
  conflict?: boolean;
  conflictReason?: string;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Normalize CRLF/CR to LF for ownership/wrapper equality (#5995). */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True when two texts differ only by end-of-line convention (#5995). */
export function contentsEqualIgnoringEol(a: string, b: string): boolean {
  return normalizeEol(a) === normalizeEol(b);
}

/**
 * `.githooks` shell entrypoints must be LF on disk for `sh` (#5995 / PR #6151 P1).
 * Ownership stays EOL-insensitive; these paths still rewrite CRLF-only drift.
 */
export function isShellHookEntrypoint(rel: string): boolean {
  const posix = rel.replace(/\\/g, "/");
  if (!posix.startsWith(".githooks/")) return false;
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  return base.endsWith(".sh") || !base.includes(".");
}

function writeContained(projectRoot: string, relPath: string, body: string): void {
  containedWrite({
    root: projectRoot,
    target: relPath,
    data: body,
    mode: "replace",
    mkdir: true,
  });
}

function relPosix(...parts: string[]): string {
  return join(...parts).replace(/\\/g, "/");
}

function trackChange(projectRoot: string, rel: string, next: string): TrackResult {
  const prior = readText(join(projectRoot, rel));
  if (prior === next) return { created: false, modified: false };
  // CRLF-vs-LF-only diffs are still Directive-managed; skip rewrite for non-shell
  // paths (#5995). Shell hooks still need LF bytes so `sh` can exec them (#6151 P1).
  if (prior !== null && contentsEqualIgnoringEol(prior, next) && !isShellHookEntrypoint(rel)) {
    return { created: false, modified: false };
  }
  writeContained(projectRoot, rel, next);
  return { created: prior === null, modified: prior !== null };
}

/**
 * Resolve deft skill pointer target (AC9.6). Prefer skills/deft/SKILL.md when
 * present in this runtime package; otherwise keep working package-root SKILL.md.
 */
export function resolveDeftSkillTargetRel(): string {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(join(pkgRoot, "skills", "deft", "SKILL.md"))) {
    return "skills/deft/SKILL.md";
  }
  return "SKILL.md";
}

/**
 * Render a one-line front-matter value as valid YAML (#6165). Plain text stays
 * unquoted so existing pointers keep the same bytes; text that YAML would
 * misread (`: `, ` #`, a leading indicator character, edge spaces) becomes a
 * JSON string, which is a valid YAML double-quoted scalar.
 */
export function yamlScalar(value: string): string {
  const needsQuotes =
    value.length === 0 ||
    value.includes(": ") ||
    value.endsWith(":") ||
    value.includes(" #") ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    value !== value.trim();
  return needsQuotes ? JSON.stringify(value) : value;
}

/**
 * Skill pointer recovery line (AC9.7, #6620): a missing path means the
 * project install has not run; damaged wiring means repair.
 */
export const SKILL_POINTER_RECOVERY =
  "if this path is missing, run `npm install` (or `pnpm install --frozen-lockfile`) in this project; if Directive's wiring is damaged, run `directive install --repair`.";

function thinSkillPointer(
  dir: string,
  description: string,
  targetRel: string,
): {
  dir: string;
  body: string;
} {
  return {
    dir,
    body: `---
name: ${dir}
description: ${yamlScalar(description)}
---

Read and follow: ${RUNTIME_PREFIX}${targetRel}

Recovery: ${SKILL_POINTER_RECOVERY}
`,
  };
}

/**
 * Thin skill pointer inventory (AC9.6) — the 12-pointer 0.126 consumer discovery set
 * (includes the always-pins).
 * No versions; package-relative only. Includes pre-pr + review-cycle (AC9.6 / #2508).
 */
export const SKILL_POINTER_INVENTORY: ReadonlyArray<{ dir: string; body: string }> = [
  thinSkillPointer(
    "deft",
    "Apply Directive framework standards for AI-assisted development.",
    resolveDeftSkillTargetRel(),
  ),
  thinSkillPointer(
    "deft-directive-setup",
    "Set up a new project with Directive framework standards.",
    "skills/deft-directive-setup/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-build",
    "Build a project from scope vBRIEFs following Directive standards.",
    "skills/deft-directive-build/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-review-cycle",
    "Greptile bot reviewer response workflow for autonomous PR review cycles.",
    "skills/deft-directive-review-cycle/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-refinement",
    "Structured refinement workflow: triage issues and update the roadmap.",
    "skills/deft-directive-refinement/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-swarm",
    "Parallel local agent orchestration with isolated worktrees.",
    "skills/deft-directive-swarm/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-interview",
    "Deterministic structured Q&A interview skill (one question per turn).",
    "skills/deft-directive-interview/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-portfolio-priority",
    "Pre-promotion portfolio prioritization across competing open RFCs/issues.",
    "skills/deft-directive-portfolio-priority/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-pre-pr",
    "Iterative pre-PR quality loop (Read-Write-Lint-Diff-Loop).",
    "skills/deft-directive-pre-pr/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-sync",
    "Session-start framework sync and alignment check.",
    "skills/deft-directive-sync/SKILL.md",
  ),
  // #5838: 0.126 also deposited these two; keep them so upgrades rewrite the
  // old `.deft/core/skills/...` pointers and fresh installs keep the feature.
  thinSkillPointer(
    "deft-directive-tutorial",
    "Runs the Directive Tutorial inside the current session (Signal, Postcard, or Echo).",
    "skills/deft-directive-tutorial/SKILL.md",
  ),
  thinSkillPointer(
    "deft-directive-feedback",
    "Mid-session and session-end framework-gap escalation for directive consumers.",
    "skills/deft-directive-feedback/SKILL.md",
  ),
];

/** Host discovery mirrors for the same thin pointers (AC8.1 / Copilot via .github/skills). */
export const SKILL_HOST_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".github/skills",
] as const;

/**
 * Resolve this runtime package's agents-entry.md (never a leftover
 * @deftai/directive-content install).
 */
export function resolveRuntimeAgentsEntryTemplatePath(): string | null {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    join(pkgRoot, "templates", "agents-entry.md"),
    // Monorepo source layout: content lives at repo content/templates/.
    join(pkgRoot, "..", "..", "content", "templates", "agents-entry.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Apply shipped templates/agents-entry.md via the same path as agents:refresh (AC9.6 / AC9.7).
 * No hardcoded stub; package-relative paths; no .deft/core.
 */
export function ensureAgentsManagedSection(projectRoot: string): TrackResult & {
  conflict: boolean;
  conflictReason?: string;
} {
  const rel = "AGENTS.md";
  const existing = readText(join(projectRoot, rel));
  if (existing !== null) {
    const start = existing.indexOf(MANAGED_SECTION_OPEN_PREFIX);
    if (start >= 0) {
      const openEnd = existing.indexOf("-->", start);
      const end = openEnd >= 0 ? existing.indexOf(MANAGED_SECTION_CLOSE, openEnd) : -1;
      if (end < 0) {
        return {
          created: false,
          modified: false,
          conflict: true,
          conflictReason: "AGENTS.md: managed section open without close marker",
        };
      }
    }
  }

  // A framework source checkout plans against its own template (#6507): pass no
  // runtime template seam, so the plan reads content/templates/agents-entry.md.
  const templatePath = isFrameworkSourceCheckoutAt(projectRoot)
    ? null
    : resolveRuntimeAgentsEntryTemplatePath();
  const templateText = templatePath !== null ? readText(templatePath) : null;
  let frameworkRoot: string | undefined;
  if (templatePath !== null) {
    const norm = templatePath.replace(/\\/g, "/");
    frameworkRoot = norm.endsWith("/content/templates/agents-entry.md")
      ? join(dirname(templatePath), "..", "..")
      : dirname(dirname(templatePath));
  }
  const result = applyAgentsRefresh(
    projectRoot,
    {},
    {
      ...(frameworkRoot !== undefined ? { frameworkRoot } : {}),
      ...(templateText !== null ? { readTemplate: () => templateText } : {}),
    },
  );
  if (
    result.state === "template-missing" ||
    result.state === "template-malformed" ||
    result.state === "unreadable"
  ) {
    return {
      created: false,
      modified: false,
      conflict: true,
      conflictReason: `AGENTS.md: agents-entry refresh failed (${result.state})`,
    };
  }
  const after = readText(join(projectRoot, rel)) ?? "";
  const managed = extractManagedSection(after);
  if (managed !== null && managed.includes(".deft/core/")) {
    return {
      created: existing === null && result.wrote,
      modified: existing !== null && result.wrote,
      conflict: true,
      conflictReason: "AGENTS.md: managed section references .deft/core",
    };
  }
  if (!result.wrote) {
    return { created: false, modified: false, conflict: false };
  }
  return {
    created: existing === null,
    modified: existing !== null,
    conflict: false,
  };
}

function extractManagedSection(text: string): string | null {
  const start = text.indexOf(MANAGED_SECTION_OPEN_PREFIX);
  if (start < 0) return null;
  const openEnd = text.indexOf("-->", start);
  const end = openEnd >= 0 ? text.indexOf(MANAGED_SECTION_CLOSE, openEnd) : -1;
  if (end < 0) return null;
  return text.slice(start, end + MANAGED_SECTION_CLOSE.length);
}

export function ensureSkillPointers(projectRoot: string): {
  created: string[];
  modified: string[];
} {
  const created: string[] = [];
  const modified: string[] = [];
  for (const hostRoot of SKILL_HOST_ROOTS) {
    for (const entry of SKILL_POINTER_INVENTORY) {
      const rel = relPosix(hostRoot, entry.dir, "SKILL.md");
      const change = trackChange(
        projectRoot,
        rel,
        entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`,
      );
      if (change.created) created.push(rel);
      else if (change.modified) modified.push(rel);
    }
  }
  return { created, modified };
}

/** All wholly owned skill pointer paths (host roots × inventory). */
export function listSkillPointerPaths(): string[] {
  const paths: string[] = [];
  for (const hostRoot of SKILL_HOST_ROOTS) {
    for (const entry of SKILL_POINTER_INVENTORY) {
      paths.push(relPosix(hostRoot, entry.dir, "SKILL.md"));
    }
  }
  return paths;
}

/** Rewrite legacy .deft/core slash teaching to package-relative (AC8.1 / AC13.1). */
function ovprSlashWrapperContents(file: HostEmittedFile): string {
  const rewritten = file.contents.replace(
    /Read and follow `([^`]+)` \(content-relative; deposit under `\.deft\/core\/` when installed\)\./,
    `Read and follow \`${RUNTIME_PREFIX}$1\`.`,
  );
  return rewritten.includes(".deft/core/")
    ? rewritten.split(".deft/core/").join(RUNTIME_PREFIX)
    : rewritten;
}

/**
 * True when on-disk slash content is a Directive thin wrapper we may refresh
 * (legacy .deft/core teaching or package-relative OVPR form).
 */
function isManagedSlashWrapper(raw: string, file: HostEmittedFile, next: string): boolean {
  const rawN = normalizeEol(raw);
  const nextN = normalizeEol(next);
  if (rawN === nextN) return true;
  if (isThinWrapperMarkdown(rawN, file.dispatchPath)) return true;
  // Already-rewritten OVPR wrapper: still thin + points at this dispatch path.
  return (
    rawN.startsWith("---\n") &&
    rawN.includes(file.dispatchPath) &&
    (rawN.includes(RUNTIME_PREFIX) || rawN.includes(".deft/core/")) &&
    rawN.includes("Read and follow") &&
    rawN.includes("Do not inline")
  );
}

/**
 * True when `rel` has unstaged worktree edits vs the index (#6151 P1).
 * No repo / no git / clean path → false (safe to report modified for staging).
 */
export function pathHasUnstagedChanges(projectRoot: string, rel: string): boolean {
  try {
    const out = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", "--", rel], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Left-unstaged disclosure when LF pins land on a dirty `.gitattributes` (#6151 P1). */
export const GITATTRIBUTES_STAGING_SKIPPED_DIRTY =
  ".gitattributes had unstaged local edits; LF pins were written but left unstaged so install/upgrade does not git add unrelated user changes (#6151 P1)";

const DESIRED_GITATTRIBUTES_LINE_SET = new Set<string>([
  ...DESIRED_GITATTRIBUTES_LINES,
  ...RETIRED_GITATTRIBUTES_LINES,
]);

/**
 * True when every attribute line is a known Directive managed line, a retired
 * `.deft/core` line, or a Deft deposit comment. Foreign rules mean the file is not pure Directive-owned
 * (#6151 P1 dirty-skip heuristic).
 */
export function isDirectiveManagedGitattributes(content: string): boolean {
  for (const raw of normalizeEol(content).split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      if (
        line.startsWith("# Deft framework:") ||
        line.startsWith("# Deft managed wiring:") ||
        line.startsWith("# consumer source.") ||
        line.startsWith("# byte identity") ||
        line.startsWith("# to LF so Windows")
      ) {
        continue;
      }
      return false;
    }
    if (!DESIRED_GITATTRIBUTES_LINE_SET.has(line)) return false;
  }
  return true;
}

/** True when `rel` exists in the worktree but is not tracked (git repo only). */
function pathIsUntrackedInRepo(projectRoot: string, rel: string): boolean {
  try {
    execFileSync("git", ["-C", projectRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return false;
  }
  try {
    execFileSync("git", ["-C", projectRoot, "ls-files", "--error-unmatch", "--", rel], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return false;
  } catch {
    return existsSync(join(projectRoot, rel));
  }
}

/**
 * Deposit narrow LF .gitattributes for managed wiring paths (#5995) and strip
 * the retired `.deft/core` lines (#5961). Reuses scaffold ensureGitattributes.
 * Reports created/modified so install/upgrade staging commits the pins (#6151 P1).
 * When the path already has unstaged user edits (or an untracked foreign file),
 * still appends missing pins but does not report modified (avoids staging WIP).
 */
export function ensureManagedPathGitattributes(projectRoot: string): {
  created: boolean;
  modified: boolean;
  wrote: boolean;
  stagingSkippedNotice?: string;
} {
  const attrsRel = ".gitattributes";
  const prior = readText(join(projectRoot, attrsRel));
  // Compute dirty signal before write — post-write `git diff` is true for clean
  // pin appends too, so it cannot alone decide staging (#6151 P1).
  const hadUnstagedEdits = prior !== null && pathHasUnstagedChanges(projectRoot, attrsRel);
  const untrackedForeign =
    prior !== null &&
    !isDirectiveManagedGitattributes(prior) &&
    pathIsUntrackedInRepo(projectRoot, attrsRel);
  const wrote = ensureGitattributes(projectRoot, { printf: () => undefined });
  if (!wrote) return { created: false, modified: false, wrote: false };
  if (prior === null) return { created: true, modified: false, wrote: true };

  const next = readText(join(projectRoot, attrsRel)) ?? "";
  // After write: confirm unstaged still, or foreign prior that changed and was
  // already dirty/untracked — never stage unfinished user WIP with the pins.
  const stillUnstaged = pathHasUnstagedChanges(projectRoot, attrsRel);
  const priorForeignChanged =
    !isDirectiveManagedGitattributes(prior) && !contentsEqualIgnoringEol(prior, next);
  const treatAsDirty =
    hadUnstagedEdits ||
    untrackedForeign ||
    (stillUnstaged && priorForeignChanged && (hadUnstagedEdits || untrackedForeign));
  if (treatAsDirty) {
    return {
      created: false,
      modified: false,
      wrote: true,
      stagingSkippedNotice: GITATTRIBUTES_STAGING_SKIPPED_DIRTY,
    };
  }
  return { created: false, modified: true, wrote: true };
}

/**
 * Deposit host slash/prompt thin wrappers with package-relative targets (AC8.1 / AC8.10).
 * Reuses emitter inventory; does not revive .deft/core teaching.
 * Preserves consumer-custom command files and reports conflicts instead of clobbering.
 */
export function ensureSlashCommands(projectRoot: string): {
  created: string[];
  modified: string[];
  conflicts: string[];
  notices: string[];
} {
  // Pin managed wiring paths to LF before compare/deposit (#5995).
  const attrs = ensureManagedPathGitattributes(projectRoot);
  const created: string[] = [];
  const modified: string[] = [];
  const conflicts: string[] = [];
  const notices: string[] = [];
  if (attrs.created) {
    created.push(".gitattributes");
  } else if (attrs.stagingSkippedNotice) {
    notices.push(attrs.stagingSkippedNotice);
    // deliberately omit from modified — dirty user WIP must not be git-added
  } else if (attrs.modified && attrs.wrote) {
    modified.push(".gitattributes");
  }
  const policy = loadHostSlashCommandsPolicyFromProject(projectRoot);
  for (const hostId of listSlashEmitterHosts()) {
    if (!isHostSlashCommandDepositEnabled(hostId, policy)) continue;
    for (const file of emitHostCommandFiles(hostId)) {
      const body = ovprSlashWrapperContents(file);
      const next = body.endsWith("\n") ? body : `${body}\n`;
      const prior = readText(join(projectRoot, file.relativePath));
      if (
        prior !== null &&
        !contentsEqualIgnoringEol(prior, next) &&
        !isManagedSlashWrapper(prior, file, next)
      ) {
        conflicts.push(
          `${file.relativePath}: existing command is not a Directive-managed wrapper; refusing to overwrite`,
        );
        continue;
      }
      const change = trackChange(projectRoot, file.relativePath, next);
      if (change.created) created.push(file.relativePath);
      else if (change.modified) modified.push(file.relativePath);
    }
  }
  return { created, modified, conflicts, notices };
}

/**
 * Verified managed slash/prompt paths from the emitter inventory (AC8.1 / AC11.10).
 * Does not claim arbitrary host command files that merely mention the runtime path.
 */
export function listVerifiedManagedSlashCommandPaths(projectRoot: string): string[] {
  const paths: string[] = [];
  const policy = loadHostSlashCommandsPolicyFromProject(projectRoot);
  for (const hostId of listSlashEmitterHosts()) {
    if (!isHostSlashCommandDepositEnabled(hostId, policy)) continue;
    for (const file of emitHostCommandFiles(hostId)) {
      const prior = readText(join(projectRoot, file.relativePath));
      if (prior === null) continue;
      const body = ovprSlashWrapperContents(file);
      const next = body.endsWith("\n") ? body : `${body}\n`;
      if (!isManagedSlashWrapper(prior, file, next)) continue;
      paths.push(file.relativePath);
    }
  }
  return paths;
}

function rewriteOpenClawSkillsDir(skillsDir: string): {
  rewritten: string[];
  failures: string[];
} {
  const rewritten: string[] = [];
  const failures: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return { rewritten, failures };
  }
  for (const name of names) {
    const rel = join(name, "SKILL.md").replace(/\\/g, "/");
    const abs = join(skillsDir, name, "SKILL.md");
    const body = readText(abs);
    if (body === null || !body.includes(".deft/core/")) continue;
    const next = body.split(".deft/core/").join(RUNTIME_PREFIX);
    if (next === body) continue;
    try {
      containedWrite({
        root: skillsDir,
        target: rel,
        data: next.endsWith("\n") ? next : `${next}\n`,
        mode: "replace",
        mkdir: true,
      });
      rewritten.push(abs);
    } catch (err) {
      failures.push(`${abs}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { rewritten, failures };
}

/**
 * Conditional OpenClaw deposits (AC8.1). Adapters no-op when OC is not detected.
 * Writes typically land in OpenClaw workspace dirs (not project ownership).
 * Rewrites deposited .deft/core paths to the installed runtime package prefix.
 */
export function ensureOpenClawIntegrations(projectRoot: string): {
  skipped: boolean;
  skipReason?: string;
  warnings: string[];
  conflicts: string[];
} {
  const warnings: string[] = [];
  const conflicts: string[] = [];
  try {
    const soft = depositOpenClawSoftRebindSkill({});
    const l2 = depositOpenClawL2ProductCommands({
      projectRoot,
      printf: () => undefined,
    });
    const skipped = Boolean(soft.skipped && l2.skipped);
    if (skipped) {
      return {
        skipped: true,
        skipReason: soft.skipReason ?? l2.skipReason ?? "OpenClaw not detected",
        warnings,
        conflicts,
      };
    }

    const dirs = new Set<string>([...soft.skillsDirs, ...l2.skillsDirs]);
    for (const dir of dirs) {
      const { failures } = rewriteOpenClawSkillsDir(dir);
      for (const failure of failures) {
        conflicts.push(`OpenClaw path rewrite failed: ${failure}`);
      }
    }
    for (const p of soft.preservedCustomPaths) {
      warnings.push(`OpenClaw soft rebind: refused/preserved write at ${p}`);
    }
    for (const p of l2.preservedCustomPaths) {
      warnings.push(`OpenClaw L2: refused/preserved write at ${p}`);
    }
    return { skipped: false, warnings, conflicts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    conflicts.push(`OpenClaw integrations write failed: ${msg}`);
    return {
      skipped: true,
      skipReason: msg,
      warnings,
      conflicts,
    };
  }
}

function hookCommand(host: string, event: string): string {
  const sha8 = hostHookOuterSha8();
  return `${hostHookEntryPrefix(host as HookHost, sha8)} --host ${host} --event ${event}`;
}

/** Rewrite bare `deft-hook` / legacy `deft hook:dispatch` to package-relative (AC9.2). */
export function rewriteBareDeftHookCommand(command: string): string {
  const trimmed = command.trim();
  if (isHostHookOuterCommand(trimmed)) return command;
  const hostMatch = trimmed.match(/--host\s+(\w+)/);
  const eventMatch = trimmed.match(/--event\s+([\w.]+)/);
  const host = hostMatch?.[1];
  const event = eventMatch?.[1];
  const sha8 = hostHookOuterSha8();
  const toOuter = (h: string, e: string) =>
    `${hostHookOuterCommand(h as HookHost, sha8)} --host ${h} --event ${e}`;
  // Legacy Grok .sh wrapper → outer
  if (isGrokWrapperCommand(trimmed) && host && event) {
    return toOuter(host, event);
  }
  if (isGrokWrapperCommand(trimmed)) {
    return toOuter("grok", "tool.before");
  }
  // Direct hook-bin with host/event → outer
  if (trimmed.includes(HOOK_BIN_COMMAND) && host && event) {
    return toOuter(host, event);
  }
  const bare = /^(?:deft-hook|deft\s+hook:dispatch)(\s+.*)?$/;
  const m = trimmed.match(bare);
  if (m) {
    const rest = (m[1] ?? "").trim();
    if (host && event) return toOuter(host, event);
    // bare without host/event: leave as package-relative interim only if no host
    return rest.length > 0 ? `${HOOK_BIN_COMMAND} ${rest}` : HOOK_BIN_COMMAND;
  }
  if (/\bdeft-hook\b/.test(trimmed) && !isHostHookOuterCommand(trimmed) && host && event) {
    return toOuter(host, event);
  }
  if (/\bdeft\s+hook:dispatch\b/.test(trimmed) && host && event) {
    return toOuter(host, event);
  }
  return command;
}

function rewriteCommandsInValue(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const next = rewriteBareDeftHookCommand(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = rewriteCommandsInValue(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: next, changed };
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const r = rewriteCommandsInValue(v);
      if (r.changed) changed = true;
      next[k] = r.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

function isManagedHookCommand(command: string): boolean {
  return (
    isHostHookOuterCommand(command) ||
    command.includes(HOOK_BIN_COMMAND) ||
    isGrokWrapperCommand(command) ||
    /(^|[\s"`'])deft-hook([\s"`']|$)/.test(command) ||
    command.includes("deft hook:dispatch")
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isManagedNestedHookCommand(command: string, host: string): boolean {
  if (host === "grok" && isGrokWrapperCommand(command)) return true;
  return isManagedHookCommand(command) && command.includes(`--host ${host}`);
}

/**
 * Drop managed commands inside a nested group; keep custom hooks and group fields.
 * Returns null when the group is empty after filtering (or was fully managed).
 * Non-group entries pass through unchanged.
 */
function filterManagedCommandsInNestedGroup(
  value: unknown,
  host: string,
  options: { hostAgnostic?: boolean } = {},
): unknown | null {
  const group = object(value);
  if (group === null || !Array.isArray(group.hooks)) return value;
  const keptHooks = group.hooks.filter((h) => {
    const text = hostHookEntryText(h);
    if (text === null) return true;
    if (options.hostAgnostic) return !isManagedHookCommand(text);
    return !isManagedNestedHookCommand(text, host);
  });
  if (keptHooks.length === 0) return null;
  return { ...group, hooks: keptHooks };
}

function cursorManagedEntry(value: unknown): boolean {
  const entry = object(value);
  return typeof entry?.command === "string" && isManagedHookCommand(entry.command);
}

function nestedToolCommand(host: string, event: string): string {
  // #5994 / AC9.1: every host/event uses the content-hashed `.mjs` outer.
  return hookCommand(host, event);
}

function nestedGroup(host: string, event: string, matcher?: string): Record<string, unknown> {
  return {
    ...(event === "tool.before" && matcher !== undefined ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        ...hostHookEntryFields(nestedToolCommand(host, event)),
        timeout: event === "tool.before" ? 30 : 30,
      },
    ],
  };
}

/** Shared matcher constants — include Grok write/search_replace/run_terminal_command/spawn_subagent. */
const PRE_TOOL_MATCHERS = [
  DIRECT_WRITE_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
] as const;

function stripNestedManaged(
  existing: Record<string, unknown>,
  host: string,
): Record<string, unknown> {
  const hooks = object(existing.hooks);
  if (hooks === null) return existing;
  const nextHooks: Record<string, unknown> = {};
  for (const key of [
    "SessionStart",
    "PreToolUse",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
  ] as const) {
    if (!(key in hooks)) continue;
    const filtered = Array.isArray(hooks[key])
      ? (hooks[key] as unknown[])
          .map((e) => filterManagedCommandsInNestedGroup(e, host))
          .filter((e): e is unknown => e !== null)
      : [];
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _h, ...rest } = existing;
    return rest;
  }
  return { ...existing, hooks: nextHooks };
}

function stripCursorManaged(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks = object(existing.hooks);
  if (hooks === null) return existing;
  const nextHooks: Record<string, unknown> = {};
  for (const key of [
    "sessionStart",
    "preToolUse",
    "preCompact",
    "beforeSubmitPrompt",
    "afterAgentResponse",
  ] as const) {
    if (!(key in hooks)) continue;
    const filtered = Array.isArray(hooks[key])
      ? (hooks[key] as unknown[]).filter((e) => !cursorManagedEntry(e))
      : [];
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _h, version: _v, ...rest } = existing;
    return rest;
  }
  return { ...existing, version: 1, hooks: nextHooks };
}

function keepCustomNestedGroups(entries: unknown[], host: string): unknown[] {
  return entries
    .map((e) =>
      filterManagedCommandsInNestedGroup(e, host, {
        // Merge clears any managed identity (incl. Grok wrapper) before redeposit.
        hostAgnostic: true,
      }),
    )
    .filter((e): e is unknown => e !== null);
}

function mergeNestedHost(
  existing: Record<string, unknown>,
  host: string,
  options: { compact: boolean; sessionEnd?: boolean },
): Record<string, unknown> {
  const hooks = object(existing.hooks) ?? {};
  const session = Array.isArray(hooks.SessionStart)
    ? keepCustomNestedGroups(hooks.SessionStart as unknown[], host)
    : [];
  const preTool = Array.isArray(hooks.PreToolUse)
    ? keepCustomNestedGroups(hooks.PreToolUse as unknown[], host)
    : [];
  const nextHooks: Record<string, unknown> = {
    ...hooks,
    SessionStart: [...session, nestedGroup(host, "session.start")],
    PreToolUse: [
      ...preTool,
      ...PRE_TOOL_MATCHERS.map((matcher) => nestedGroup(host, "tool.before", matcher)),
    ],
  };
  if (options.compact) {
    const preCompact = Array.isArray(hooks.PreCompact)
      ? keepCustomNestedGroups(hooks.PreCompact as unknown[], host)
      : [];
    const postCompact = Array.isArray(hooks.PostCompact)
      ? keepCustomNestedGroups(hooks.PostCompact as unknown[], host)
      : [];
    nextHooks.PreCompact = [...preCompact, nestedGroup(host, "session.compact")];
    nextHooks.PostCompact = [...postCompact, nestedGroup(host, "session.compact")];
  }
  if (options.sessionEnd) {
    // Releases the session lease on every end reason (no matcher), as `verify:hooks-installed` does (#6274 / #7438).
    const sessionEnd = Array.isArray(hooks.SessionEnd)
      ? keepCustomNestedGroups(hooks.SessionEnd as unknown[], host)
      : [];
    nextHooks.SessionEnd = [...sessionEnd, nestedGroup(host, "session.end")];
  }
  return { ...existing, hooks: nextHooks };
}

function mergeCursorHost(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks = object(existing.hooks) ?? {};
  const keep = (key: string) =>
    Array.isArray(hooks[key])
      ? (hooks[key] as unknown[]).filter((e) => !cursorManagedEntry(e))
      : [];
  return {
    ...existing,
    version: 1,
    hooks: {
      ...hooks,
      sessionStart: [
        ...keep("sessionStart"),
        { command: hookCommand("cursor", "session.start"), timeout: 30 },
      ],
      preToolUse: [
        ...keep("preToolUse"),
        ...PRE_TOOL_MATCHERS.map((matcher) => ({
          command: hookCommand("cursor", "tool.before"),
          matcher,
          failClosed: true,
          timeout: 30,
        })),
      ],
      preCompact: [
        ...keep("preCompact"),
        { command: hookCommand("cursor", "session.compact"), timeout: 30 },
      ],
      beforeSubmitPrompt: [
        ...keep("beforeSubmitPrompt"),
        { command: hookCommand("cursor", "prompt.submit"), timeout: 30 },
      ],
      afterAgentResponse: [
        ...keep("afterAgentResponse"),
        { command: hookCommand("cursor", "agent.response"), timeout: 30 },
      ],
    },
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `${path} is not valid JSON; refusing to overwrite user configuration: ${cause}`,
    );
  }
  const obj = object(parsed);
  if (obj === null) {
    throw new Error(`${path} must contain a JSON object; refusing to overwrite.`);
  }
  // Always rewrite bare deft-hook strings first (AC9.2).
  return rewriteCommandsInValue(obj).value as Record<string, unknown>;
}

const HOST_HOOK_SPECS: Array<{
  host: HookHost;
  rel: string;
  merge: (cfg: Record<string, unknown>) => Record<string, unknown>;
  strip: (cfg: Record<string, unknown>) => Record<string, unknown>;
}> = [
  {
    host: "claude",
    rel: ".claude/settings.json",
    merge: (cfg) => mergeNestedHost(cfg, "claude", { compact: true, sessionEnd: true }),
    strip: (cfg) => stripNestedManaged(cfg, "claude"),
  },
  {
    host: "grok",
    rel: ".grok/hooks/deft.json",
    merge: (cfg) => mergeNestedHost(cfg, "grok", { compact: true }),
    strip: (cfg) => stripNestedManaged(cfg, "grok"),
  },
  {
    host: "cursor",
    rel: ".cursor/hooks.json",
    merge: mergeCursorHost,
    strip: stripCursorManaged,
  },
  {
    host: "codex",
    rel: ".codex/hooks.json",
    merge: (cfg) => mergeNestedHost(cfg, "codex", { compact: false }),
    strip: (cfg) => stripNestedManaged(cfg, "codex"),
  },
];

export function ensureHostHooks(
  projectRoot: string,
  hostHooksPolicy: HostHooksPolicy = loadHostHooksPolicyFromProject(projectRoot),
): {
  created: string[];
  modified: string[];
  warnings: string[];
} {
  const created: string[] = [];
  const modified: string[] = [];
  const warnings: string[] = [];

  for (const spec of HOST_HOOK_SPECS) {
    const abs = join(projectRoot, spec.rel);
    const prior = readText(abs);
    const enabled = isHostHookDepositEnabled(spec.host, hostHooksPolicy);
    if (!enabled) {
      // Disabled host: strip managed entries only; do not create the file.
      if (prior === null) continue;
      const stripped = spec.strip(readJsonObject(abs));
      const next = `${JSON.stringify(stripped, null, 2)}\n`;
      if (prior === next || contentsEqualIgnoringEol(prior, next)) continue;
      writeContained(projectRoot, spec.rel, next);
      modified.push(spec.rel);
      continue;
    }
    const base = prior === null ? {} : readJsonObject(abs);
    const merged = spec.merge(base);
    const next = `${JSON.stringify(merged, null, 2)}\n`;
    if (prior === next || (prior !== null && contentsEqualIgnoringEol(prior, next))) continue;
    writeContained(projectRoot, spec.rel, next);
    if (prior === null) created.push(spec.rel);
    else modified.push(spec.rel);
  }

  // #5994: deposit content-hashed `.mjs` outers; strip legacy Grok `.sh`.
  const outerSource = hostHookOuterSource();
  const outerSha8 = hostHookOuterSha8(outerSource);
  for (const host of ["claude", "grok", "cursor", "codex"] as const) {
    const rel = hostHookOuterRelPath(host, outerSha8);
    const enabled = isHostHookDepositEnabled(host, hostHooksPolicy);
    if (enabled) {
      const prior = readText(join(projectRoot, rel));
      if (prior === null || !contentsEqualIgnoringEol(prior, outerSource)) {
        writeContained(projectRoot, rel, outerSource);
        if (prior === null) created.push(rel);
        else modified.push(rel);
      }
    } else if (existsSync(join(projectRoot, rel))) {
      try {
        containedRemove({ root: projectRoot, target: rel });
        modified.push(rel);
      } catch {
        /* best-effort strip */
      }
    }
  }
  ensureAgyHostHook(
    projectRoot,
    hostHooksPolicy,
    outerSource,
    outerSha8,
    created,
    modified,
    warnings,
  );
  const wrapperRel = GROK_PRETOOLUSE_WRAPPER_REL_PATH;
  if (existsSync(join(projectRoot, wrapperRel))) {
    try {
      containedRemove({ root: projectRoot, target: wrapperRel });
      modified.push(wrapperRel);
    } catch {
      /* best-effort strip */
    }
  }

  return { created, modified, warnings };
}

/** agy hook file as written, with no command rewrite: the file is shared with the user's hooks. */
function readAgyHookConfig(
  abs: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; warning: string } {
  const raw = readFileSync(abs, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      warning: `Skipped the agy hooks: ${AGY_HOOK_PATH} is not valid JSON (${cause}). The file was left unchanged.`,
    };
  }
  const obj = object(parsed);
  if (obj === null) {
    return {
      ok: false,
      warning: `Skipped the agy hooks: ${AGY_HOOK_PATH} must contain a JSON object. The file was left unchanged.`,
    };
  }
  return { ok: true, config: obj };
}

/**
 * agy deposit (#7347 / #7438): the `zzzz-directive` entry of `.agents/hooks.json` and the
 * `.agents/deft-hook-<sha8>.mjs` outer. Deposits only when policy enables agy and the
 * committed admission verdict admits it. The hook file is entry-owned: foreign entries stay,
 * and an opt-out removes only Directive's entry (the file goes when nothing else is left).
 */
function ensureAgyHostHook(
  projectRoot: string,
  hostHooksPolicy: HostHooksPolicy,
  outerSource: string,
  outerSha8: string,
  created: string[],
  modified: string[],
  warnings: string[],
): void {
  const enabled =
    isHostHookDepositEnabled("agy", hostHooksPolicy) && agyDepositAdmitted(outerSource);
  const abs = join(projectRoot, AGY_HOOK_PATH);
  const prior = readText(abs);
  const outerRel = hostHookOuterRelPath("agy", outerSha8);
  if (enabled) {
    const read = prior === null ? { ok: true as const, config: {} } : readAgyHookConfig(abs);
    if (!read.ok) {
      warnings.push(read.warning);
      return;
    }
    const base = read.config;
    const merged = mergeAgyConfig(base, outerSha8);
    // A foreign hook that uses Directive's name is left as is (same object back).
    if (prior === null || merged !== base) {
      const next = `${JSON.stringify(merged, null, 2)}\n`;
      if (prior === null || !contentsEqualIgnoringEol(prior, next)) {
        writeContained(projectRoot, AGY_HOOK_PATH, next);
        if (prior === null) created.push(AGY_HOOK_PATH);
        else modified.push(AGY_HOOK_PATH);
      }
    }
    const priorOuter = readText(join(projectRoot, outerRel));
    if (priorOuter === null || !contentsEqualIgnoringEol(priorOuter, outerSource)) {
      writeContained(projectRoot, outerRel, outerSource);
      if (priorOuter === null) created.push(outerRel);
      else modified.push(outerRel);
    }
    return;
  }
  let keptConfig: Record<string, unknown> | null = null;
  if (prior !== null) {
    const read = readAgyHookConfig(abs);
    if (!read.ok) {
      warnings.push(read.warning);
      return;
    }
    const cfg = read.config;
    const stripped = stripAgyHostHookConfig(cfg);
    keptConfig = Object.keys(stripped).length === 0 ? null : stripped;
    if (stripped !== cfg) {
      if (Object.keys(stripped).length === 0) {
        containedRemove({ root: projectRoot, target: AGY_HOOK_PATH });
      } else {
        writeContained(projectRoot, AGY_HOOK_PATH, `${JSON.stringify(stripped, null, 2)}\n`);
      }
      modified.push(AGY_HOOK_PATH);
    }
  }
  // A kept entry (a user command chained onto Directive's) still runs the outer: keep the file.
  const stillReferenced = referencedHostHookOuterNames(keptConfig).has(basename(outerRel));
  if (!stillReferenced && existsSync(join(projectRoot, outerRel))) {
    try {
      containedRemove({ root: projectRoot, target: outerRel });
      modified.push(outerRel);
    } catch {
      /* best-effort strip */
    }
  }
}

/** Escape `text` for use inside a double-quoted sh string. */
function shDoubleQuoted(text: string): string {
  return text.replace(/[\\"$`]/g, (ch) => `\\${ch}`);
}

/**
 * The git-hook helper's missing-runtime line: the `runtime-missing` row, with
 * `{install}` filled in by the helper from the lockfile at the repo root.
 */
const GITHOOK_RUNTIME_MISSING_LINE = shDoubleQuoted(
  ENTRY_GUARD_MESSAGES["runtime-missing"],
).replace("{install}", () => "$_directive_install");

/** Helper warning lines (#6740); `{reason}` becomes the shell verdict variable. */
const GITHOOK_BARE_FLAG_WARNING = shDoubleQuoted(KILL_SWITCH_BARE_FLAG_WARNING);
const GITHOOK_INVALID_WARNING = shDoubleQuoted(
  formatInvalidKillRecordWarning("{reason}" as KillSwitchRecordInvalidReason, false),
).replace("{reason}", () => "$_directive_kill_verdict");
const GITHOOK_INVALID_WARNING_FLAG = shDoubleQuoted(
  formatInvalidKillRecordWarning("{reason}" as KillSwitchRecordInvalidReason, true),
).replace("{reason}", () => "$_directive_kill_verdict");

// Taskfile F1 kill-record-first + project-PM pin miss live in tasks/engine.yml +
// tasks/engine-invoke.cjs (#5994 / #6740) — disable-active runs BEFORE pin-bin / is-buildable-source;
// pin-bin also quiet-exits when the record is valid. This GITHOOK_HELPER is the .githooks twin.
// #6740: the helper checks the kill record with shell tests, git and grep -qxF only, before
// it looks for the runtime or node, so git-hook stand-down needs no Node. It carries the
// reader marker line that doctor reports.
const GITHOOK_HELPER = `#!/usr/bin/env sh
# Package-relative Directive git-hook helper (AC9.9 / AC9.12 / #5994 / #6740).
${KILL_SWITCH_GITHOOK_MARKER}
# Sourced by pre-commit/pre-push; defines run_directive.
# Shared entry order: kill record → runtime missing (project install, by lockfile) → pin bin.js.
if [ -z "\${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$REPO_ROOT" ]; then
  echo "directive hooks: unable to resolve repo root." >&2
  exit 1
fi
_directive_kill_warned=""
# #6740: kill record verdict (valid | absent | an invalid reason). CR removed (tr), then exact
# whole lines (grep -qxF); the record binds to git rev-parse --absolute-git-dir. No node.
_directive_kill_record() {
  _rec="$REPO_ROOT/${KILL_SWITCH_RECORD_REL}"
  if [ ! -e "$_rec" ] && [ ! -L "$_rec" ]; then
    echo absent
    return 0
  fi
  if [ -L "$_rec" ] || [ ! -f "$_rec" ]; then
    echo not-a-regular-file
    return 0
  fi
  if [ ! -r "$_rec" ]; then
    echo unreadable
    return 0
  fi
  if ! tr -d '\\r' <"$_rec" 2>/dev/null | grep -qxF "${KILL_SWITCH_RECORD_SCHEMA_LINE}"; then
    echo missing-schema-line
    return 0
  fi
  _gd="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir 2>/dev/null)" || _gd=""
  if [ -z "$_gd" ]; then
    echo git-dir-unresolved
    return 0
  fi
  if ! tr -d '\\r' <"$_rec" 2>/dev/null | grep -qxF "${KILL_SWITCH_RECORD_GIT_DIR_PREFIX}$_gd"; then
    echo git-dir-mismatch
    return 0
  fi
  echo valid
}
run_directive() {
  # #3039 / #5543 / #5994 F1 / #6740: a valid kill record stands down BEFORE requiring
  # pin bin.js or node; a bare flag file turns nothing off and gets one warning per hook.
  _directive_kill_verdict="$(_directive_kill_record)"
  if [ "$_directive_kill_verdict" = "valid" ]; then
    return 0
  fi
  if [ -z "$_directive_kill_warned" ]; then
    _directive_kill_warned=1
    _directive_kill_flag=""
    if [ -f "$REPO_ROOT/${KILL_SWITCH_BARE_FLAG_NAME}" ] && [ ! -L "$REPO_ROOT/${KILL_SWITCH_BARE_FLAG_NAME}" ]; then
      _directive_kill_flag=1
    fi
    if [ "$_directive_kill_verdict" != "absent" ]; then
      if [ -n "$_directive_kill_flag" ]; then
        echo "${GITHOOK_INVALID_WARNING_FLAG}" >&2
      else
        echo "${GITHOOK_INVALID_WARNING}" >&2
      fi
    elif [ -n "$_directive_kill_flag" ]; then
      echo "${GITHOOK_BARE_FLAG_WARNING}" >&2
    fi
  fi
  RUNTIME_BIN="$REPO_ROOT/${RUNTIME_BIN_REL}"
  if [ ! -f "$RUNTIME_BIN" ]; then
    if [ -f "$REPO_ROOT/pnpm-lock.yaml" ]; then
      _directive_install='\`pnpm install --frozen-lockfile\`'
    elif [ -f "$REPO_ROOT/package-lock.json" ]; then
      _directive_install='\`npm install\`'
    else
      _directive_install='\`npm install\` (or \`pnpm install --frozen-lockfile\`)'
    fi
    echo "directive hooks: missing $RUNTIME_BIN" >&2
    echo "${GITHOOK_RUNTIME_MISSING_LINE}" >&2
    exit 1
  fi
  node "$RUNTIME_BIN" "$@"
}
`;

const PRE_COMMIT = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive verify:branch --project-root "$REPO_ROOT" || exit $?
run_directive verify:encoding --staged --project-root "$REPO_ROOT" || exit $?
# Forward coverage is warn-only in this hook (#6807); CI and the merge gate still enforce it.
run_directive verify:forward-coverage --staged --project-root "$REPO_ROOT" || echo "directive hooks: forward coverage is advisory here; CI and the merge gate still enforce it." >&2
if [ -d "$REPO_ROOT/xbrief" ] || [ -d "$REPO_ROOT/vbrief" ]; then
  run_directive verify:vbrief-conformance --staged --project-root "$REPO_ROOT" || exit $?
  run_directive verify:xbrief-drift --staged --project-root "$REPO_ROOT" || exit $?
fi
`;

// Refspec-aware default-branch push gate, as in 0.126 (#5808 / D-021). Git's
// ref list arrives on stdin and goes straight to preflight-gh.
const PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive preflight-gh --pre-push-stdin --project-root "$REPO_ROOT" || exit $?
`;

/** Current Directive git-hook bodies by repo-relative path (#5808 / #5976). */
export const DIRECTIVE_GIT_HOOK_BODIES: Readonly<Record<string, string>> = {
  ".githooks/_directive-run.sh": GITHOOK_HELPER,
  ".githooks/pre-commit": PRE_COMMIT,
  ".githooks/pre-push": PRE_PUSH,
};

/**
 * Current OVPR helpers plus supported latest-legacy Directive git hooks
 * (`_deft-run.sh` / `run_deft` / copied-core era). True third-party hooks
 * (e.g. prettier-only) must stay unrecognized so we refuse overwrite (AC10.3).
 * Greptile wave4e: do not treat a bare `.deft/core` mention as whole-hook ownership.
 */
function isOurGitHookBody(rel: string, body: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  if (base === "_directive-run.sh" || base === "_deft-run.sh") {
    return (
      body.includes(RUNTIME_BIN_REL) ||
      body.includes("run_directive") ||
      body.includes("run_deft") ||
      body.includes(".deft/core") ||
      body.includes("packages/cli/dist/bin.js")
    );
  }
  // Managed hook shape: shared helper source, package-relative bin, or known
  // legacy `run_deft verify|preflight` verbs — not a lone `.deft/core` path.
  return (
    body.includes("_directive-run.sh") ||
    body.includes("_deft-run.sh") ||
    body.includes(RUNTIME_BIN_REL) ||
    /\brun_deft\s+(verify:|preflight)/.test(body)
  );
}

const EXECUTABLE_GITHOOKS = new Set([".githooks/pre-commit", ".githooks/pre-push"]);

/**
 * #6806: replace a git hook by writing a temp file in the same directory and
 * renaming it over the target. A shell that is running the old hook keeps its
 * open file; an in-place truncate would make bash read the new file at the old
 * byte offset. On Windows a rename onto a file that a running shell holds open
 * fails, so the open hook is first moved aside (allowed there), then the temp
 * file takes its name and the moved file is removed. Only when both fail is the
 * hook written in place as before.
 */
function writeGitHookAtomic(projectRoot: string, rel: string, body: string): void {
  const slash = rel.lastIndexOf("/");
  const stem = `${rel.slice(0, slash + 1)}.${rel.slice(slash + 1)}.${process.pid}`;
  const tmpRel = `${stem}.directive-tmp`;
  const asideRel = `${stem}.directive-old`;
  const removeQuietly = (target: string): void => {
    try {
      containedRemove({ root: projectRoot, target, mutation: false });
    } catch {
      /* best-effort cleanup */
    }
  };
  containedWrite({
    root: projectRoot,
    target: tmpRel,
    data: body,
    mode: "replace",
    mkdir: true,
    mutation: false,
  });
  if (EXECUTABLE_GITHOOKS.has(rel)) {
    try {
      containedChmod({ root: projectRoot, target: tmpRel, mode: 0o755 });
    } catch {
      /* best-effort on platforms without chmod */
    }
  }
  try {
    containedRename({ root: projectRoot, from: tmpRel, to: rel });
    return;
  } catch {
    /* target held open (Windows): move it aside below */
  }
  try {
    containedRename({ root: projectRoot, from: rel, to: asideRel, mutation: false });
  } catch {
    removeQuietly(tmpRel);
    writeContained(projectRoot, rel, body);
    return;
  }
  try {
    containedRename({ root: projectRoot, from: tmpRel, to: rel });
  } catch {
    // Put the old hook back, then fall back to the in-place write.
    try {
      containedRename({ root: projectRoot, from: asideRel, to: rel, mutation: false });
    } catch {
      /* the in-place write below still leaves a current hook */
    }
    removeQuietly(tmpRel);
    writeContained(projectRoot, rel, body);
    return;
  }
  removeQuietly(asideRel);
}

/** `trackChange` for git hooks: same skip rules, replacement by rename (#6806). */
function trackGitHookChange(
  projectRoot: string,
  rel: string,
  prior: string | null,
  next: string,
): TrackResult {
  if (prior === next) return { created: false, modified: false };
  if (prior !== null && contentsEqualIgnoringEol(prior, next) && !isShellHookEntrypoint(rel)) {
    return { created: false, modified: false };
  }
  writeGitHookAtomic(projectRoot, rel, next);
  return { created: prior === null, modified: prior !== null };
}

/** AC8.6 / AC2.5 / F-008 — disclosed when hooks files exist but core.hooksPath cannot activate. */
export const GIT_HOOKS_INACTIVE_NO_GIT =
  "Git hooks inactive until git init + eligible repair/self-complete (core.hooksPath not set)";

/**
 * True when `rel` is tracked by git in `projectRoot`. Any git failure (no repo,
 * no git binary) reads as untracked.
 */
export function isGitTrackedPath(projectRoot: string, rel: string): boolean {
  try {
    execFileSync("git", ["-C", projectRoot, "ls-files", "--error-unmatch", "--", rel], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Disclosure for a Directive git hook that setup replaced or removed (D-023).
 * The git-history note is only true for a file git already tracks.
 */
export function formatGitHookUpdated(rel: string, tracked: boolean): string {
  return tracked
    ? `Updated \`${rel}\`; your earlier version is in git history.`
    : `Updated \`${rel}\`.`;
}

/** Where a `core.hooksPath` value comes from (`git config --show-scope`). */
export type HooksPathScope = "local" | "worktree" | "global" | "system" | "command" | "unknown";

/**
 * Effective `core.hooksPath` for a checkout (#4960 / #5846, ledger Problem 20).
 * - `unset`: Git uses its default hooks folder.
 * - `ours`: points at this project's `.githooks`, or at the `.githooks` of another
 *   checkout (linked worktree) of the same repository (#7029).
 * - `foreign`: points anywhere else (another tool, a global hooks folder, a cloud host).
 *
 * `needsRelative` (#7029): set (true) on `ours` when the value is not the relative
 * `.githooks`. Git resolves a relative value against each worktree's own root; an
 * absolute value makes every linked worktree run one checkout's hooks.
 */
export interface HooksPathState {
  readonly kind: "unset" | "ours" | "foreign";
  readonly value: string | null;
  readonly scope: HooksPathScope | null;
  readonly needsRelative?: true;
}

const HOOKS_PATH_SCOPES: ReadonlySet<string> = new Set([
  "local",
  "worktree",
  "global",
  "system",
  "command",
]);

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  // Windows paths are case-insensitive; Git may print another drive-letter case.
  if (process.platform === "win32" && a.toLowerCase() === b.toLowerCase()) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function isRelativeGithooksValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === ".githooks" || trimmed === ".githooks/";
}

/** True when a `core.hooksPath` value names `<projectRoot>/.githooks`. */
export function isOurHooksPathValue(projectRoot: string, value: string): boolean {
  const trimmed = value.trim();
  if (isRelativeGithooksValue(trimmed)) return true;
  if (trimmed === "") return false;
  return samePath(resolve(projectRoot, trimmed), resolve(projectRoot, ".githooks"));
}

/**
 * Working-tree roots of every checkout of this repository (`git worktree list
 * --porcelain`), main checkout first. Empty when Git cannot list them. Read-only.
 */
export function listCheckoutRoots(projectRoot: string): string[] {
  let raw: string;
  try {
    raw = execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length).trim());
  }
  return roots;
}

/**
 * True when a `core.hooksPath` value names the `.githooks` of any checkout of
 * this repository: this one, or another linked worktree (#7029).
 */
export function isCheckoutHooksPathValue(projectRoot: string, value: string): boolean {
  if (isOurHooksPathValue(projectRoot, value)) return true;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const target = resolve(projectRoot, trimmed);
  return listCheckoutRoots(projectRoot).some((root) =>
    samePath(target, resolve(root, ".githooks")),
  );
}

/** True when a `core.hooksPath` value is an absolute path (POSIX or Windows form). */
export function isAbsoluteHooksPathValue(value: string): boolean {
  const trimmed = value.trim();
  return isAbsolute(trimmed) || trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
}

/**
 * #7029: disclosure line when setup replaced a `core.hooksPath` that named a
 * checkout's `.githooks` by another form (an absolute path) with the relative value.
 */
export function formatHooksPathMadeRelative(previous: string): string {
  return `Set core.hooksPath to .githooks (was '${previous}'), so each worktree runs its own hooks.`;
}

/** Read-only: the effective `core.hooksPath` and its config scope. Never writes Git config. */
export function readHooksPathState(projectRoot: string): HooksPathState {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["-C", projectRoot, "config", "--show-scope", "--get", "core.hooksPath"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return { kind: "unset", value: null, scope: null };
  }
  const line = raw.replace(/\r?\n$/, "");
  const tab = line.indexOf("\t");
  const scopeText = tab >= 0 ? line.slice(0, tab) : "";
  const value = (tab >= 0 ? line.slice(tab + 1) : line).trim();
  if (value === "") return { kind: "unset", value: null, scope: null };
  const scope: HooksPathScope = HOOKS_PATH_SCOPES.has(scopeText)
    ? (scopeText as HooksPathScope)
    : "unknown";
  if (!isCheckoutHooksPathValue(projectRoot, value)) return { kind: "foreign", value, scope };
  return isRelativeGithooksValue(value)
    ? { kind: "ours", value, scope }
    : { kind: "ours", value, scope, needsRelative: true };
}

/** Plain-English name for a config scope, for messages. */
export function describeHooksPathScope(scope: HooksPathScope | null): string {
  switch (scope) {
    case "global":
      return "your global Git config";
    case "system":
      return "your system Git config";
    case "local":
    case "worktree":
      return "this repository's Git config";
    case "command":
      return "the Git command line";
    default:
      return "your Git config";
  }
}

/**
 * Disclosure when another hooks folder is set and setup may not take it over
 * (automatic setup, upgrade). Names the one fix (#4960 / #5846, D-017).
 */
export function formatForeignHooksPathInactive(state: HooksPathState): string {
  return (
    `Git hooks inactive: core.hooksPath is '${state.value ?? ""}', set by ${describeHooksPathScope(state.scope)}. ` +
    `Run directive install --repair to review and approve using Directive's .githooks.`
  );
}

/**
 * Disclosure when setting `.githooks` did not take effect because another config
 * source still wins (an included file, or `git -c`). Names where it is set.
 */
export function formatHooksPathStillForeign(projectRoot: string, state: HooksPathState): string {
  let origin = "";
  try {
    const raw = execFileSync(
      "git",
      ["-C", projectRoot, "config", "--show-origin", "--get", "core.hooksPath"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const tab = raw.indexOf("\t");
    origin = (tab >= 0 ? raw.slice(0, tab) : "").trim();
  } catch {
    origin = "";
  }
  const where = origin === "" ? describeHooksPathScope(state.scope) : origin;
  return (
    `Git hooks inactive: core.hooksPath is still '${state.value ?? ""}' after setting .githooks, ` +
    `because ${where} sets it. Directive does not edit that file: remove the core.hooksPath ` +
    `setting there to use Directive's .githooks.`
  );
}

export interface EnsureGitHooksOptions {
  /**
   * Operator approved the install/repair plan that disclosed taking over another
   * `core.hooksPath` (#4960, ledger Problem 20). Only the launcher passes this,
   * after its single approval; automatic setup and upgrade never do.
   */
  readonly takeOverHooksPath?: boolean;
}

/** Disclosure for an old Directive git-hook helper that setup removed (D-023). */
export function formatGitHookRemoved(rel: string, tracked: boolean): string {
  return tracked
    ? `Removed \`${rel}\`; your earlier version is in git history.`
    : `Removed \`${rel}\`.`;
}

/**
 * Replace every Directive-shaped git hook with the current template, edited or
 * not (AC8.3 / INIT-18 / D-023), and name each one it replaced. A hook that is
 * not Directive-shaped stays a named conflict and is never touched.
 */
export function ensureGitHooks(
  projectRoot: string,
  options: EnsureGitHooksOptions = {},
): {
  created: string[];
  modified: string[];
  removed: string[];
  conflicts: string[];
  /** One plain line per existing hook that was replaced or removed (D-023). */
  updated: string[];
  /** True only when core.hooksPath is relative .githooks (AC9.9). */
  hooksPathActive: boolean;
  /** Human disclosure when hooks are not live; null when active. */
  inactiveDisclosure: string | null;
  /** Set when this run replaced another `core.hooksPath` with `.githooks` (#4960). */
  hooksPathTakenOver: { previous: string; scope: HooksPathScope | null } | null;
} {
  const created: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];
  const updated: string[] = [];
  for (const [rel, body] of Object.entries(DIRECTIVE_GIT_HOOK_BODIES)) {
    const next = body.endsWith("\n") ? body : `${body}\n`;
    const prior = readText(join(projectRoot, rel));
    if (prior !== null && !contentsEqualIgnoringEol(prior, next) && !isOurGitHookBody(rel, prior)) {
      conflicts.push(
        `${rel}: existing hook is not Directive-managed; refusing to overwrite (chain or remove manually)`,
      );
      continue;
    }
    const tracked = prior !== null && isGitTrackedPath(projectRoot, rel);
    const change = trackGitHookChange(projectRoot, rel, prior, next);
    if (change.created) created.push(rel);
    else if (change.modified) {
      modified.push(rel);
      updated.push(formatGitHookUpdated(rel, tracked));
    }
    if (EXECUTABLE_GITHOOKS.has(rel) && existsSync(join(projectRoot, rel))) {
      try {
        containedChmod({ root: projectRoot, target: rel, mode: 0o755 });
      } catch {
        /* best-effort on platforms without chmod */
      }
    }
  }

  // Drop the old `_deft-run.sh` helper once no remaining hook sources it.
  const legacyHelperRel = ".githooks/_deft-run.sh";
  const legacyHelperAbs = join(projectRoot, legacyHelperRel);
  if (existsSync(legacyHelperAbs)) {
    const legacyBody = readText(legacyHelperAbs);
    if (legacyBody !== null && isOurGitHookBody(legacyHelperRel, legacyBody)) {
      let stillReferenced = false;
      const hooksDir = join(projectRoot, ".githooks");
      try {
        for (const name of readdirSync(hooksDir)) {
          if (name === "_deft-run.sh") continue;
          const other = readText(join(hooksDir, name));
          if (other !== null && other.includes("_deft-run.sh")) {
            stillReferenced = true;
            break;
          }
        }
      } catch {
        stillReferenced = true;
      }
      if (!stillReferenced) {
        const tracked = isGitTrackedPath(projectRoot, legacyHelperRel);
        try {
          const rem = containedRemove({ root: projectRoot, target: legacyHelperRel });
          if (rem.removed) {
            removed.push(legacyHelperRel);
            updated.push(formatGitHookRemoved(legacyHelperRel, tracked));
          }
        } catch {
          /* best-effort; conflicts already captured for other files */
        }
      }
    }
  }

  let hooksPathActive = false;
  let inactiveDisclosure: string | null = null;
  let hooksPathTakenOver: { previous: string; scope: HooksPathScope | null } | null = null;

  // Activate relative hooksPath when unset or already ours (AC9.9). Another hooks
  // folder is taken over only with the install/repair plan's approval (#4960,
  // ledger Problem 20); otherwise hooks stay inactive and setup names the fix.
  if (!existsSync(join(projectRoot, ".git"))) {
    inactiveDisclosure = GIT_HOOKS_INACTIVE_NO_GIT;
  } else {
    const state = readHooksPathState(projectRoot);
    if (state.kind === "ours" && state.needsRelative === true && state.value !== null) {
      // #7029: an absolute value naming a checkout's .githooks makes every linked
      // worktree run that checkout's hooks. It is already Directive's folder, so
      // rewrite it to the relative value without the takeover approval. Repository
      // config only (P20): a worktree-scoped value is replaced where it lives.
      const where = state.scope === "worktree" ? "--worktree" : "--local";
      let wrote = false;
      try {
        execFileSync(
          "git",
          ["-C", projectRoot, "config", where, "--replace-all", "core.hooksPath", ".githooks"],
          { stdio: ["ignore", "ignore", "ignore"] },
        );
        wrote = true;
      } catch {
        /* verified below */
      }
      const after = readHooksPathState(projectRoot);
      if (after.kind === "ours" && after.needsRelative !== true) {
        hooksPathActive = true;
        updated.push(formatHooksPathMadeRelative(state.value));
      } else if (isOurHooksPathValue(projectRoot, state.value)) {
        // Not rewritten, but it still names this checkout's own .githooks.
        hooksPathActive = true;
      } else if (!wrote) {
        inactiveDisclosure =
          "Git hooks inactive: could not set core.hooksPath=.githooks (the repository's Git config is locked or not writable). Try directive install --repair again.";
      } else {
        // The write landed but another source (an included config file or the
        // command line) still wins. Repeating repair cannot fix that; name it.
        inactiveDisclosure = formatHooksPathStillForeign(projectRoot, after);
      }
    } else if (state.kind === "ours") {
      hooksPathActive = true;
    } else if (state.kind === "unset" || options.takeOverHooksPath === true) {
      // Repository config only; never global or system (P20). A worktree-scoped
      // value outranks local config, so replace it where it lives.
      // --replace-all: a repository config may hold the key more than once.
      const where = state.scope === "worktree" ? "--worktree" : "--local";
      let wrote = false;
      try {
        execFileSync(
          "git",
          ["-C", projectRoot, "config", where, "--replace-all", "core.hooksPath", ".githooks"],
          { stdio: ["ignore", "ignore", "ignore"] },
        );
        wrote = true;
      } catch {
        /* verified below; a failed (for example locked) write never falls through */
      }
      const after = readHooksPathState(projectRoot);
      if (after.kind === "ours") {
        hooksPathActive = true;
        if (state.kind === "foreign" && state.value !== null) {
          hooksPathTakenOver = { previous: state.value, scope: state.scope };
        }
      } else if (after.kind === "foreign" && !wrote) {
        inactiveDisclosure =
          "Git hooks inactive: could not set core.hooksPath=.githooks (the repository's Git config is locked or not writable). Try directive install --repair again.";
      } else if (after.kind === "foreign") {
        // Still another value after our write (an included config file or the
        // command line wins). Repeating repair cannot fix that; name the file.
        inactiveDisclosure = formatHooksPathStillForeign(projectRoot, after);
      } else {
        inactiveDisclosure = "Git hooks inactive: could not set core.hooksPath=.githooks";
      }
    } else {
      inactiveDisclosure = formatForeignHooksPathInactive(state);
    }
  }
  return {
    created,
    modified,
    removed,
    conflicts,
    updated,
    hooksPathActive,
    inactiveDisclosure,
    hooksPathTakenOver,
  };
}

const DEFT_INCLUDE_BLOCK =
  `  deft:\n` + `    taskfile: ./${RUNTIME_PREFIX}Taskfile.yml\n` + `    optional: true\n`;

/**
 * Merge the Directive `deft:` include into an existing Taskfile without
 * duplicating top-level `includes:` keys or an occupied `deft` child.
 */
export function ensureTaskfileInclude(projectRoot: string): TrackResult & {
  conflict?: boolean;
  conflictReason?: string;
} {
  const rel = "Taskfile.yml";
  const existing = readText(join(projectRoot, rel));
  if (existing === null) {
    writeContained(projectRoot, rel, MINIMAL_TASKFILE);
    return { created: true, modified: false };
  }
  if (existing.includes(`taskfile: ./${RUNTIME_PREFIX}Taskfile.yml`)) {
    return { created: false, modified: false };
  }
  // Replace legacy .deft/core Taskfile include if present.
  if (/taskfile:\s*\.\/\.deft\/core\/Taskfile\.yml/.test(existing)) {
    const fixed = existing.replace(
      /taskfile:\s*\.\/\.deft\/core\/Taskfile\.yml/g,
      `taskfile: ./${RUNTIME_PREFIX}Taskfile.yml`,
    );
    writeContained(projectRoot, rel, fixed.endsWith("\n") ? fixed : `${fixed}\n`);
    return { created: false, modified: true };
  }

  // Occupied deft child with a different path — conflict, do not duplicate.
  if (/(^|\n)[ \t]*deft:\s*(\n|$)/.test(existing) && /includes:/.test(existing)) {
    return {
      created: false,
      modified: false,
      conflict: true,
      conflictReason:
        "Taskfile.yml: includes.deft already exists with a different path; refusing to duplicate",
    };
  }

  // Merge into an existing includes: mapping (avoid a second top-level key).
  const includesMatch = existing.match(/(^|\n)includes:\s*(#.*)?\n/);
  if (includesMatch && includesMatch.index !== undefined) {
    const insertAt = includesMatch.index + includesMatch[0].length;
    const next = existing.slice(0, insertAt) + DEFT_INCLUDE_BLOCK + existing.slice(insertAt);
    writeContained(projectRoot, rel, next.endsWith("\n") ? next : `${next}\n`);
    return { created: false, modified: true };
  }

  // Inline `includes: { ... }` — append a block-style includes would duplicate;
  // treat as conflict so the operator can convert.
  if (/(^|\n)includes:\s*\{/.test(existing)) {
    return {
      created: false,
      modified: false,
      conflict: true,
      conflictReason:
        "Taskfile.yml: inline includes mapping; refusing to append a duplicate includes key",
    };
  }

  const suffix = existing.endsWith("\n") ? "" : "\n";
  const block = `${suffix}\n# Added by Directive setup (Wave 2c)\nincludes:\n${DEFT_INCLUDE_BLOCK}`;
  writeContained(projectRoot, rel, `${existing}${block}`);
  return { created: false, modified: true };
}
