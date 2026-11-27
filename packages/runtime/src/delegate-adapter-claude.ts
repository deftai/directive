/**
 * Claude Code host adapter for TOTP delegation arming (#7420 B1 / clause 20).
 *
 * Thin by contract: it extracts the prompt text and the session id from the
 * `UserPromptSubmit` hook payload and hands them to the one core arming verb.
 * It decides nothing. It never blocks the prompt, never fails the hook, and is
 * quiet for prompts that hold no arm command and for repeats of an already
 * used code (a repeat is a no-op in core).
 *
 * Deposit wiring (the `UserPromptSubmit` and `SessionEnd` registrations in the
 * Claude settings deposit) is a separate installer change; this module is the
 * library the registered command runs (`deft delegate claude-hook`).
 */

import {
  type ArmDelegationInput,
  type ArmOutcome,
  armDelegation,
  formatArmOutcomeLine,
} from "@deftai/directive-core/authz";

/** Host label written into the record and audit. */
export const CLAUDE_DELEGATION_HOST = "claude";

/** Claude Code hook event this adapter reads for arming. */
export const CLAUDE_ARM_HOOK_EVENT = "UserPromptSubmit";

/** Claude Code hook event this adapter reads for session end. */
export const CLAUDE_SESSION_END_HOOK_EVENT = "SessionEnd";

export interface ClaudePromptSubmit {
  readonly promptText: string;
  readonly hostSessionId: string;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract `prompt` and `session_id` from a `UserPromptSubmit` payload. Null for
 * any other event or a malformed payload.
 */
export function extractClaudePromptSubmit(raw: string): ClaudePromptSubmit | null {
  const obj = parseObject(raw);
  if (obj === null) return null;
  const event = obj.hook_event_name;
  if (event !== undefined && event !== CLAUDE_ARM_HOOK_EVENT) return null;
  const prompt = obj.prompt;
  const session = obj.session_id;
  if (typeof prompt !== "string" || typeof session !== "string") return null;
  return { promptText: prompt, hostSessionId: session };
}

/** Extract `session_id` from a `SessionEnd` payload; null otherwise. */
export function extractClaudeSessionEnd(raw: string): string | null {
  const obj = parseObject(raw);
  if (obj === null) return null;
  const event = obj.hook_event_name;
  if (event !== undefined && event !== CLAUDE_SESSION_END_HOOK_EVENT) return null;
  const session = obj.session_id;
  return typeof session === "string" && session.trim().length > 0 ? session : null;
}

export interface ClaudeAdapterResult {
  /** Always 0: the adapter never blocks the prompt or fails the hook. */
  readonly exitCode: 0;
  /** Hook stdout (JSON additionalContext) or empty for a quiet outcome. */
  readonly stdout: string;
  readonly outcome: ArmOutcome | null;
}

/**
 * Run the adapter on one hook payload. `arm` is the core verb (seam for tests);
 * the adapter passes it only the prompt text and the session id, plus where
 * the store lives.
 */
export function runClaudeDelegateAdapter(input: {
  readonly stdinText: string;
  readonly projectRoot: string;
  readonly arm?: (input: ArmDelegationInput) => ArmOutcome;
  readonly armSeams?: Omit<
    ArmDelegationInput,
    "projectRoot" | "promptText" | "hostSessionId" | "host"
  >;
}): ClaudeAdapterResult {
  const payload = extractClaudePromptSubmit(input.stdinText);
  if (payload === null) return { exitCode: 0, stdout: "", outcome: null };
  let outcome: ArmOutcome;
  try {
    outcome = (input.arm ?? armDelegation)({
      ...(input.armSeams ?? {}),
      projectRoot: input.projectRoot,
      promptText: payload.promptText,
      hostSessionId: payload.hostSessionId,
      host: CLAUDE_DELEGATION_HOST,
    });
  } catch (err) {
    outcome = { kind: "refused-no-write", reason: `arming failed: ${String(err)}` };
  }
  const line = formatArmOutcomeLine(outcome);
  if (line === null) return { exitCode: 0, stdout: "", outcome };
  const stdout = `${JSON.stringify({
    hookSpecificOutput: { hookEventName: CLAUDE_ARM_HOOK_EVENT, additionalContext: line },
  })}\n`;
  return { exitCode: 0, stdout, outcome };
}
