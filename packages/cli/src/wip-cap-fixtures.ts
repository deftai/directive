/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// biome-ignore lint/correctness/noUnusedVariables: pre-existing fixture type, needed for test structure
interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
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

function writeXbrief(root: string, folder: "pending" | "active", name: string): void {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { status: "approved", title: "T", items: [] } })}\n`,
    { encoding: "utf8" },
  );
}

/** Build a throwaway project root with optional PROJECT-DEFINITION and WIP files. */
export function buildFixtureRepo(options: WipFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-wip-cap-parity-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  if (options.plan !== undefined) {
    writeProjectDefinition(root, options.plan);
  }
  for (let i = 0; i < (options.pendingFiles ?? 0); i += 1) {
    writeXbrief(root, "pending", `pending-${i}.xbrief.json`);
  }
  for (let i = 0; i < (options.activeFiles ?? 0); i += 1) {
    writeXbrief(root, "active", `active-${i}.xbrief.json`);
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
