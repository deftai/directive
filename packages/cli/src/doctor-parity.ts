#!/usr/bin/env node
/**
 * Golden-output parity harness (#1728): runs BOTH the Python oracle
 * (`scripts/doctor.py`) and the ported TS doctor CLI with identical argv,
 * then diffs exit codes and stdout. Exit 0 only on byte-identical results.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly setup?: (root: string) => void;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly scenarios: Array<{
    readonly name: string;
    readonly exitMismatch: boolean;
    readonly pythonExit: number;
    readonly tsExit: number;
    readonly stdoutMismatch: boolean;
    readonly pythonStdout: string;
    readonly tsStdout: string;
  }>;
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  { name: "full-json-deft-root", argv: ["--full", "--json"] },
  { name: "full-quiet-deft-root", argv: ["--full", "--quiet"] },
  { name: "unknown-flag", argv: ["--not-a-real-flag"] },
  {
    name: "full-json-consumer-fixture",
    argv: ["--full", "--json"],
    setup(root) {
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(
        join(root, ".deft", "core", "VERSION"),
        "tag: v0.1.0\nsha: abcdef0123456789abcdef0123456789abcdef01\nref: v0.1.0\n",
        "utf8",
      );
    },
  },
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
  };
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

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Normalise volatile lines while preserving doctor semantics. */
export function normaliseStdout(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Using CPython") &&
        !line.startsWith("Creating virtual environment") &&
        !line.startsWith("Installed "),
    )
    .join("\n");
}

function runScenario(
  deftRoot: string,
  scenario: ParityScenario,
): { python: ScenarioResult; ts: ScenarioResult } {
  let cwd = scenario.cwd ?? deftRoot;
  let tempRoot: string | undefined;
  const argv = [...scenario.argv];
  if (scenario.setup) {
    tempRoot = mkdtempSync(join(tmpdir(), "deft-doctor-parity-"));
    scenario.setup(tempRoot);
    cwd = tempRoot;
  }
  try {
    const pyArgs = ["run", "python", join(deftRoot, "scripts", "doctor.py"), ...argv];
    const tsArgs = [join(deftRoot, "packages", "cli", "dist", "doctor.js"), ...argv];
    const env = { ...scenario.env, PYTHONUTF8: "1" };
    const py = runCapture("uv", pyArgs, cwd, env);
    const ts = runCapture("node", tsArgs, cwd, env);
    return {
      python: { name: scenario.name, exitCode: py.status, stdout: py.stdout, stderr: py.stderr },
      ts: { name: scenario.name, exitCode: ts.status, stdout: ts.stdout, stderr: ts.stderr },
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
): {
  exitMismatch: boolean;
  stdoutMismatch: boolean;
  pythonStdout: string;
  tsStdout: string;
} {
  const pythonStdout = normaliseStdout(python.stdout);
  const tsStdout = normaliseStdout(ts.stdout);
  return {
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pythonStdout !== tsStdout,
    pythonStdout,
    tsStdout,
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
  const ok = scenarios.every((s) => !s.exitMismatch && !s.stdoutMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `doctor parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["doctor parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.stdoutMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
      if (s.stdoutMismatch) {
        lines.push(`    python stdout (${s.pythonStdout.length} bytes)`);
        lines.push(`    ts stdout (${s.tsStdout.length} bytes)`);
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
    process.stderr.write(`doctor parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
