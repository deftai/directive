import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertDepositContained } from "../deposit/contain.js";
import { containedRemove, containedRename, containedWrite } from "../fs/contained-write.js";
import type { HookEvent, HookHost } from "../hooks/dispatcher.js";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "../hooks/tools.js";
import {
  type HostHooksPolicy,
  isHostHookDepositEnabled,
  loadHostHooksPolicyFromProject,
} from "../policy/host-hooks.js";
import type { InitDepositIo } from "./constants.js";
import { type HookRuntimeTravelSeams, inspectHookRuntimeTravel } from "./hook-runtime-travel.js";

export {
  DIRECT_WRITE_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  SHELL_HOOK_MATCHER,
  SPAWN_HOOK_MATCHER,
} from "../hooks/tools.js";
export const DEFT_HOOK_COMMAND_MARKER = "deft-hook";
export const LEGACY_DEFT_HOOK_COMMAND_MARKER = "deft hook:dispatch";
export const AGENT_HOOK_PATHS = [
  ".claude/settings.json",
  ".grok/hooks/deft.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
] as const;

/**
 * Cursor session.start / session.compact deposit timeout (seconds).
 * Lightweight ceremony paths — keep tight so stalled hooks fail fast.
 */
export const CURSOR_SESSION_HOOK_TIMEOUT_SECONDS = 5;

/**
 * Cursor preToolUse (tool.before) deposit timeout (seconds).
 *
 * Mutation tool.before runs `inspectMutationGates` → gated
 * `verifySessionRitual`, which re-runs non-cacheable agent-hook readiness on
 * every boundary. Live readiness alone has a multi-host fixture ceiling of
 * ~24s (`content/contracts/agent-hook-readiness.md`); the historical deposit
 * default of 5s was below that budget. Under Cursor `failClosed: true`, a
 * host timeout kill surfaces as opaque exit-1 with no Directive decision
 * code (#3246 / related #2864). Keep this above the readiness ceiling plus
 * dispatch overhead so allow/deny can render within the host budget.
 */
export const CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS = 30;

/** Nested Claude/Grok/Codex command-hook default timeout (seconds). */
export const NESTED_HOOK_TIMEOUT_SECONDS = 5;

export type AgentHookPath = (typeof AGENT_HOOK_PATHS)[number];
export type AgentHookRegistrationStatus = "healthy" | "disabled" | "missing" | "drifted";

/** Whether the host receives a compact/resume hook deposit (#2113). */
export type AgentHookCompactSupport = "deposited" | "unsupported";

export interface AgentHookInspection {
  readonly host: HookHost;
  readonly path: AgentHookPath;
  readonly status: AgentHookRegistrationStatus;
  readonly detail: string;
  readonly compactSupport: AgentHookCompactSupport;
}

export interface AgentHookDepositResult {
  readonly changed: boolean;
  readonly changedPaths: AgentHookPath[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function command(host: HookHost, event: HookEvent): string {
  return `${DEFT_HOOK_COMMAND_MARKER} --host ${host} --event ${event}`;
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error(
      `${path} is not valid JSON; refusing to overwrite user configuration: ${cause}`,
    );
  }
  const config = object(parsed);
  if (config === null) {
    throw new Error(
      `${path} must contain a JSON object; refusing to overwrite user configuration.`,
    );
  }
  return config;
}

function hooksObject(config: Record<string, unknown>, path: string): Record<string, unknown> {
  if (config.hooks === undefined) return {};
  const hooks = object(config.hooks);
  if (hooks === null) throw new Error(`${path}: hooks must be a JSON object.`);
  return { ...hooks };
}

function eventArray(hooks: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = hooks[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: hooks.${key} must be an array.`);
  return [...value];
}

function nestedCommands(value: unknown): string[] {
  const group = object(value);
  if (group === null || !Array.isArray(group.hooks)) return [];
  return group.hooks.flatMap((candidate) => {
    const hook = object(candidate);
    return typeof hook?.command === "string" ? [hook.command] : [];
  });
}

function isManagedNestedGroup(value: unknown): boolean {
  return nestedCommands(value).some(
    (command) =>
      command.includes(DEFT_HOOK_COMMAND_MARKER) ||
      command.includes(LEGACY_DEFT_HOOK_COMMAND_MARKER),
  );
}

function isManagedNestedGroupForHost(value: unknown, host: NestedHookHost): boolean {
  return nestedCommands(value).some(
    (command) =>
      (command.includes(DEFT_HOOK_COMMAND_MARKER) ||
        command.includes(LEGACY_DEFT_HOOK_COMMAND_MARKER)) &&
      command.includes(`--host ${host}`),
  );
}

function isManagedCursorEntry(value: unknown): boolean {
  const entry = object(value);
  if (typeof entry?.command !== "string") return false;
  return (
    entry.command.includes(DEFT_HOOK_COMMAND_MARKER) ||
    entry.command.includes(LEGACY_DEFT_HOOK_COMMAND_MARKER) ||
    entry.command.includes("deft-cursor-hook-adapter.mjs")
  );
}

function isManagedCursorEntryForHost(value: unknown): boolean {
  return isManagedCursorEntry(value);
}

type NestedHookHost = "claude" | "grok" | "codex";

function nestedGroup(host: NestedHookHost, event: HookEvent, matcher?: string) {
  return {
    ...(event === "tool.before" && matcher !== undefined ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: command(host, event),
        timeout: NESTED_HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

function mergeNestedConfig(
  config: Record<string, unknown>,
  path: string,
  host: NestedHookHost,
  options: { compact?: boolean } = {},
): Record<string, unknown> {
  const hooks = hooksObject(config, path);
  const session = eventArray(hooks, "SessionStart", path).filter(
    (entry) => !isManagedNestedGroup(entry),
  );
  const preTool = eventArray(hooks, "PreToolUse", path).filter(
    (entry) => !isManagedNestedGroup(entry),
  );
  hooks.SessionStart = [...session, nestedGroup(host, "session.start")];
  hooks.PreToolUse = [
    ...preTool,
    nestedGroup(host, "tool.before", DIRECT_WRITE_HOOK_MATCHER),
    nestedGroup(host, "tool.before", SPAWN_HOOK_MATCHER),
    // Shell/Bash for runtimeAuthority scopes.push / scopes.merge (#2711)
    nestedGroup(host, "tool.before", SHELL_HOOK_MATCHER),
    // MCP push/merge (mcp__*, bare merge_pull_request / git_push, …) (#2711)
    nestedGroup(host, "tool.before", MCP_HOOK_MATCHER),
  ];
  if (options.compact) {
    const preCompact = eventArray(hooks, "PreCompact", path).filter(
      (entry) => !isManagedNestedGroup(entry),
    );
    const postCompact = eventArray(hooks, "PostCompact", path).filter(
      (entry) => !isManagedNestedGroup(entry),
    );
    hooks.PreCompact = [...preCompact, nestedGroup(host, "session.compact")];
    hooks.PostCompact = [...postCompact, nestedGroup(host, "session.compact")];
  }
  return { ...config, hooks };
}

function stripManagedNestedConfig(
  config: Record<string, unknown>,
  path: string,
  host: NestedHookHost,
): Record<string, unknown> {
  const hooks = hooksObject(config, path);
  const nextHooks: Record<string, unknown> = {};
  for (const key of ["SessionStart", "PreToolUse", "PreCompact", "PostCompact"] as const) {
    if (!(key in hooks)) continue;
    const filtered = eventArray(hooks, key, path).filter(
      (entry) => !isManagedNestedGroupForHost(entry, host),
    );
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _hooks, ...rest } = config;
    return rest;
  }
  return { ...config, hooks: nextHooks };
}

function stripManagedCursorConfig(
  config: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const hooks = hooksObject(config, path);
  const nextHooks: Record<string, unknown> = {};
  for (const key of ["sessionStart", "preToolUse", "preCompact"] as const) {
    if (!(key in hooks)) continue;
    const filtered = eventArray(hooks, key, path).filter(
      (entry) => !isManagedCursorEntryForHost(entry),
    );
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _hooks, version: _version, ...rest } = config;
    return rest;
  }
  return { ...config, version: 1, hooks: nextHooks };
}

function mergeCursorConfig(config: Record<string, unknown>, path: string): Record<string, unknown> {
  const hooks = hooksObject(config, path);
  const session = eventArray(hooks, "sessionStart", path).filter(
    (entry) => !isManagedCursorEntry(entry),
  );
  const preTool = eventArray(hooks, "preToolUse", path).filter(
    (entry) => !isManagedCursorEntry(entry),
  );
  const preCompact = eventArray(hooks, "preCompact", path).filter(
    (entry) => !isManagedCursorEntry(entry),
  );
  hooks.sessionStart = [
    ...session,
    {
      command: command("cursor", "session.start"),
      timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
    },
  ];
  hooks.preToolUse = [
    ...preTool,
    {
      command: command("cursor", "tool.before"),
      matcher: DIRECT_WRITE_HOOK_MATCHER,
      failClosed: true,
      timeout: CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
    },
    {
      command: command("cursor", "tool.before"),
      matcher: SPAWN_HOOK_MATCHER,
      failClosed: true,
      timeout: CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
    },
    {
      command: command("cursor", "tool.before"),
      matcher: SHELL_HOOK_MATCHER,
      failClosed: true,
      timeout: CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
    },
    {
      command: command("cursor", "tool.before"),
      matcher: MCP_HOOK_MATCHER,
      failClosed: true,
      timeout: CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS,
    },
  ];
  hooks.preCompact = [
    ...preCompact,
    {
      command: command("cursor", "session.compact"),
      timeout: CURSOR_SESSION_HOOK_TIMEOUT_SECONDS,
    },
  ];
  return { ...config, version: 1, hooks };
}

function writeJsonIfChanged(
  projectRoot: string,
  path: string,
  payload: Record<string, unknown>,
  kind: "wrote" | "stripped",
): boolean {
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === next) return false;
  // Atomic replace via temp under project root (#2951 / #2980 wave A).
  const parent = dirname(path);
  const tmpName = `${basename(path)}.deft-${process.pid}.tmp`;
  const temporary = join(parent, tmpName);
  try {
    containedWrite({
      root: resolve(projectRoot),
      target: temporary,
      data: next,
      mode: "replace",
      mutation: { kind, path },
    });
    containedRename({
      root: resolve(projectRoot),
      from: temporary,
      to: path,
      mutation: false,
    });
  } catch (err) {
    try {
      containedRemove({ root: resolve(projectRoot), target: temporary, mutation: false });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return true;
}

/** Merge Directive-owned project hook entries without replacing user configuration. */
export function writeAgentHookDeposit(
  projectRoot: string,
  io: InitDepositIo = { printf: () => undefined },
  hostHooksPolicy: HostHooksPolicy = loadHostHooksPolicyFromProject(projectRoot),
  travelSeams: HookRuntimeTravelSeams = {},
): AgentHookDepositResult {
  const changedPaths: AgentHookPath[] = [];
  const strippedPaths: AgentHookPath[] = [];
  const definitions: Array<{
    host: HookHost;
    path: AgentHookPath;
    merge: (config: Record<string, unknown>, path: string) => Record<string, unknown>;
    strip: (config: Record<string, unknown>, path: string) => Record<string, unknown>;
  }> = [
    {
      host: "claude",
      path: AGENT_HOOK_PATHS[0],
      merge: (config, path) => mergeNestedConfig(config, path, "claude", { compact: true }),
      strip: (config, path) => stripManagedNestedConfig(config, path, "claude"),
    },
    {
      host: "grok",
      path: AGENT_HOOK_PATHS[1],
      merge: (config, path) => mergeNestedConfig(config, path, "grok", { compact: true }),
      strip: (config, path) => stripManagedNestedConfig(config, path, "grok"),
    },
    {
      host: "cursor",
      path: AGENT_HOOK_PATHS[2],
      merge: mergeCursorConfig,
      strip: stripManagedCursorConfig,
    },
    {
      host: "codex",
      path: AGENT_HOOK_PATHS[3],
      merge: (config, path) => mergeNestedConfig(config, path, "codex", { compact: false }),
      strip: (config, path) => stripManagedNestedConfig(config, path, "codex"),
    },
  ];

  type PreparedWrite =
    | { mode: "skip" }
    | {
        mode: "merge" | "strip";
        absolute: string;
        path: AgentHookPath;
        payload: Record<string, unknown>;
      };

  const prepared: PreparedWrite[] = definitions.map((definition) => {
    const absolute = join(projectRoot, definition.path);
    assertDepositContained(projectRoot, absolute);
    if (!isHostHookDepositEnabled(definition.host, hostHooksPolicy)) {
      if (!existsSync(absolute)) return { mode: "skip" };
      return {
        mode: "strip",
        absolute,
        path: definition.path,
        payload: definition.strip(readConfig(absolute), absolute),
      };
    }
    return {
      mode: "merge",
      absolute,
      path: definition.path,
      payload: definition.merge(readConfig(absolute), absolute),
    };
  });

  for (const item of prepared) {
    if (item.mode === "skip") continue;
    if (
      writeJsonIfChanged(
        projectRoot,
        item.absolute,
        item.payload,
        item.mode === "strip" ? "stripped" : "wrote",
      )
    ) {
      if (item.mode === "strip") strippedPaths.push(item.path);
      else changedPaths.push(item.path);
    }
  }

  const legacyAdapterPaths = [
    ".cursor/hooks/deft-cursor-hook-adapter.mjs",
    ".cursor/hooks/deft-cursor-hook-adapter.test.mjs",
  ] as const;
  let adaptersRemoved = 0;
  for (const relative of legacyAdapterPaths) {
    const absolute = join(projectRoot, relative);
    assertDepositContained(projectRoot, absolute);
    if (containedRemove({ root: projectRoot, target: absolute }).removed) {
      adaptersRemoved += 1;
    }
  }

  if (changedPaths.length > 0) {
    io.printf(`Installed Directive agent hooks: ${changedPaths.join(", ")}\n`);
  }
  if (strippedPaths.length > 0) {
    io.printf(
      `Removed Directive-managed agent hooks (plan.policy.hostHooks opt-out): ${strippedPaths.join(", ")}\n`,
    );
  }
  if (changedPaths.length === 0 && strippedPaths.length === 0 && adaptersRemoved === 0) {
    io.printf("Directive agent hooks already current.\n");
  }
  // #3785: the registration is trackable and the deposit that implements it is
  // born-ignored, so warn when a clone would inherit the fence without a way to
  // obtain the runtime it names.
  const travel = inspectHookRuntimeTravel(
    projectRoot,
    definitions.map((definition) => ({ host: definition.host, path: definition.path })),
    hostHooksPolicy,
    travelSeams,
  );
  if (travel.warning !== null) io.printf(`${travel.warning}\n`);
  return {
    changed: changedPaths.length + strippedPaths.length + adaptersRemoved > 0,
    changedPaths: [...changedPaths, ...strippedPaths],
  };
}

function hasNestedRegistration(
  config: Record<string, unknown>,
  host: NestedHookHost,
  options: { compact?: boolean } = {},
): boolean {
  const hooks = object(config.hooks);
  if (hooks === null) return false;
  const session = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const preTool = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const sessionCommand = command(host, "session.start");
  const toolCommand = command(host, "tool.before");
  const compactCommand = command(host, "session.compact");
  const base =
    session.some((entry) => {
      const group = object(entry);
      return group?.matcher === undefined && nestedCommands(entry).includes(sessionCommand);
    }) &&
    preTool.some((entry) => {
      const group = object(entry);
      return (
        group?.matcher === DIRECT_WRITE_HOOK_MATCHER && nestedCommands(entry).includes(toolCommand)
      );
    }) &&
    preTool.some((entry) => {
      const group = object(entry);
      return group?.matcher === SPAWN_HOOK_MATCHER && nestedCommands(entry).includes(toolCommand);
    }) &&
    preTool.some((entry) => {
      const group = object(entry);
      return group?.matcher === SHELL_HOOK_MATCHER && nestedCommands(entry).includes(toolCommand);
    }) &&
    preTool.some((entry) => {
      const group = object(entry);
      return group?.matcher === MCP_HOOK_MATCHER && nestedCommands(entry).includes(toolCommand);
    });
  if (!base) return false;
  if (!options.compact) return true;
  const preCompact = Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [];
  const postCompact = Array.isArray(hooks.PostCompact) ? hooks.PostCompact : [];
  return (
    preCompact.some((entry) => nestedCommands(entry).includes(compactCommand)) &&
    postCompact.some((entry) => nestedCommands(entry).includes(compactCommand))
  );
}

function isCursorToolBeforeEntry(value: unknown, matcher: string): boolean {
  const hook = object(value);
  return (
    hook?.command === command("cursor", "tool.before") &&
    hook.matcher === matcher &&
    hook.failClosed === true &&
    // #3246: budget must cover gated ritual + live agent-hook readiness.
    hook.timeout === CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS
  );
}

function hasCursorRegistration(config: Record<string, unknown>): boolean {
  const hooks = object(config.hooks);
  if (hooks === null || config.version !== 1) return false;
  const session = Array.isArray(hooks.sessionStart) ? hooks.sessionStart : [];
  const preTool = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
  const preCompact = Array.isArray(hooks.preCompact) ? hooks.preCompact : [];
  return (
    session.some((entry) => object(entry)?.command === command("cursor", "session.start")) &&
    preTool.some((entry) => isCursorToolBeforeEntry(entry, DIRECT_WRITE_HOOK_MATCHER)) &&
    preTool.some((entry) => isCursorToolBeforeEntry(entry, SPAWN_HOOK_MATCHER)) &&
    preTool.some((entry) => isCursorToolBeforeEntry(entry, SHELL_HOOK_MATCHER)) &&
    preTool.some((entry) => isCursorToolBeforeEntry(entry, MCP_HOOK_MATCHER)) &&
    preCompact.some((entry) => object(entry)?.command === command("cursor", "session.compact"))
  );
}

/** Read-only registration probe shared by verify and doctor. */
export function inspectAgentHookDeposit(
  projectRoot: string,
  hostHooksPolicy: HostHooksPolicy = loadHostHooksPolicyFromProject(projectRoot),
): AgentHookInspection[] {
  const definitions: Array<{
    host: HookHost;
    path: AgentHookPath;
    compactSupport: AgentHookCompactSupport;
    valid: (config: Record<string, unknown>) => boolean;
  }> = [
    {
      host: "claude",
      path: AGENT_HOOK_PATHS[0],
      compactSupport: "deposited",
      valid: (config) => hasNestedRegistration(config, "claude", { compact: true }),
    },
    {
      host: "grok",
      path: AGENT_HOOK_PATHS[1],
      compactSupport: "deposited",
      valid: (config) => hasNestedRegistration(config, "grok", { compact: true }),
    },
    {
      host: "cursor",
      path: AGENT_HOOK_PATHS[2],
      compactSupport: "deposited",
      valid: hasCursorRegistration,
    },
    {
      host: "codex",
      path: AGENT_HOOK_PATHS[3],
      compactSupport: "unsupported",
      valid: (config) => hasNestedRegistration(config, "codex", { compact: false }),
    },
  ];

  return definitions.map((definition) => {
    const absolute = join(projectRoot, definition.path);
    const compactNote =
      definition.compactSupport === "unsupported"
        ? " Compact re-arm is not deposited for Codex (no native compact hook surface)."
        : " PreCompact/PostCompact or preCompact compact re-arm is deposited.";
    if (!isHostHookDepositEnabled(definition.host, hostHooksPolicy)) {
      return {
        host: definition.host,
        path: definition.path,
        status: "disabled",
        compactSupport: definition.compactSupport,
        detail: `plan.policy.hostHooks.${definition.host} is false — Directive hook deposit is skipped for this host.`,
      };
    }
    if (!existsSync(absolute)) {
      return {
        host: definition.host,
        path: definition.path,
        status: "missing",
        compactSupport: definition.compactSupport,
        detail: `${definition.path} is missing.${compactNote}`,
      };
    }
    try {
      const config = readConfig(absolute);
      if (definition.valid(config)) {
        return {
          host: definition.host,
          path: definition.path,
          status: "healthy",
          compactSupport: definition.compactSupport,
          detail:
            "SessionStart, direct-write + spawn PreToolUse, and compact re-arm registrations are current." +
            (definition.compactSupport === "unsupported" ? compactNote : ""),
        };
      }
      return {
        host: definition.host,
        path: definition.path,
        status: "drifted",
        compactSupport: definition.compactSupport,
        detail:
          "Directive SessionStart, direct-write/spawn PreToolUse, or compact re-arm registration is missing/drifted." +
          compactNote,
      };
    } catch (cause) {
      return {
        host: definition.host,
        path: definition.path,
        status: "drifted",
        compactSupport: definition.compactSupport,
        detail: `${String(cause)}${compactNote}`,
      };
    }
  });
}
