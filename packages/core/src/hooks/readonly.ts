import { READ_ONLY_HOOK_ENV } from "./tools.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Session posture env for assist/research low-ceremony writes (#1802). */
export const ASSIST_SESSION_POSTURE_ENV = "DEFT_SESSION_POSTURE";

/** Explicit non-lifecycle assist markers (#3080 / #1802). Primary: ephemeral; aliases: docs, assist. */
const EPHEMERAL_ROLE_MARKERS = new Set(["ephemeral", "docs", "assist"]);

/** Assist/research session posture tokens (structural; not free-text NLP) (#1802). */
const ASSIST_POSTURE_MARKERS = new Set([
  "assist",
  "ephemeral",
  "docs",
  "research",
  "research-notes",
  "research_notes",
  "scratch",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function envTruthy(environ: NodeJS.ProcessEnv, name: string): boolean {
  return TRUTHY.has((environ[name] ?? "").trim().toLowerCase());
}

function isReadOnlyCapability(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.toLowerCase().replace(/[_\s-]/g, "");
  return normalized === "readonly";
}

function normalizePostureToken(value: string): string {
  return value.toLowerCase().replace(/[_\s]/g, "-");
}

/** Best-effort read-only explore signal from host payload (#1185). */
export function hookReadOnlyFromPayload(payload: unknown): boolean {
  const input = record(payload);
  if (input === null) return false;
  const toolInput = toolInputRecord(input) ?? input;
  const capability =
    fieldString(toolInput, "capability_mode") ??
    fieldString(toolInput, "capabilityMode") ??
    fieldString(toolInput, "default_capability_mode") ??
    fieldString(toolInput, "defaultCapabilityMode") ??
    fieldString(input, "capability_mode") ??
    fieldString(input, "capabilityMode") ??
    fieldString(input, "default_capability_mode") ??
    fieldString(input, "defaultCapabilityMode");
  if (isReadOnlyCapability(capability)) return true;
  const posture =
    fieldString(toolInput, "posture") ??
    fieldString(input, "posture") ??
    fieldString(input, "session_posture") ??
    fieldString(input, "sessionPosture");
  if (isReadOnlyCapability(posture)) return true;
  if (toolInput.readOnly === true || toolInput.read_only === true) return true;
  if (input.readOnly === true || input.read_only === true) return true;
  return false;
}

/** Read-only hook context: env override or host payload marker (#1185). */
export function isReadOnlyHookContext(
  payload: unknown,
  environ: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envTruthy(environ, READ_ONLY_HOOK_ENV)) return true;
  return hookReadOnlyFromPayload(payload);
}

/** Explore sub-agent spawns are exempt from the implementation gate stack (#1185). */
export function isExploreSpawn(payload: unknown): boolean {
  const input = record(payload);
  if (input === null) return false;
  const toolInput = toolInputRecord(input) ?? input;
  const subagentType =
    fieldString(toolInput, "subagent_type") ??
    fieldString(toolInput, "subagentType") ??
    fieldString(input, "subagent_type") ??
    fieldString(input, "subagentType");
  if (subagentType?.toLowerCase() === "explore") return true;
  const workerRole =
    fieldString(toolInput, "worker_role") ??
    fieldString(toolInput, "workerRole") ??
    fieldString(input, "worker_role") ??
    fieldString(input, "workerRole");
  return workerRole?.toLowerCase() === "explore";
}

/**
 * Assist / research / ephemeral session posture for low-ceremony scratch writes (#1802).
 * Structural markers only (env, payload posture fields, worker_role/subagent_type).
 * Absent marker → false (fail closed). Compose with allowlisted scratch path fence.
 */
export function isAssistPosture(
  payload: unknown,
  environ: NodeJS.ProcessEnv = process.env,
): boolean {
  const envPosture = (environ[ASSIST_SESSION_POSTURE_ENV] ?? "").trim();
  if (envPosture.length > 0 && ASSIST_POSTURE_MARKERS.has(normalizePostureToken(envPosture))) {
    return true;
  }
  // Explicit assist env override (truthy), separate from posture token names.
  if (envTruthy(environ, "DEFT_HOOK_ASSIST")) return true;

  const input = record(payload);
  if (input === null) return false;
  const toolInput = toolInputRecord(input) ?? input;
  const posture =
    fieldString(toolInput, "posture") ??
    fieldString(toolInput, "session_posture") ??
    fieldString(toolInput, "sessionPosture") ??
    fieldString(input, "posture") ??
    fieldString(input, "session_posture") ??
    fieldString(input, "sessionPosture");
  if (posture !== null && ASSIST_POSTURE_MARKERS.has(normalizePostureToken(posture))) {
    return true;
  }
  // Shared taxonomy with #3080 / #3259 ephemeral spawn markers.
  if (isEphemeralSpawn(payload, environ)) return true;
  return false;
}

/**
 * Structural implement signals that win over an ephemeral marker (fail closed, #3080).
 * Detected from envelope fields only — never free-text prompt heuristics.
 */
function hasImplementConflictSignal(
  toolInput: Record<string, unknown>,
  input: Record<string, unknown>,
): boolean {
  const driveTo =
    fieldString(toolInput, "drive_to") ??
    fieldString(toolInput, "driveTo") ??
    fieldString(toolInput, "drive-to") ??
    fieldString(input, "drive_to") ??
    fieldString(input, "driveTo") ??
    fieldString(input, "drive-to");
  if (driveTo !== null) {
    const normalized = driveTo.toLowerCase().replace(/[_\s]/g, "-");
    if (
      normalized === "merge-ready" ||
      normalized === "merge" ||
      normalized.startsWith("merge-") ||
      normalized.includes("implement")
    ) {
      return true;
    }
  }
  // Non-ephemeral worker roles that imply product implementation / swarm leaf.
  // Skip when this field is itself the ephemeral marker (conflict is via other fields).
  const workerRole =
    fieldString(toolInput, "worker_role") ??
    fieldString(toolInput, "workerRole") ??
    fieldString(input, "worker_role") ??
    fieldString(input, "workerRole");
  if (workerRole !== null && !EPHEMERAL_ROLE_MARKERS.has(workerRole.toLowerCase())) {
    const role = workerRole.toLowerCase().replace(/[_\s]/g, "-");
    if (
      role === "leaf-implementation" ||
      role === "implementation" ||
      role === "implement" ||
      role.includes("implement")
    ) {
      return true;
    }
  }
  const dispatchKind =
    fieldString(toolInput, "dispatch_kind") ??
    fieldString(toolInput, "dispatchKind") ??
    fieldString(input, "dispatch_kind") ??
    fieldString(input, "dispatchKind");
  if (dispatchKind !== null) {
    const kind = dispatchKind.toLowerCase().replace(/[_\s]/g, "-");
    if (kind === "swarm-cohort" || kind === "swarm-leaf" || kind.includes("implement")) {
      return true;
    }
  }
  return false;
}

/**
 * Session assist env tokens that count as structural ephemeral markers for spawn (#3259).
 * Reuses #1802 ASSIST_POSTURE_MARKERS / DEFT_HOOK_ASSIST — not free-text NLP.
 */
function hasSessionAssistEphemeralEnv(environ: NodeJS.ProcessEnv): boolean {
  const envPosture = (environ[ASSIST_SESSION_POSTURE_ENV] ?? "").trim();
  if (envPosture.length > 0 && ASSIST_POSTURE_MARKERS.has(normalizePostureToken(envPosture))) {
    return true;
  }
  return envTruthy(environ, "DEFT_HOOK_ASSIST");
}

/**
 * Ephemeral / assist / docs spawns skip active-xBRIEF implementation gates (#3080 / #3259).
 * True only with an explicit allowlisted marker. Absent marker → false (fail closed).
 * Markers: structural `worker_role`/`subagent_type` ∈ {ephemeral,docs,assist}, OR
 * session assist env (`DEFT_SESSION_POSTURE` assist-set / `DEFT_HOOK_ASSIST=1`) for spawn.
 * Free-text prompt strings are never classified. When a marker conflicts with implement
 * envelope signals, implement wins.
 */
export function isEphemeralSpawn(
  payload: unknown,
  environ: NodeJS.ProcessEnv = process.env,
): boolean {
  const input = record(payload);
  const toolInput = input !== null ? (toolInputRecord(input) ?? input) : null;

  let hasMarker = false;
  if (input !== null && toolInput !== null) {
    const subagentType =
      fieldString(toolInput, "subagent_type") ??
      fieldString(toolInput, "subagentType") ??
      fieldString(input, "subagent_type") ??
      fieldString(input, "subagentType");
    const workerRole =
      fieldString(toolInput, "worker_role") ??
      fieldString(toolInput, "workerRole") ??
      fieldString(input, "worker_role") ??
      fieldString(input, "workerRole");
    if (
      (workerRole !== null && EPHEMERAL_ROLE_MARKERS.has(workerRole.toLowerCase())) ||
      (subagentType !== null && EPHEMERAL_ROLE_MARKERS.has(subagentType.toLowerCase()))
    ) {
      hasMarker = true;
    }
  }
  // #3259 D1-B: session assist env is a structural ephemeral marker for spawn tools.
  // Call sites gate "spawn only"; this helper stays pure classification.
  if (!hasMarker && hasSessionAssistEphemeralEnv(environ)) {
    hasMarker = true;
  }
  if (!hasMarker) return false;

  // Implement signals win over ephemeral markers including session assist env (fail closed).
  if (input !== null && toolInput !== null && hasImplementConflictSignal(toolInput, input)) {
    return false;
  }
  return true;
}

/** Grok PreToolUse stdin field for process-only critic spawn (#4241). Not explore. */
const PROCESS_ONLY_CRITIC_SUBAGENT_TYPE = "plan";

/** Host-visible spawn flag implement-class never sets (#4296). Not dest-path. */
const PROCESS_ONLY_CRITIC_FLAG_KEYS = ["process_only", "processOnly"] as const;

function fieldTruthy(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return TRUTHY.has(value.trim().toLowerCase());
  return false;
}

function hasProcessOnlyCriticFlag(
  toolInput: Record<string, unknown>,
  input: Record<string, unknown>,
): boolean {
  return PROCESS_ONLY_CRITIC_FLAG_KEYS.some(
    (key) => fieldTruthy(toolInput, key) || fieldTruthy(input, key),
  );
}

/** Verified Grok spawn surface that actually emits `subagent_type` (#4241). */
const GROK_SPAWN_TOOL_NORMALIZED = "spawnsubagent";

export interface ProcessOnlyCriticSpawnContext {
  readonly host: string;
  readonly toolName?: string | null;
  readonly environ?: NodeJS.ProcessEnv;
}

function normalizedHookToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isGrokSpawnToolName(toolName: string | null | undefined): boolean {
  if (typeof toolName !== "string" || toolName.trim().length === 0) return false;
  return normalizedHookToolName(toolName) === GROK_SPAWN_TOOL_NORMALIZED;
}

/**
 * Grok hook-process identity (#4272). `GROK_HOOK_EVENT` is injected into every
 * Grok hook process. `GROK_SESSION_ID` is read from the hook environ object
 * when the caller supplied one — not from ambient `process.env`, so a Grok
 * TUI test runner does not flip Cursor Task dest occupancy.
 */
export function isGrokHookProcess(environ?: NodeJS.ProcessEnv): boolean {
  const env = environ ?? process.env;
  return Boolean(env.GROK_HOOK_EVENT?.trim() || env.GROK_SESSION_ID?.trim());
}

export interface GrokSpawnDestContractInput {
  readonly host: string;
  readonly toolName?: string | null;
  readonly payload?: unknown;
  readonly environ?: NodeJS.ProcessEnv;
}

/**
 * Handler-runtime identity for Grok dest occupancy (#4272).
 * True when argv host is grok, the hook process is Grok, or the tool is
 * `spawn_subagent` (Grok aliases Task onto the shared Cursor/Claude deposit).
 */
export function appliesGrokSpawnDestContract(input: GrokSpawnDestContractInput): boolean {
  if (input.host === "grok") return true;
  if (isGrokHookProcess(input.environ)) return true;
  if (isGrokSpawnToolName(input.toolName)) return true;
  const payload = record(input.payload);
  if (payload === null) return false;
  return isGrokSpawnToolName(fieldString(payload, "tool_name") ?? fieldString(payload, "toolName"));
}

/**
 * Process-only critic spawn: dest occupancy skip without the explore tool allowlist
 * (#4241 / #4296). True on Grok `spawn_subagent` when a host-visible stdin marker
 * implement-class never sets is present: `subagent_type` `plan`, or `process_only`.
 * Dest-path (`cwd`) is not a class. Prompt text is never a class. Do not skip
 * #2885 on destProven. Implement envelope signals win.
 */
export function isProcessOnlyCriticSpawn(
  payload: unknown,
  context: ProcessOnlyCriticSpawnContext,
): boolean {
  const input = record(payload);
  if (input === null) return false;
  const toolName =
    (typeof context.toolName === "string" && context.toolName.trim().length > 0
      ? context.toolName.trim()
      : null) ??
    fieldString(input, "tool_name") ??
    fieldString(input, "toolName");
  if (!isGrokSpawnToolName(toolName)) return false;
  if (
    !appliesGrokSpawnDestContract({
      host: context.host,
      toolName,
      payload,
      environ: context.environ,
    })
  ) {
    return false;
  }
  const toolInput = toolInputRecord(input) ?? input;
  const subagentType =
    fieldString(toolInput, "subagent_type") ??
    fieldString(toolInput, "subagentType") ??
    fieldString(input, "subagent_type") ??
    fieldString(input, "subagentType");
  const isPlan = subagentType?.toLowerCase() === PROCESS_ONLY_CRITIC_SUBAGENT_TYPE;
  const isFlag = hasProcessOnlyCriticFlag(toolInput, input);
  if (!isPlan && !isFlag) return false;
  return !hasImplementConflictSignal(toolInput, input);
}
