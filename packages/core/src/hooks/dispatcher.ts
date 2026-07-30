import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type AuthzDecision,
  type AuthzState,
  appendAuthzAudit,
  classifyHookAuthzOps,
  evaluateAuthzMutation,
  type HumanOriginGrant,
  listActiveHumanGrants,
  loadAuthzState,
  utcIso,
} from "../authz/index.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import {
  detectNoDeftDirective,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
} from "../policy/no-deft-directive.js";
import {
  classifyMcpTool,
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityShellOp,
  listShellOps,
  loadRuntimeAuthorityFromProject,
  type RuntimeAuthorityPolicy,
  type RuntimeAuthorityShellOp,
} from "../policy/runtime-authority.js";
import { markRitualStaleAfterCompact } from "../session/ritual-sentinel.js";
import { runSessionStartHookWrite } from "../session/session-start-hook.js";
import { inspectSessionRitual, type VerifyResult } from "../session/verify-session-ritual.js";
import { isExploreSpawn, isReadOnlyHookContext } from "./readonly.js";
import { type ActiveScopeInspection, inspectActiveScope } from "./scope.js";
import { isDirectWriteTool, isMcpTool, isShellTool, isSpawnTool } from "./tools.js";

export { hookReadOnlyFromPayload, isExploreSpawn, isReadOnlyHookContext } from "./readonly.js";
export {
  DIRECT_WRITE_HOOK_MATCHER,
  DIRECT_WRITE_TOOL_NAMES,
  isDirectWriteTool,
  isMcpTool,
  isShellTool,
  isSpawnTool,
  MCP_HOOK_MATCHER,
  MCP_PUSH_MERGE_BARE_NAMES,
  READ_ONLY_HOOK_ENV,
  SHELL_HOOK_MATCHER,
  SHELL_TOOL_NAMES,
  SPAWN_HOOK_MATCHER,
  SPAWN_TOOL_NAMES,
} from "./tools.js";

export const HOOK_HOSTS = ["claude", "grok", "cursor", "codex"] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

export const HOOK_EVENTS = ["session.start", "session.compact", "tool.before"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Hosts that receive compact/resume hook deposits via init/update (#2113). */
export const COMPACT_HOOK_HOSTS = ["claude", "grok", "cursor"] as const;
export type CompactHookHost = (typeof COMPACT_HOOK_HOSTS)[number];

/** Hosts without a native compact hook surface — deposit skips cleanly (#2113). */
export const COMPACT_HOOK_SKIP_HOSTS = ["codex"] as const;

export type HookVerdict = "allow" | "deny";
export type HookDecisionCode =
  | "session-start"
  | "session-start-disabled"
  | "session-start-degraded"
  | "session-compact-rearm"
  | "session-compact-rearm-degraded"
  | "session-compact-noop"
  | "not-direct-write"
  | "invalid-input"
  /** Host closed stdin with zero bytes — integration failure, not a policy gate (#2864). */
  | "stdin-empty"
  | "ritual-not-ready"
  | "scope-not-ready"
  | "write-propose-ready"
  | "write-ready"
  | "read-only-deny"
  | "spawn-explore-ready"
  | "spawn-ready"
  | "spawn-not-ready"
  | "runtime-policy-deny-path"
  | "runtime-policy-deny-scope"
  /** Shell/MCP classifiable push/merge allowed under runtimeAuthority (#2711). */
  | "shell-op-ready"
  /** Shell/MCP tool seen but command/tool not classifiable as push/merge — fail open (#2711). */
  | "shell-op-unclassifiable"
  /** UAT lease / human-origin grant denial (#2944). */
  | "authz-uat-deny"
  | "authz-grant-missing"
  | "authz-grant-origin-reject"
  | "authz-grant-scope-deny"
  | "authz-grant-expired"
  | "authz-grant-revoked"
  | "authz-grant-single-use-spent";

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

/** Stdin parse metadata from hook-dispatch; absent when callers supply payload directly. */
export interface HookPayloadContext {
  readonly stdinEmpty?: boolean;
  readonly parseFailed?: boolean;
}

export interface HookDispatchInput {
  readonly host: HookHost;
  readonly event: HookEvent;
  readonly projectRoot: string;
  readonly payload: unknown;
  readonly payloadContext?: HookPayloadContext;
  /** Injected for tests; defaults to `process.env`. */
  readonly environ?: NodeJS.ProcessEnv;
}

export interface HookPolicySeams {
  readonly inspectRitual?: (projectRoot: string) => VerifyResult;
  readonly inspectScope?: (projectRoot: string) => ActiveScopeInspection;
  readonly sessionStart?: (projectRoot: string) => { code: number; stdout: string; stderr: string };
  /** Test seam for #2926 root opt-out on SessionStart. */
  readonly detectNoDeftDirective?: typeof detectNoDeftDirective;
  readonly markCompactStale?: (projectRoot: string) => {
    changed: boolean;
    statePath: string;
    message: string;
  };
  readonly loadRuntimeAuthority?: (projectRoot: string) => RuntimeAuthorityPolicy;
  /** Test seam for #2944 UAT lease + human-origin grants. */
  readonly loadAuthzState?: (projectRoot: string) => AuthzState;
  readonly loadAuthzGrants?: (
    projectRoot: string,
    state: AuthzState,
  ) => readonly HumanOriginGrant[];
  /** When false, skip writing `.deft/authz/audit.jsonl` (tests). Default true. */
  readonly authzAudit?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First non-empty trimmed string from candidates (array form — clear arity for static tools). */
function firstString(values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function fieldPresent(input: Record<string, unknown>, key: string): boolean {
  return key in input;
}

function fieldString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function toolInputRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const toolCall = record(payload.tool_call) ?? record(payload.toolCall);
  return (
    record(payload.tool_input) ??
    record(payload.toolInput) ??
    record(payload.input) ??
    record(payload.arguments) ??
    (toolCall !== null ? record(toolCall.arguments) : null)
  );
}

/**
 * Cursor preToolUse payloads sometimes omit `tool_name` even when the hook matcher
 * fired for a direct-write tool (#2628). Infer from nested tool input when possible.
 */
function inferCursorDirectWriteToolName(payload: Record<string, unknown>): string | null {
  const toolInput = toolInputRecord(payload);
  if (toolInput !== null) {
    if (
      fieldPresent(toolInput, "new_string") ||
      fieldPresent(toolInput, "newString") ||
      fieldPresent(toolInput, "old_string") ||
      fieldPresent(toolInput, "oldString")
    ) {
      return "StrReplace";
    }

    if (
      fieldString(toolInput, "contents") !== null ||
      fieldString(toolInput, "content") !== null ||
      fieldString(toolInput, "text") !== null
    ) {
      return "Write";
    }

    if (
      fieldString(toolInput, "patch") !== null ||
      fieldString(toolInput, "unified_diff") !== null ||
      fieldString(toolInput, "diff") !== null
    ) {
      return "ApplyPatch";
    }

    if (Array.isArray(toolInput.edits)) return "MultiEdit";
    if (Array.isArray(toolInput.cells) || toolInput.cell_id != null) {
      return "NotebookEdit";
    }
  }

  // Cursor maps Claude Edit → Write; a write target without contents is still a direct write.
  if (hookWriteTargetPath(payload) !== null) return "Write";

  return null;
}

export function hookPayloadTopLevelKeys(payload: unknown): string[] {
  const input = record(payload);
  if (input === null) return [];
  return Object.keys(input).sort();
}

export function hookToolName(payload: unknown, host?: HookHost): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolObject = record(input.tool);
  const toolCall = record(input.tool_call) ?? record(input.toolCall);
  // OpenAI-style nestings are host-agnostic; checked before Cursor-only inference.
  const direct =
    fieldString(input, "tool_name") ??
    fieldString(input, "toolName") ??
    fieldString(input, "tool") ??
    (toolObject !== null ? fieldString(toolObject, "name") : null) ??
    (toolCall !== null ? fieldString(toolCall, "name") : null);
  if (direct !== null) return direct;
  if (host === "cursor") return inferCursorDirectWriteToolName(input);
  return null;
}

interface MissingToolNameInput {
  readonly host: HookHost;
  readonly payload: unknown;
  readonly context?: HookPayloadContext;
}

function missingToolNameMessage(input: MissingToolNameInput): string {
  const { host, payload, context } = input;
  if (host === "cursor") {
    if (context?.stdinEmpty) {
      return (
        "Directive denied this Cursor preToolUse event because the host sent an empty payload " +
        "(stdin was empty — not a session ritual or scope failure). " +
        "If write tools should pass, update Directive or report the payload shape from Cursor."
      );
    }
    if (context?.parseFailed) {
      return (
        "Directive denied this Cursor preToolUse event because the host payload was not valid JSON " +
        "(host-integration mismatch — not a session ritual or scope failure). " +
        "If write tools should pass, update Directive or report the payload shape from Cursor."
      );
    }
    const keys = hookPayloadTopLevelKeys(payload);
    if (keys.length > 0) {
      return (
        "Directive denied this Cursor preToolUse event because the host payload omitted a " +
        "recognizable tool name (host-integration mismatch — not a session ritual or scope failure). " +
        `Top-level payload keys: ${keys.join(", ")}. ` +
        "If write tools should pass, update Directive or report the payload shape from Cursor."
      );
    }
    return (
      "Directive denied this Cursor preToolUse event because the host payload omitted a " +
      "recognizable tool name (host-integration mismatch — not a session ritual or scope failure). " +
      "If write tools should pass, update Directive or report the payload shape from Cursor."
    );
  }
  return "Directive denied this matched write event because the host payload omitted its tool name.";
}

/**
 * Best-effort write-target path from host PreToolUse payloads (#2625).
 * Hosts disagree on nesting (`tool_input.file_path` vs top-level `path`).
 */
export function hookWriteTargetPath(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  return firstString([
    toolInput?.file_path,
    toolInput?.filePath,
    toolInput?.path,
    input.file_path,
    input.filePath,
    input.path,
  ]);
}

/** POSIX-ish project-relative path for lifecycle matching. */
export function toProjectRelativePosix(projectRoot: string, targetPath: string): string {
  const abs = resolve(projectRoot, targetPath.replace(/\\/g, "/"));
  const rel = relative(resolve(projectRoot), abs);
  return rel.split(sep).join("/").replace(/\\/g, "/");
}

function posixRelative(fromAbs: string, toAbs: string): string {
  return relative(fromAbs, toAbs).split(sep).join("/").replace(/\\/g, "/");
}

/**
 * Lexical "outside project root" predicate used by #2885.
 * - `".."` / `"../…"` are outside (not bare `startsWith("..")` — that matches `..secret`).
 * - Absolute relatives and win32 cross-drive paths (`D:/…`) are outside.
 * - Drive-letter form is win32-only so POSIX children like `D:/tmp/x` stay in-repo.
 */
export function isLexicalOutsideProjectRoot(relPosix: string): boolean {
  if (relPosix === ".." || relPosix.startsWith("../") || isAbsolute(relPosix)) {
    return true;
  }
  // path.relative returns absolute drive paths across volumes on Windows only.
  return process.platform === "win32" && /^[A-Za-z]:\//.test(relPosix);
}

/**
 * True when a write target is outside `projectRoot` for the active-scope skip (#2885).
 * Lexically outside paths still fail the skip when a symlink/junction re-enters the project.
 * When the project root cannot be realpath'd (unit fixtures), lexical classification wins.
 */
export function isOutsideProjectRootWrite(projectRoot: string, targetPath: string): boolean {
  const projectAbs = resolve(projectRoot);
  const targetAbs = resolve(projectRoot, targetPath.replace(/\\/g, "/"));
  const rel = posixRelative(projectAbs, targetAbs);
  if (!isLexicalOutsideProjectRoot(rel)) return false;

  try {
    const projectReal = realpathSync(projectAbs);
    let probe = targetAbs;
    for (;;) {
      try {
        const probeReal = realpathSync(probe);
        const reenter = posixRelative(projectReal, probeReal);
        // Empty reenter ⇒ probeReal === projectReal (inside). Lexical-outside reenter ⇒ truly out.
        if (reenter === "" || !isLexicalOutsideProjectRoot(reenter)) return false;
        return true;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return true;
        probe = parent;
      }
    }
  } catch {
    return true;
  }
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

function isWindowsDriveOnlyRoot(value: string): boolean {
  return /^[A-Za-z]:[/\\]?$/.test(value.trim());
}

function hookPayloadRootCandidates(input: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      candidates.push(value.trim());
    }
  };
  push(input.workspaceRoot);
  push(input.workspace_root);
  const workspaceRoots = input.workspace_roots;
  if (Array.isArray(workspaceRoots)) {
    for (const entry of workspaceRoots) push(entry);
  }
  push(input.cwd);
  return candidates;
}

/** Collapse join('C:', 'c:\\...') doubled drive prefix on Windows (#2787). */
function collapseDoubledWindowsDrivePrefix(path: string): string {
  return path.replace(/^([A-Za-z]:\\)(?=[A-Za-z]:\\)/i, "");
}

function msysPathToWin32(path: string): string | null {
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(path.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

/** Normalize hook project-root resolution on Windows (doubled drive + MSYS `/c/...`). */
export function normalizeHookProjectRoot(path: string): string {
  if (process.platform !== "win32") return resolve(path);
  const trimmed = path.trim();
  const msys = msysPathToWin32(trimmed);
  let resolved = resolve(msys ?? trimmed);
  const collapsed = collapseDoubledWindowsDrivePrefix(resolved);
  if (collapsed !== resolved) {
    resolved = resolve(collapsed);
  }
  if (/^[a-z]:\\/.test(resolved)) {
    resolved = `${resolved.charAt(0).toUpperCase()}${resolved.slice(1)}`;
  }
  return resolved;
}

export function projectRootFromHookPayload(payload: unknown, fallback: string): string {
  const fallbackResolved = normalizeHookProjectRoot(fallback);
  const input = record(payload);
  if (input === null) return fallbackResolved;
  const usable = hookPayloadRootCandidates(input).find(
    (candidate) => !isWindowsDriveOnlyRoot(candidate),
  );
  if (usable !== undefined) {
    return normalizeHookProjectRoot(usable);
  }
  return fallbackResolved;
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
  scopePath: string | null = null,
): HookDecision {
  return {
    verdict: "deny",
    code,
    event: input.event,
    host: input.host,
    toolName,
    projectRoot: resolve(input.projectRoot),
    message,
    scopePath,
  };
}

function runtimeAuthorityForDirectWrite(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
  scopePath: string | null,
): HookDecision | null {
  const projectRoot = resolve(input.projectRoot);
  let policy: RuntimeAuthorityPolicy;
  try {
    policy = (seams.loadRuntimeAuthority ?? loadRuntimeAuthorityFromProject)(projectRoot);
  } catch {
    // Fail-open on policy load crash — host behavior; ritual/scope gates already passed.
    return null;
  }
  const writeTarget = hookWriteTargetPath(input.payload);
  const relPath = writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
  const verdict = evaluateRuntimeAuthorityDirectWrite({ policy, relPathPosix: relPath });
  if (verdict.allowed) return null;
  return deny(
    input,
    verdict.code ?? "runtime-policy-deny-path",
    toolName,
    verdict.reason ?? "Directive denied this direct write under runtime authority policy.",
    scopePath,
  );
}

function loadAuthzContext(
  projectRoot: string,
  seams: HookPolicySeams,
): { state: AuthzState; grants: readonly HumanOriginGrant[] } {
  const state = (seams.loadAuthzState ?? loadAuthzState)(projectRoot);
  const grants = (seams.loadAuthzGrants ?? listActiveHumanGrants)(projectRoot, state);
  return { state, grants };
}

function authzCodeToHook(code: AuthzDecision["code"]): HookDecisionCode {
  switch (code) {
    case "authz-uat-deny":
      return "authz-uat-deny";
    case "authz-grant-missing":
      return "authz-grant-missing";
    case "authz-grant-origin-reject":
      return "authz-grant-origin-reject";
    case "authz-grant-scope-deny":
      return "authz-grant-scope-deny";
    case "authz-grant-expired":
      return "authz-grant-expired";
    case "authz-grant-revoked":
      return "authz-grant-revoked";
    case "authz-grant-single-use-spent":
      return "authz-grant-single-use-spent";
    default:
      return "authz-uat-deny";
  }
}

function recordAuthzAudit(
  projectRoot: string,
  decision: AuthzDecision,
  state: AuthzState,
  seams: HookPolicySeams,
): void {
  if (seams.authzAudit === false) return;
  // Only audit when UAT is active or a deny occurred under an authz code.
  const uatActive = state.uat?.active === true;
  if (!uatActive && decision.allowed) return;
  try {
    appendAuthzAudit(projectRoot, {
      schemaVersion: 1,
      ts: utcIso(),
      humanApprovalRef: decision.humanApprovalRef,
      approvedScope: decision.approvedScope,
      attemptedOp: String(decision.attemptedOp),
      path: decision.path,
      result: decision.allowed ? "allow" : "deny",
      code: decision.code,
      message: decision.reason,
      campaignId: state.uat?.campaignId ?? null,
    });
  } catch {
    // Audit write must not crash the host tool gate.
  }
}

/**
 * UAT lease + human-origin grant gate (#2944). Returns deny decision or null when allowed.
 * Composes before runtimeAuthority path/scope checks for direct writes and shell/MCP.
 */
function authzForMutation(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
  options: { isDirectWrite: boolean; relPath: string | null; scopePath: string | null },
): HookDecision | null {
  const projectRoot = resolve(input.projectRoot);
  let state: AuthzState;
  let grants: readonly HumanOriginGrant[];
  try {
    ({ state, grants } = loadAuthzContext(projectRoot, seams));
  } catch {
    // Fail open when store is unreadable outside intentional UAT posture.
    return null;
  }

  const shellCommand = isShellTool(toolName) ? hookShellCommand(input.payload) : null;
  const ops = classifyHookAuthzOps({
    toolName,
    shellCommand,
    isDirectWrite: options.isDirectWrite,
    mcpArgsText: options.isDirectWrite ? null : hookMcpArgsText(input.payload),
  });

  // No classifiable authz ops (unrelated tools) — leave to other gates.
  if (ops.length === 0) return null;

  // Evaluate each op; first deny wins (compound shell must not short-circuit).
  for (const op of ops) {
    const decision = evaluateAuthzMutation({
      state,
      grants,
      op,
      path: options.relPath,
    });
    recordAuthzAudit(projectRoot, decision, state, seams);
    if (!decision.allowed) {
      return deny(
        input,
        authzCodeToHook(decision.code),
        toolName,
        decision.reason,
        options.scopePath,
      );
    }
  }
  return null;
}

/**
 * Best-effort shell command string from host PreToolUse payloads (#2711).
 * Hosts disagree on nesting (`tool_input.command` vs top-level `command`).
 */
export function hookShellCommand(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  return firstString([
    toolInput !== null ? toolInput.command : null,
    toolInput !== null ? toolInput.cmd : null,
    toolInput !== null ? toolInput.shell_command : null,
    input.command,
    input.cmd,
  ]);
}

/** Serialize tool args for MCP classification when nested objects are present (#2711). */
function hookMcpArgsText(payload: unknown): string | null {
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  if (toolInput === null) return null;
  try {
    return JSON.stringify(toolInput);
  } catch {
    return null;
  }
}

function loadRuntimeAuthorityPolicySafe(
  input: HookDispatchInput,
  seams: HookPolicySeams,
): RuntimeAuthorityPolicy | null {
  const projectRoot = resolve(input.projectRoot);
  try {
    return (seams.loadRuntimeAuthority ?? loadRuntimeAuthorityFromProject)(projectRoot);
  } catch {
    return null;
  }
}

/**
 * Evaluate scopes.push / scopes.merge for Shell/Bash or classifiable MCP tools (#2711).
 * Returns a full HookDecision (allow or deny). Unclassifiable ops fail open.
 */
function decideShellOrMcpRuntimeAuthority(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
): HookDecision {
  const projectRoot = resolve(input.projectRoot);

  // Wave 1 authz first: UAT lease denies push/PR/merge/settings/deploy without cohort (#2944).
  // Composes with #2711 shell matchers; does not re-implement them.
  const authzDeny = authzForMutation(input, toolName, seams, {
    isDirectWrite: false,
    relPath: null,
    scopePath: null,
  });
  if (authzDeny !== null) return authzDeny;

  const policy = loadRuntimeAuthorityPolicySafe(input, seams);
  if (policy === null) {
    return {
      verdict: "allow",
      code: "shell-op-unclassifiable",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message: `Directive allowed ${toolName}: runtimeAuthority policy load failed (fail open).`,
      scopePath: null,
    };
  }

  // Shell: evaluate every classifiable op in compound/multi-line commands (#2711 Greptile).
  // MCP / bare push-merge names: single tool name maps to at most one op
  // (includes bare `merge_pull_request` etc. that isMcpTool does not flag).
  const ops: RuntimeAuthorityShellOp[] = [];
  if (isShellTool(toolName)) {
    const command = hookShellCommand(input.payload);
    if (command !== null) ops.push(...listShellOps(command));
  } else {
    const mcpOp = classifyMcpTool(toolName, hookMcpArgsText(input.payload));
    if (mcpOp !== null) ops.push(mcpOp);
  }

  if (ops.length === 0) {
    return {
      verdict: "allow",
      code: "shell-op-unclassifiable",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message:
        `${toolName} is classifiable as Shell/MCP but the command/tool was not recognized as ` +
        "push or merge — fail open (host gap; see runtime-authority.md).",
      scopePath: null,
    };
  }

  // Deny if any classifiable op is out of scope (compound commands must not short-circuit).
  for (const op of ops) {
    const verdict = evaluateRuntimeAuthorityShellOp({ policy, op });
    if (!verdict.allowed) {
      return deny(
        input,
        verdict.code ?? "runtime-policy-deny-scope",
        toolName,
        verdict.reason ??
          "Directive denied this shell/MCP operation under runtime authority policy.",
      );
    }
  }

  const opsLabel = ops.join("+");
  return {
    verdict: "allow",
    code: "shell-op-ready",
    event: input.event,
    host: input.host,
    toolName,
    projectRoot,
    message: `Directive runtimeAuthority allowed classifiable ${opsLabel} via ${toolName}.`,
    scopePath: null,
  };
}

function inspectMutationGates(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
  options: { proposedLifecycleExempt: boolean },
): HookDecision {
  const projectRoot = resolve(input.projectRoot);
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

  if (options.proposedLifecycleExempt) {
    const writeTarget = hookWriteTargetPath(input.payload);
    if (isProposedLifecycleWrite(projectRoot, writeTarget)) {
      const relPath =
        writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
      // UAT still allows xbrief/proposed/** as evidence/defect capture (#2944).
      const authzDeny = authzForMutation(input, toolName, seams, {
        isDirectWrite: true,
        relPath,
        scopePath: null,
      });
      if (authzDeny !== null) return authzDeny;
      const runtimeDeny = runtimeAuthorityForDirectWrite(input, toolName, seams, null);
      if (runtimeDeny !== null) return runtimeDeny;
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
  }

  let scope: ActiveScopeInspection;
  try {
    scope = (seams.inspectScope ?? inspectActiveScope)(projectRoot);
  } catch (cause) {
    scope = { ready: false, path: null, message: String(cause) };
  }
  if (!scope.ready) {
    const writeTarget = hookWriteTargetPath(input.payload);
    const relTarget =
      writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
    // Active-scope governs in-repo lifecycle work only. Outside-root Write/Edit
    // (agent memory, $TMPDIR, user config) skips the deny; null/unparseable
    // targets stay fail-closed. Spawn has no write target → still requires scope (#2885).
    // Lexical ../ + realpath re-entry guard (not bare startsWith(".."); not symlink aliases).
    const outsideRoot = writeTarget !== null && isOutsideProjectRootWrite(projectRoot, writeTarget);
    if (!outsideRoot || isSpawnTool(toolName)) {
      const proposedPathHint =
        options.proposedLifecycleExempt &&
        relTarget !== null &&
        (relTarget.startsWith("xbrief/proposed/") || relTarget.startsWith("vbrief/proposed/"))
          ? " For a new proposal under xbrief/proposed/, include a lifecycle artifact " +
            "filename (*.xbrief.json) in the Write/Edit payload so the gate can exempt " +
            "planning writes (#2625)."
          : " Recovery: run `deft scope:activate -- <path>` for the approved xBRIEF, " +
            (options.proposedLifecycleExempt
              ? "or Write a new proposal to xbrief/proposed/*.xbrief.json (planning exemption)."
              : "then re-run the pre-start_agent gate stack.");
      const denyCode = isSpawnTool(toolName) ? "spawn-not-ready" : "scope-not-ready";
      return deny(
        input,
        denyCode,
        toolName,
        `Directive denied ${toolName}: ${scope.message}${proposedPathHint}`,
      );
    }
  }

  const allowCode = isSpawnTool(toolName) ? "spawn-ready" : "write-ready";
  if (!isSpawnTool(toolName)) {
    const writeTarget = hookWriteTargetPath(input.payload);
    const relPath = writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
    // Wave 1 authz (UAT lease + human-origin grant) before runtimeAuthority (#2944 / #2948 L1–L2).
    const authzDeny = authzForMutation(input, toolName, seams, {
      isDirectWrite: true,
      relPath,
      scopePath: scope.path,
    });
    if (authzDeny !== null) return authzDeny;
    const runtimeDeny = runtimeAuthorityForDirectWrite(input, toolName, seams, scope.path);
    if (runtimeDeny !== null) return runtimeDeny;
  }
  return {
    verdict: "allow",
    code: allowCode,
    event: input.event,
    host: input.host,
    toolName,
    projectRoot,
    message: `Directive ${isSpawnTool(toolName) ? "spawn" : "write"} gate passed for ${toolName}.`,
    scopePath: scope.path,
  };
}

/** Decide a normalized event using only the P0 direct-write policy. */
export function decideHook(input: HookDispatchInput, seams: HookPolicySeams = {}): HookDecision {
  const projectRoot = resolve(input.projectRoot);
  if (input.event === "session.compact") {
    try {
      const result = (seams.markCompactStale ?? markRitualStaleAfterCompact)(projectRoot);
      if (!result.changed) {
        return {
          verdict: "allow",
          code: "session-compact-noop",
          event: input.event,
          host: input.host,
          toolName: null,
          projectRoot,
          message: result.message,
          scopePath: null,
        };
      }
      return {
        verdict: "allow",
        code: "session-compact-rearm",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message: result.message,
        scopePath: null,
      };
    } catch (cause) {
      return {
        verdict: "allow",
        code: "session-compact-rearm-degraded",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message:
          "Directive compact re-arm bookkeeping failed on its non-blocking path: " +
          `${String(cause)}`,
        scopePath: null,
      };
    }
  }

  if (input.event === "session.start") {
    // #2926: root `.no-deft-directive` wins — skip host SessionStart bookkeeping.
    const detectOptOut = seams.detectNoDeftDirective ?? detectNoDeftDirective;
    const optOut = detectOptOut(projectRoot);
    if (optOut.present) {
      const message = optOut.inconsistent
        ? `${NO_DEFT_DIRECTIVE_DISABLED_MESSAGE}. ${NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE}`
        : NO_DEFT_DIRECTIVE_DISABLED_MESSAGE;
      return {
        verdict: "allow",
        code: "session-start-disabled",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message,
        scopePath: null,
      };
    }
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

  const toolName = hookToolName(input.payload, input.host);
  if (toolName === null) {
    // stdin-empty is a host-integration failure; keep it distinct from invalid-input
    // so agents can retry without treating it as a policy refusal (#2864).
    const missingCode: HookDecisionCode = input.payloadContext?.stdinEmpty
      ? "stdin-empty"
      : "invalid-input";
    return deny(
      input,
      missingCode,
      null,
      missingToolNameMessage({
        host: input.host,
        payload: input.payload,
        context: input.payloadContext,
      }),
    );
  }
  const environ = input.environ ?? process.env;
  const readOnly = isReadOnlyHookContext(input.payload, environ);
  if (readOnly && isDirectWriteTool(toolName)) {
    return deny(
      input,
      "read-only-deny",
      toolName,
      `Directive denied ${toolName}: read-only explore posture blocks direct writes. ` +
        'Use Grok `default_capability_mode = "read-only"` for role-based explore agents, ' +
        "or set explore subagent_type / DEFT_HOOK_READ_ONLY=1 when the harness supports it.",
    );
  }

  if (isSpawnTool(toolName)) {
    if (readOnly && !isExploreSpawn(input.payload)) {
      return deny(
        input,
        "read-only-deny",
        toolName,
        `Directive denied ${toolName}: read-only posture blocks implementation sub-agent spawns. ` +
          "Use subagent_type explore for read-only research spawns.",
      );
    }
    if (isExploreSpawn(input.payload)) {
      return {
        verdict: "allow",
        code: "spawn-explore-ready",
        event: input.event,
        host: input.host,
        toolName,
        projectRoot,
        message: `Directive allowed explore ${toolName} spawn without implementation gates.`,
        scopePath: null,
      };
    }
    return inspectMutationGates(input, toolName, seams, { proposedLifecycleExempt: false });
  }

  // Shell/Bash and classifiable MCP: enforce scopes.push / scopes.merge (#2711).
  // Route bare push/merge MCP names (merge_pull_request, git_push, …) even when
  // isMcpTool is false — classifyMcpTool is the gate (dispatcher-side, no tools↔policy cycle).
  // Does not require active-scope ritual — only runtimeAuthority when enabled.
  if (
    isShellTool(toolName) ||
    isMcpTool(toolName) ||
    classifyMcpTool(toolName, hookMcpArgsText(input.payload)) !== null
  ) {
    return decideShellOrMcpRuntimeAuthority(input, toolName, seams);
  }

  if (!isDirectWriteTool(toolName)) {
    return {
      verdict: "allow",
      code: "not-direct-write",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message: `${toolName} is outside the P0 direct-write/spawn/shell enforcement slice.`,
      scopePath: null,
    };
  }

  return inspectMutationGates(input, toolName, seams, { proposedLifecycleExempt: true });
}

/**
 * Render host-facing hook output.
 *
 * Cursor deposits use `failClosed: true`. Cursor treats empty/null stdout as a
 * hook failure and blocks the tool — so Cursor allows must emit explicit
 * `{"permission":"allow"}`. Other hosts keep empty allow so the host permission
 * flow is unchanged.
 *
 * Cursor stdout always includes `code` (stable machine-readable decision code)
 * so agents can distinguish policy denials from host-integration failures
 * without parsing English (#2864). Exit status still does not encode the
 * verdict — see hook-dispatch `run()` exit-code contract.
 */
export function renderHostDecision(host: HookHost, decision: HookDecision): string {
  if (decision.verdict === "allow") {
    if (host === "cursor") {
      return JSON.stringify({ permission: "allow", code: decision.code });
    }
    return "";
  }
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
        code: decision.code,
      });
  }
}
