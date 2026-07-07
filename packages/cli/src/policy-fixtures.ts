/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// biome-ignore lint/correctness/noUnusedVariables: pre-existing fixture type, needed for test structure
interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function writeFixture(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
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
  mkdirSync(join(root, "xbrief"), { recursive: true });
  if (plan !== undefined) {
    writeFixture(root, plan);
  }
  return root;
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
