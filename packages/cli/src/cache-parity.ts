#!/usr/bin/env node
/**
 * Golden-output parity harness (#1728): runs BOTH the Python oracle
 * (`scripts/cache.py`) and the ported TS cache CLI with identical argv,
 * then diffs exit codes and normalised stdout/stderr. Exit 0 only on
 * identical results. Each scenario uses an isolated temp cwd (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
}

export interface ParityResult {
  readonly ok: boolean;
  readonly scenarios: Array<{
    readonly name: string;
    readonly exitMismatch: boolean;
    readonly pythonExit: number;
    readonly tsExit: number;
    readonly messageMismatch: boolean;
    readonly pythonMessage: string;
    readonly tsMessage: string;
  }>;
}

/** Validation-only scenarios (no live gh network). */
export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  { name: "usage-no-cmd", argv: [] },
  { name: "put-missing-args", argv: ["put"] },
  { name: "get-invalid-key", argv: ["get", "github-issue", "bad/key"] },
  {
    name: "put-missing-raw-file",
    argv: ["put", "github-issue", "deftai/directive/1", "--raw-file", "/nonexistent"],
  },
  { name: "get-miss", argv: ["get", "github-issue", "deftai/directive/999"] },
  {
    name: "invalidate-missing",
    argv: ["invalidate", "github-issue", "deftai/directive/999"],
  },
  { name: "prune-dry-run-empty", argv: ["prune", "--dry-run"] },
  {
    name: "fetch-all-invalid-repo",
    argv: ["fetch-all", "--source", "github-issue", "--repo", "bad"],
  },
  {
    name: "fetch-all-batch-size-zero",
    argv: [
      "fetch-all",
      "--source",
      "github-issue",
      "--repo",
      "deftai/directive",
      "--batch-size",
      "0",
    ],
  },
  {
    name: "fetch-all-delay-negative",
    argv: [
      "fetch-all",
      "--source",
      "github-issue",
      "--repo",
      "deftai/directive",
      "--delay-ms",
      "-1",
    ],
  },
  { name: "prune-to-cap-dry-run", argv: ["prune", "--to-cap", "--dry-run"] },
];

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCapture(cmd: string, args: string[], cwd: string): Capture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

/** Normalise gate output for comparison. */
export function normaliseMessage(stdout: string, stderr: string, exitCode: number): string {
  const raw = exitCode === 0 ? stdout : stderr;
  return raw
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Using CPython") &&
        !line.startsWith("Creating virtual environment") &&
        !line.startsWith("Installed "),
    )
    .join("\n")
    .trim()
    .replace(/\s+/g, " ");
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runScenario(
  deftRoot: string,
  scenario: ParityScenario,
): { python: ScenarioResult; ts: ScenarioResult } {
  const cwd = mkdtempSync(join(tmpdir(), "deft-cache-parity-"));
  try {
    const pyArgs = ["run", "python", join(deftRoot, "scripts", "cache.py"), ...scenario.argv];
    const tsArgs = [join(deftRoot, "packages", "cli", "dist", "cache.js"), ...scenario.argv];
    const py = runCapture("uv", pyArgs, cwd);
    const ts = runCapture("node", tsArgs, cwd);
    return {
      python: { name: scenario.name, exitCode: py.status, stdout: py.stdout, stderr: py.stderr },
      ts: { name: scenario.name, exitCode: ts.status, stdout: ts.stdout, stderr: ts.stderr },
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function diffParity(
  python: ScenarioResult,
  ts: ScenarioResult,
): {
  exitMismatch: boolean;
  messageMismatch: boolean;
  pythonMessage: string;
  tsMessage: string;
} {
  const pythonMessage = normaliseMessage(python.stdout, python.stderr, python.exitCode);
  const tsMessage = normaliseMessage(ts.stdout, ts.stderr, ts.exitCode);
  return {
    exitMismatch: python.exitCode !== ts.exitCode,
    messageMismatch: pythonMessage !== tsMessage,
    pythonMessage,
    tsMessage,
  };
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const scenarios: ParityResult["scenarios"] = [];
  for (const scenario of PARITY_SCENARIOS) {
    const ran = runScenario(deftRoot, scenario);
    scenarios.push({
      name: scenario.name,
      pythonExit: ran.python.exitCode,
      tsExit: ran.ts.exitCode,
      ...diffParity(ran.python, ran.ts),
    });
  }
  const ok = scenarios.every((s) => !s.exitMismatch && !s.messageMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `cache parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["cache parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.messageMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      if (s.messageMismatch) {
        lines.push(`    python: ${s.pythonMessage}`);
        lines.push(`    ts:     ${s.tsMessage}`);
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
    process.stderr.write(`cache parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
