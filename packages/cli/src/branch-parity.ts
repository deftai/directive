#!/usr/bin/env node
/**
 * Golden-output parity harness (#1719): builds throwaway git fixture repos for
 * branch-protection scenarios, runs BOTH the Python oracle
 * (`scripts/preflight_branch.py`) and the ported TS gate, and diffs exit
 * codes + normalised messages. Exit 0 only on identical results.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
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
  readonly branch: "default" | "feature" | "detached";
  readonly defaultBranchName?: string;
  readonly plan?: Record<string, unknown> | null;
  readonly allowMissingProjectDefinition?: boolean;
  readonly env?: Record<string, string | undefined>;
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

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "deft-parity",
      GIT_AUTHOR_EMAIL: "parity@test.local",
      GIT_COMMITTER_NAME: "deft-parity",
      GIT_COMMITTER_EMAIL: "parity@test.local",
    },
  });
}

function writeProjectDef(root: string, plan: Record<string, unknown>): void {
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

/** Scenarios exercised by the parity harness (mirrors Python contract cases). */
export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: "setup-exemption",
    branch: "default",
    plan: null,
    env: { DEFT_SETUP_INTERVIEW: "1", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "feature-branch",
    branch: "feature",
    plan: { policy: { allowDirectCommitsToMaster: false } },
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "detached-head",
    branch: "detached",
    plan: { policy: { allowDirectCommitsToMaster: false } },
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "master-blocked",
    branch: "default",
    defaultBranchName: "master",
    plan: { policy: { allowDirectCommitsToMaster: false } },
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "master-opt-out-typed",
    branch: "default",
    defaultBranchName: "master",
    plan: { policy: { allowDirectCommitsToMaster: true } },
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "env-bypass",
    branch: "default",
    defaultBranchName: "master",
    plan: { policy: { allowDirectCommitsToMaster: false } },
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "1" },
  },
  {
    name: "missing-pd-config-error",
    branch: "default",
    defaultBranchName: "master",
    plan: undefined,
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "missing-pd-bootstrap",
    branch: "default",
    defaultBranchName: "master",
    plan: undefined,
    allowMissingProjectDefinition: true,
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
  },
  {
    name: "malformed-typed-field",
    branch: "default",
    defaultBranchName: "master",
    plan: { policy: { allowDirectCommitsToMaster: "yes" } },
    env: { DEFT_SETUP_INTERVIEW: "", DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "" },
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

/** Normalise gate message for comparison (trim, collapse whitespace). */
export function normaliseMessage(stdout: string, stderr: string, exitCode: number): string {
  const raw = exitCode === 0 ? stdout : stderr;
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/PROJECT-DEFINITION not found at [^\s)]+/g, "PROJECT-DEFINITION not found at <ROOT>");
}

/** Build a fixture git repo for one scenario. */
export function buildScenarioRepo(scenario: ParityScenario): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-branch-parity-"));
  const defaultBranch = scenario.defaultBranchName ?? "master";
  try {
    writeFileSync(join(root, "README.md"), "# parity\n", "utf8");

    if (scenario.plan !== null && scenario.plan !== undefined) {
      writeProjectDef(root, scenario.plan);
    }

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["branch", "-M", defaultBranch], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    gitCommit(root, "init");

    if (scenario.branch === "feature") {
      execFileSync("git", ["checkout", "-q", "-b", "feat/parity"], { cwd: root });
    } else if (scenario.branch === "detached") {
      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: root });
    }
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }

  return { root };
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
): { python: ScenarioResult; ts: ScenarioResult; root: string } {
  const { root } = buildScenarioRepo(scenario);
  const env = scenario.env ?? {};
  const sharedArgs = ["--project-root", root];
  if (scenario.allowMissingProjectDefinition) {
    sharedArgs.push("--allow-missing-project-definition");
  }

  const pyArgs = ["run", "python", join(deftRoot, "scripts", "preflight_branch.py"), ...sharedArgs];
  const tsArgs = [join(deftRoot, "packages", "cli", "dist", "verify-branch.js"), ...sharedArgs];

  const py = runCapture("uv", pyArgs, deftRoot, env);
  const ts = runCapture("node", tsArgs, deftRoot, env);

  return {
    root,
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

/** Diff python vs TS gate outputs for one scenario. */
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
    let root: string | undefined;
    try {
      const ran = runScenario(deftRoot, scenario);
      root = ran.root;
      const diff = diffParity(ran.python, ran.ts);
      scenarios.push({
        name: scenario.name,
        pythonExit: ran.python.exitCode,
        tsExit: ran.ts.exitCode,
        ...diff,
      });
    } finally {
      if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  const ok = scenarios.every((s) => !s.exitMismatch && !s.messageMismatch);
  return { ok, scenarios };
}

/** Render a human-readable parity report (exported for unit tests). */
export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `verify_branch parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["verify_branch parity: DIVERGENCE"];
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
    process.stderr.write(`verify_branch parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
