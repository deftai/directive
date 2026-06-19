#!/usr/bin/env node
/**
 * Golden-output parity harness (#1729): runs BOTH the Python oracle
 * (`scripts/release.py`) and the ported TS release CLI with identical argv,
 * then diffs exit codes and normalised stderr/stdout. Exit 0 only on
 * byte-identical results (volatile ISO dates normalised in stderr).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_CHANGELOG = ` Changelog

All notable changes to the project.

## [Unreleased]

### Added
- New release automation (#74)

### Changed
- Refactored module X

### Fixed
- Bug Y

## [0.20.2] - 2026-04-24

### Added
- Prior change

## [0.20.0] - 2026-04-23

### Added
- Older change

[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD
[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2
[0.20.0]: https://github.com/deftai/directive/compare/v0.19.0...v0.20.0
`;

export interface ScenarioResult {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityScenario {
  readonly name: string;
  readonly argv: readonly string[];
  readonly setup?: (root: string) => void;
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
    name: "dry-run-fixture",
    argv: [
      "0.21.0",
      "--dry-run",
      "--skip-tag",
      "--skip-release",
      "--repo",
      "deftai/directive",
      "--allow-vbrief-drift",
      "--skip-ci",
    ],
    setup(root) {
      writeFileSync(join(root, "CHANGELOG.md"), SAMPLE_CHANGELOG, "utf8");
      execFileSync("git", ["init", "-q", "-b", "master", root]);
      execFileSync("git", ["config", "user.email", "parity@test.local"], { cwd: root });
      execFileSync("git", ["config", "user.name", "deft-parity"], { cwd: root });
      execFileSync("git", ["add", "CHANGELOG.md"], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "init"], {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "deft-parity",
          GIT_AUTHOR_EMAIL: "parity@test.local",
          GIT_COMMITTER_NAME: "deft-parity",
          GIT_COMMITTER_EMAIL: "parity@test.local",
        },
      });
    },
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

/** Normalise volatile ISO dates in stderr while preserving semantics. */
export function normaliseStderr(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}/g, "YYYY-MM-DD");
}

export function pickOutput(result: ScenarioResult, stream: "stdout" | "stderr"): string {
  return stream === "stdout" ? result.stdout : result.stderr;
}

function runScenario(
  deftRoot: string,
  scenario: ParityScenario,
): { python: ScenarioResult; ts: ScenarioResult; projectRoot?: string } {
  let cwd = deftRoot;
  let tempRoot: string | undefined;
  let projectRoot: string | undefined;
  const argv = [...scenario.argv];

  if (scenario.setup) {
    tempRoot = mkdtempSync(join(tmpdir(), "deft-release-parity-"));
    projectRoot = tempRoot;
    scenario.setup(tempRoot);
    const idx = argv.indexOf("--project-root");
    if (idx === -1) {
      argv.push("--project-root", tempRoot);
    }
    cwd = deftRoot;
  }

  try {
    const pyArgs = ["run", "python", join(deftRoot, "scripts", "release.py"), ...argv];
    const tsArgs = [join(deftRoot, "packages", "cli", "dist", "release.js"), ...argv];
    const py = runCapture("uv", pyArgs, cwd);
    const ts = runCapture("node", tsArgs, cwd);
    return {
      python: { name: scenario.name, exitCode: py.status, stdout: py.stdout, stderr: py.stderr },
      ts: { name: scenario.name, exitCode: ts.status, stdout: ts.stdout, stderr: ts.stderr },
      projectRoot,
    };
  } finally {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
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
    return `release parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["release parity: DIVERGENCE"];
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
    process.stderr.write(`release parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
