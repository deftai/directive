#!/usr/bin/env node
/**
 * Golden-output parity harness (#1729): runs BOTH the Python oracle
 * (`scripts/release_rollback.py`) and the ported TS release:rollback CLI
 * with identical argv, then diffs exit codes and normalised stderr/stdout.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScenarioResult {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityScenario {
  readonly name: string;
  readonly argv: readonly string[];
  readonly compareStdout?: boolean;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly scenarios: Array<{
    readonly name: string;
    readonly exitMismatch: boolean;
    readonly pythonExit: number;
    readonly tsExit: number;
    readonly outputMismatch: boolean;
    readonly pythonOutput: string;
    readonly tsOutput: string;
    readonly stream: "stdout" | "stderr";
  }>;
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  { name: "invalid-version", argv: ["not-a-version"] },
  {
    name: "negative-allow-low-downloads",
    argv: ["0.21.0", "--allow-low-downloads", "-1"],
  },
  {
    name: "dry-run-absent",
    argv: ["0.99.0", "--dry-run", "--repo", "deftai/directive"],
  },
  {
    name: "allow-low-downloads-missing-value",
    argv: ["0.21.0", "--allow-low-downloads", "--dry-run"],
  },
  { name: "help", argv: ["--help"], compareStdout: true },
];

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): Capture {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    DEFT_CACHE_DISABLE: "1",
    PYTHONUTF8: "1",
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  try {
    const result = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      env: merged as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: result.status ?? 2,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === "number" ? e.status : 2,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function normaliseStderr(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}/g, "YYYY-MM-DD");
}

export function pickOutput(result: ScenarioResult, stream: "stdout" | "stderr"): string {
  return stream === "stdout" ? result.stdout : result.stderr;
}

function runScenario(
  deftRoot: string,
  scenario: ParityScenario,
): { python: ScenarioResult; ts: ScenarioResult } {
  const argv = [...scenario.argv];
  const pyArgs = ["run", "python", join(deftRoot, "scripts", "release_rollback.py"), ...argv];
  const tsArgs = [join(deftRoot, "packages", "cli", "dist", "release-rollback.js"), ...argv];
  const py = runCapture("uv", pyArgs, deftRoot);
  const ts = runCapture("node", tsArgs, deftRoot);
  return {
    python: {
      name: scenario.name,
      exitCode: py.status,
      stdout: py.stdout,
      stderr: py.stderr,
    },
    ts: {
      name: scenario.name,
      exitCode: ts.status,
      stdout: ts.stdout,
      stderr: ts.stderr,
    },
  };
}

export function diffParity(
  python: ScenarioResult,
  ts: ScenarioResult,
  stream: "stdout" | "stderr",
): {
  exitMismatch: boolean;
  outputMismatch: boolean;
  pythonOutput: string;
  tsOutput: string;
} {
  let pythonOutput = pickOutput(python, stream);
  let tsOutput = pickOutput(ts, stream);
  if (stream === "stderr") {
    pythonOutput = normaliseStderr(pythonOutput);
    tsOutput = normaliseStderr(tsOutput);
  }
  return {
    exitMismatch: python.exitCode !== ts.exitCode,
    outputMismatch: pythonOutput !== tsOutput,
    pythonOutput,
    tsOutput,
  };
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const scenarios: ParityResult["scenarios"] = [];
  for (const scenario of PARITY_SCENARIOS) {
    const ran = runScenario(deftRoot, scenario);
    const stream: "stdout" | "stderr" = scenario.compareStdout ? "stdout" : "stderr";
    scenarios.push({
      name: scenario.name,
      pythonExit: ran.python.exitCode,
      tsExit: ran.ts.exitCode,
      stream,
      ...diffParity(ran.python, ran.ts, stream),
    });
  }
  const ok = scenarios.every((s) => !s.exitMismatch && !s.outputMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `release-rollback parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["release-rollback parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.outputMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
      if (s.outputMismatch) {
        lines.push(`    stream: ${s.stream}`);
        lines.push(`    python (${s.pythonOutput.length} bytes)`);
        lines.push(`    ts (${s.tsOutput.length} bytes)`);
      }
    }
  }
  return lines.join("\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runParity();
    if (result.ok) {
      process.stdout.write(`${renderReport(result)}\n`);
      process.exit(0);
    }
    process.stderr.write(`${renderReport(result)}\n`);
    process.exit(1);
  } catch (err) {
    const msg = String(err).replace(/\r?\n/g, " ");
    process.stderr.write(`release-rollback parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
