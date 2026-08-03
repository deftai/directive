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
  // Shared taxonomy with #3080 ephemeral spawn markers.
  if (isEphemeralSpawn(payload)) return true;
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
 * Ephemeral / assist / docs spawns skip active-xBRIEF implementation gates (#3080).
 * True only with an explicit allowlisted marker. Absent marker → false (fail closed).
 * When an ephemeral marker conflicts with implement envelope signals, implement wins.
 */
export function isEphemeralSpawn(payload: unknown): boolean {
  const input = record(payload);
  if (input === null) return false;
  const toolInput = toolInputRecord(input) ?? input;
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
  const marker =
    (workerRole !== null && EPHEMERAL_ROLE_MARKERS.has(workerRole.toLowerCase())
      ? workerRole.toLowerCase()
      : null) ??
    (subagentType !== null && EPHEMERAL_ROLE_MARKERS.has(subagentType.toLowerCase())
      ? subagentType.toLowerCase()
      : null);
  if (marker === null) return false;
  // Implement signals win over ephemeral markers (fail closed).
  if (hasImplementConflictSignal(toolInput, input)) return false;
  return true;
}
