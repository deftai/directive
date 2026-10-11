/**
 * Package-relative wiring writers for Contract 1 setup (Wave 2c / R9 / AC13.1).
 * All managed pointers target node_modules/@deftai/directive-runtime/ — never .deft/core.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  containedChmod,
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
import {
  isHostHookDepositEnabled,
  loadHostHooksPolicyFromProject,
  type HostHooksPolicy,
} from "@deftai/directive-core/dist/policy/host-hooks.js";
import type { HookHost } from "@deftai/directive-core/dist/hooks/dispatcher.js";

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

/** Thin skill pointer inventory (AC9.6) — no versions; package-relative only. */
export const SKILL_POINTER_INVENTORY: ReadonlyArray<{ dir: string; body: string }> = [
  {
    dir: "deft",
    body: `---
name: deft
description: Apply Directive framework standards for AI-assisted development.
---

Read and follow: ${RUNTIME_PREFIX}SKILL.md

Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}
`,
  },
  {
    dir: "deft-directive-setup",
    body: `---
name: deft-directive-setup
description: Set up a new project with Directive framework standards.
---

Read and follow: ${RUNTIME_PREFIX}skills/deft-directive-setup/SKILL.md

Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}
`,
  },
  {
    dir: "deft-directive-build",
    body: `---
name: deft-directive-build
description: Build a project from scope vBRIEFs following Directive standards.
---

Read and follow: ${RUNTIME_PREFIX}skills/deft-directive-build/SKILL.md

Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}
`,
  },
  {
    dir: "deft-directive-swarm",
    body: `---
name: deft-directive-swarm
description: Parallel local agent orchestration with isolated worktrees.
---

Read and follow: ${RUNTIME_PREFIX}skills/deft-directive-swarm/SKILL.md

Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}
`,
  },
  {
    dir: "deft-directive-sync",
    body: `---
name: deft-directive-sync
description: Session-start framework sync and alignment check.
---

Read and follow: ${RUNTIME_PREFIX}skills/deft-directive-sync/SKILL.md

Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}
`,
  },
];

/** Host discovery mirrors for the same thin pointers (AC8.1). */
const SKILL_HOST_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".github/skills",
] as const;

export function ensureAgentsManagedSection(projectRoot: string): TrackResult & {
  conflict: boolean;
  conflictReason?: string;
} {
  const rel = "AGENTS.md";
  const section = [
    `${MANAGED_SECTION_OPEN_PREFIX} v3 -->`,
    `Full guidelines: ${RUNTIME_MAIN_MD}`,
    `Skills: ${RUNTIME_PREFIX}skills/`,
    `Hooks: ${HOOK_BIN_COMMAND} --host <host> --event <event>`,
    `Recovery: ${INSTALLATION_RECOVERY_GUIDANCE}`,
    MANAGED_SECTION_CLOSE,
    "",
  ].join("\n");

  const existing = readText(join(projectRoot, rel));
  if (existing === null) {
    writeContained(projectRoot, rel, `${section}\n`);
    return { created: true, modified: false, conflict: false };
  }

  const start = existing.indexOf(MANAGED_SECTION_OPEN_PREFIX);
  if (start < 0) {
    const suffix = existing.endsWith("\n") ? "" : "\n";
    writeContained(projectRoot, rel, `${existing}${suffix}\n${section}\n`);
    return { created: false, modified: true, conflict: false };
  }
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
  const closeEnd = end + MANAGED_SECTION_CLOSE.length;
  const current = existing.slice(start, closeEnd);
  if (
    current.includes(RUNTIME_MAIN_MD) &&
    current.includes(INSTALLATION_RECOVERY_GUIDANCE) &&
    !current.includes(".deft/core/")
  ) {
    return { created: false, modified: false, conflict: false };
  }
  const next = existing.slice(0, start) + section.trimEnd() + existing.slice(closeEnd);
  writeContained(projectRoot, rel, next.endsWith("\n") ? next : `${next}\n`);
  return { created: false, modified: true, conflict: false };
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

function isOurGitHookBody(rel: string, body: string): boolean {
  if (rel.endsWith("_directive-run.sh")) {
    return body.includes(RUNTIME_BIN_REL) || body.includes("run_directive");
  }
  return body.includes("_directive-run.sh");
}

const EXECUTABLE_GITHOOKS = new Set([".githooks/pre-commit", ".githooks/pre-push"]);

export function ensureGitHooks(projectRoot: string): {
  created: string[];
  modified: string[];
  conflicts: string[];
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

  // Activate relative hooksPath only when unset or already .githooks (AC9.9 / Greptile P1).
  if (existsSync(join(projectRoot, ".git"))) {
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
      } catch {
        /* non-fatal outside a real git repo */
      }
    } else if (current !== ".githooks" && current !== ".githooks/") {
      conflicts.push(
        `core.hooksPath is '${current}' (not .githooks); refusing to redirect and disable existing checks`,
      );
    }
  }
  return { created, modified, conflicts };
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
