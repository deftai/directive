#!/usr/bin/env node
/**
 * Golden-output parity harness (#1725): runs BOTH the Python oracle
 * (`scripts/triage_actions.py`) and the ported TS triage-actions CLI with
 * isolated fixture roots, then diffs exit codes and normalised stdout/stderr.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: readonly string[];
}

export interface ParityDiff {
  readonly caseName: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly stderrMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

/** Strip volatile UUIDs and timestamps before compare. */
export function normalizeOutput(text: string): string {
  return text
    .replace(
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      "<UUID>",
    )
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>")
    .replace(/Using CPython[^\n]*\n/g, "")
    .replace(/Creating virtual environment[^\n]*\n/g, "")
    .replace(/Installed \d+ packages[^\n]*\n/g, "");
}

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
  const merged = { ...process.env, ...env };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
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
}

/** Build a throwaway project root with an empty audit-log parent directory. */
export function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-actions-parity-"));
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function pythonWrapperScript(deftRoot: string, fixtureRoot: string): string {
  return [
    "import os, sys",
    "from pathlib import Path",
    `fixture = Path(${JSON.stringify(fixtureRoot)})`,
    `deft_root = Path(${JSON.stringify(deftRoot)})`,
    "sys.path.insert(0, str(deft_root / 'scripts'))",
    "import candidates_log as cl",
    "cl.DEFAULT_LOG_PATH = fixture / 'vbrief/.eval/candidates.jsonl'",
    "import triage_actions",
    "triage_actions.candidates_log = cl",
    "raise SystemExit(triage_actions.main(sys.argv[1:]))",
  ].join("\n");
}

function runPythonTriageAction(
  deftRoot: string,
  fixtureRoot: string,
  argv: readonly string[],
): CommandCapture {
  const cap = runCapture(
    "uv",
    ["run", "python", "-c", pythonWrapperScript(deftRoot, fixtureRoot), ...argv],
    deftRoot,
    { TRIAGE_PARITY_FIXTURE: fixtureRoot },
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTsTriageAction(
  deftRoot: string,
  fixtureRoot: string,
  argv: readonly string[],
): CommandCapture {
  const cap = runCapture(
    "node",
    [
      join(deftRoot, "packages", "cli", "dist", "triage-actions.js"),
      ...argv,
      "--project-root",
      fixtureRoot,
    ],
    deftRoot,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

/** Diff one parity case between Python oracle and TS CLI. */
export function diffCase(python: CommandCapture, ts: CommandCapture, caseName: string): ParityDiff {
  const pyOut = normalizeOutput(python.stdout);
  const tsOut = normalizeOutput(ts.stdout);
  const pyErr = normalizeOutput(python.stderr);
  const tsErr = normalizeOutput(ts.stderr);
  return {
    caseName,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pyOut !== tsOut,
    stderrMismatch: pyErr !== tsErr,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "defer-invalid-resume-on",
    argv: [
      "defer",
      "--issue",
      "7",
      "--repo",
      "deftai/directive",
      "--reason",
      "later",
      "--resume-on",
      "not-valid",
    ],
  },
  {
    name: "defer-success",
    argv: ["defer", "--issue", "7", "--repo", "deftai/directive", "--reason", "later"],
  },
  {
    name: "defer-with-resume-on",
    argv: [
      "defer",
      "--issue",
      "8",
      "--repo",
      "deftai/directive",
      "--reason",
      "blocked",
      "--resume-on",
      "ref:closed:#99",
    ],
  },
  {
    name: "accept-idempotent",
    argv: ["accept", "--issue", "9", "--repo", "deftai/directive", "--actor", "agent:test"],
  },
];

function seedAcceptFixture(fixtureRoot: string): void {
  const entry = {
    actor: "agent:test",
    decision: "accept",
    decision_id: "prior-id-0000-0000-0000-000000000001",
    issue_number: 9,
    repo: "deftai/directive",
    timestamp: "2026-06-18T12:00:00Z",
  };
  writeFileSync(
    join(fixtureRoot, "vbrief/.eval/candidates.jsonl"),
    `${JSON.stringify(entry, Object.keys(entry).sort())}\n`,
    "utf8",
  );
}

/** Run all parity cases; returns aggregate result. */
export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    const pyFixture = buildFixtureRepo();
    const tsFixture = buildFixtureRepo();
    if (testCase.name === "accept-idempotent") {
      seedAcceptFixture(pyFixture);
      seedAcceptFixture(tsFixture);
    }
    try {
      const python = runPythonTriageAction(deftRoot, pyFixture, testCase.argv);
      const ts = runTsTriageAction(deftRoot, tsFixture, testCase.argv);
      diffs.push(diffCase(python, ts, testCase.name));
    } finally {
      rmSync(pyFixture, { recursive: true, force: true });
      rmSync(tsFixture, { recursive: true, force: true });
    }
  }
  const ok = diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch);
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `triage-actions parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage-actions parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch) {
      lines.push(`  case: ${d.caseName}`);
      if (d.exitMismatch) lines.push(`    exit: python=${d.pythonExit} ts=${d.tsExit}`);
      if (d.stdoutMismatch) lines.push("    stdout mismatch");
      if (d.stderrMismatch) lines.push("    stderr mismatch");
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
    process.stderr.write(`triage-actions parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
