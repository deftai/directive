/**
 * Cooperative host-session identity and exact lifecycle-command rewriting (#3611).
 *
 * This is payload/environment classification, not authentication. Host hook JSON
 * is locally forgeable under the occupancy model's cooperating-process
 * assumption. The provider table and the canonical owner form live in
 * `session/host-session-owner.ts` because the CLI claim path resolves the same
 * owner from the same host (#3873).
 */

import {
  ambientHostSessionOwner,
  canonicalHostSessionId,
  HOST_IDENTITY_PROVIDERS,
  type HookHostIdentityProvider,
  type HookHostIdentitySource,
  hookHostIdentitySource,
  isUsableHostSessionId,
  MAX_HOOK_HOST_IDENTITY_UTF8_BYTES,
  readHostEnvIdentity,
} from "../../session/host-session-owner.js";
import { isShellTool } from "../tools.js";
import { record, toolInputRecord } from "./payload.js";
import { hookToolName } from "./tool-name.js";

export {
  ambientHostSessionOwner,
  HOST_IDENTITY_PROVIDERS,
  type HookHostIdentityProvider,
  type HookHostIdentitySource,
  hookHostIdentitySource,
  MAX_HOOK_HOST_IDENTITY_UTF8_BYTES,
};

export type HookHostIdentityStatus = "ok" | "missing" | "invalid" | "conflict" | "unsupported";

export type HookHostIdentityResolution =
  | {
      readonly status: "ok";
      readonly provider: HookHostIdentityProvider;
      readonly rawSessionId: string;
      readonly sessionId: string;
      readonly message: null;
    }
  | {
      readonly status: Exclude<HookHostIdentityStatus, "ok">;
      readonly provider: string;
      readonly rawSessionId: null;
      readonly sessionId: null;
      readonly message: string;
    };

type IdentityFieldResolution =
  | { readonly status: "ok"; readonly value: string }
  | { readonly status: "missing" | "invalid"; readonly value: null };

function identityField(input: Record<string, unknown>, fieldName: string): IdentityFieldResolution {
  if (!(fieldName in input)) return { status: "missing", value: null };
  const raw = input[fieldName];
  if (typeof raw !== "string" || !isUsableHostSessionId(raw)) {
    return { status: "invalid", value: null };
  }
  return { status: "ok", value: raw };
}

function unresolvedHostIdentity(
  status: Exclude<HookHostIdentityStatus, "ok">,
  provider: string,
  message: string,
): HookHostIdentityResolution {
  return { status, provider, rawSessionId: null, sessionId: null, message };
}

function resolvedHostIdentity(
  provider: HookHostIdentityProvider,
  rawSessionId: string,
): HookHostIdentityResolution {
  return {
    status: "ok",
    provider,
    rawSessionId,
    sessionId: canonicalHostSessionId(provider, rawSessionId),
    message: null,
  };
}

/**
 * Resolve the stable conversation/session-family key documented by each host.
 *
 * - Codex: payload `session_id` (parent and subagents share it).
 * - Claude Code: payload `session_id` (`agent_id` is not the owner key).
 * - Cursor: payload `conversation_id`; simultaneous `session_id` must agree.
 * - Grok: hook process `GROK_SESSION_ID` (#3873). The payload `session_id` is
 *   deliberately not read -- that contract is unverified.
 * - Unknown hosts: no guessed identity; callers keep the explicit/env flow.
 */
export function resolveHookHostIdentity(
  host: string,
  payload: unknown,
  environ: NodeJS.ProcessEnv = process.env,
): HookHostIdentityResolution {
  const source = hookHostIdentitySource(host);
  if (source === null) {
    return unresolvedHostIdentity(
      "unsupported",
      host,
      `Host ${host || "<empty>"} has no verified session identity contract.`,
    );
  }
  const provider = host as HookHostIdentityProvider;

  if (source.kind === "host-env") {
    const value = readHostEnvIdentity(environ, source.variable);
    if (value.status !== "ok") {
      return unresolvedHostIdentity(
        value.status,
        provider,
        `${provider} hook process environment ` +
          `${value.status === "missing" ? "omits" : "has invalid"} ${source.variable}.`,
      );
    }
    return resolvedHostIdentity(provider, value.rawSessionId);
  }

  const input = record(payload);
  if (input === null) {
    return unresolvedHostIdentity(
      "invalid",
      provider,
      `${provider} hook payload is not an object.`,
    );
  }

  if (provider !== "cursor") {
    const session = identityField(input, source.field);
    if (session.status !== "ok") {
      return unresolvedHostIdentity(
        session.status,
        provider,
        `${provider} hook payload ${session.status === "missing" ? "omits" : "has invalid"} ${source.field}.`,
      );
    }
    return resolvedHostIdentity(provider, session.value);
  }

  const conversation = identityField(input, source.field);
  if (conversation.status !== "ok") {
    return unresolvedHostIdentity(
      conversation.status,
      provider,
      `Cursor hook payload ${conversation.status === "missing" ? "omits" : "has invalid"} conversation_id.`,
    );
  }
  const simultaneousSession = identityField(input, "session_id");
  if (simultaneousSession.status === "invalid") {
    return unresolvedHostIdentity(
      "invalid",
      provider,
      "Cursor hook payload has invalid session_id alongside conversation_id.",
    );
  }
  if (simultaneousSession.status === "ok" && simultaneousSession.value !== conversation.value) {
    return unresolvedHostIdentity(
      "conflict",
      provider,
      "Cursor hook identity conflict: conversation_id and session_id differ.",
    );
  }
  return resolvedHostIdentity(provider, conversation.value);
}

/**
 * True when a `host-env` provider simply did not publish its variable (#3873).
 *
 * Absence is the pre-#3873 state rather than a broken contract, so callers keep
 * the documented explicit `--session-id` / `DEFT_SESSION_ID` flow instead of
 * failing a host that never had a hook identity to begin with. It is never an
 * admission: with no explicit owner the actor stays unset and the write gate
 * still denies. A present-but-malformed variable is `invalid` and fails closed.
 */
export function hostIdentityFallsBackToExplicitOwner(
  host: string,
  resolution: HookHostIdentityResolution,
): boolean {
  return resolution.status === "missing" && hookHostIdentitySource(host)?.kind === "host-env";
}

export const EXACT_LIFECYCLE_VERBS = [
  "session:start",
  "session:ready",
  "session:end",
  "occupancy:steal",
  "occupancy:release",
  "occupancy:heartbeat",
  "swarm:launch",
] as const;
export type ExactLifecycleVerb = (typeof EXACT_LIFECYCLE_VERBS)[number];

const DIRECT_LIFECYCLE_VERBS: Readonly<Record<string, ExactLifecycleVerb>> = {
  "session:start": "session:start",
  "session:ready": "session:ready",
  "session:end": "session:end",
  "occupancy:steal": "occupancy:steal",
  "occupancy:release": "occupancy:release",
  "occupancy:heartbeat": "occupancy:heartbeat",
  "swarm-launch": "swarm:launch",
};

export interface ExactLifecycleCommandRewrite {
  readonly kind: "rewrite";
  readonly verb: ExactLifecycleVerb;
  readonly originalCommand: string;
  readonly rewrittenCommand: string;
  readonly updatedInput: Record<string, unknown>;
}

export interface ExactLifecycleCommandConflict {
  readonly kind: "conflict";
  readonly verb: ExactLifecycleVerb;
  readonly existingSessionId: string;
  readonly requestedSessionId: string;
  readonly message: string;
}

export type ExactLifecycleCommandResult =
  | ExactLifecycleCommandRewrite
  | ExactLifecycleCommandConflict
  | null;

// Derived from the provider list so the rewrite surface cannot drift from the
// identity surface: a provider added to one is added to both (#3873). Provider
// ids are lowercase ASCII words, so the alternation needs no escaping.
const CANONICAL_OWNER_PATTERN = new RegExp(
  `^host:(?:${HOST_IDENTITY_PROVIDERS.join("|")}):v1:[A-Za-z0-9_-]+$`,
);
// Shell expansion markers are deliberately absent: `$`/backticks for POSIX,
// `@` splatting for PowerShell, and `%NAME%` expansion for command shells.
// Backslashes are inspectable so Windows path-bearing lifecycle commands fail
// closed, but they remain outside the auto-approved rewrite surface below.
const INSPECTABLE_TOKEN_PATTERN = /^[A-Za-z0-9_./\\:+=,-]+$/;

interface ExactInvocation {
  readonly verb: ExactLifecycleVerb;
  readonly task: boolean;
  readonly forwardedArgs: readonly string[];
  readonly rewriteSafe: boolean;
  readonly requiresOwner: boolean;
}

interface ExactLifecyclePayload {
  readonly invocation: ExactInvocation;
  readonly originalCommand: string;
  readonly toolInput: Record<string, unknown>;
}

interface LifecycleArgumentPolicy {
  readonly booleanFlags: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly rewriteUnsafeFlags: ReadonlySet<string>;
  readonly separateOnlyValueFlags?: ReadonlySet<string>;
}

const LIFECYCLE_ARGUMENT_POLICIES: Readonly<Record<ExactLifecycleVerb, LifecycleArgumentPolicy>> = {
  "session:start": {
    booleanFlags: new Set([
      "--json",
      "--no-history",
      "--read-only",
      "--with-network",
      "--rearm",
      "--hard-budget",
      "--compact",
      "--steal",
      "--confirm",
    ]),
    valueFlags: new Set([
      "--tier",
      "--defer",
      "--task-size",
      "--ceremony-task-size",
      "--model-tier",
      "--ceremony-model-tier",
      "--project-shape",
      "--ceremony-project-shape",
      "--ceremony-depth",
      "--max-turns",
      "--max-budget",
      "--session-id",
      "--occupant",
      "--project-root",
    ]),
    rewriteUnsafeFlags: new Set(["--project-root"]),
  },
  "session:ready": {
    booleanFlags: new Set(["--json", "--with-network"]),
    valueFlags: new Set(["--repo", "--session-id", "--project-root"]),
    rewriteUnsafeFlags: new Set(["--project-root"]),
  },
  "session:end": {
    booleanFlags: new Set(),
    valueFlags: new Set(["--session-id", "--project-root"]),
    rewriteUnsafeFlags: new Set(["--project-root"]),
  },
  "occupancy:steal": {
    booleanFlags: new Set(["--confirm"]),
    valueFlags: new Set(["--occupant", "--session-id", "--project-root"]),
    rewriteUnsafeFlags: new Set(["--project-root"]),
  },
  "occupancy:release": {
    booleanFlags: new Set(),
    valueFlags: new Set(["--session-id", "--project-root"]),
    rewriteUnsafeFlags: new Set(["--project-root"]),
  },
  "occupancy:heartbeat": {
    booleanFlags: new Set(),
    valueFlags: new Set(["--session-id", "--project-root"]),
    rewriteUnsafeFlags: new Set(["--project-root"]),
  },
  "swarm:launch": {
    booleanFlags: new Set([
      "--autonomous",
      "--no-create-worktrees",
      "--enforce-gates",
      "--no-audit",
    ]),
    valueFlags: new Set([
      "--stories",
      "--paths",
      "--group",
      "--worktree-map",
      "--base-branch",
      "--allocation-plan-id",
      "--batching-rationale",
      "--operator-approval",
      "--output",
      "--gate-clearances",
      "--project-root",
      "--session-id",
    ]),
    rewriteUnsafeFlags: new Set([
      "--paths",
      "--worktree-map",
      "--output",
      "--gate-clearances",
      "--project-root",
      "--no-audit",
    ]),
    separateOnlyValueFlags: new Set([
      "--stories",
      "--paths",
      "--group",
      "--worktree-map",
      "--base-branch",
      "--allocation-plan-id",
      "--batching-rationale",
      "--operator-approval",
      "--output",
      "--gate-clearances",
      "--project-root",
    ]),
  },
};

function lifecycleArgumentValueIsRewriteSafe(
  verb: ExactLifecycleVerb,
  flag: string,
  value: string,
): boolean {
  if (verb !== "swarm:launch" || flag !== "--stories") return true;

  // `swarm:launch --stories` accepts both logical IDs and filesystem paths.
  // Only the ID form belongs in the auto-approved rewrite bridge; path-bearing
  // invocations must keep the host's ordinary permission decision.
  return value
    .split(",")
    .every(
      (story) =>
        story.length > 0 &&
        !story.endsWith(".json") &&
        !story.includes("/") &&
        !story.includes("\\"),
    );
}

interface LifecycleArgumentAnalysis {
  readonly rewriteSafe: boolean;
  readonly readOnly: boolean;
}

/**
 * Validate the complete CLI argument surface before returning an allow+rewrite.
 * Path rebinding/destination flags and unknown/future flags are recognized but
 * kept outside the auto-rewrite bridge. Supported hosts must carry the matching
 * owner explicitly before those commands retain normal permission handling.
 */
function analyzeLifecycleArguments(
  verb: ExactLifecycleVerb,
  args: readonly string[],
): LifecycleArgumentAnalysis {
  const policy = LIFECYCLE_ARGUMENT_POLICIES[verb];
  let rewriteSafe = true;
  let readOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (policy.booleanFlags.has(token)) {
      if (verb === "session:start" && token === "--read-only") readOnly = true;
      if (policy.rewriteUnsafeFlags.has(token)) rewriteSafe = false;
      continue;
    }

    const equals = token.indexOf("=");
    if (equals > 0) {
      const flag = token.slice(0, equals);
      const value = token.slice(equals + 1);
      if (!policy.valueFlags.has(flag)) {
        rewriteSafe = false;
        continue;
      }
      if (policy.rewriteUnsafeFlags.has(flag)) rewriteSafe = false;
      if (policy.separateOnlyValueFlags?.has(flag) === true) rewriteSafe = false;
      // Keep malformed session identity visible to inspection so the
      // dispatcher can deny ambiguity instead of silently skipping rewrite.
      if (value.length === 0 && flag !== "--session-id") rewriteSafe = false;
      if (!lifecycleArgumentValueIsRewriteSafe(verb, flag, value)) rewriteSafe = false;
      continue;
    }

    if (!policy.valueFlags.has(token)) {
      rewriteSafe = false;
      continue;
    }
    if (policy.rewriteUnsafeFlags.has(token)) rewriteSafe = false;
    const value = args[index + 1];
    if (value === undefined) {
      if (token !== "--session-id") rewriteSafe = false;
      continue;
    }
    if (value.startsWith("--")) rewriteSafe = false;
    if (!lifecycleArgumentValueIsRewriteSafe(verb, token, value)) rewriteSafe = false;
    // Match the real lifecycle parsers: known value flags consume the next
    // argv token even when it begins with `--`. This prevents a swallowed
    // `--session-id=...` from being mistaken for an effective owner.
    index += 1;
  }
  return { rewriteSafe, readOnly };
}

/**
 * Inspect single-space-separated lifecycle commands while excluding shell
 * quoting, substitution, redirection, chaining, aliases, and wrappers.
 * Windows path separators remain inspectable but make rewriting unsafe.
 */
function exactLifecycleInvocation(command: string): ExactInvocation | null {
  if (command.length === 0 || command !== command.trim()) return null;
  const tokens = command.split(" ");
  if (tokens.some((token) => token.length === 0 || !INSPECTABLE_TOKEN_PATTERN.test(token))) {
    return null;
  }
  if (tokens.length < 2) return null;

  const executable = tokens[0];
  const verb = tokens[1];
  if (executable === "deft" || executable === "directive") {
    const typedVerb = verb === undefined ? undefined : DIRECT_LIFECYCLE_VERBS[verb];
    if (typedVerb === undefined) return null;
    const forwardedArgs = tokens.slice(2);
    const { rewriteSafe, readOnly } = analyzeLifecycleArguments(typedVerb, forwardedArgs);
    const requiresOwner = typedVerb !== "session:start" || !readOnly;
    return {
      verb: typedVerb,
      task: false,
      forwardedArgs,
      rewriteSafe: rewriteSafe && forwardedArgs.every((token) => !token.includes("\\")),
      requiresOwner,
    };
  }
  if (executable !== "task") return null;
  if (!(EXACT_LIFECYCLE_VERBS as readonly string[]).includes(verb ?? "")) return null;
  const typedVerb = verb as ExactLifecycleVerb;
  if (tokens.length === 2) {
    return {
      verb: typedVerb,
      task: true,
      forwardedArgs: [],
      rewriteSafe: true,
      requiresOwner: true,
    };
  }
  // Go Task's canonical CLI_ARGS boundary. Flags without `--` are ambiguous
  // Task CLI flags and must not receive an auto-approving rewrite.
  if (tokens[2] !== "--") return null;
  const forwardedArgs = tokens.slice(3);
  const { rewriteSafe, readOnly } = analyzeLifecycleArguments(typedVerb, forwardedArgs);
  const requiresOwner = typedVerb !== "session:start" || !readOnly;
  return {
    verb: typedVerb,
    task: true,
    forwardedArgs,
    rewriteSafe: rewriteSafe && forwardedArgs.every((token) => !token.includes("\\")),
    requiresOwner,
  };
}

function exactLifecyclePayload(payload: unknown): ExactLifecyclePayload | null {
  const toolName = hookToolName(payload);
  if (toolName === null || !isShellTool(toolName)) {
    return null;
  }
  const input = record(payload);
  if (input === null) return null;
  const toolInput = toolInputRecord(input);
  if (toolInput === null || typeof toolInput.command !== "string") return null;
  const originalCommand = toolInput.command;
  const invocation = exactLifecycleInvocation(originalCommand);
  return invocation === null ? null : { invocation, originalCommand, toolInput };
}

/** Logical lifecycle verb for one exact, simple shell command; otherwise null. */
export function exactLifecycleCommandVerb(payload: unknown): ExactLifecycleVerb | null {
  return exactLifecyclePayload(payload)?.invocation.verb ?? null;
}

interface SessionIdArgs {
  readonly status: "absent" | "present" | "invalid";
  readonly values: readonly string[];
}

function sessionIdArgs(verb: ExactLifecycleVerb, args: readonly string[]): SessionIdArgs {
  const policy = LIFECYCLE_ARGUMENT_POLICIES[verb];
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token.startsWith("--session-id=")) {
      const value = token.slice("--session-id=".length);
      if (value.length === 0) return { status: "invalid", values: [] };
      values.push(value);
      continue;
    }
    if (token === "--session-id") {
      const value = args[i + 1];
      if (
        value === undefined ||
        value.length === 0 ||
        (verb === "swarm:launch" && value.startsWith("--"))
      ) {
        return { status: "invalid", values: [] };
      }
      values.push(value);
      i += 1;
      continue;
    }
    if (token.indexOf("=") < 0 && policy.valueFlags.has(token) && args[i + 1] !== undefined) i += 1;
  }
  if (values.length === 0) return { status: "absent", values };
  if (values.length !== 1) return { status: "invalid", values };
  return { status: "present", values };
}

export interface ExactLifecycleCommandInspection {
  readonly verb: ExactLifecycleVerb;
  readonly task: boolean;
  readonly rewriteSafe: boolean;
  readonly requiresOwner: boolean;
  readonly sessionIdStatus: SessionIdArgs["status"];
  readonly sessionId: string | null;
}

/** Inspect one exact lifecycle command without requiring a host identity. */
export function inspectExactLifecycleCommand(
  payload: unknown,
): ExactLifecycleCommandInspection | null {
  const exact = exactLifecyclePayload(payload);
  if (exact === null) return null;
  const session = sessionIdArgs(exact.invocation.verb, exact.invocation.forwardedArgs);
  return {
    verb: exact.invocation.verb,
    task: exact.invocation.task,
    rewriteSafe: exact.invocation.rewriteSafe,
    requiresOwner: exact.invocation.requiresOwner,
    sessionIdStatus: session.status,
    sessionId: session.status === "present" ? (session.values[0] ?? null) : null,
  };
}

/**
 * Append a canonical host owner to one exact Directive lifecycle command.
 *
 * The returned `updatedInput` is a complete shallow clone of the original
 * host tool input. `null` means no safe rewrite. An explicit foreign identity
 * is surfaced as a conflict so dispatcher wiring can deny instead of replacing
 * operator input.
 */
export function rewriteExactLifecycleCommand(
  payload: unknown,
  sessionId: string,
): ExactLifecycleCommandResult {
  if (!CANONICAL_OWNER_PATTERN.test(sessionId)) return null;
  const exact = exactLifecyclePayload(payload);
  if (exact === null) return null;
  const { invocation, originalCommand, toolInput } = exact;
  if (!invocation.rewriteSafe || !invocation.requiresOwner) return null;

  const existing = sessionIdArgs(invocation.verb, invocation.forwardedArgs);
  if (existing.status === "invalid") return null;
  if (existing.status === "present") {
    const existingSessionId = existing.values[0] ?? "";
    if (existingSessionId === sessionId) return null;
    return {
      kind: "conflict",
      verb: invocation.verb,
      existingSessionId,
      requestedSessionId: sessionId,
      message:
        `Lifecycle command ${invocation.verb} already names a different ` +
        "--session-id; refusing rewrite.",
    };
  }

  const taskForwarding = invocation.task && originalCommand.split(" ").length === 2 ? " --" : "";
  const rewrittenCommand = `${originalCommand}${taskForwarding} --session-id=${sessionId}`;
  return {
    kind: "rewrite",
    verb: invocation.verb,
    originalCommand,
    rewrittenCommand,
    updatedInput: { ...toolInput, command: rewrittenCommand },
  };
}
