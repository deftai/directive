import * as childProcess from "node:child_process";

export interface ToolCheck {
  readonly name: string;
  readonly command: readonly string[];
}

export const TOOLS: readonly ToolCheck[] = [
  { name: "go", command: ["go", "version"] },
  { name: "uv", command: ["uv", "--version"] },
  { name: "git", command: ["git", "--version"] },
  { name: "gh", command: ["gh", "--version"] },
];

export type CommandRunner = (
  command: readonly string[],
  timeoutMs: number,
) =>
  | { returncode: number; stdout: string; stderr: string }
  | { error: "not-found" | "exception"; message: string };

export interface ToolchainCheckResult {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function defaultCommandRunner(
  command: readonly string[],
  timeoutMs: number,
):
  | { returncode: number; stdout: string; stderr: string }
  | { error: "not-found" | "exception"; message: string } {
  try {
    const stdout = childProcess.execFileSync(command[0] ?? "", command.slice(1), {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as {
      code?: string;
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (e.code === "ENOENT") {
      return { error: "not-found", message: "" };
    }
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? err),
    };
  }
}

/** Run maintainer toolchain probe (mirrors scripts/toolchain-check.py). */
export function runToolchainCheck(
  runner: CommandRunner = defaultCommandRunner,
  tools: readonly ToolCheck[] = TOOLS,
): ToolchainCheckResult {
  const lines: string[] = [];
  const failed: string[] = [];

  for (const tool of tools) {
    const result = runner(tool.command, DEFAULT_TIMEOUT_MS);
    if ("error" in result) {
      if (result.error === "not-found") {
        failed.push(tool.name);
        lines.push(`  ${tool.name}: NOT FOUND`);
      } else {
        failed.push(tool.name);
        lines.push(`  ${tool.name}: ERROR - ${result.message}`);
      }
      continue;
    }
    const version = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
    if (result.returncode === 0) {
      lines.push(`  ${tool.name}: ${version}`);
    } else {
      failed.push(tool.name);
      lines.push(`  ${tool.name}: FAILED (exit ${result.returncode})`);
    }
  }

  lines.push("");
  if (failed.length > 0) {
    lines.push(`Missing tools: ${failed.join(", ")}`);
    return { lines, exitCode: 1 };
  }
  lines.push("All required tools available");
  return { lines, exitCode: 0 };
}
