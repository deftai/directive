#!/usr/bin/env node
/**
 * Golden-output parity harness (#1722): builds throwaway fixture repos, runs
 * BOTH the Python oracle (scripts/policy.py + shims) and the TS policy CLI,
 * and diffs resolution output + disclosure_line + exit codes.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
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
  readonly env?: Record<string, string | undefined>;
  readonly fixture?: Record<string, unknown>;
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

/** Strip volatile ISO timestamps from audit / JSON envelopes before compare. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<TS>")
    .replace(/PROJECT-DEFINITION not found at [^\s)]+/g, "PROJECT-DEFINITION not found at <ROOT>")
    .replace(
      /fail-closed: PROJECT-DEFINITION not found at [^)]+/g,
      "fail-closed: PROJECT-DEFINITION not found at <ROOT>",
    );
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
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      env: merged as NodeJS.ProcessEnv,
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

function writeFixture(root: string, plan: Record<string, unknown>): void {
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

/** Build a throwaway project root with optional PROJECT-DEFINITION plan payload. */
export function buildFixtureRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-policy-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (plan !== undefined) {
    writeFixture(root, plan);
  }
  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonPolicy(
  deftRoot: string,
  repo: string,
  argv: string[],
  env: Record<string, string | undefined>,
): CommandCapture {
  const sub = argv[0];
  if (sub === undefined) {
    throw new Error("missing policy subcommand");
  }
  const rest = argv.slice(1);
  const withRoot = [...rest, "--project-root", repo];
  if (sub === "show") {
    const cap = runCapture(
      "uv",
      ["run", "python", join(deftRoot, "scripts", "_policy_show_cli.py"), ...withRoot],
      deftRoot,
      env,
    );
    return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  if (sub === "resolve") {
    const cap = runCapture(
      "uv",
      ["run", "python", join(deftRoot, "scripts", "policy.py"), "show", ...withRoot],
      deftRoot,
      env,
    );
    return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  const cap = runCapture(
    "uv",
    ["run", "python", join(deftRoot, "scripts", "policy_set.py"), sub, ...withRoot],
    deftRoot,
    env,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTsPolicy(
  deftRoot: string,
  repo: string,
  argv: string[],
  env: Record<string, string | undefined>,
): CommandCapture {
  const cap = runCapture(
    "node",
    [join(deftRoot, "packages", "cli", "dist", "policy.js"), ...argv, "--project-root", repo],
    deftRoot,
    env,
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
    name: "resolve-default-missing-pd",
    argv: ["resolve"],
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "resolve-typed-false",
    argv: ["resolve"],
    fixture: { policy: { allowDirectCommitsToMaster: false } },
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "resolve-typed-true",
    argv: ["resolve"],
    fixture: { policy: { allowDirectCommitsToMaster: true } },
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "resolve-legacy-narrative",
    argv: ["resolve"],
    fixture: { narratives: { "Allow direct commits to master": "true" } },
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "resolve-env-bypass",
    argv: ["resolve"],
    fixture: { policy: { allowDirectCommitsToMaster: false } },
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "1" },
  },
  {
    name: "show-text-defaults",
    argv: ["show"],
    fixture: {},
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "show-field-wipCap",
    argv: ["show", "--field", "plan.policy.wipCap"],
    fixture: { policy: { wipCap: 7 } },
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "allow-direct-commits-refuse",
    argv: ["allow-direct-commits"],
    fixture: {},
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "enforce-branches",
    argv: ["enforce-branches", "--actor", "parity-test"],
    fixture: { policy: { allowDirectCommitsToMaster: true } },
    env: { DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
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
      const env = testCase.env ?? {};
      const python = runPythonPolicy(deftRoot, pyRepo, testCase.argv, env);
      const ts = runTsPolicy(deftRoot, tsRepo, testCase.argv, env);
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
    return `policy parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["policy parity: DIVERGENCE"];
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
    process.stderr.write(`policy parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
