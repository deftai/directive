/**
 * Pure payload field accessors for host PreToolUse shapes (#2950).
 * No process I/O.
 */

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First non-empty trimmed string from candidates. */
export function firstString(values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function fieldPresent(input: Record<string, unknown>, key: string): boolean {
  return key in input;
}

export function fieldString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

/**
 * Nested tool input record across host spellings
 * (`tool_input` / `arguments` / `tool_call.arguments` / …).
 */
export function toolInputRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const toolCall = record(payload.tool_call) ?? record(payload.toolCall);
  return (
    record(payload.tool_input) ??
    record(payload.toolInput) ??
    record(payload.input) ??
    record(payload.arguments) ??
    (toolCall !== null ? record(toolCall.arguments) : null)
  );
}

export function hookPayloadTopLevelKeys(payload: unknown): string[] {
  const input = record(payload);
  if (input === null) return [];
  return Object.keys(input).sort();
}

const STDIN_ENV_BAG_KEYS = ["env", "environ"] as const;

/** Stdin env bag for per-spawn hook environ (#4393). Not process-wide DEFT_ACTIVE_SCOPE. */
export function hookPayloadEnvironBag(payload: unknown): NodeJS.ProcessEnv | null {
  const input = record(payload);
  if (input === null) return null;
  for (const key of STDIN_ENV_BAG_KEYS) {
    const bag = record(input[key]);
    if (bag === null) continue;
    const env: NodeJS.ProcessEnv = {};
    let any = false;
    for (const [name, value] of Object.entries(bag)) {
      if (typeof value === "string") {
        env[name] = value;
        any = true;
      }
    }
    if (any) return env;
  }
  return null;
}

/**
 * Merge stdin env bag over fallback. `undefined` means no bag — callers omit
 * `environ` so `decideHook` keeps process.env as the CLI fallback.
 */
export function mergeHookDispatchEnviron(
  payload: unknown,
  fallback: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  const bag = hookPayloadEnvironBag(payload);
  if (bag === null) return undefined;
  return { ...fallback, ...bag };
}

/** Canonical advertised writing skip-class field on native spawn_subagent JSON (#4794). */
export const GROK_SPAWN_WRITING_SKIP_CLASS_FIELD = "process_only" as const;

/** Host-visible process-only skip-class keys. Implement-class never sets these (#4315 / #4794). */
export const PROCESS_ONLY_FLAG_KEYS = [GROK_SPAWN_WRITING_SKIP_CLASS_FIELD, "processOnly"] as const;

/**
 * Advertised Grok spawn_subagent JSON (#4794).
 * Writing skip-class is process_only. Dest-path (cwd) is not skip class.
 * Implement-class never sets the skip-class field.
 */
export const GROK_SPAWN_SUBAGENT_ADVERTISED_JSON = {
  name: "spawn_subagent",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      description: { type: "string" },
      subagent_type: {
        type: "string",
        enum: ["general-purpose", "explore", "plan"],
      },
      background: { type: "boolean" },
      isolation: { type: "string" },
      resume_from: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      process_only: {
        type: "boolean",
        description:
          "Writing skip-class. Implement-class never sets this. Dest-path is not this class.",
      },
    },
  },
} as const;

/**
 * Production skip-class field operators can pass on advertised spawn_subagent JSON (#4794).
 * Classification honors this field only when advertised JSON lists it as a boolean
 * that is not dest-path (`cwd`).
 */
export function grokSpawnAdvertisedWritingSkipClass():
  | typeof GROK_SPAWN_WRITING_SKIP_CLASS_FIELD
  | null {
  const advertised = GROK_SPAWN_SUBAGENT_ADVERTISED_JSON;
  if (advertised.name !== "spawn_subagent") return null;
  const destPathField: string = "cwd";
  if (GROK_SPAWN_WRITING_SKIP_CLASS_FIELD === destPathField) return null;
  const skip = advertised.parameters.properties[GROK_SPAWN_WRITING_SKIP_CLASS_FIELD];
  if (skip === undefined || skip.type !== "boolean") return null;
  return GROK_SPAWN_WRITING_SKIP_CLASS_FIELD;
}

const PROCESS_ONLY_TRUTHY = new Set(["1", "true", "yes", "on"]);

function fieldTruthy(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return PROCESS_ONLY_TRUTHY.has(value.trim().toLowerCase());
  return false;
}

function hasProcessOnlyFlag(input: Record<string, unknown>): boolean {
  return PROCESS_ONLY_FLAG_KEYS.some((key) => fieldTruthy(input, key));
}

/**
 * Land host-visible `process_only` onto canonical `tool_input` (#4315).
 * Grok PreToolUse stdin uses `toolInput` (camelCase). Production classification
 * lands the advertised skip-class field from GROK_SPAWN_SUBAGENT_ADVERTISED_JSON
 * (#4794). Dest-path and prompt are not this class. Implement-class never sets the flag.
 */
export function landProcessOnlyFlagOnToolInput(payload: unknown): unknown {
  const advertisedField = grokSpawnAdvertisedWritingSkipClass();
  if (advertisedField === null) return payload;
  const input = record(payload);
  if (input === null) return payload;
  const nested = toolInputRecord(input);
  const camel = record(input.toolInput);
  const flagged =
    (nested !== null && hasProcessOnlyFlag(nested)) ||
    (camel !== null && hasProcessOnlyFlag(camel)) ||
    hasProcessOnlyFlag(input);
  if (!flagged) return payload;
  const current = record(input.tool_input);
  if (camel === null && current !== null && current[advertisedField] === true) return payload;
  const source = { ...(camel ?? {}), ...(nested ?? {}) };
  return { ...input, tool_input: { ...source, [advertisedField]: true } };
}
