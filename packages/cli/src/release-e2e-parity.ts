#!/usr/bin/env node
/**
 * Golden-output parity harness (#1729): runs BOTH the Python oracle
 * (`scripts/release_e2e.py`) and the ported TS release:e2e CLI with
 * identical argv, then diffs exit codes and normalised stderr/stdout.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityScenario {
  readonly name: string;
  readonly argv: readonly string[];
  readonly compareStdout?: boolean;
}

export interface ParityDiff {
  readonly name: string;
  readonly exitMismatch: boolean;
  readonly outputMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly pythonOutput: string;
  readonly tsOutput: string;
  readonly stream: "stdout" | "stderr";
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  { name: "help", argv: ["--help"], compareStdout: true },
  { name: "dry-run", argv: ["--dry-run"] },
  { name: "dry-run-keep-repo", argv: ["--dry-run", "--keep-repo"] },
  {
    name: "dry-run-project-root",
    argv: ["--dry-run", "--owner", "deftai", "--project-root", "/tmp/deft-e2e-parity-root"],
  },
];

/** Normalise volatile repo slugs and ISO dates in stderr while preserving semantics. */
export function normaliseStderr(text: string): string {
  return text
    .replace(/deftai-release-test-\d{14}-[0-9a-f]{6}/g, "deftai-release-test-YYYYMMDDHHMMSS-uuid6")
    .replace(/\d{4}-\d{2}-\d{2}/g, "YYYY-MM-DD");
}

function runCapture(cmd: string, args: string[], cwd: string): CommandCapture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEFT_CACHE_DISABLE: "1",
      PYTHONUTF8: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runScenario(deftRoot: string, scenario: ParityScenario): ParityDiff {
  const argv = [...scenario.argv];
  const py = runCapture(
    "uv",
    ["run", "python", join(deftRoot, "scripts", "release_e2e.py"), ...argv],
    deftRoot,
  );
  const ts = runCapture(
    "node",
    [join(deftRoot, "packages", "cli", "dist", "release-e2e.js"), ...argv],
    deftRoot,
  );
  const stream: "stdout" | "stderr" = scenario.compareStdout ? "stdout" : "stderr";
  let pythonOutput = stream === "stdout" ? py.stdout : py.stderr;
  let tsOutput = stream === "stdout" ? ts.stdout : ts.stderr;
  if (stream === "stderr") {
    pythonOutput = normaliseStderr(pythonOutput);
    tsOutput = normaliseStderr(tsOutput);
  }
  return {
    name: scenario.name,
    exitMismatch: py.exitCode !== ts.exitCode,
    outputMismatch: pythonOutput !== tsOutput,
    pythonExit: py.exitCode,
    tsExit: ts.exitCode,
    pythonOutput,
    tsOutput,
    stream,
  };
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs = PARITY_SCENARIOS.map((scenario) => runScenario(deftRoot, scenario));
  const ok = diffs.every((d) => !d.exitMismatch && !d.outputMismatch);
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `release-e2e parity: CLEAN -- Python and TS agree on ${result.diffs.length} scenario(s).`;
  }
  const lines = ["release-e2e parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.outputMismatch) {
      lines.push(`  scenario: ${d.name}`);
      if (d.exitMismatch) {
        lines.push(`    exit mismatch: python=${d.pythonExit} ts=${d.tsExit}`);
      }
      if (d.outputMismatch) {
        lines.push(`    stream: ${d.stream}`);
        lines.push(`    python (${d.pythonOutput.length} bytes):`);
        lines.push(d.pythonOutput);
        lines.push(`    ts (${d.tsOutput.length} bytes):`);
        lines.push(d.tsOutput);
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
    process.stderr.write(`release-e2e parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
