import { READ_ONLY_HOOK_ENV } from "./tools.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

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
