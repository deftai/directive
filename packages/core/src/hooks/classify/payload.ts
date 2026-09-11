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
