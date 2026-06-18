#!/usr/bin/env node
/**
 * Golden-output parity harness (#1723): builds throwaway fixture repos, runs
 * BOTH the Python oracle (`scripts/preflight_wip_cap.py`) and the ported TS
 * verify:wip-cap gate, and diffs exit codes + stdout/stderr (cache-off).
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

export interface WipFixtureOptions {
  readonly plan?: Record<string, unknown>;
  readonly pendingFiles?: number;
  readonly activeFiles?: number;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: string[];
  readonly fixture?: WipFixtureOptions;
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
  return text.replace(/project_root=[^\s)]+/g, "project_root=<ROOT>");
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

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], ...plan },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

function writeVbrief(root: string, folder: "pending" | "active", name: string): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { status: "approved", title: "T", items: [] } })}\n`,
    { encoding: "utf8" },
  );
}

/** Build a throwaway project root with optional PROJECT-DEFINITION and WIP files. */
export function buildFixtureRepo(options: WipFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-wip-cap-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (options.plan !== undefined) {
    writeProjectDefinition(root, options.plan);
  }
  for (let i = 0; i < (options.pendingFiles ?? 0); i += 1) {
    writeVbrief(root, "pending", `pending-${i}.vbrief.json`);
  }
  for (let i = 0; i < (options.activeFiles ?? 0); i += 1) {
    writeVbrief(root, "active", `active-${i}.vbrief.json`);
  }
  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonWipCap(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  const cap = runCapture(
    "uv",
    [
      "run",
      "python",
      join(deftRoot, "scripts", "preflight_wip_cap.py"),
      ...argv,
      "--project-root",
      repo,
    ],
    deftRoot,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTsWipCap(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  const cap = runCapture(
    "node",
    [
      join(deftRoot, "packages", "cli", "dist", "verify-wip-cap.js"),
      ...argv,
      "--project-root",
      repo,
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
    name: "within-cap-typed-empty",
    argv: [],
    fixture: { plan: { policy: { wipCap: 5 } } },
  },
  {
    name: "within-cap-with-files",
    argv: [],
    fixture: {
      plan: { policy: { wipCap: 5 } },
      pendingFiles: 2,
      activeFiles: 1,
    },
  },
  {
    name: "over-cap-refusal",
    argv: [],
    fixture: {
      plan: { policy: { wipCap: 2 } },
      pendingFiles: 1,
      activeFiles: 1,
    },
  },
  {
    name: "over-cap-allow-flag",
    argv: ["--allow-over-cap"],
    fixture: {
      plan: { policy: { wipCap: 2 } },
      pendingFiles: 2,
    },
  },
  {
    name: "malformed-wipCap",
    argv: [],
    fixture: { plan: { policy: { wipCap: -1 } } },
  },
  {
    name: "within-cap-quiet",
    argv: ["--quiet"],
    fixture: { plan: { policy: { wipCap: 3 } }, pendingFiles: 1 },
  },
  {
    name: "over-cap-allow-quiet",
    argv: ["--allow-over-cap", "--quiet"],
    fixture: {
      plan: { policy: { wipCap: 1 } },
      pendingFiles: 2,
    },
  },
];

/** Run all parity cases; returns aggregate result. */
export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    const pyRepo = buildFixtureRepo(testCase.fixture);
    const tsRepo = buildFixtureRepo(testCase.fixture);
    try {
      const python = runPythonWipCap(deftRoot, pyRepo, testCase.argv);
      const ts = runTsWipCap(deftRoot, tsRepo, testCase.argv);
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
    return `verify:wip-cap parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["verify:wip-cap parity: DIVERGENCE"];
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
    process.stderr.write(`verify:wip-cap parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
