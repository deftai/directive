/**
 * Safety filters for literal acceptance commands (#3267 Greptile P1).
 *
 * Stored commands may originate from issue text. Before shell execution they
 * MUST pass an allowlist of argv-shaped CLI invocations without shell metacharacters.
 * source=task_statement is capture-only until agent promotes to verify_commands.
 *
 * Wrapper verbs (task/deft/directive) and package managers are further restricted
 * to read-only / verification subcommands so ambient credentials and lifecycle
 * mutations cannot ride an acceptance command (#3267 residual).
 */

import type { LiteralAcceptanceSource } from "./types.js";
import { EXECUTABLE_LITERAL_SOURCES } from "./types.js";

/** Characters that imply shell composition / expansion (refuse closed). */
const SHELL_META_CHARS = new Set([
  ";",
  "|",
  "&",
  "`",
  "\n",
  "\r",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "$",
  "\0",
]);

/**
 * First-token allowlist for **execution** (#3267 Greptile P1 ambient-authority).
 * Network/SCM tools (curl/gh/git/docker) are intentionally excluded — they retain
 * ambient credentials. Capture may still record broader CLI shape; only these
 * tokens may spawn, and wrappers/PMs require subcommand allowlists below.
 */
const ALLOWED_FIRST_TOKENS = new Set([
  "task",
  "deft",
  "directive",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "vitest",
  "true",
  "false",
]);

/**
 * Exact wrapper subcommands that are verification-shaped (no scope/policy/scm/swarm
 * mutations). Additional args after these tokens are allowed (e.g. `task check --json`).
 */
const ALLOWED_WRAPPER_SUBCOMMANDS = new Set([
  "check",
  "doctor",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
  "test",
]);

/**
 * Prefixes for wrapper verbs that stay on the verify/read surface.
 * `verify:` / `verify-` cover task verify:* family; bare `verify ` is the space form.
 */
const ALLOWED_WRAPPER_PREFIXES = ["verify:", "verify-", "verify "] as const;

export interface CommandSafetyResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

/** Whether this provenance is allowed to spawn a shell (#3267). */
export function isExecutableLiteralSource(source: LiteralAcceptanceSource | string): boolean {
  return (EXECUTABLE_LITERAL_SOURCES as readonly string[]).includes(source);
}

/**
 * Linear-time scan: refuse shell metacharacters and non-allowlisted first tokens.
 * Intentionally does not parse full shell grammar — fail closed on ambiguity.
 */
export function evaluateCommandSafety(command: string): CommandSafetyResult {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, reason: "empty command" };
  }
  const trimmed = command.trim();
  if (trimmed.length > 500) {
    return { ok: false, reason: "command exceeds 500 characters" };
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] as string;
    if (SHELL_META_CHARS.has(ch)) {
      return {
        ok: false,
        reason: `shell metacharacter ${JSON.stringify(ch)} is not allowed in literal AC commands`,
      };
    }
  }
  let end = 0;
  while (end < trimmed.length && trimmed[end] !== " " && trimmed[end] !== "\t") {
    end += 1;
  }
  const first = trimmed.slice(0, end).toLowerCase();
  if (first.includes("/") || first.includes("\\") || first.includes(":")) {
    return { ok: false, reason: "path-like first token is not allowlisted" };
  }
  if (!ALLOWED_FIRST_TOKENS.has(first)) {
    return {
      ok: false,
      reason: `first token ${JSON.stringify(first)} is not in the literal-AC allowlist`,
    };
  }

  const rest = trimmed.slice(end).trim();

  // Framework wrappers: only verification / help / version subcommands (no scope/policy/merge).
  if (first === "task" || first === "deft" || first === "directive") {
    return evaluateWrapperSubcommand(rest);
  }

  // Package managers: only test/exec vitest/run test|check|--version (no install/publish/net).
  if (first === "pnpm" || first === "npm" || first === "npx" || first === "yarn" || first === "bun") {
    return evaluatePackageManagerArgs(rest);
  }

  // vitest first-token: allow run / related test args only.
  if (first === "vitest") {
    const low = rest.toLowerCase();
    if (
      rest.length === 0 ||
      low === "run" ||
      low.startsWith("run ") ||
      low === "--version" ||
      low === "-v" ||
      low.startsWith("--run")
    ) {
      return { ok: true, reason: null };
    }
    return {
      ok: false,
      reason: "vitest args must be run|--version (watch/ui/network denied for ambient-authority)",
    };
  }

  return { ok: true, reason: null };
}

/**
 * Restrict task/deft/directive to verification-shaped subcommands.
 * Fail closed on scope/policy/swarm/pr/scm/lifecycle mutations.
 */
function evaluateWrapperSubcommand(rest: string): CommandSafetyResult {
  if (rest.length === 0) {
    return {
      ok: false,
      reason: "wrapper verb (task/deft/directive) requires a restricted verification subcommand",
    };
  }
  const low = rest.toLowerCase();
  // First subcommand token (before flags/args).
  let subEnd = 0;
  while (subEnd < low.length && low[subEnd] !== " " && low[subEnd] !== "\t") {
    subEnd += 1;
  }
  const sub = low.slice(0, subEnd);

  if (ALLOWED_WRAPPER_SUBCOMMANDS.has(sub)) {
    return { ok: true, reason: null };
  }
  for (const prefix of ALLOWED_WRAPPER_PREFIXES) {
    if (low.startsWith(prefix)) {
      return { ok: true, reason: null };
    }
  }
  return {
    ok: false,
    reason:
      "wrapper subcommand must be check|doctor|verify:*|help|--version " +
      "(scope/policy/swarm/scm/merge and other ambient-authority verbs denied)",
  };
}

/** Package-manager subcommand allowlist (no install/publish/exec of arbitrary bins). */
function evaluatePackageManagerArgs(rest: string): CommandSafetyResult {
  if (rest.length === 0) {
    return { ok: false, reason: "package manager requires a restricted subcommand" };
  }
  const low = rest.toLowerCase();
  // exec: only vitest (not deft/task — those re-open wrapper ambient authority).
  if (low.startsWith("exec ")) {
    const afterExec = low.slice("exec ".length).trim();
    if (afterExec === "vitest" || afterExec.startsWith("vitest ")) {
      return { ok: true, reason: null };
    }
    return {
      ok: false,
      reason:
        "package-manager exec is limited to vitest " +
        "(exec of deft/task/other bins denied for ambient-authority)",
    };
  }
  const allowedPm =
    low === "test" ||
    low === "--version" ||
    low === "-v" ||
    low.startsWith("test ") ||
    low.startsWith("run test") ||
    low.startsWith("run check") ||
    low.startsWith("run vitest");
  if (!allowedPm) {
    return {
      ok: false,
      reason:
        "package-manager args must be test|exec vitest|run test|run check|--version " +
        "(arbitrary scripts/network install denied for ambient-authority)",
    };
  }
  return { ok: true, reason: null };
}
