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

/** One remediation when a command cannot fail (#3396). */
export const NOOP_ACCEPTANCE_REMEDIATION =
  "acceptance commands must be able to fail; name a command that exercises the artifact";

/** Capture/stamp outcome recorded on the acceptance event (#3396). */
export const REJECTED_NOOP_OUTCOME = "rejected-noop" as const;

export type RejectedNoopOutcome = typeof REJECTED_NOOP_OUTCOME;

export interface CommandSafetyResult {
  readonly ok: boolean;
  readonly reason: string | null;
  /** Set when the command is a denylisted no-op (#3396). */
  readonly outcome?: RejectedNoopOutcome;
}

/** First tokens that always succeed or always fail without exercising an artifact. */
const NOOP_FIRST_TOKENS = new Set(["true", "false", ":", "echo", "printf"]);

/** `test` operators that inspect a path (not a constant comparison). */
const TEST_FILE_OPERATORS = new Set([
  "-b",
  "-c",
  "-d",
  "-e",
  "-f",
  "-g",
  "-h",
  "-k",
  "-L",
  "-p",
  "-r",
  "-S",
  "-s",
  "-t",
  "-u",
  "-w",
  "-x",
]);

function firstTokenAndRest(trimmed: string): { readonly first: string; readonly rest: string } {
  let end = 0;
  while (end < trimmed.length && trimmed[end] !== " " && trimmed[end] !== "\t") {
    end += 1;
  }
  return { first: trimmed.slice(0, end).toLowerCase(), rest: trimmed.slice(end).trim() };
}

function noopRefusal(): CommandSafetyResult {
  return {
    ok: false,
    reason: NOOP_ACCEPTANCE_REMEDIATION,
    outcome: REJECTED_NOOP_OUTCOME,
  };
}

/**
 * Unconditional no-ops cannot be acceptance oracles (#3396).
 * `test` with only constant args is a no-op; `test -f path` is an assertion.
 */
export function evaluateNoopDenylist(command: string): CommandSafetyResult {
  if (typeof command !== "string") {
    return { ok: true, reason: null };
  }
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { ok: true, reason: null };
  }
  const { first, rest } = firstTokenAndRest(trimmed);
  if (NOOP_FIRST_TOKENS.has(first)) {
    return noopRefusal();
  }
  if (first === "exit" && rest.length === 0) {
    return noopRefusal();
  }
  if (first === "test") {
    const tokens = rest.length === 0 ? [] : rest.split(/\s+/);
    if (!tokens.some((token) => TEST_FILE_OPERATORS.has(token))) {
      return noopRefusal();
    }
  }
  return { ok: true, reason: null };
}

/** True when a refusal reason is the #3396 no-op remediation. */
export function isNoopRefusalReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.includes("acceptance commands must be able to fail");
}

/**
 * Capture records verbatim statement spans as fence@ / labeled@ / prompt@ / inline@.
 * Metadata and plan.acceptance mirrors are not statement provenance.
 */
export function isVerbatimStatementSpan(sourceSpan: string | null | undefined): boolean {
  if (typeof sourceSpan !== "string" || sourceSpan.trim().length === 0) {
    return false;
  }
  return /^(fence|labeled|prompt|inline)@/i.test(sourceSpan.trim());
}

export type StampSourceRung = "stated" | "derived" | "project_floor";

export interface StampAcceptanceCommand {
  readonly command: string;
  readonly source?: string;
  readonly sourceSpan?: string | null;
}

export interface StampAcceptanceSafetyInput {
  readonly commands: readonly StampAcceptanceCommand[];
  readonly previousRung?: StampSourceRung | null;
}

export interface StampAcceptanceSafetyResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly outcome?: RejectedNoopOutcome;
  readonly sourceRung: StampSourceRung;
  readonly hasVerbatimStatementSpan: boolean;
}

function commandHasStatementProvenance(cmd: StampAcceptanceCommand): boolean {
  if (cmd.source !== undefined && cmd.source !== "task_statement") {
    return false;
  }
  return isVerbatimStatementSpan(cmd.sourceSpan ?? null);
}

/**
 * Stamp-time no-op refuse + stated-only-with-span (#3396).
 * A restamp cannot raise the rung to stated without a recorded statement span.
 */
export function evaluateStampAcceptanceSafety(
  input: StampAcceptanceSafetyInput,
): StampAcceptanceSafetyResult {
  const hasVerbatimStatementSpan = input.commands.some(commandHasStatementProvenance);
  let sourceRung: StampSourceRung;
  if (input.commands.length === 0) {
    sourceRung = input.previousRung ?? "project_floor";
  } else if (hasVerbatimStatementSpan) {
    sourceRung = "stated";
  } else {
    sourceRung = "derived";
  }
  for (const cmd of input.commands) {
    const noop = evaluateNoopDenylist(cmd.command);
    if (!noop.ok) {
      return {
        ok: false,
        reason: noop.reason,
        outcome: REJECTED_NOOP_OUTCOME,
        sourceRung,
        hasVerbatimStatementSpan,
      };
    }
  }
  return {
    ok: true,
    reason: null,
    sourceRung,
    hasVerbatimStatementSpan,
  };
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
  const noop = evaluateNoopDenylist(trimmed);
  if (!noop.ok) {
    return noop;
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
  // npx is stricter (no run/exec registry forms) — see evaluatePackageManagerArgs.
  if (
    first === "pnpm" ||
    first === "npm" ||
    first === "npx" ||
    first === "yarn" ||
    first === "bun"
  ) {
    return evaluatePackageManagerArgs(rest, first);
  }

  // vitest first-token: allow run / related test args only (no watch/ui).
  if (first === "vitest") {
    return evaluateVitestArgs(rest);
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

/**
 * Package-manager subcommand allowlist (no install/publish/exec of arbitrary bins).
 * `npx` is stricter than npm/pnpm/yarn/bun: it must not accept `run`/`exec` forms that
 * resolve arbitrary registry packages with inherited env (Greptile conf residual).
 */
function evaluatePackageManagerArgs(rest: string, firstToken: string): CommandSafetyResult {
  if (rest.length === 0) {
    return { ok: false, reason: "package manager requires a restricted subcommand" };
  }
  const low = rest.toLowerCase();

  // npx: only vitest (direct) or version/help — no `npx run` / `npx exec <pkg>` registry path.
  if (firstToken === "npx") {
    if (low === "--version" || low === "-v" || low === "--help" || low === "-h") {
      return { ok: true, reason: null };
    }
    if (low === "vitest" || low.startsWith("vitest ")) {
      const after = low === "vitest" ? "" : low.slice("vitest".length).trim();
      return evaluateVitestArgs(after);
    }
    return {
      ok: false,
      reason:
        "npx is limited to vitest|--version|--help " +
        "(npx run/exec/registry packages denied for ambient-authority)",
    };
  }

  // exec: only vitest (not deft/task — those re-open wrapper ambient authority).
  if (low.startsWith("exec ")) {
    const afterExec = low.slice("exec ".length).trim();
    if (afterExec === "vitest" || afterExec.startsWith("vitest ")) {
      const after = afterExec === "vitest" ? "" : afterExec.slice("vitest".length).trim();
      return evaluateVitestArgs(after);
    }
    return {
      ok: false,
      reason:
        "package-manager exec is limited to vitest " +
        "(exec of deft/task/other bins denied for ambient-authority)",
    };
  }
  if (low.startsWith("run vitest")) {
    const after = low.slice("run vitest".length).trim();
    return evaluateVitestArgs(after.length > 0 ? `run ${after}` : "run");
  }
  const allowedPm =
    low === "test" ||
    low === "--version" ||
    low === "-v" ||
    low.startsWith("test ") ||
    low.startsWith("run test") ||
    low.startsWith("run check");
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

/**
 * Vitest args: only non-interactive run paths. Deny watch/ui/browser hang modes.
 */
function evaluateVitestArgs(rest: string): CommandSafetyResult {
  const low = rest.trim().toLowerCase();
  if (low.length === 0) {
    // bare `vitest` defaults to watch in many setups — refuse closed.
    return {
      ok: false,
      reason: "vitest requires explicit run (bare vitest defaults to watch; denied)",
    };
  }
  for (const bad of ["watch", "ui", "browser", "--watch", "--ui", "--browser", "dev"]) {
    if (
      low === bad ||
      low.startsWith(`${bad} `) ||
      low.endsWith(` ${bad}`) ||
      low.includes(` ${bad} `)
    ) {
      return {
        ok: false,
        reason: `vitest ${bad} is denied (hang/interactive mode; use run)`,
      };
    }
  }
  if (
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
