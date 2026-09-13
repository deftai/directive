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

/** Host-visible process-only skip-class keys. Implement-class never sets these (#4315). */
const PROCESS_ONLY_FLAG_KEYS = ["process_only", "processOnly"] as const;
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
 * Grok PreToolUse stdin uses `toolInput` (camelCase). Pass is the field on
 * stdin, not advertised schema. Dest-path and prompt are not this class.
 * Implement-class never sets the flag.
 */
export function landProcessOnlyFlagOnToolInput(payload: unknown): unknown {
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
  if (current !== null && current.process_only === true) return payload;
  const source = nested ?? camel ?? {};
  return { ...input, tool_input: { ...source, process_only: true } };
}
