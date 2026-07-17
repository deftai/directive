import { relative, resolve, sep } from "node:path";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { runSessionStartHookWrite } from "../session/session-start-hook.js";
import { inspectSessionRitual, type VerifyResult } from "../session/verify-session-ritual.js";
import { type ActiveScopeInspection, inspectActiveScope } from "./scope.js";
import { isDirectWriteTool } from "./tools.js";

export { DIRECT_WRITE_TOOL_NAMES, isDirectWriteTool } from "./tools.js";

export const HOOK_HOSTS = ["claude", "grok", "cursor", "codex"] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

export const HOOK_EVENTS = ["session.start", "tool.before"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookVerdict = "allow" | "deny";
export type HookDecisionCode =
  | "session-start"
  | "session-start-degraded"
  | "not-direct-write"
  | "invalid-input"
  | "ritual-not-ready"
  | "scope-not-ready"
  | "write-propose-ready"
  | "write-ready";

export interface HookDecision {
  readonly verdict: HookVerdict;
  readonly code: HookDecisionCode;
  readonly event: HookEvent;
  readonly host: HookHost;
  readonly toolName: string | null;
  readonly projectRoot: string;
  readonly message: string;
  readonly scopePath: string | null;
}

export interface HookDispatchInput {
  readonly host: HookHost;
  readonly event: HookEvent;
  readonly projectRoot: string;
  readonly payload: unknown;
}

export interface HookPolicySeams {
  readonly inspectRitual?: (projectRoot: string) => VerifyResult;
  readonly inspectScope?: (projectRoot: string) => ActiveScopeInspection;
  readonly sessionStart?: (projectRoot: string) => { code: number; stdout: string; stderr: string };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function hookToolName(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  return firstString(input.tool_name, input.toolName, input.tool);
}

/**
 * Best-effort write-target path from host PreToolUse payloads (#2625).
 * Hosts disagree on nesting (`tool_input.file_path` vs top-level `path`).
 */
export function hookWriteTargetPath(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = record(input.tool_input) ?? record(input.toolInput) ?? record(input.input);
  return firstString(
    toolInput?.file_path,
    toolInput?.filePath,
    toolInput?.path,
    input.file_path,
    input.filePath,
    input.path,
  );
}

/** POSIX-ish project-relative path for lifecycle matching. */
export function toProjectRelativePosix(projectRoot: string, targetPath: string): string {
  const abs = resolve(projectRoot, targetPath);
  const rel = relative(resolve(projectRoot), abs);
  return rel.split(sep).join("/");
}

/**
 * Proposing a scope under xbrief/proposed/ (or legacy vbrief/proposed/) is
 * planning, not implementation dispatch — exempt from the active-scope gate (#2625).
 */
export function isProposedLifecycleWrite(projectRoot: string, targetPath: string | null): boolean {
  if (targetPath === null || targetPath.trim().length === 0) return false;
  const posix = toProjectRelativePosix(projectRoot, targetPath);
  // resolve()+relative() collapses mid-path `..`; only outside-root `..` remains.
  if (posix.startsWith("..")) return false;
  const base = posix.includes("/") ? posix.slice(posix.lastIndexOf("/") + 1) : posix;
  if (!hasArtifactSuffix(base)) return false;
  return posix.startsWith("xbrief/proposed/") || posix.startsWith("vbrief/proposed/");
}

export function projectRootFromHookPayload(payload: unknown, fallback: string): string {
  const input = record(payload);
  if (input === null) return resolve(fallback);
  const workspaceRoots = input.workspace_roots;
  const root = firstString(
    input.workspaceRoot,
    input.workspace_root,
    Array.isArray(workspaceRoots) ? workspaceRoots[0] : null,
    input.cwd,
    fallback,
  );
  return resolve(root ?? fallback);
}

export function isHookHost(value: string): value is HookHost {
  return (HOOK_HOSTS as readonly string[]).includes(value);
}

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function deny(
  input: HookDispatchInput,
  code: HookDecisionCode,
  toolName: string | null,
  message: string,
): HookDecision {
  return {
    verdict: "deny",
    code,
    event: input.event,
    host: input.host,
    toolName,
    projectRoot: resolve(input.projectRoot),
    message,
    scopePath: null,
  };
}

/** Decide a normalized event using only the P0 direct-write policy. */
export function decideHook(input: HookDispatchInput, seams: HookPolicySeams = {}): HookDecision {
  const projectRoot = resolve(input.projectRoot);
  if (input.event === "session.start") {
    try {
      const result = (seams.sessionStart ?? runSessionStartHookWrite)(projectRoot);
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim().replace(/\s+/g, " ").slice(0, 400);
        return {
          verdict: "allow",
          code: "session-start-degraded",
          event: input.event,
          host: input.host,
          toolName: null,
          projectRoot,
          message:
            `Directive SessionStart bookkeeping reported exit ${result.code} on its non-blocking path` +
            `${detail.length > 0 ? `: ${detail}` : "."}`,
          scopePath: null,
        };
      }
    } catch (cause) {
      return {
        verdict: "allow",
        code: "session-start-degraded",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message: `Directive SessionStart bookkeeping failed on its non-blocking path: ${String(cause)}`,
        scopePath: null,
      };
    }
    return {
      verdict: "allow",
      code: "session-start",
      event: input.event,
      host: input.host,
      toolName: null,
      projectRoot,
      message: "SessionStart bookkeeping completed on a non-blocking path.",
      scopePath: null,
    };
  }

  const toolName = hookToolName(input.payload);
  if (toolName === null) {
    return deny(
      input,
      "invalid-input",
      null,
      "Directive denied this matched write event because the host payload omitted its tool name.",
    );
  }
  if (!isDirectWriteTool(toolName)) {
    return {
      verdict: "allow",
      code: "not-direct-write",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message: `${toolName} is outside the P0 direct-write enforcement slice.`,
      scopePath: null,
    };
  }

  let ritual: VerifyResult;
  try {
    ritual = (
      seams.inspectRitual ??
      ((root) => inspectSessionRitual(root, { tier: "gated", posture: "mutation" }))
    )(projectRoot);
  } catch (cause) {
    return deny(
      input,
      "ritual-not-ready",
      toolName,
      `Directive could not inspect the gated session ritual: ${String(cause)}. ` +
        "Run `deft session:start`, then `deft verify:session-ritual -- --tier=gated`.",
    );
  }
  if (ritual.code !== 0) {
    return deny(
      input,
      "ritual-not-ready",
      toolName,
      `Directive denied ${toolName}: ${ritual.message} ` +
        "Recovery: run `deft session:start`, then " +
        "`deft verify:session-ritual -- --tier=gated`.",
    );
  }

  const writeTarget = hookWriteTargetPath(input.payload);
  if (isProposedLifecycleWrite(projectRoot, writeTarget)) {
    return {
      verdict: "allow",
      code: "write-propose-ready",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message:
        `Directive write gate allowed ${toolName} for a proposed lifecycle xBRIEF ` +
        "(planning write; active scope not required).",
      scopePath: null,
    };
  }

  let scope: ActiveScopeInspection;
  try {
    scope = (seams.inspectScope ?? inspectActiveScope)(projectRoot);
  } catch (cause) {
    scope = { ready: false, path: null, message: String(cause) };
  }
  if (!scope.ready) {
    const relTarget =
      writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
    const proposedPathHint =
      relTarget !== null &&
      (relTarget.startsWith("xbrief/proposed/") || relTarget.startsWith("vbrief/proposed/"))
        ? " For a new proposal under xbrief/proposed/, include a lifecycle artifact " +
          "filename (*.xbrief.json) in the Write/Edit payload so the gate can exempt " +
          "planning writes (#2625)."
        : " Recovery: run `deft scope:activate -- <path>` for the approved xBRIEF, " +
          "or Write a new proposal to xbrief/proposed/*.xbrief.json (planning exemption).";
    return deny(
      input,
      "scope-not-ready",
      toolName,
      `Directive denied ${toolName}: ${scope.message}${proposedPathHint}`,
    );
  }

  return {
    verdict: "allow",
    code: "write-ready",
    event: input.event,
    host: input.host,
    toolName,
    projectRoot,
    message: `Directive write gate passed for ${toolName}.`,
    scopePath: scope.path,
  };
}

/** Render only authoritative denials; allow preserves the host's own permission flow. */
export function renderHostDecision(host: HookHost, decision: HookDecision): string {
  if (decision.verdict === "allow") return "";
  switch (host) {
    case "claude":
    case "codex":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.message,
        },
      });
    case "grok":
      return JSON.stringify({ decision: "deny", reason: decision.message });
    case "cursor":
      return JSON.stringify({
        permission: "deny",
        user_message: decision.message,
        agent_message: decision.message,
      });
  }
}
