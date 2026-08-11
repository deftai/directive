/**
 * Run stored literal acceptance commands verbatim (#3267).
 *
 * Same flags, same cwd (project root unless the command record states otherwise).
 * Fail closed on non-zero exit or missing expected stdout.
 * Self-chosen verification is supplementary — this gate only runs stored literals.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { evaluateCommandSafety } from "./safety.js";
import type {
  LiteralAcceptanceCommand,
  LiteralAcceptanceGateResult,
  LiteralAcceptanceRunner,
  LiteralAcceptanceRunResult,
} from "./types.js";

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

  const runs: LiteralAcceptanceRunResult[] = [];
  for (const cmd of commands) {
    if (typeof cmd.command !== "string" || cmd.command.trim().length === 0) {
      return {
        ok: false,
        code: 2,
        message: "Literal acceptance-command gate config error: empty command entry (#3267)",
        commands,
        runs,
      };
    }
    runs.push(runLiteralAcceptanceCommand(cmd, options));
  }

  const failed = runs.filter((r) => !r.ok);
  if (failed.length === 0) {
    const lines = runs.map((r) => `  ✓ ${r.command} — ${r.detail}`);
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
  };
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
