import * as childProcess from "node:child_process";
import { nodeRuntimeRemediationLines } from "./node-runtime.js";

export interface ToolCheck {
  readonly name: string;
  readonly command: readonly string[];
}

export const MAINTAINER_TOOLS: readonly ToolCheck[] = [
  { name: "go", command: ["go", "version"] },
  { name: "uv", command: ["uv", "--version"] },
  { name: "git", command: ["git", "--version"] },
  { name: "gh", command: ["gh", "--version"] },
  { name: "node", command: ["node", "--version"] },
  { name: "pnpm", command: ["pnpm", "--version"] },
];

/** Consumer npm-deposit toolchain (#2022 Phase 3) -- no Python/go/uv maintainer tools. */
export const CONSUMER_TOOLS: readonly ToolCheck[] = [
  { name: "git", command: ["git", "--version"] },
  { name: "gh", command: ["gh", "--version"] },
  { name: "node", command: ["node", "--version"] },
  { name: "pnpm", command: ["pnpm", "--version"] },
  { name: "task", command: ["task", "--version"] },
];

/** @deprecated use MAINTAINER_TOOLS */
export const TOOLS: readonly ToolCheck[] = MAINTAINER_TOOLS;

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

export interface ToolchainCheckOptions {
  readonly consumer?: boolean;
}

/** Run maintainer or consumer toolchain probe (mirrors scripts/toolchain-check.py). */
export function runToolchainCheck(
  runner: CommandRunner = defaultCommandRunner,
  options: ToolchainCheckOptions = {},
  tools?: readonly ToolCheck[],
): ToolchainCheckResult {
  const selectedTools = tools ?? (options.consumer ? CONSUMER_TOOLS : MAINTAINER_TOOLS);
  const lines: string[] = [];
  const failed: string[] = [];

  for (const tool of selectedTools) {
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
    lines.push(...nodeRuntimeRemediationLines(failed));
    return { lines, exitCode: 1 };
  }
  lines.push("All required tools available");
  return { lines, exitCode: 0 };
}
