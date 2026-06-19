#!/usr/bin/env node
/**
 * Golden-output parity harness (#1725): builds throwaway fixture repos, runs
 * BOTH the Python oracle (`scripts/triage_bootstrap.py`) and the ported TS
 * triage:bootstrap CLI, and diffs exit codes + stdout/stderr (cache-off).
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
  readonly argv: string[];
  readonly fixture?: FixtureOptions;
}

export interface FixtureOptions {
  readonly scopeVbriefs?: Array<{ folder: string; slug: string; issue: number }>;
  readonly preRunBootstrap?: boolean;
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
    .replace(/project_root": "[^"]+"/g, 'project_root": "<ROOT>"')
    .replace(/"project_root": "[^"]+"/g, '"project_root": "<ROOT>"')
    .replace(/project_root=[^\s)]+/g, "project_root=<ROOT>")
    .replace(/under \/tmp\/[^\s)]+/g, "under <ROOT>")
    .replace(/under \/var\/[^\s)]+/g, "under <ROOT>");
}

/** Compare stdout, parsing JSON payloads when present. */
export function normalizeStdout(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.project_root === "string") {
        parsed.project_root = "<ROOT>";
      }
      const steps = parsed.steps;
      if (Array.isArray(steps)) {
        for (const step of steps) {
          if (typeof step !== "object" || step === null) continue;
          const record = step as Record<string, unknown>;
          if (typeof record.message === "string") {
            record.message = normalizeOutput(record.message);
          }
          const details = record.details;
          if (typeof details === "object" && details !== null) {
            const detailRecord = details as Record<string, unknown>;
            if (typeof detailRecord.audit_path === "string") {
              detailRecord.audit_path = "<ROOT>/vbrief/.eval/candidates.jsonl";
            }
            if (typeof detailRecord.fetch_timeout_s === "number") {
              detailRecord.fetch_timeout_s = Math.trunc(detailRecord.fetch_timeout_s);
            }
            if (typeof detailRecord.elapsed_s === "number") {
              detailRecord.elapsed_s = Number(detailRecord.elapsed_s.toFixed(3));
            }
          }
        }
      }
      return JSON.stringify(parsed);
    } catch {
      return normalizeOutput(text);
    }
  }
  return normalizeOutput(text);
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

function writeScopeVbrief(root: string, folder: string, slug: string, issueNumber: number): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.vbrief.json`),
    `${JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        id: slug,
        title: slug,
        status: "proposed",
        references: [
          {
            type: "x-vbrief/github-issue",
            uri: `https://github.com/deftai/directive/issues/${issueNumber}`,
          },
        ],
      },
    })}\n`,
    { encoding: "utf8" },
  );
}

/** Build a throwaway project root with optional vBRIEF fixtures. */
export function buildFixtureRepo(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-bootstrap-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  for (const item of options.scopeVbriefs ?? []) {
    writeScopeVbrief(root, item.folder, item.slug, item.issue);
  }
  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonBootstrap(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  const args = ["run", "python", join(deftRoot, "scripts", "triage_bootstrap.py"), ...argv];
  if (!argv.some((a) => a === "--project-root" || a.startsWith("--project-root="))) {
    args.push("--project-root", repo);
  }
  const cap = runCapture("uv", args, deftRoot);
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTsBootstrap(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  const args = [join(deftRoot, "packages", "cli", "dist", "triage-bootstrap.js"), ...argv];
  if (!argv.some((a) => a === "--project-root" || a.startsWith("--project-root="))) {
    args.push("--project-root", repo);
  }
  const cap = runCapture("node", args, deftRoot);
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

/** Diff one parity case between Python oracle and TS CLI. */
export function diffCase(python: CommandCapture, ts: CommandCapture, caseName: string): ParityDiff {
  const pyOut = normalizeStdout(python.stdout);
  const tsOut = normalizeStdout(ts.stdout);
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
    name: "json-no-repo-quiet",
    argv: ["--json", "--quiet"],
  },
  {
    name: "recap-no-repo-quiet",
    argv: ["--quiet"],
  },
  {
    name: "config-error-bad-root",
    argv: ["--json", "--project-root", "/nonexistent-deft-bootstrap-parity-root"],
  },
  {
    name: "json-invalid-repo-quiet",
    argv: ["--json", "--quiet", "--repo", "bad"],
  },
  {
    name: "json-idempotent-rerun",
    argv: ["--json", "--quiet"],
    fixture: { preRunBootstrap: true },
  },
];

/** Run all parity cases; returns aggregate result. */
export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    const pyRepo = buildFixtureRepo(testCase.fixture ?? {});
    const tsRepo = buildFixtureRepo(testCase.fixture ?? {});
    try {
      if (testCase.fixture?.preRunBootstrap === true) {
        runPythonBootstrap(deftRoot, pyRepo, ["--quiet"]);
        runTsBootstrap(deftRoot, tsRepo, ["--quiet"]);
      }
      const python = runPythonBootstrap(deftRoot, pyRepo, testCase.argv);
      const ts = runTsBootstrap(deftRoot, tsRepo, testCase.argv);
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
    return `triage:bootstrap parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage:bootstrap parity: DIVERGENCE"];
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
    process.stderr.write(`triage:bootstrap parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
