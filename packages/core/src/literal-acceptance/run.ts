/**
 * Run stored literal acceptance commands verbatim (#3267).
 *
 * Same flags, same cwd (project root unless the command record states otherwise).
 * Fail closed on non-zero exit or missing expected stdout.
 * Self-chosen verification is supplementary — this gate only runs stored literals.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { isInlineProseMention } from "./capture.js";
import { evaluateCommandSafety, isExecutableLiteralSource } from "./safety.js";
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

  const untrusted = commands.filter(
    (c) =>
      c.source === "task_statement" &&
      options.allowTaskStatement !== true &&
      !isInlineProseMention(c),
  );
  const executable = commands.filter(
    (c) =>
      isExecutableLiteralSource(c.source) ||
      (c.source === "task_statement" && options.allowTaskStatement === true),
  );

  // Fail closed: every capture-only stated command must have a matching agent-promoted
  // peer with the same execution constraints (command + cwd + expectedStdout + exit).
  // Command-text-only promotion must not drop cwd/expected-result (Greptile conf residual).
  const promotionKey = (c: (typeof commands)[number]): string => {
    const cwd =
      c.cwd !== null && c.cwd !== undefined && String(c.cwd).trim().length > 0
        ? String(c.cwd).trim()
        : "";
    const stdout =
      c.expectedStdout !== null &&
      c.expectedStdout !== undefined &&
      String(c.expectedStdout).length > 0
        ? String(c.expectedStdout)
        : "";
    const exit = typeof c.expectedExitCode === "number" ? c.expectedExitCode : 0;
    return `${c.command}\0${cwd}\0${stdout}\0${exit}`;
  };
  const executableKeySet = new Set(executable.map(promotionKey));
  // Also accept command-text match when both sides have default context (null cwd / exit 0),
  // but never when the stated row carries a non-default constraint the peer lacks.
  const unpromoted = untrusted.filter((c) => {
    if (executableKeySet.has(promotionKey(c))) return false;
    // Strict: if stated has non-default context, require exact peer key only.
    const hasContext =
      (c.cwd !== null && c.cwd !== undefined && String(c.cwd).trim().length > 0) ||
      (c.expectedStdout !== null &&
        c.expectedStdout !== undefined &&
        String(c.expectedStdout).length > 0) ||
      (typeof c.expectedExitCode === "number" && c.expectedExitCode !== 0);
    if (hasContext) return true;
    // Default-context stated: require at least same command text among executables.
    return !executable.some((e) => e.command === c.command);
  });
  if (unpromoted.length > 0) {
    const listed = unpromoted
      .map((c) => {
        const bits = [`command=${JSON.stringify(c.command)}`];
        if (c.cwd) bits.push(`cwd=${JSON.stringify(c.cwd)}`);
        if (c.expectedStdout) bits.push(`expectedStdout=${JSON.stringify(c.expectedStdout)}`);
        if (typeof c.expectedExitCode === "number" && c.expectedExitCode !== 0) {
          bits.push(`expectedExitCode=${c.expectedExitCode}`);
        }
        return `  - ${bits.join(" ")} (source=${c.source})`;
      })
      .join("\n");
    return {
      ok: false,
      code: 1,
      message:
        `Literal acceptance-command gate FAILED (#3267): ${unpromoted.length} stated command(s) ` +
        `are capture-only (source=task_statement) and have no matching agent-promoted peer.\n` +
        `If the command is this story's acceptance, promote the exact strings ` +
        `(and cwd/expectedStdout/expectedExitCode when stated) into ` +
        `plan.metadata.swarm.verify_commands (or plan item / explicit metadata), then re-run.\n` +
        `If the capture is not an acceptance command, record the exact string in ` +
        `plan.metadata.literal_acceptance_not_commands without promoting it (#3721).\n` +
        `Note: an unrelated executable peer or a same-text peer with different context does not waive.\n` +
        listed,
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

  const runs: LiteralAcceptanceRunResult[] = [];
  const rejected: RejectedLiteralCommand[] = [];
  for (const cmd of executable) {
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
    const run = runLiteralAcceptanceCommand(cmd, options);
    runs.push(run);
    if (isSafetyRefusalRun(run)) {
      rejected.push({
        command: run.command,
        reason: safetyRefusalReason(run),
        sourceSpan: cmd.sourceSpan ?? null,
      });
    }
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
