/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    .replace(/\/tmp\/[^\s"']+/g, "<TMP>")
    .replace(/(?:\/private)?\/var\/folders\/[^\s"']+/g, "<TMP>")
    .replace(/^WARN [^\n]*\n/gm, "")
    .replace(/Using CPython[^\n]*\n/g, "")
    .replace(/Creating virtual environment[^\n]*\n/g, "")
    .replace(/Installed \d+ packages[^\n]*\n/g, "");
}

// biome-ignore lint/correctness/noUnusedVariables: pre-existing fixture type, needed for test structure
interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export { resolveDeftRoot };

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
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { policy } }, null, 2)}\n`,
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
  mkdirSync(join(root, "xbrief"), { recursive: true });
  setup?.(root);
  return root;
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
