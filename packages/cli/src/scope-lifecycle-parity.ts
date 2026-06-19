#!/usr/bin/env node
/**
 * Golden-output parity harness (#1726): runs BOTH the Python oracle
 * (`scripts/scope_lifecycle.py`) and the ported TS scope lifecycle CLI,
 * then diffs exit codes and normalised stdout/stderr.
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
  readonly fileRel?: string;
}

export interface ParityDiff {
  readonly caseName: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly stderrMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly pythonStdout: string;
  readonly pythonStderr: string;
  readonly tsStdout: string;
  readonly tsStderr: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

const FIXTURE_NAME = "2026-04-12-add-oauth.vbrief.json";

export function normalizeOutput(text: string): string {
  return text
    .replace(/--project-root [^\s]+/g, "--project-root <ROOT>")
    .trim()
    .replace(/\s+/g, " ");
}

function runCapture(cmd: string, args: string[], cwd: string): CommandCapture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
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

function writeFixture(repo: string, folder: string, status: string): string {
  const full = join(repo, "vbrief", folder, FIXTURE_NAME);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.5" },
        plan: { title: "Add OAuth support", status, items: [] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return full;
}

export const PARITY_CASES: readonly ParityCase[] = [
  { name: "usage-no-args", argv: [] },
  {
    name: "invalid-transition-promote-active",
    argv: ["promote", "<FILE>"],
    fileRel: `vbrief/active/${FIXTURE_NAME}`,
  },
  {
    name: "promote-success",
    argv: ["promote", "<FILE>"],
    fileRel: `vbrief/proposed/${FIXTURE_NAME}`,
  },
];

export function buildArgv(repo: string, testCase: ParityCase): string[] {
  return testCase.argv.map((arg) => {
    if (arg === "<FILE>" && testCase.fileRel !== undefined) {
      return join(repo, testCase.fileRel);
    }
    return arg;
  });
}

function runPythonScope(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  return runCapture(
    "uv",
    [
      "run",
      "python",
      join(deftRoot, "scripts", "scope_lifecycle.py"),
      ...argv,
      "--project-root",
      repo,
    ],
    deftRoot,
  );
}

function runTsScope(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  return runCapture(
    "node",
    [
      join(deftRoot, "packages", "core", "dist", "scope", "cli.js"),
      ...argv,
      "--project-root",
      repo,
    ],
    deftRoot,
  );
}

export function diffCase(python: CommandCapture, ts: CommandCapture, caseName: string): ParityDiff {
  return {
    caseName,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: normalizeOutput(python.stdout) !== normalizeOutput(ts.stdout),
    stderrMismatch: normalizeOutput(python.stderr) !== normalizeOutput(ts.stderr),
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
    pythonStdout: python.stdout,
    pythonStderr: python.stderr,
    tsStdout: ts.stdout,
    tsStderr: ts.stderr,
  };
}

function setupFixtureRepo(testCase: ParityCase): string {
  const repo = mkdtempSync(join(tmpdir(), "deft-scope-parity-"));
  mkdirSync(join(repo, "vbrief"), { recursive: true });
  if (testCase.fileRel?.includes("/proposed/")) {
    writeFixture(repo, "proposed", "proposed");
  }
  if (testCase.fileRel?.includes("/active/")) {
    writeFixture(repo, "active", "running");
  }
  return repo;
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];

  for (const testCase of PARITY_CASES) {
    const mutates = testCase.name === "promote-success";
    const pyRepo = setupFixtureRepo(testCase);
    const tsRepo = mutates ? setupFixtureRepo(testCase) : pyRepo;
    try {
      const pyArgv = buildArgv(pyRepo, testCase);
      const tsArgv = buildArgv(tsRepo, testCase);
      const py = runPythonScope(deftRoot, pyRepo, pyArgv);
      const ts = runTsScope(deftRoot, tsRepo, tsArgv);
      diffs.push(diffCase(py, ts, testCase.name));
    } finally {
      rmSync(pyRepo, { recursive: true, force: true });
      if (tsRepo !== pyRepo) {
        rmSync(tsRepo, { recursive: true, force: true });
      }
    }
  }

  const ok = diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch);
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `scope-lifecycle parity: CLEAN -- Python and TS agree on ${result.diffs.length} scenario(s).`;
  }
  const lines = ["scope-lifecycle parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch) {
      lines.push(`  scenario: ${d.caseName}`);
      if (d.exitMismatch) {
        lines.push(`    exit mismatch: python=${d.pythonExit} ts=${d.tsExit}`);
      }
      if (d.stdoutMismatch) {
        lines.push(`    python stdout: ${normalizeOutput(d.pythonStdout)}`);
        lines.push(`    ts stdout:     ${normalizeOutput(d.tsStdout)}`);
      }
      if (d.stderrMismatch) {
        lines.push(`    python stderr: ${normalizeOutput(d.pythonStderr)}`);
        lines.push(`    ts stderr:     ${normalizeOutput(d.tsStderr)}`);
      }
    }
  }
  return lines.join("\n");
}

export function runParityCli(): number {
  try {
    const result = runParity();
    if (result.ok) {
      process.stdout.write(`${renderReport(result)}\n`);
      return 0;
    }
    process.stderr.write(`${renderReport(result)}\n`);
    return 1;
  } catch (err) {
    const msg = String(err).replace(/\r?\n/g, " ");
    process.stderr.write(`scope-lifecycle parity: harness error -- ${msg}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runParityCli());
}
