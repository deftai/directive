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
  // Windows cmd expands %NAME% inside an argument (GHSA-mq3j-2229-p7xx).
  "%",
  "\0",
]);

/**
 * First-token allowlist for **execution** (#3267 Greptile P1 ambient-authority).
 * Network/SCM tools (curl/gh/git/docker) are intentionally excluded — they retain
 * ambient credentials. Capture may still record broader CLI shape; only these
 * tokens may spawn. Wrappers, package managers, vitest, the Python interpreters,
 * and `node` require the argument grammars below. python, python3, and py are
 * exact `-m pytest` only (#4702). `node` is exact `--test` only (#4978). Bare
 * pytest, uv, and go test stay out.
 */
const PYTHON_PYTEST_INTERPRETERS = new Set(["python", "python3", "py"]);

/** Built-in `node --test --test-reporter` names (#4978). Exact whole-string match. */
const NODE_TEST_REPORTERS = new Set(["spec", "tap", "junit", "lcov", "dot"]);

/** Strip one layer of matching wrapping quotes so shell-stripped dash forms cannot bypass. */
function unwrapShellQuotes(token: string): string {
  if (token.length < 2) {
    return token;
  }
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return token.slice(1, -1);
  }
  return token;
}

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
  "node",
  ...PYTHON_PYTEST_INTERPRETERS,
]);

function formatAllowedFirstTokens(): string {
  return [...ALLOWED_FIRST_TOKENS].sort().join(", ");
}
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
 * `task <name>:test` (#6886): the whole command, for first token `task` only.
 * Nothing may follow — no second task, variable assignment or flag.
 */
const TASK_WORKSPACE_TEST_PATTERN = /^[a-z0-9][a-z0-9_-]*:test$/;

/**
 * Wrapper refusal text (#6886 item 9): names the admitted subcommands and the
 * JS workspace test-runner form.
 */
export const WRAPPER_SUBCOMMAND_REFUSAL =
  "wrapper subcommand must be check|doctor|test|<name>:test (task only, nothing after)|verify:*|help|--version " +
  "(scope/policy/swarm/scm/merge and other ambient-authority verbs denied); " +
  "for a JS workspace test runner use npx vitest run <path> or pnpm exec vitest run <path> " +
  "with cwd: <workspace dir>";

/**
 * Wrapper verbs that stay on the verify/read surface: `verify:<name>` /
 * `verify-<name>` as one token, or `verify <name>` as two. The name is exact
 * (GHSA-mq3j-2229-p7xx: the old prefix match let any text follow).
 */
const WRAPPER_VERIFY_VERB_PATTERN = /^verify[:-][a-z0-9][a-z0-9:_-]*$/;
const WRAPPER_VERIFY_NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/;

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
 * Stamp-time no-op and command-safety refuse (#3396 / #4702).
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
    const safety = evaluateCommandSafety(cmd.command);
    if (!safety.ok) {
      return {
        ok: false,
        reason: safety.reason,
        ...(safety.outcome !== undefined ? { outcome: safety.outcome } : {}),
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
      reason:
        `first token ${JSON.stringify(first)} is not in the literal-AC allowlist ` +
        `(accepted: ${formatAllowedFirstTokens()})`,
    };
  }

  const rest = trimmed.slice(end).trim();

  // Framework wrappers: only verification / help / version subcommands (no scope/policy/merge).
  if (first === "task" || first === "deft" || first === "directive") {
    return evaluateWrapperSubcommand(rest, first);
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

  // python/python3/py: only `-m pytest` (not pip, http.server, -c, or a bare pytest token).
  if (PYTHON_PYTEST_INTERPRETERS.has(first)) {
    return evaluatePythonPytestArgs(rest);
  }

  // node: closed `--test` argv grammar only (#4978). Fall-through ok for node is forbidden.
  if (first === "node") {
    return evaluateNodeTestArgs(rest);
  }

  return { ok: true, reason: null };
}
// ---------------------------------------------------------------------------
// Closed argument grammar (GHSA-mq3j-2229-p7xx).
//
// Every argument after an admitted verb is checked against one closed grammar,
// on both sides of `--`. A token is either a plain relative path or a flag from
// a closed per-form table. Everything else refuses: package-manager, runner and
// interpreter options can load code or move the run outside the repository.
// ---------------------------------------------------------------------------

/**
 * Split an argument string on blanks. A token may be wholly wrapped in one pair
 * of matching quotes, or be `--name=` followed by one wholly quoted value.
 * Quotes are kept on the token. Any other quote use returns null, so quoting
 * cannot hide a flag from the closed grammar.
 */
function tokenizeArgs(rest: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const isBlank = (ch: string | undefined): boolean => ch === " " || ch === "\t";
  while (i < rest.length) {
    if (isBlank(rest[i])) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < rest.length && !isBlank(rest[end])) {
      const c = rest[end] as string;
      if (c === '"' || c === "'") {
        const atStart = end === i;
        const afterFlagEquals = /^--?[A-Za-z][A-Za-z0-9._-]*=$/.test(rest.slice(i, end));
        if (!atStart && !afterFlagEquals) {
          return null;
        }
        const close = rest.indexOf(c, end + 1);
        if (close < 0) {
          return null;
        }
        const after = rest[close + 1];
        if (after !== undefined && !isBlank(after)) {
          return null;
        }
        end = close + 1;
        break;
      }
      end += 1;
    }
    tokens.push(rest.slice(i, end));
    i = end;
  }
  return tokens;
}

function isWrappedInQuotes(token: string): boolean {
  return unwrapShellQuotes(token) !== token;
}

/** One path segment of an argument path. `.` and `..` are refused separately. */
const ARG_SEGMENT_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/;

/** One path segment that may hold a `*` glob (node --test only). */
const ARG_GLOB_SEGMENT_PATTERN = /^[A-Za-z0-9_.*][A-Za-z0-9._*-]*$/;

/**
 * A plain relative path inside the working directory: `/`-joined segments, an
 * optional trailing `/`, or `.` alone. No `..`, no leading `/` or `-`, no `%`,
 * `=`, `:` or `\`. With `allowGlob`, segments may hold `*` (not as the first
 * character of the path).
 */
function isRelativeArgPath(value: string, allowGlob = false): boolean {
  if (value === ".") {
    return true;
  }
  if (value.startsWith("*")) {
    return false;
  }
  const body = value.endsWith("/") ? value.slice(0, -1) : value;
  if (body.length === 0) {
    return false;
  }
  const segment = allowGlob ? ARG_GLOB_SEGMENT_PATTERN : ARG_SEGMENT_PATTERN;
  return body.split("/").every((part) => part !== "." && part !== ".." && segment.test(part));
}

/** A workspace package name (`name` or `@scope/name`). */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** A plain word value such as `--tier gated`. */
const PLAIN_WORD_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** A non-negative integer value. */
const COUNT_PATTERN = /^[0-9]{1,6}$/;

/** Test-name value: no `/`, `=`, `%`, `\` or quotes; blanks only inside quotes. */
const TEST_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9 _#@.:+,-]*$/;

/** Admitted package script names: test, check, test:<name> and check:<name>. */
const ADMITTED_SCRIPT_NAME_PATTERN = /^(?:test|check)(?::[A-Za-z0-9][A-Za-z0-9_-]*)?$/;

/** Built-in vitest reporter names. */
const VITEST_REPORTERS = new Set([
  "default",
  "basic",
  "verbose",
  "dot",
  "tree",
  "tap",
  "tap-flat",
  "junit",
  "json",
  "github-actions",
  "hanging-process",
]);

/** pytest `--tb` styles. */
const PYTEST_TB_STYLES = new Set(["auto", "long", "short", "line", "native", "no"]);

type FlagKind =
  | "bool"
  | "path"
  | "package"
  | "word"
  | "count"
  | "test-name"
  | "reporter"
  | "coverage-enabled"
  | "tb-style"
  | "workers";

/** Test-runner flags passed through to the repository's own test command. */
const RUNNER_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ["--run", "bool"],
  ["--fail-fast", "bool"],
  ["--changed", "bool"],
  ["--coverage", "bool"],
  ["--coverage.enabled", "coverage-enabled"],
  ["--reporter", "reporter"],
  ["-t", "test-name"],
  ["--testNamePattern", "test-name"],
]);

/** Framework wrapper (task/deft/directive) verification flags. */
const WRAPPER_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ["--json", "bool"],
  ["--full", "bool"],
  ["--enforce", "bool"],
  ["--skip-gh", "bool"],
  ["--strict", "bool"],
  ["--allow-over-cap", "bool"],
  ["--help", "bool"],
  ["-h", "bool"],
  ["--tier", "word"],
  ["--tip", "path"],
  ["--base-ref", "path"],
  ["--ledger", "path"],
  ["--filter", "path"],
  ["--issue", "count"],
  ["--pr", "count"],
]);

/** `python -m pytest` flags (no plugin, config, rootdir or basetemp options). */
const PYTEST_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ["-q", "bool"],
  ["-qq", "bool"],
  ["--quiet", "bool"],
  ["-v", "bool"],
  ["-vv", "bool"],
  ["--verbose", "bool"],
  ["-x", "bool"],
  ["--exitfirst", "bool"],
  ["-s", "bool"],
  ["--no-header", "bool"],
  ["--strict-markers", "bool"],
  ["--lf", "bool"],
  ["--last-failed", "bool"],
  ["--ff", "bool"],
  ["--failed-first", "bool"],
  ["-k", "test-name"],
  ["-m", "test-name"],
  ["--tb", "tb-style"],
  ["--maxfail", "count"],
  ["--durations", "count"],
  ["-n", "workers"],
]);

/**
 * Grammar contexts. Package managers and wrappers have their own flags before
 * `--` and the runner flags after it; pnpm, yarn and bun hand every argument
 * after the script name to the script, so they use the runner flags on both
 * sides. Direct vitest and pytest have no `--`.
 */
type ClosedGrammarContext =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "vitest"
  | "task"
  | "wrapper"
  | "pytest";

export const CLOSED_ARGUMENT_GRAMMAR_REASON =
  "arguments after the command must be plain relative paths or admitted flags: " +
  "--run, --fail-fast, --changed, --coverage, --coverage.enabled=true|false, " +
  "--reporter <built-in>, -t <test name>; npm --prefix <relative dir> / -w <workspace> " +
  "and pnpm --filter <package> before --; wrapper verification flags such as --json, " +
  "--tier <word>, --base-ref <ref>; pytest -q/-v/-x/-k/-m/--tb; " +
  "other package-manager, runner and interpreter options are denied";

function closedGrammarRefusal(detail: string): CommandSafetyResult {
  return { ok: false, reason: `${detail}; ${CLOSED_ARGUMENT_GRAMMAR_REASON}` };
}

function isTestNameValue(raw: string): boolean {
  const quoted = isWrappedInQuotes(raw);
  const value = quoted ? unwrapShellQuotes(raw) : raw;
  if (!TEST_NAME_PATTERN.test(value)) {
    return false;
  }
  if (!quoted && /\s/.test(value)) {
    return false;
  }
  return !value.split(/\s+/).some((word) => word.startsWith("-"));
}

function isFlagValue(kind: FlagKind, raw: string): boolean {
  if (kind === "test-name") {
    return isTestNameValue(raw);
  }
  const value = unwrapShellQuotes(raw);
  switch (kind) {
    case "path":
      return isRelativeArgPath(value);
    case "package":
      return PACKAGE_NAME_PATTERN.test(value);
    case "word":
      return PLAIN_WORD_PATTERN.test(value);
    case "count":
      return COUNT_PATTERN.test(value);
    case "reporter":
      return VITEST_REPORTERS.has(value);
    case "coverage-enabled":
      return value === "true" || value === "false";
    case "tb-style":
      return PYTEST_TB_STYLES.has(value);
    case "workers":
      return value === "auto" || COUNT_PATTERN.test(value);
    default:
      return false;
  }
}

const NPM_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ["--prefix", "path"],
  ["-w", "package"],
  ["--workspace", "package"],
]);

const PNPM_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ...RUNNER_FLAGS,
  ["--filter", "package"],
]);

const WRAPPER_AND_RUNNER_FLAGS: ReadonlyMap<string, FlagKind> = new Map<string, FlagKind>([
  ...WRAPPER_FLAGS,
  ...RUNNER_FLAGS,
]);

/** Flags admitted before `--` (or anywhere, for contexts without `--`). */
function flagsBeforeSeparator(context: ClosedGrammarContext): ReadonlyMap<string, FlagKind> {
  switch (context) {
    case "npm":
      return NPM_FLAGS;
    case "pnpm":
      return PNPM_FLAGS;
    case "task":
    case "wrapper":
      return WRAPPER_FLAGS;
    case "pytest":
      return PYTEST_FLAGS;
    default:
      return RUNNER_FLAGS;
  }
}

/** Flags admitted after `--`: the repository's own runner and wrapper flags. */
function flagsAfterSeparator(context: ClosedGrammarContext): ReadonlyMap<string, FlagKind> {
  return context === "task" || context === "wrapper" ? WRAPPER_AND_RUNNER_FLAGS : RUNNER_FLAGS;
}

/** A positional argument: a test path, or a pytest node id `path::name`. */
function isPositionalArg(value: string, context: ClosedGrammarContext): boolean {
  if (context === "pytest") {
    const [path, ...names] = value.split("::");
    return (
      isRelativeArgPath(path ?? "") && names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    );
  }
  return isRelativeArgPath(value);
}

/**
 * The closed grammar for every argument after an admitted verb, on both sides
 * of `--` (GHSA-mq3j-2229-p7xx).
 */
function evaluateClosedTrailingArgs(
  tokens: readonly string[],
  context: ClosedGrammarContext,
): CommandSafetyResult {
  let sawSeparator = false;
  let sawPrefix = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i] as string;
    if (raw === "--") {
      if (context === "vitest" || context === "pytest" || sawSeparator) {
        return closedGrammarRefusal('a second "--", or "--" after vitest or pytest, is denied');
      }
      sawSeparator = true;
      continue;
    }
    if (isWrappedInQuotes(raw) || !raw.startsWith("-")) {
      // A wrapper takes no positional before `--`: it would name a second task
      // or set a Taskfile variable (VAR=value).
      if ((context === "task" || context === "wrapper") && !sawSeparator) {
        return closedGrammarRefusal(
          `wrapper argument ${JSON.stringify(raw)} before "--" is denied ` +
            "(a second task name or VAR=value)",
        );
      }
      if (!isPositionalArg(unwrapShellQuotes(raw), context)) {
        return closedGrammarRefusal(`argument ${JSON.stringify(raw)} is not a plain relative path`);
      }
      continue;
    }
    const eq = raw.indexOf("=");
    const name = eq < 0 ? raw : raw.slice(0, eq);
    const attached = eq < 0 ? undefined : raw.slice(eq + 1);
    if (name === "--if-present") {
      return closedGrammarRefusal(
        '"--if-present" is denied (a missing script would exit 0 without running a check)',
      );
    }
    const table = sawSeparator ? flagsAfterSeparator(context) : flagsBeforeSeparator(context);
    const kind = table.get(name);
    if (kind === undefined) {
      return closedGrammarRefusal(`option ${JSON.stringify(name)} is not in the closed grammar`);
    }
    if (kind === "bool") {
      if (attached !== undefined) {
        return closedGrammarRefusal(`option ${JSON.stringify(name)} takes no value`);
      }
      continue;
    }
    let value = attached;
    if (value === undefined) {
      // `task` parses its own flags before `--`: a separate value token would
      // be read as a task name, so it must be attached with `=`.
      if (context === "task" && !sawSeparator) {
        return closedGrammarRefusal(
          `task option ${JSON.stringify(name)} before "--" must attach its value with =`,
        );
      }
      const next = tokens[i + 1];
      if (next === undefined || next === "--") {
        return closedGrammarRefusal(`option ${JSON.stringify(name)} needs a value`);
      }
      value = next;
      i += 1;
    }
    if (!isFlagValue(kind, value)) {
      return closedGrammarRefusal(`option ${JSON.stringify(name)} has a value outside its grammar`);
    }
    if (name === "--prefix") {
      if (sawPrefix) {
        return closedGrammarRefusal('"--prefix" may appear once');
      }
      sawPrefix = true;
      // #7223: the prefix directory is where npm runs the script, so it gets
      // the same dependency / dot-folder refusal as the record cwd.
      const refusedSegment = dependencyOrDotSegment(unwrapShellQuotes(value));
      if (refusedSegment !== null) {
        return {
          ok: false,
          reason: `"--prefix" segment ${JSON.stringify(refusedSegment)} is refused: ${ACCEPTANCE_DEPENDENCY_PATH_REASON}`,
        };
      }
    }
  }
  return { ok: true, reason: null };
}

/**
 * The `npm --prefix` operand of an npm command, or null. verify:ac checks its
 * real path like the record cwd before it spawns (GHSA-mq3j-2229-p7xx).
 */
export function packageManagerPrefixOperand(command: string): string | null {
  if (typeof command !== "string") {
    return null;
  }
  const tokens = tokenizeArgs(command.trim());
  if (tokens === null || (tokens[0] ?? "").toLowerCase() !== "npm") {
    return null;
  }
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--") {
      return null;
    }
    if (token === "--prefix") {
      const next = tokens[i + 1];
      return next === undefined ? null : unwrapShellQuotes(next);
    }
    if (token.startsWith("--prefix=")) {
      return unwrapShellQuotes(token.slice("--prefix=".length));
    }
  }
  return null;
}

/**
 * Restrict task/deft/directive to verification-shaped subcommands.
 * Fail closed on scope/policy/swarm/pr/scm/lifecycle mutations. Arguments after
 * the subcommand use the closed grammar: no positional before `--` (a second
 * task name or VAR=value), wrapper flags only, plain paths after `--`.
 */
function evaluateWrapperSubcommand(rest: string, first: string): CommandSafetyResult {
  if (first === "task" && TASK_WORKSPACE_TEST_PATTERN.test(rest)) {
    return { ok: true, reason: null };
  }
  if (rest.length === 0) {
    return {
      ok: false,
      reason: "wrapper verb (task/deft/directive) requires a restricted verification subcommand",
    };
  }
  const tokens = tokenizeArgs(rest);
  if (tokens === null) {
    return closedGrammarRefusal("quotes must wrap a whole argument");
  }
  const sub = tokens[0] as string;
  let argStart: number;
  if (ALLOWED_WRAPPER_SUBCOMMANDS.has(sub) || WRAPPER_VERIFY_VERB_PATTERN.test(sub)) {
    argStart = 1;
  } else if (sub === "verify" && WRAPPER_VERIFY_NAME_PATTERN.test(tokens[1] ?? "")) {
    argStart = 2;
  } else {
    return { ok: false, reason: WRAPPER_SUBCOMMAND_REFUSAL };
  }
  return evaluateClosedTrailingArgs(tokens.slice(argStart), first === "task" ? "task" : "wrapper");
}

const PACKAGE_MANAGER_ARGS_REASON =
  "package-manager args must be test|exec vitest|run <script>|--version, where <script> is " +
  "test, check, test:<name> or check:<name> " +
  "(arbitrary scripts/network install denied for ambient-authority)";

/**
 * Package-manager subcommand allowlist (no install/publish/exec of arbitrary bins).
 * `npx` is stricter than npm/pnpm/yarn/bun: it must not accept `run`/`exec` forms that
 * resolve arbitrary registry packages with inherited env (Greptile conf residual).
 * The script name is exact (case-sensitive); every later argument uses the
 * closed grammar (GHSA-mq3j-2229-p7xx).
 */
function evaluatePackageManagerArgs(rest: string, firstToken: string): CommandSafetyResult {
  if (rest.length === 0) {
    return { ok: false, reason: "package manager requires a restricted subcommand" };
  }
  const low = rest.toLowerCase();
  const tokens = tokenizeArgs(rest);
  if (tokens === null) {
    return closedGrammarRefusal("quotes must wrap a whole argument");
  }
  const head = tokens[0] ?? "";

  // npx: only vitest (direct) or version/help — no `npx run` / `npx exec <pkg>` registry path.
  if (firstToken === "npx") {
    if (low === "--version" || low === "-v" || low === "--help" || low === "-h") {
      return { ok: true, reason: null };
    }
    if (head === "vitest") {
      return evaluateVitestTokens(tokens.slice(1));
    }
    return {
      ok: false,
      reason:
        "npx is limited to vitest|--version|--help " +
        "(npx run/exec/registry packages denied for ambient-authority)",
    };
  }
  if (low === "--version" || low === "-v") {
    return { ok: true, reason: null };
  }

  // exec: only vitest (not deft/task — those re-open wrapper ambient authority).
  if (head === "exec") {
    if (tokens[1] === "vitest") {
      return evaluateVitestTokens(tokens.slice(2));
    }
    return {
      ok: false,
      reason:
        "package-manager exec is limited to vitest " +
        "(exec of deft/task/other bins denied for ambient-authority)",
    };
  }
  if (head === "run" && tokens[1] === "vitest") {
    // One leading `--` hands the rest to the script (`npm run vitest -- --run`).
    const after = tokens[2] === "--" ? tokens.slice(3) : tokens.slice(2);
    return evaluateVitestTokens(["run", ...after]);
  }
  const context = firstToken as ClosedGrammarContext;
  if (head === "test") {
    return evaluateClosedTrailingArgs(tokens.slice(1), context);
  }
  if (head === "run" && ADMITTED_SCRIPT_NAME_PATTERN.test(tokens[1] ?? "")) {
    return evaluateClosedTrailingArgs(tokens.slice(2), context);
  }
  return { ok: false, reason: PACKAGE_MANAGER_ARGS_REASON };
}

/**
 * Vitest args: only non-interactive run paths. Deny watch/ui/browser hang modes.
 */
function evaluateVitestArgs(rest: string): CommandSafetyResult {
  const tokens = tokenizeArgs(rest.trim());
  if (tokens === null) {
    return closedGrammarRefusal("quotes must wrap a whole argument");
  }
  return evaluateVitestTokens(tokens);
}

function evaluateVitestTokens(tokens: readonly string[]): CommandSafetyResult {
  if (tokens.length === 0) {
    // bare `vitest` defaults to watch in many setups — refuse closed.
    return {
      ok: false,
      reason: "vitest requires explicit run (bare vitest defaults to watch; denied)",
    };
  }
  const lowTokens = tokens.map((token) => token.toLowerCase());
  for (const bad of ["watch", "ui", "browser", "--watch", "--ui", "--browser", "dev"]) {
    if (lowTokens.includes(bad)) {
      return {
        ok: false,
        reason: `vitest ${bad} is denied (hang/interactive mode; use run)`,
      };
    }
  }
  const head = lowTokens[0] as string;
  if (tokens.length === 1 && (head === "--version" || head === "-v")) {
    return { ok: true, reason: null };
  }
  if (head === "run" || head === "--run") {
    return evaluateClosedTrailingArgs(tokens.slice(1), "vitest");
  }
  return {
    ok: false,
    reason: "vitest args must be run|--version (watch/ui/network denied for ambient-authority)",
  };
}

/**
 * Python interpreters: only exact `python|python3|py -m pytest` plus pytest args (#4702).
 * `-m` and `pytest` are case-sensitive. Other modes and modules stay denied.
 * uv is not an interpreter on this list. pytest arguments use the closed
 * grammar: node ids and a closed flag set (no plugin, config, rootdir or
 * basetemp options) (GHSA-mq3j-2229-p7xx).
 */
function evaluatePythonPytestArgs(rest: string): CommandSafetyResult {
  const tokens = tokenizeArgs(rest.trim());
  if (tokens === null || tokens[0] !== "-m" || tokens[1] !== "pytest") {
    return {
      ok: false,
      reason:
        "python/python3/py is limited to -m pytest " +
        "(other interpreter modes and modules denied for ambient-authority)",
    };
  }
  return evaluateClosedTrailingArgs(tokens.slice(2), "pytest");
}

/**
 * `node`: closed `--test` argv grammar (#4978 / leftover #4751).
 * tokens[0] must be exactly `--test`. Every later flag is an exact name from
 * `NODE_TEST_FLAGS` (GHSA-mq3j-2229-p7xx: a prefix match let `_` spellings,
 * quotes or `^` reach module-loading and file-writing options). Destination,
 * rerun-failures and `--test-global-setup` are not on the list.
 * `--test-reporter` values are a closed five-name allow-set. A quote must wrap
 * a whole argument or a whole `--flag=` value. Positional arguments are plain
 * relative paths, with `*` globs.
 */
function evaluateNodeTestArgs(rest: string): CommandSafetyResult {
  const tokens = tokenizeArgs(rest.trim());
  if (tokens === null) {
    return closedGrammarRefusal("node --test: quotes must wrap a whole argument");
  }
  if (unwrapShellQuotes(tokens[0] ?? "") !== "--test") {
    return {
      ok: false,
      reason:
        "node is limited to --test " + "(other interpreter modes denied for ambient-authority)",
    };
  }
  for (let i = 1; i < tokens.length; i += 1) {
    const raw = tokens[i] as string;
    if (isWrappedInQuotes(raw) || !raw.startsWith("-")) {
      const value = unwrapShellQuotes(raw);
      if (!isRelativeArgPath(value, true)) {
        return closedGrammarRefusal(
          `node --test argument ${JSON.stringify(value)} is not a plain relative path`,
        );
      }
      continue;
    }
    const eq = raw.indexOf("=");
    const name = eq < 0 ? raw : raw.slice(0, eq);
    const attached = eq < 0 ? undefined : raw.slice(eq + 1);
    const kind = NODE_TEST_FLAGS.get(name);
    if (kind === undefined) {
      return {
        ok: false,
        reason:
          `node --test dash token ${JSON.stringify(raw)} is denied: flags must be one of ` +
          `${[...NODE_TEST_FLAGS.keys()].join(", ")}`,
      };
    }
    if (kind === "bool") {
      if (attached !== undefined) {
        return closedGrammarRefusal(`node --test flag ${JSON.stringify(name)} takes no value`);
      }
      continue;
    }
    let value = attached;
    if (value === undefined) {
      value = tokens[i + 1];
      i += 1;
    }
    if (value === undefined || !isNodeTestFlagValue(kind, value)) {
      if (kind === "reporter") {
        return {
          ok: false,
          reason: "node --test --test-reporter value must be one of spec|tap|junit|lcov|dot",
        };
      }
      return closedGrammarRefusal(
        `node --test flag ${JSON.stringify(name)} has a value outside its grammar`,
      );
    }
  }
  return { ok: true, reason: null };
}

type NodeTestFlagKind = "bool" | "reporter" | "test-name" | "count" | "shard" | "isolation";

/** Exact `node --test` flags admitted after `--test` (GHSA-mq3j-2229-p7xx). */
const NODE_TEST_FLAGS: ReadonlyMap<string, NodeTestFlagKind> = new Map<string, NodeTestFlagKind>([
  ["--test-reporter", "reporter"],
  ["--test-name-pattern", "test-name"],
  ["--test-skip-pattern", "test-name"],
  ["--test-only", "bool"],
  ["--test-force-exit", "bool"],
  ["--test-concurrency", "count"],
  ["--test-timeout", "count"],
  ["--test-shard", "shard"],
  ["--test-isolation", "isolation"],
  ["--experimental-test-coverage", "bool"],
]);

function isNodeTestFlagValue(kind: NodeTestFlagKind, raw: string): boolean {
  if (kind === "test-name") {
    return isTestNameValue(raw);
  }
  const value = unwrapShellQuotes(raw);
  switch (kind) {
    case "reporter":
      return NODE_TEST_REPORTERS.has(value);
    case "count":
      return COUNT_PATTERN.test(value);
    case "shard":
      return /^[0-9]{1,4}\/[0-9]{1,4}$/.test(value);
    case "isolation":
      return value === "process" || value === "none";
    default:
      return false;
  }
}

/** One cwd segment: no leading dot, so `.` and `..` never match (#6886 item 1). */
const CWD_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The installed-dependency folder name; compared without case (#7223). */
export const DEPENDENCY_DIR_SEGMENT = "node_modules";

/** Refusal table id of the dependency / dot-folder cwd refusal (#7223; enforce). */
export const ACCEPTANCE_CWD_DEPENDENCY_REFUSAL_ID = "acceptance-cwd-dependency";

/**
 * Why a dependency or dot-folder path is refused (#7223). Acceptance commands
 * run only from the repository's own directories, never from installed
 * dependencies or hidden tool folders.
 */
export const ACCEPTANCE_DEPENDENCY_PATH_REASON =
  "acceptance commands run only from the repository's own directories, " +
  "never from installed dependencies (node_modules) or a dot folder";

/**
 * The first segment of `path` that names installed dependencies (`node_modules`,
 * any case) or starts with a dot, or null (#7223). Splits on `/` and `\`. A
 * lone `.` segment names the same directory and is not counted.
 */
export function dependencyOrDotSegment(path: string): string | null {
  for (const segment of path.split(/[\\/]/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment.toLowerCase() === DEPENDENCY_DIR_SEGMENT || segment.startsWith(".")) {
      return segment;
    }
  }
  return null;
}

/**
 * Cwd-grammar warning text (#6886 item 1). Every gate prints the same text; a
 * cwd outside the grammar warns. verify:ac checks the real directory just
 * before it runs the command. A dependency or dot-folder cwd is refused
 * (#7223, `ACCEPTANCE_CWD_DEPENDENCY_REFUSAL_ID`).
 */
export const ACCEPTANCE_CWD_GRAMMAR_REASON =
  "cwd is not a plain relative path (segments matching [A-Za-z0-9_][A-Za-z0-9._-]* joined by /); " +
  "verify:ac runs the command only when its real directory is inside the repository";

export interface AcceptanceCwdVerdict {
  /** False when the cwd is outside the grammar (a warning unless `refused`). */
  readonly ok: boolean;
  readonly reason: string | null;
  /** True when the cwd is refused, not only warned: a dependency or dot-folder segment (#7223). */
  readonly refused?: boolean;
}

export interface AcceptanceCommandRecordVerdict {
  readonly command: CommandSafetyResult;
  readonly cwd: AcceptanceCwdVerdict;
}

/**
 * Cwd grammar only; reads no file system (#6886 item 1). A cwd with a
 * `node_modules` or leading-dot segment is refused (#7223); any other cwd
 * outside the grammar warns.
 */
export function evaluateAcceptanceCwdGrammar(cwd: string | null | undefined): AcceptanceCwdVerdict {
  if (cwd === null || cwd === undefined) {
    return { ok: true, reason: null };
  }
  const raw = cwd.trim();
  if (raw.length === 0 || raw === ".") {
    return { ok: true, reason: null };
  }
  const refusedSegment = dependencyOrDotSegment(raw);
  if (refusedSegment !== null) {
    return {
      ok: false,
      refused: true,
      reason: `cwd segment ${JSON.stringify(refusedSegment)} is refused: ${ACCEPTANCE_DEPENDENCY_PATH_REASON}`,
    };
  }
  const conforms = raw.split("/").every((segment) => CWD_SEGMENT_PATTERN.test(segment));
  return conforms
    ? { ok: true, reason: null }
    : { ok: false, reason: ACCEPTANCE_CWD_GRAMMAR_REASON };
}

/**
 * The one record rule (#6886 item 1): a command verdict from
 * `evaluateCommandSafety` and a separate cwd-grammar verdict. Reads no file
 * system, so activation and verify:ac give the same answer and reason text.
 */
export function evaluateAcceptanceCommandRecord(record: {
  readonly command: string;
  readonly cwd?: string | null;
}): AcceptanceCommandRecordVerdict {
  return {
    command: evaluateCommandSafety(record.command),
    cwd: evaluateAcceptanceCwdGrammar(record.cwd),
  };
}
