/** Test fixtures extracted from legacy parity harness (#2083). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
