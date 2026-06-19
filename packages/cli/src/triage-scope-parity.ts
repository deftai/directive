#!/usr/bin/env node
/**
 * Golden-output parity harness (#1725): runs BOTH the Python oracle
 * (`scripts/triage_scope.py`) and the ported TS triage:scope CLI, then
 * diffs exit codes and normalised stdout/stderr (cache-off).
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

export interface ScopeFixtureOptions {
  readonly policy?: Record<string, unknown>;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: string[];
  readonly fixture?: ScopeFixtureOptions;
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
    .replace(/--project-root [^\s]+/g, "--project-root <ROOT>")
    .replace(/--cache-root [^\s]+/g, "--cache-root <ROOT>")
    .replace(/path=[^\s\n]+coverage\.json/g, "path=<ROOT>/coverage.json");
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

function writeProjectDefinition(root: string, policy: Record<string, unknown> = {}): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], policy },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function buildFixtureRepo(options: ScopeFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-scope-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeProjectDefinition(root, options.policy ?? {});
  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonScope(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  return runCapture(
    "uv",
    [
      "run",
      "python",
      join(deftRoot, "scripts", "triage_scope.py"),
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
    [join(deftRoot, "packages", "cli", "dist", "triage-scope.js"), ...argv, "--project-root", repo],
    deftRoot,
  );
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

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "list-default",
    argv: ["--list"],
  },
  {
    name: "list-custom-scope-ignores",
    argv: ["--list"],
    fixture: {
      policy: {
        triageScope: [{ rule: "labels", "any-of": ["bug"] }],
        triageScopeIgnores: [
          { label: "wontfix" },
          { rule: "author", "any-of": ["dependabot[bot]"] },
        ],
      },
    },
  },
  {
    name: "add-label",
    argv: ["--add-label=priority:p0"],
  },
  {
    name: "add-milestone",
    argv: ["--add-milestone=v2.0-blocker"],
  },
  {
    name: "ignore-label",
    argv: ["--ignore-label=wontfix"],
  },
  {
    name: "mutations-mutually-exclusive",
    argv: ["--add-label=bug", "--ignore-label=wontfix"],
  },
  {
    name: "diff-from-upstream-missing-repo",
    argv: ["--diff-from-upstream"],
    fixture: { policy: {} },
  },
  {
    name: "refresh-denominator-missing-repo",
    argv: ["--refresh-denominator", "--count", "10"],
  },
  {
    name: "invalid-project-root",
    argv: ["--list"],
    fixture: undefined,
  },
  {
    name: "schema-error",
    argv: ["--list"],
    fixture: {
      policy: {
        triageScope: [{ rule: "bogus-type" }],
      },
    },
  },
  {
    name: "refresh-denominator-success",
    argv: [
      "--refresh-denominator",
      "--repo",
      "deftai/directive",
      "--count",
      "247",
      "--source",
      "github-issue",
    ],
    fixture: {
      policy: { triageScope: [{ rule: "all-open" }] },
    },
  },
];

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    if (testCase.name === "invalid-project-root") {
      const missing = join(tmpdir(), `deft-missing-${Date.now()}`);
      const python = runPythonScope(deftRoot, missing, testCase.argv);
      const ts = runTsScope(deftRoot, missing, testCase.argv);
      diffs.push(diffCase(python, ts, testCase.name));
      continue;
    }
    const pyRepo = buildFixtureRepo(testCase.fixture);
    const tsRepo = buildFixtureRepo(testCase.fixture);
    try {
      const extraArgv = [...testCase.argv];
      if (testCase.name === "refresh-denominator-success") {
        const cacheRoot = mkdtempSync(join(tmpdir(), "deft-scope-cache-"));
        extraArgv.push("--cache-root", cacheRoot);
      }
      const python = runPythonScope(deftRoot, pyRepo, extraArgv);
      const ts = runTsScope(deftRoot, tsRepo, extraArgv);
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
    return `triage:scope parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage:scope parity: DIVERGENCE"];
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
    process.stderr.write(`triage:scope parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
