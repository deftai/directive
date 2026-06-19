#!/usr/bin/env node
/**
 * Golden-output parity harness (#1724): runs BOTH the Python oracle
 * (`scripts/scm.py`) and the ported TS SCM CLI with identical argv, then
 * diffs exit codes and normalised stdout/stderr. Exit 0 only on identical
 * results.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
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
  { name: "usage-too-short", argv: [] },
  { name: "unknown-namespace", argv: ["isue", "list"] },
  { name: "unknown-issue-verb", argv: ["issue", "merge"] },
  {
    name: "rest-rejected-close",
    argv: ["issue", "close", "--rest", "1", "--repo", "deftai/directive"],
  },
  {
    name: "rest-rejected-edit",
    argv: ["issue", "edit", "--rest", "1", "--repo", "deftai/directive"],
  },
  { name: "rest-view-missing-repo", argv: ["issue", "view", "--rest", "1"] },
  {
    name: "rest-view-missing-positional",
    argv: ["issue", "view", "--rest", "--repo", "deftai/directive"],
  },
  {
    name: "rest-view-non-integer",
    argv: ["issue", "view", "--rest", "abc", "--repo", "deftai/directive"],
  },
  {
    name: "rest-view-unknown-flag",
    argv: ["issue", "view", "--rest", "1", "--repo", "deftai/directive", "--state", "closed"],
  },
  { name: "rest-list-missing-repo", argv: ["issue", "list", "--rest"] },
  {
    name: "rest-list-unknown-flag",
    argv: ["issue", "list", "--rest", "--repo", "deftai/directive", "--unknown-flag", "x"],
  },
  {
    name: "rest-list-leftover-positional",
    argv: ["issue", "list", "--rest", "123", "--repo", "deftai/directive"],
  },
  {
    name: "rest-list-non-integer-limit",
    argv: ["issue", "list", "--rest", "--repo", "deftai/directive", "--limit", "many"],
  },
  {
    name: "rest-view-invalid-repo",
    argv: ["issue", "view", "--rest", "1", "--repo", "directive"],
  },
  {
    name: "rest-list-invalid-repo",
    argv: ["issue", "list", "--rest", "--repo", "directive"],
  },
];

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCapture(cmd: string, args: string[], cwd: string): Capture {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === "number" ? e.status : 2,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
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
  const pyArgs = ["run", "python", join(deftRoot, "scripts", "scm.py"), ...scenario.argv];
  const tsArgs = [join(deftRoot, "packages", "core", "dist", "scm", "cli.js"), ...scenario.argv];

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

/** Diff python vs TS outputs for one scenario. */
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

/** Run all parity scenarios and return a structured result. */
export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const scenarios: ParityResult["scenarios"] = [];

  for (const scenario of PARITY_SCENARIOS) {
    const ran = runScenario(deftRoot, scenario);
    const diff = diffParity(ran.python, ran.ts);
    scenarios.push({
      name: scenario.name,
      pythonExit: ran.python.exitCode,
      tsExit: ran.ts.exitCode,
      ...diff,
    });
  }

  const ok = scenarios.every((s) => !s.exitMismatch && !s.messageMismatch);
  return { ok, scenarios };
}

/** Render a human-readable parity report. */
export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `scm parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["scm parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.messageMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
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
    process.stderr.write(`scm parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
