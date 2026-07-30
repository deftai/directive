/**
 * Map hook tool invocations to authz operation classes (#2944).
 * Reuses #2711 push/merge shell classification; adds PR create/advance detection
 * for UAT denials without re-owning runtimeAuthority Shell matchers.
 */

import {
  classifyMcpTool,
  classifyShellCommand,
  listShellOps,
  type RuntimeAuthorityShellOp,
} from "../policy/runtime-authority.js";
import type { AuthzOperation } from "./types.js";

export type AuthzClassifiedOp = AuthzOperation | "test" | "evidence" | "unknown";

/** Best-effort shell classification for UAT-sensitive ops beyond push/merge. */
export function classifyShellAuthzOps(command: string): AuthzClassifiedOp[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [];

  const found = new Set<AuthzClassifiedOp>();
  for (const op of listShellOps(cmd)) {
    found.add(op);
  }

  // PR create / advance (Wave 1 UAT denials; full verb program remains #1095).
  const lower = cmd.toLowerCase();
  if (
    /\bgh(?:\.exe)?\s+pr\s+create\b/.test(lower) ||
    /\bgh(?:\.exe)?\s+pr\s+edit\b/.test(lower) ||
    /\bgh(?:\.exe)?\s+pr\s+ready\b/.test(lower) ||
    /\bgh(?:\.exe)?\s+pr\s+reopen\b/.test(lower)
  ) {
    found.add("pr");
  }

  // Issue filing remains allowed under UAT.
  if (
    /\bgh(?:\.exe)?\s+issue\s+create\b/.test(lower) ||
    /\bgh(?:\.exe)?\s+api\s+.*\/issues\b/.test(lower)
  ) {
    found.add("issue_mutation");
  }

  // Test runners — allow under UAT.
  if (
    /\b(vitest|pytest|go\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|task\s+test)\b/.test(
      lower,
    )
  ) {
    found.add("test");
  }

  // Settings / deploy heuristics (narrow).
  if (
    /\bgh(?:\.exe)?\s+repo\s+edit\b/.test(lower) ||
    /\bgh(?:\.exe)?\s+api\s+.*\/settings\b/.test(lower)
  ) {
    found.add("settings");
  }
  if (
    /\b(terraform\s+apply|helm\s+upgrade|kubectl\s+apply|fly\s+deploy|vercel\s+deploy)\b/.test(
      lower,
    )
  ) {
    found.add("deployment");
  }

  return [...found];
}

/** Map a PreToolUse tool name + optional shell command to authz ops. */
export function classifyHookAuthzOps(input: {
  readonly toolName: string;
  readonly shellCommand: string | null;
  readonly isDirectWrite: boolean;
  readonly mcpArgsText?: string | null;
}): AuthzClassifiedOp[] {
  const { toolName, shellCommand, isDirectWrite } = input;
  if (isDirectWrite) return ["edit"];

  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower === "run_terminal_cmd") {
    // Missing command string: fail open (host gap) — same posture as #2711.
    if (shellCommand === null) return [];
    // Empty classification (git status, tests without product verbs, …) is not gated.
    return classifyShellAuthzOps(shellCommand);
  }

  // MCP / bare names via #2711 classifier + PR heuristics.
  const mcpOp: RuntimeAuthorityShellOp | null = classifyMcpTool(
    toolName,
    input.mcpArgsText ?? null,
  );
  if (mcpOp !== null) return [mcpOp];

  if (/create[_-]?pull[_-]?request|pull[_-]?request[_-]?create|pr[_-]?create/.test(lower)) {
    return ["pr"];
  }
  if (/create[_-]?issue|issue[_-]?create/.test(lower)) {
    return ["issue_mutation"];
  }

  // Unrelated tools — not gated by Wave 1 authz (prefer fail-open over false deny).
  return [];
}

/** Map RuntimeAuthority shell op into AuthzOperation (identity for push/merge). */
export function runtimeOpToAuthz(op: RuntimeAuthorityShellOp): AuthzOperation {
  return op;
}

/** Re-export #2711 classifiers for composition docs/tests. */
export { classifyMcpTool, classifyShellCommand, listShellOps };
