/**
 * Run stored literal acceptance commands verbatim (#3267).
 *
 * Same flags, same cwd (project root unless the command record states otherwise).
 * Fail closed on non-zero exit or missing expected stdout.
 * Self-chosen verification is supplementary — this gate only runs stored literals.
 */

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { formatDeclaredRefusal } from "../refusal-declarations/print.js";
import { isInlineProseMention } from "./capture.js";
import {
  ACCEPTANCE_DEPENDENCY_PATH_REASON,
  DEPENDENCY_DIR_SEGMENT,
  evaluateAcceptanceCwdGrammar,
  evaluateCommandSafety,
  isExecutableLiteralSource,
  packageManagerPrefixOperand,
} from "./safety.js";
import type {
  LiteralAcceptanceCommand,
  LiteralAcceptanceGateResult,
  LiteralAcceptanceRunner,
  LiteralAcceptanceRunResult,
  RejectedLiteralCommand,
} from "./types.js";

/** True when the row is a pre-execution safety refusal, not a product measurement (#3615). */
export function isSafetyRefusalRun(
  run: Pick<LiteralAcceptanceRunResult, "exitCode" | "detail">,
): boolean {
  return run.exitCode === 2 && /^refused:\s*/i.test(run.detail);
}

function safetyRefusalReason(run: Pick<LiteralAcceptanceRunResult, "detail">): string {
  return run.detail.replace(/^refused:\s*/i, "").trim();
}

/** Default shell runner: exact command string via platform shell. */
export function defaultLiteralAcceptanceRunner(input: {
  readonly command: string;
  readonly cwd: string;
}): { exitCode: number; stdout: string; stderr: string } {
  // Windows: cmd.exe /c; POSIX: shell true uses sh -c. Exact string preserved.
  const result = spawnSync(input.command, {
    cwd: input.cwd,
    encoding: "utf8",
    shell: true,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const exitCode =
    typeof result.status === "number" ? result.status : result.error !== undefined ? 1 : 1;
  return {
    exitCode,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr:
      typeof result.stderr === "string"
        ? result.stderr
        : result.error instanceof Error
          ? result.error.message
          : "",
  };
}

function resolveCwd(projectRoot: string, cmd: LiteralAcceptanceCommand): string {
  if (cmd.cwd === null || cmd.cwd === undefined || cmd.cwd.trim().length === 0) {
    return resolve(projectRoot);
  }
  const raw = cmd.cwd.trim();
  if (isAbsolute(raw)) return raw;
  return resolve(projectRoot, raw);
}

/** Refusal table id of the run-time cwd containment check (#6886 item 2; enforce). */
export const ACCEPTANCE_CWD_CONTAINMENT_REFUSAL_ID = "acceptance-cwd-containment";

export interface AcceptanceCwdContainment {
  readonly ok: boolean;
  readonly reason: string | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run-time containment (#6886 item 2). The real path of `cwd` must be an
 * existing directory that is the project root's real path or inside it, with
 * no `node_modules` segment below the root (#7223). Checked just before a
 * spawn; a directory replaced after the check is not covered.
 */
export function evaluateAcceptanceCwdContainment(
  projectRoot: string,
  cwd: string,
): AcceptanceCwdContainment {
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(projectRoot));
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `the project root ${JSON.stringify(projectRoot)} has no real path (${errorText(err)})`,
    };
  }
  let realCwd: string;
  try {
    realCwd = realpathSync(resolve(cwd));
    if (!statSync(realCwd).isDirectory()) {
      return {
        ok: false,
        reason: `the working directory ${JSON.stringify(cwd)} is not a directory`,
      };
    }
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `the working directory ${JSON.stringify(cwd)} is missing or has no real path (${errorText(err)})`,
    };
  }
  const rel = relative(realRoot, realCwd);
  if (rel.length > 0 && (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))) {
    return {
      ok: false,
      reason: `the working directory ${JSON.stringify(cwd)} resolves outside the repository (${realCwd})`,
    };
  }
  // #7223: the real path below the root must not pass through installed
  // dependencies, so a symlink or junction into node_modules is refused too.
  if (rel.split(sep).some((segment) => segment.toLowerCase() === DEPENDENCY_DIR_SEGMENT)) {
    return {
      ok: false,
      reason:
        `the working directory ${JSON.stringify(cwd)} resolves inside installed dependencies ` +
        `(${realCwd}); ${ACCEPTANCE_DEPENDENCY_PATH_REASON}`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Containment for one spawn: the cwd, then the `npm --prefix` directory when the
 * command names one. The grammar checks the prefix spelling only; a symlink or
 * junction can still point outside the repository (GHSA-mq3j-2229-p7xx). The
 * record cwd as written is checked first, before path resolution drops
 * segments such as `..`, so every runner refuses a dependency or dot-folder
 * cwd, not only the verify:ac record list (#7223).
 */
function evaluateRunContainment(
  projectRoot: string,
  cmd: LiteralAcceptanceCommand,
  cwd: string,
): AcceptanceCwdContainment {
  const grammar = evaluateAcceptanceCwdGrammar(cmd.cwd);
  if (grammar.refused === true) {
    return { ok: false, reason: grammar.reason ?? ACCEPTANCE_DEPENDENCY_PATH_REASON };
  }
  const command = cmd.command;
  const containment = evaluateAcceptanceCwdContainment(projectRoot, cwd);
  if (!containment.ok) {
    return containment;
  }
  const prefix = packageManagerPrefixOperand(command);
  if (prefix === null) {
    return containment;
  }
  const prefixContainment = evaluateAcceptanceCwdContainment(projectRoot, resolve(cwd, prefix));
  if (!prefixContainment.ok) {
    return {
      ok: false,
      reason: `--prefix ${JSON.stringify(prefix)}: ${prefixContainment.reason ?? "outside the repository"}`,
    };
  }
  return prefixContainment;
}

/** The declared containment refusal line (#6886 item 7). */
export function formatAcceptanceCwdContainmentRefusal(command: string, reason: string): string {
  return formatDeclaredRefusal({
    id: ACCEPTANCE_CWD_CONTAINMENT_REFUSAL_ID,
    detail: `acceptance command ${JSON.stringify(command)} was not spawned: ${reason}`,
  }).line;
}

function containmentRefusalRun(
  cmd: LiteralAcceptanceCommand,
  cwd: string,
  reason: string,
): LiteralAcceptanceRunResult {
  const line = formatAcceptanceCwdContainmentRefusal(cmd.command, reason);
  return {
    command: cmd.command,
    cwd,
    exitCode: 2,
    stdout: "",
    stderr: line,
    ok: false,
    detail: `refused: ${line}`,
  };
}

/**
 * True when the row is the run-time containment refusal (#6886 item 2). It is
 * not a command-form refusal: it never joins the rejected ledger and it keeps
 * exit 2, even when it fires after an earlier command ran.
 */
export function isContainmentRefusalRun(
  run: Pick<LiteralAcceptanceRunResult, "exitCode" | "detail">,
): boolean {
  return (
    isSafetyRefusalRun(run) &&
    run.detail.includes(`deft gate ${ACCEPTANCE_CWD_CONTAINMENT_REFUSAL_ID} `)
  );
}

function nonEmptyExpectedStdout(cmd: LiteralAcceptanceCommand): string {
  return cmd.expectedStdout !== null &&
    cmd.expectedStdout !== undefined &&
    String(cmd.expectedStdout).length > 0
    ? String(cmd.expectedStdout)
    : "";
}

/**
 * Run one command record verbatim. Does not re-tokenize or rewrite the command string.
 */
export function runLiteralAcceptanceCommand(
  cmd: LiteralAcceptanceCommand,
  options: {
    readonly projectRoot: string;
    readonly runner?: LiteralAcceptanceRunner;
  },
): LiteralAcceptanceRunResult {
  const cwd = resolveCwd(options.projectRoot, cmd);
  const safety = evaluateCommandSafety(cmd.command);
  if (!safety.ok) {
    return {
      command: cmd.command,
      cwd,
      exitCode: 2,
      stdout: "",
      stderr: safety.reason ?? "unsafe command",
      ok: false,
      detail: `refused: ${safety.reason ?? "unsafe command"}`,
    };
  }
  const containment = evaluateRunContainment(options.projectRoot, cmd, cwd);
  if (!containment.ok) {
    return containmentRefusalRun(cmd, cwd, containment.reason ?? "cwd outside the repository");
  }
  const runner = options.runner ?? defaultLiteralAcceptanceRunner;
  const result = runner({ command: cmd.command, cwd });
  const expectedExit = cmd.expectedExitCode ?? 0;
  let ok = result.exitCode === expectedExit;
  let detail = ok
    ? `exit ${result.exitCode} (expected ${expectedExit})`
    : `exit ${result.exitCode} (expected ${expectedExit})`;

  if (
    ok &&
    cmd.expectedStdout !== null &&
    cmd.expectedStdout !== undefined &&
    cmd.expectedStdout.length > 0
  ) {
    if (!result.stdout.includes(cmd.expectedStdout)) {
      ok = false;
      detail = `stdout missing expected substring ${JSON.stringify(cmd.expectedStdout)}`;
    }
  }

  return {
    command: cmd.command,
    cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ok,
    detail,
  };
}

interface CaptureOnlyOptions {
  /**
   * When true, allow source=task_statement (raw issue text) to spawn.
   * Default false — issue text is capture-only until promoted (#3267 Greptile P1).
   */
  readonly allowTaskStatement?: boolean;
}

/** Execution identity: command + cwd + expected exit (#4238). */
function literalExecutionKey(c: LiteralAcceptanceCommand): string {
  const cwd =
    c.cwd !== null && c.cwd !== undefined && String(c.cwd).trim().length > 0
      ? String(c.cwd).trim()
      : "";
  const exit = typeof c.expectedExitCode === "number" ? c.expectedExitCode : 0;
  return `${c.command}\0${cwd}\0${exit}`;
}

function untrustedCaptureOnly(
  commands: readonly LiteralAcceptanceCommand[],
  options: CaptureOnlyOptions,
): LiteralAcceptanceCommand[] {
  return commands.filter(
    (c) =>
      c.source === "task_statement" &&
      options.allowTaskStatement !== true &&
      !isInlineProseMention(c),
  );
}

function executableRecords(
  commands: readonly LiteralAcceptanceCommand[],
  options: CaptureOnlyOptions,
): LiteralAcceptanceCommand[] {
  return commands.filter(
    (c) =>
      isExecutableLiteralSource(c.source) ||
      (c.source === "task_statement" && options.allowTaskStatement === true),
  );
}

/**
 * Capture-only records with no agent-promoted peer of the same execution
 * identity. Runs nothing; activation and verify:ac share it (#6886 item 4).
 * A same-text peer counts only when both sides have default cwd/exit.
 */
export function findUnpromotedCaptureOnlyCommands(
  commands: readonly LiteralAcceptanceCommand[],
  options: CaptureOnlyOptions = {},
): LiteralAcceptanceCommand[] {
  const executable = executableRecords(commands, options);
  const executableKeySet = new Set(executable.map(literalExecutionKey));
  return untrustedCaptureOnly(commands, options).filter((c) => {
    if (executableKeySet.has(literalExecutionKey(c))) return false;
    const hasNonStdoutContext =
      (c.cwd !== null && c.cwd !== undefined && String(c.cwd).trim().length > 0) ||
      (typeof c.expectedExitCode === "number" && c.expectedExitCode !== 0);
    if (hasNonStdoutContext) return true;
    return !executable.some((e) => e.command === c.command);
  });
}

/** One listed line per unpromoted capture-only record. */
export function formatUnpromotedCaptureOnlyRecord(c: LiteralAcceptanceCommand): string {
  const bits = [`command=${JSON.stringify(c.command)}`];
  if (c.cwd) bits.push(`cwd=${JSON.stringify(c.cwd)}`);
  if (c.expectedStdout) bits.push(`expectedStdout=${JSON.stringify(c.expectedStdout)}`);
  if (typeof c.expectedExitCode === "number" && c.expectedExitCode !== 0) {
    bits.push(`expectedExitCode=${c.expectedExitCode}`);
  }
  return `${bits.join(" ")} (source=${c.source})`;
}

/** Promote-or-dispose remedy for an unpromoted capture-only record (#3267 / #3721). */
export const UNPROMOTED_CAPTURE_REMEDY =
  "If the command is this story's acceptance, read it first: confirm it is an admitted form " +
  "that runs only this repository's own tests, with no extra options or paths outside the " +
  "repository. Only then record it (and cwd/expectedStdout/expectedExitCode when stated) in " +
  "plan.metadata.swarm.verify_commands (or plan item / explicit metadata), then re-run.\n" +
  "If the capture is not an acceptance command, record the exact string in " +
  "plan.metadata.literal_acceptance_not_commands without promoting it (#3721).";

/** The verify:ac message for unpromoted capture-only records (#3267). */
export function formatUnpromotedCaptureOnlyMessage(
  unpromoted: readonly LiteralAcceptanceCommand[],
): string {
  const listed = unpromoted.map((c) => `  - ${formatUnpromotedCaptureOnlyRecord(c)}`).join("\n");
  return (
    `Literal acceptance-command gate FAILED (#3267): ${unpromoted.length} stated command(s) ` +
    `are capture-only (source=task_statement) and have no matching agent-promoted peer.\n` +
    `${UNPROMOTED_CAPTURE_REMEDY}\n` +
    `Note: an unrelated executable peer or a same-text peer with different context does not waive.\n` +
    listed
  );
}

/**
 * Run all stored commands in order. Fail closed if any fail.
 * Empty command list → ok (nothing stated to verify).
 */
export function runLiteralAcceptanceCommands(
  commands: readonly LiteralAcceptanceCommand[],
  options: {
    readonly projectRoot: string;
    readonly runner?: LiteralAcceptanceRunner;
    /**
     * When true, allow source=task_statement (raw issue text) to spawn.
     * Default false — issue text is capture-only until promoted (#3267 Greptile P1).
     */
    readonly allowTaskStatement?: boolean;
  },
): LiteralAcceptanceGateResult {
  if (commands.length === 0) {
    return {
      ok: true,
      code: 0,
      message: "Literal acceptance-command gate: no stated commands (nothing to run) (#3267)",
      commands: [],
      runs: [],
    };
  }

  const untrusted = untrustedCaptureOnly(commands, options);
  const executable = executableRecords(commands, options);

  // Fail closed: every capture-only stated command must have a matching agent-promoted
  // peer with the same execution identity (command + cwd + exit). Stdout is checked
  // after a single run so two stdout expectations cannot force a second spawn (#4238).
  const executionKey = literalExecutionKey;
  const executableKeySet = new Set(executable.map(executionKey));
  const unpromoted = findUnpromotedCaptureOnlyCommands(commands, options);
  if (unpromoted.length > 0) {
    return {
      ok: false,
      code: 1,
      message: formatUnpromotedCaptureOnlyMessage(unpromoted),
      commands,
      runs: [],
    };
  }

  if (executable.length === 0) {
    return {
      ok: true,
      code: 0,
      message: "Literal acceptance-command gate: no executable (agent-authored) commands (#3267)",
      commands,
      runs: [],
    };
  }

  // Capture may retain multiple executable peers (different stdout) so
  // promotion matching still works. Run each command+cwd+exit once, then
  // validate the result against every retained stdout expectation (#4238).
  type RunGroup = {
    representative: LiteralAcceptanceCommand;
    expectedStdouts: string[];
  };
  const toRunByKey = new Map<string, RunGroup>();
  const addToGroup = (cmd: LiteralAcceptanceCommand, asRepresentative: boolean): void => {
    const key = executionKey(cmd);
    const stdout = nonEmptyExpectedStdout(cmd);
    const group = toRunByKey.get(key);
    if (group === undefined) {
      toRunByKey.set(key, {
        representative: cmd,
        expectedStdouts: stdout.length > 0 ? [stdout] : [],
      });
      return;
    }
    if (stdout.length > 0 && !group.expectedStdouts.includes(stdout)) {
      group.expectedStdouts.push(stdout);
    }
    if (
      asRepresentative &&
      nonEmptyExpectedStdout(group.representative).length === 0 &&
      stdout.length > 0
    ) {
      group.representative = cmd;
    }
  };
  for (const cmd of executable) {
    addToGroup(cmd, true);
  }
  for (const cmd of untrusted) {
    if (executableKeySet.has(executionKey(cmd))) {
      addToGroup(cmd, false);
    }
  }

  // #6886 item 2: check every working directory before the first spawn, so a
  // refused cwd spawns nothing at all. No refusal joins the rejected ledger.
  const containmentRefusals: LiteralAcceptanceRunResult[] = [];
  for (const group of toRunByKey.values()) {
    const cmd = group.representative;
    if (typeof cmd.command !== "string" || cmd.command.trim().length === 0) continue;
    const cwd = resolveCwd(options.projectRoot, cmd);
    const containment = evaluateRunContainment(options.projectRoot, cmd, cwd);
    if (!containment.ok) {
      containmentRefusals.push(
        containmentRefusalRun(cmd, cwd, containment.reason ?? "cwd outside the repository"),
      );
    }
  }
  if (containmentRefusals.length > 0) {
    return {
      ok: false,
      code: 2,
      message:
        `Literal acceptance-command gate refused (#6886): ${containmentRefusals.length} ` +
        `command(s) have a working directory that is missing, outside the repository or inside ` +
        `installed dependencies; ` +
        `nothing was spawned.\n` +
        containmentRefusals.map((r) => `  ✗ ${r.command} — ${r.detail}`).join("\n"),
      commands,
      runs: containmentRefusals,
    };
  }

  const runs: LiteralAcceptanceRunResult[] = [];
  const rejected: RejectedLiteralCommand[] = [];
  for (const group of toRunByKey.values()) {
    const cmd = group.representative;
    if (typeof cmd.command !== "string" || cmd.command.trim().length === 0) {
      return {
        ok: false,
        code: 2,
        message: "Literal acceptance-command gate config error: empty command entry (#3267)",
        commands,
        runs,
        rejected: rejected.length > 0 ? rejected : undefined,
      };
    }
    const runCmd = group.expectedStdouts.length === 0 ? cmd : { ...cmd, expectedStdout: null };
    let run = runLiteralAcceptanceCommand(runCmd, options);
    if (run.ok && group.expectedStdouts.length > 0) {
      const missing = group.expectedStdouts.filter((s) => !run.stdout.includes(s));
      if (missing.length > 0) {
        run = {
          ...run,
          ok: false,
          detail: `stdout missing expected substring ${JSON.stringify(missing[0])}`,
        };
      }
    }
    runs.push(run);
    // A directory that an earlier command removed or replaced is refused at
    // its own spawn; that refusal stays a containment refusal (#6886).
    if (isContainmentRefusalRun(run)) continue;
    if (isSafetyRefusalRun(run)) {
      rejected.push({
        command: run.command,
        reason: safetyRefusalReason(run),
        sourceSpan: cmd.sourceSpan ?? null,
      });
    }
  }

  const lateContainment = runs.filter(isContainmentRefusalRun);
  if (lateContainment.length > 0) {
    return {
      ok: false,
      code: 2,
      message:
        `Literal acceptance-command gate refused (#6886): ${lateContainment.length} ` +
        `command(s) had a working directory that was missing, outside the repository or inside ` +
        `installed dependencies ` +
        `when their turn came; those commands were not spawned.\n` +
        runs.map((r) => `  ${r.ok ? "✓" : "✗"} ${r.command} — ${r.detail}`).join("\n"),
      commands,
      runs,
      rejected: rejected.length > 0 ? rejected : undefined,
    };
  }

  const failed = runs.filter((r) => !r.ok);
  if (failed.length === 0) {
    const lines = runs.map((r) => `  ✓ ${r.command} — ${r.detail}`);
    // Untrusted that matched an executable peer were promoted for run; no skip note needed.
    return {
      ok: true,
      code: 0,
      message:
        `Literal acceptance-command gate passed (#3267): ${runs.length} command(s) run verbatim\n` +
        lines.join("\n"),
      commands,
      runs,
    };
  }

  const lines = runs.map((r) => {
    const mark = r.ok ? "✓" : "✗";
    const err = r.ok
      ? r.detail
      : `${r.detail}${r.stderr.trim().length > 0 ? `; stderr=${truncate(r.stderr, 200)}` : ""}`;
    return `  ${mark} ${r.command} — ${err}`;
  });
  return {
    ok: false,
    code: 1,
    message:
      `Literal acceptance-command gate FAILED (#3267): ${failed.length}/${runs.length} command(s) did not pass.\n` +
      `Commands must run verbatim (same flags/cwd) — self-chosen verification is not a substitute.\n` +
      lines.join("\n"),
    commands,
    runs,
    rejected: rejected.length > 0 ? rejected : undefined,
  };
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
