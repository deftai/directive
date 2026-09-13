/**
 * verify:consumer-test-lane (#4386).
 *
 * Compose the project's declared test command into the consumer chokepoint.
 * Do not invent `go test ./...` or a universal shipped-library suite.
 * PRODUCT_FIRST_AC_GATE (`verify:ac`) stays first and is not replaced.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliSpawnPlan } from "../check/cli-native-gates.js";
import { killDescendantTree } from "../check/suite-gate-supervisor-lib.js";
import { PRODUCT_AC_GATE_ID } from "../product-first-done-gate/types.js";

export type OutputStream = "stdout" | "stderr" | "none";

export const CONSUMER_TEST_LANE_GATE_ID = "verify:consumer-test-lane";
export const DEFAULT_TEST_TIMEOUT_MS = 15 * 60 * 1000;

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped?: boolean;
}

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SpawnFn = (command: string, args: readonly string[], cwd: string) => SpawnResult;

export interface EvaluateOptions {
  readonly projectRoot?: string;
  readonly quiet?: boolean;
  readonly spawn?: SpawnFn;
  readonly timeoutMs?: number;
}

export interface DeclaredTestCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: "plan.policy.testCommand" | "package.json scripts.test";
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Argv-only whitespace split. Quoted shells, env assignments, and composition are not parsed. Prefer a string[] in plan.policy.testCommand. */
function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function parseTestCommand(raw: unknown): { command: string; args: string[] } | null {
  if (typeof raw === "string" && raw.trim().length > 0) {
    const tokens = tokenize(raw);
    const command = tokens[0];
    if (command === undefined) return null;
    return { command, args: tokens.slice(1) };
  }
  if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === "string")) {
    const tokens = raw.map((item) => item.trim()).filter((item) => item.length > 0);
    const command = tokens[0];
    if (command === undefined) return null;
    return { command, args: tokens.slice(1) };
  }
  return null;
}

function packageManager(projectRoot: string): string {
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Resolve a project-declared test command. Absence is skip, not invention.
 */
export function resolveDeclaredTestCommand(projectRoot: string): DeclaredTestCommand | null {
  const root = resolve(projectRoot);
  const planPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  const plan = readJson(planPath);
  if (isRecord(plan) && isRecord(plan.plan) && isRecord(plan.plan.policy)) {
    const parsed = parseTestCommand(plan.plan.policy.testCommand);
    if (parsed !== null) {
      return { ...parsed, source: "plan.policy.testCommand" };
    }
  }

  const pkgPath = join(root, "package.json");
  const pkg = readJson(pkgPath);
  if (isRecord(pkg) && isRecord(pkg.scripts) && typeof pkg.scripts.test === "string") {
    const testScript = pkg.scripts.test.trim();
    if (testScript.length > 0) {
      return {
        command: packageManager(root),
        args: ["test"],
        source: "package.json scripts.test",
      };
    }
  }
  return null;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  const plan = cliSpawnPlan(command, [...args]);
  const platform = process.platform;
  const child = spawn(plan.command, plan.args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      killDescendantTree(child.pid, { platform });
    }
  }, timeoutMs);
  return new Promise((resolveSpawn) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveSpawn({
        exitCode: 2,
        stdout,
        stderr: error.message,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveSpawn({
        exitCode: timedOut ? 124 : (code ?? 2),
        stdout,
        stderr,
      });
    });
  });
}

function formatSkip(): string {
  return (
    `${CONSUMER_TEST_LANE_GATE_ID}: no declared test command ` +
    `(plan.policy.testCommand or package.json scripts.test). ` +
    `Skip; do not invent a suite. ${PRODUCT_AC_GATE_ID} remains first.`
  );
}

function formatPass(declared: DeclaredTestCommand): string {
  const invocation = [declared.command, ...declared.args].join(" ");
  return (
    `${CONSUMER_TEST_LANE_GATE_ID}: declared test command passed ` +
    `(${declared.source}: ${invocation}). ` +
    `${PRODUCT_AC_GATE_ID} is not replaced.`
  );
}

function formatFail(declared: DeclaredTestCommand, exitCode: number, stderr: string): string {
  const invocation = [declared.command, ...declared.args].join(" ");
  const tail =
    stderr.trim().length > 0 ? ` ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}` : "";
  return (
    `${CONSUMER_TEST_LANE_GATE_ID}: declared test command failed ` +
    `(exit ${exitCode}; ${declared.source}: ${invocation}).${tail}`
  );
}

/** Run the declared consumer test command, or skip when none is declared. */
export async function evaluate(options: EvaluateOptions = {}): Promise<EvaluateResult> {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const declared = resolveDeclaredTestCommand(projectRoot);
  if (declared === null) {
    return {
      code: 0,
      message: options.quiet === true ? "" : formatSkip(),
      stream: "stdout",
      skipped: true,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const spawnFn = options.spawn;
  const result =
    spawnFn !== undefined
      ? spawnFn(declared.command, declared.args, projectRoot)
      : await defaultSpawn(declared.command, declared.args, projectRoot, timeoutMs);

  if (result.exitCode === 0) {
    return {
      code: 0,
      message: options.quiet === true ? "" : formatPass(declared),
      stream: "stdout",
    };
  }

  return {
    code: 1,
    message: formatFail(declared, result.exitCode, result.stderr),
    stream: "stderr",
  };
}
