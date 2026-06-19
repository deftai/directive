#!/usr/bin/env node
/**
 * Golden-output parity harness (#1725): runs BOTH the Python oracle and the
 * ported TS triage aux-A CLIs with identical argv on throwaway fixtures,
 * then diffs exit codes + stdout/stderr (cache-off).
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
  readonly script:
    | "triage_welcome.py"
    | "triage_reconcile.py"
    | "triage_scope_drift.py"
    | "triage_refresh.py";
  readonly tsCli:
    | "triage-welcome.js"
    | "triage-reconcile.js"
    | "triage-scope-drift.js"
    | "triage-refresh.js";
  readonly argv: readonly string[];
  readonly setup?: (root: string) => void;
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

/** Strip volatile absolute paths before compare. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/project_root=[^\s)"]+/g, "project_root=<ROOT>")
    .replace(/"project_root": "[^"]+"/g, '"project_root": "<ROOT>"')
    .replace(/\/tmp\/[^\s"']+/g, "<TMP>");
}

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCapture(cmd: string, args: string[], cwd: string): Capture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 2,
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

export { resolveDeftRoot };

function runPython(
  deftRoot: string,
  script: ParityCase["script"],
  repo: string,
  argv: readonly string[],
): CommandCapture {
  const cap = runCapture(
    "python3",
    [join(deftRoot, "scripts", script), ...argv, "--project-root", repo],
    deftRoot,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTs(
  deftRoot: string,
  cli: ParityCase["tsCli"],
  repo: string,
  argv: readonly string[],
): CommandCapture {
  const cap = runCapture(
    "node",
    [join(deftRoot, "packages", "cli", "dist", cli), ...argv, "--project-root", repo],
    deftRoot,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

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

function writeProjectDefinition(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { policy } }, null, 2)}\n`,
    "utf8",
  );
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "welcome-default-empty",
    script: "triage_welcome.py",
    tsCli: "triage-welcome.js",
    argv: ["--no-history"],
  },
  {
    name: "reconcile-dry-run-json-empty",
    script: "triage_reconcile.py",
    tsCli: "triage-reconcile.js",
    argv: ["--dry-run", "--json"],
  },
  {
    name: "reconcile-text-empty",
    script: "triage_reconcile.py",
    tsCli: "triage-reconcile.js",
    argv: [],
  },
  {
    name: "scope-drift-empty-cache",
    script: "triage_scope_drift.py",
    tsCli: "triage-scope-drift.js",
    argv: [],
    setup: (root) => writeProjectDefinition(root),
  },
  {
    name: "refresh-empty-active",
    script: "triage_refresh.py",
    tsCli: "triage-refresh.js",
    argv: [],
  },
  {
    name: "welcome-bad-root",
    script: "triage_welcome.py",
    tsCli: "triage-welcome.js",
    argv: [],
    setup: () => {},
  },
];

export function buildFixtureRepo(setup?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-aux-a-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  setup?.(root);
  return root;
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    if (testCase.name === "welcome-bad-root") {
      const badRoot = join(tmpdir(), "deft-triage-missing-dir-never-created");
      const python = runPython(deftRoot, testCase.script, badRoot, testCase.argv);
      const ts = runTs(deftRoot, testCase.tsCli, badRoot, testCase.argv);
      diffs.push(diffCase(python, ts, testCase.name));
      continue;
    }
    const pyRepo = buildFixtureRepo(testCase.setup);
    const tsRepo = buildFixtureRepo(testCase.setup);
    try {
      const python = runPython(deftRoot, testCase.script, pyRepo, testCase.argv);
      const ts = runTs(deftRoot, testCase.tsCli, tsRepo, testCase.argv);
      diffs.push(diffCase(python, ts, testCase.name));
    } finally {
      rmSync(pyRepo, { recursive: true, force: true });
      rmSync(tsRepo, { recursive: true, force: true });
    }
  }
  const ok = diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch);
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `triage-aux-a parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage-aux-a parity: DIVERGENCE"];
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
    process.stderr.write(`triage-aux-a parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
