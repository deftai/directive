/**
 * Package-relative wiring writers for Contract 1 setup (Wave 2c / R9 / AC13.1).
 * All managed pointers target node_modules/@deftai/directive-runtime/ — never .deft/core.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  containedChmod,
  containedRemove,
  containedWrite,
} from "@deftai/directive-core/dist/fs/contained-write.js";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "@deftai/directive-core/dist/hooks/tools.js";
import {
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PACKAGE_PATH_PREFIX,
} from "@deftai/directive-core/dist/install-health/constants.js";
import {
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_OPEN_PREFIX,
} from "@deftai/directive-core/dist/install-health/index.js";
import { applyAgentsRefresh } from "@deftai/directive-core/dist/platform/agents-md.js";
import {
  isHostHookDepositEnabled,
  loadHostHooksPolicyFromProject,
  type HostHooksPolicy,
} from "@deftai/directive-core/dist/policy/host-hooks.js";
import {
  isHostSlashCommandDepositEnabled,
  loadHostSlashCommandsPolicyFromProject,
} from "@deftai/directive-core/dist/policy/host-slash-commands.js";
import type { HookHost } from "@deftai/directive-core/dist/hooks/dispatcher.js";
import { depositOpenClawSoftRebindSkill } from "@deftai/directive-core/dist/session/openclaw-soft-rebind-deposit.js";
import {
  emitHostCommandFiles,
  listSlashEmitterHosts,
  type HostEmittedFile,
} from "@deftai/directive-core/dist/slash/emitters.js";
import { isThinWrapperMarkdown } from "@deftai/directive-core/dist/slash/generator.js";
import { depositOpenClawL2ProductCommands } from "@deftai/directive-core/dist/slash/openclaw-deposit.js";

export const RUNTIME_PREFIX = RUNTIME_PACKAGE_PATH_PREFIX;
export const HOOK_BIN_COMMAND = `node ${RUNTIME_PREFIX}dist/hook-bin.js`;
export const RUNTIME_BIN_REL = `${RUNTIME_PREFIX}dist/bin.js`;
export const RUNTIME_MAIN_MD = `${RUNTIME_PREFIX}main.md`;
export const RUNTIME_TASKFILE_INCLUDE = `taskfile: ./${RUNTIME_PREFIX}Taskfile.yml`;

export type TrackResult = { created: boolean; modified: boolean; conflict?: boolean; conflictReason?: string };

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeContained(
  projectRoot: string,
  relPath: string,
  body: string,
): void {
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

function trackChange(
  projectRoot: string,
  rel: string,
  next: string,
): TrackResult {
  const prior = readText(join(projectRoot, rel));
  if (prior === next) return { created: false, modified: false };
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

function thinSkillPointer(dir: string, description: string, targetRel: string): {
  dir: string;
  body: string;
} {
  return {
    dir,
    body: `---
name: ${dir}
description: ${description}
---

Read and follow: ${RUNTIME_PREFIX}${targetRel}

Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}
`,
  };
}

/**
 * Thin skill pointer inventory (AC9.6) — prior consumer discovery set + always-pins.
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

  const templatePath = resolveRuntimeAgentsEntryTemplatePath();
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
      const change = trackChange(projectRoot, rel, entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`);
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
  if (raw === next) return true;
  if (isThinWrapperMarkdown(raw, file.dispatchPath)) return true;
  // Already-rewritten OVPR wrapper: still thin + points at this dispatch path.
  return (
    raw.startsWith("---\n") &&
    raw.includes(file.dispatchPath) &&
    (raw.includes(RUNTIME_PREFIX) || raw.includes(".deft/core/")) &&
    raw.includes("Read and follow") &&
    raw.includes("Do not inline")
  );
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
} {
  const created: string[] = [];
  const modified: string[] = [];
  const conflicts: string[] = [];
  const policy = loadHostSlashCommandsPolicyFromProject(projectRoot);
  for (const hostId of listSlashEmitterHosts()) {
    if (!isHostSlashCommandDepositEnabled(hostId, policy)) continue;
    for (const file of emitHostCommandFiles(hostId)) {
      const body = ovprSlashWrapperContents(file);
      const next = body.endsWith("\n") ? body : `${body}\n`;
      const prior = readText(join(projectRoot, file.relativePath));
      if (prior !== null && prior !== next && !isManagedSlashWrapper(prior, file, next)) {
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
  return { created, modified, conflicts };
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
  return `${HOOK_BIN_COMMAND} --host ${host} --event ${event}`;
}

/** Rewrite bare `deft-hook` / legacy `deft hook:dispatch` to package-relative (AC9.2). */
export function rewriteBareDeftHookCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.startsWith(HOOK_BIN_COMMAND)) return command;
  const bare = /^(?:deft-hook|deft\s+hook:dispatch)(\s+.*)?$/;
  const m = trimmed.match(bare);
  if (m) {
    const rest = (m[1] ?? "").trim();
    return rest.length > 0 ? `${HOOK_BIN_COMMAND} ${rest}` : HOOK_BIN_COMMAND;
  }
  // Inline occurrences inside longer strings (rare)
  if (/\bdeft-hook\b/.test(trimmed) && !trimmed.includes(RUNTIME_PREFIX)) {
    return trimmed.replace(/\bdeft-hook\b/g, HOOK_BIN_COMMAND);
  }
  if (/\bdeft\s+hook:dispatch\b/.test(trimmed) && !trimmed.includes(RUNTIME_PREFIX)) {
    return trimmed.replace(/\bdeft\s+hook:dispatch\b/g, HOOK_BIN_COMMAND);
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
    command.includes(HOOK_BIN_COMMAND) ||
    /(^|[\s"`'])deft-hook([\s"`']|$)/.test(command) ||
    command.includes("deft hook:dispatch")
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedManagedGroup(value: unknown): boolean {
  const group = object(value);
  if (group === null || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((h) => {
    const hook = object(h);
    return typeof hook?.command === "string" && isManagedHookCommand(hook.command);
  });
}

function cursorManagedEntry(value: unknown): boolean {
  const entry = object(value);
  return typeof entry?.command === "string" && isManagedHookCommand(entry.command);
}

function nestedGroup(host: string, event: string, matcher?: string): Record<string, unknown> {
  return {
    ...(event === "tool.before" && matcher !== undefined ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: hookCommand(host, event),
        timeout: event === "tool.before" ? 30 : 5,
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
  for (const key of ["SessionStart", "PreToolUse", "PreCompact", "PostCompact"] as const) {
    if (!(key in hooks)) continue;
    const filtered = Array.isArray(hooks[key])
      ? (hooks[key] as unknown[]).filter((e) => {
          const group = object(e);
          if (group === null || !Array.isArray(group.hooks)) return true;
          return !group.hooks.some((h) => {
            const hook = object(h);
            return (
              typeof hook?.command === "string" &&
              isManagedHookCommand(hook.command) &&
              hook.command.includes(`--host ${host}`)
            );
          });
        })
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

function mergeNestedHost(
  existing: Record<string, unknown>,
  host: string,
  options: { compact: boolean },
): Record<string, unknown> {
  const hooks = object(existing.hooks) ?? {};
  const session = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart.filter((e) => !nestedManagedGroup(e))
    : [];
  const preTool = Array.isArray(hooks.PreToolUse)
    ? hooks.PreToolUse.filter((e) => !nestedManagedGroup(e))
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
      ? hooks.PreCompact.filter((e) => !nestedManagedGroup(e))
      : [];
    const postCompact = Array.isArray(hooks.PostCompact)
      ? hooks.PostCompact.filter((e) => !nestedManagedGroup(e))
      : [];
    nextHooks.PreCompact = [...preCompact, nestedGroup(host, "session.compact")];
    nextHooks.PostCompact = [...postCompact, nestedGroup(host, "session.compact")];
  }
  return { ...existing, hooks: nextHooks };
}

function mergeCursorHost(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks = object(existing.hooks) ?? {};
  const keep = (key: string) =>
    Array.isArray(hooks[key]) ? (hooks[key] as unknown[]).filter((e) => !cursorManagedEntry(e)) : [];
  return {
    ...existing,
    version: 1,
    hooks: {
      ...hooks,
      sessionStart: [
        ...keep("sessionStart"),
        { command: hookCommand("cursor", "session.start"), timeout: 5 },
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
        { command: hookCommand("cursor", "session.compact"), timeout: 5 },
      ],
      beforeSubmitPrompt: [
        ...keep("beforeSubmitPrompt"),
        { command: hookCommand("cursor", "prompt.submit"), timeout: 5 },
      ],
      afterAgentResponse: [
        ...keep("afterAgentResponse"),
        { command: hookCommand("cursor", "agent.response"), timeout: 5 },
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
    merge: (cfg) => mergeNestedHost(cfg, "claude", { compact: true }),
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
} {
  const created: string[] = [];
  const modified: string[] = [];

  for (const spec of HOST_HOOK_SPECS) {
    const abs = join(projectRoot, spec.rel);
    const prior = readText(abs);
    const enabled = isHostHookDepositEnabled(spec.host, hostHooksPolicy);
    if (!enabled) {
      // Disabled host: strip managed entries only; do not create the file.
      if (prior === null) continue;
      const stripped = spec.strip(readJsonObject(abs));
      const next = `${JSON.stringify(stripped, null, 2)}\n`;
      if (prior === next) continue;
      writeContained(projectRoot, spec.rel, next);
      modified.push(spec.rel);
      continue;
    }
    const base = prior === null ? {} : readJsonObject(abs);
    const merged = spec.merge(base);
    const next = `${JSON.stringify(merged, null, 2)}\n`;
    if (prior === next) continue;
    writeContained(projectRoot, spec.rel, next);
    if (prior === null) created.push(spec.rel);
    else modified.push(spec.rel);
  }
  return { created, modified };
}

const GITHOOK_HELPER = `#!/usr/bin/env sh
# Package-relative Directive git-hook helper (AC9.9).
# Sourced by pre-commit/pre-push; defines run_directive.
if [ -z "\${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$REPO_ROOT" ]; then
  echo "directive hooks: unable to resolve repo root." >&2
  exit 1
fi
RUNTIME_BIN="$REPO_ROOT/${RUNTIME_BIN_REL}"
if [ ! -f "$RUNTIME_BIN" ]; then
  echo "directive hooks: missing $RUNTIME_BIN" >&2
  echo "Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}" >&2
  exit 1
fi
run_directive() {
  # #3039 / #5543: root local kill-switch — skip CLI spawn when flag is present,
  # not a symlink, and not tracked by git (tracked flag must not disable clones).
  _kill="$REPO_ROOT/.deft-directive-disable"
  if [ -f "$_kill" ] && [ ! -L "$_kill" ]; then
    if ! git -C "$REPO_ROOT" ls-files --error-unmatch -- .deft-directive-disable >/dev/null 2>&1; then
      echo "Directive is DISABLED for this project via root .deft-directive-disable (test/local kill-switch)." >&2
      echo "Git hooks skipping Directive CLI spawn (#5543 / #3039). Deposit may remain." >&2
      echo "Recovery: rm .deft-directive-disable && start a new agent session." >&2
      return 0
    fi
  fi
  node "$RUNTIME_BIN" "$@"
}
`;

const PRE_COMMIT = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive verify:encoding --staged --project-root "$REPO_ROOT" || exit $?
`;

const PRE_PUSH = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
# shellcheck source=/dev/null
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive verify:branch --project-root "$REPO_ROOT" || exit $?
`;

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

/** AC8.6 / AC2.5 / F-008 — disclosed when hooks files exist but core.hooksPath cannot activate. */
export const GIT_HOOKS_INACTIVE_NO_GIT =
  "Git hooks inactive until git init + eligible repair/self-complete (core.hooksPath not set)";

export function ensureGitHooks(projectRoot: string): {
  created: string[];
  modified: string[];
  conflicts: string[];
  /** True only when core.hooksPath is relative .githooks (AC9.9). */
  hooksPathActive: boolean;
  /** Human disclosure when hooks are not live; null when active. */
  inactiveDisclosure: string | null;
} {
  const created: string[] = [];
  const modified: string[] = [];
  const conflicts: string[] = [];
  const files: Array<{ rel: string; body: string }> = [
    { rel: ".githooks/_directive-run.sh", body: GITHOOK_HELPER },
    { rel: ".githooks/pre-commit", body: PRE_COMMIT },
    { rel: ".githooks/pre-push", body: PRE_PUSH },
  ];
  for (const file of files) {
    const next = file.body.endsWith("\n") ? file.body : `${file.body}\n`;
    const prior = readText(join(projectRoot, file.rel));
    if (prior !== null && prior !== next && !isOurGitHookBody(file.rel, prior)) {
      conflicts.push(
        `${file.rel}: existing hook is not Directive-managed; refusing to overwrite (chain or remove manually)`,
      );
      continue;
    }
    const change = trackChange(projectRoot, file.rel, next);
    if (change.created) created.push(file.rel);
    else if (change.modified) modified.push(file.rel);
    if (EXECUTABLE_GITHOOKS.has(file.rel) && existsSync(join(projectRoot, file.rel))) {
      try {
        containedChmod({ root: projectRoot, target: file.rel, mode: 0o755 });
      } catch {
        /* best-effort on platforms without chmod */
      }
    }
  }

  // Drop obsolete latest-legacy helper once OVPR hooks are in place (wave4e).
  // Greptile: keep helper if any other .githooks file still sources it.
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
        try {
          const rem = containedRemove({ root: projectRoot, target: legacyHelperRel });
          if (rem.removed) modified.push(legacyHelperRel);
        } catch {
          /* best-effort; conflicts already captured for other files */
        }
      }
    }
  }

  let hooksPathActive = false;
  let inactiveDisclosure: string | null = null;

  // Activate relative hooksPath only when unset or already .githooks (AC9.9 / Greptile P1).
  if (!existsSync(join(projectRoot, ".git"))) {
    inactiveDisclosure = GIT_HOOKS_INACTIVE_NO_GIT;
  } else {
    let current: string | null = null;
    try {
      current = execFileSync("git", ["-C", projectRoot, "config", "--get", "core.hooksPath"], {
        encoding: "utf8",
      }).trim();
    } catch {
      current = null;
    }
    if (current === null || current === "") {
      try {
        execFileSync("git", ["-C", projectRoot, "config", "core.hooksPath", ".githooks"]);
        hooksPathActive = true;
      } catch {
        inactiveDisclosure =
          "Git hooks inactive: could not set core.hooksPath=.githooks";
      }
    } else if (current === ".githooks" || current === ".githooks/") {
      hooksPathActive = true;
    } else {
      conflicts.push(
        `core.hooksPath is '${current}' (not .githooks); refusing to redirect and disable existing checks`,
      );
      inactiveDisclosure = `Git hooks inactive: core.hooksPath is '${current}' (not .githooks)`;
    }
  }
  return { created, modified, conflicts, hooksPathActive, inactiveDisclosure };
}

const MINIMAL_TASKFILE = `version: '3'

# Installed by Directive setup (Wave 2c). Framework tasks under deft:.
includes:
  deft:
    ${RUNTIME_TASKFILE_INCLUDE}
    optional: true
`;

const DEFT_INCLUDE_BLOCK =
  `  deft:\n` +
  `    taskfile: ./${RUNTIME_PREFIX}Taskfile.yml\n` +
  `    optional: true\n`;

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
    const next =
      existing.slice(0, insertAt) + DEFT_INCLUDE_BLOCK + existing.slice(insertAt);
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
