/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface JsonGateOutput {
  readonly exitCode: number;
  readonly ready: boolean;
  readonly vbriefPath: string;
  readonly message: string;
  readonly rawJson: string;
}

export interface ParityCaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly exitMismatch: boolean;
  readonly messageMismatch: boolean;
  readonly readyMismatch: boolean;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly cases: ParityCaseResult[];
}

/** Fixture corpus: [label, folder, file content]. */
export const PARITY_FIXTURES: ReadonlyArray<readonly [string, string, string]> = [
  ["active_running", "active", JSON.stringify({ plan: { status: "running" } })],
  ["pending", "pending", JSON.stringify({ plan: { status: "running" } })],
  ["proposed", "proposed", JSON.stringify({ plan: { status: "running" } })],
  ["malformed_json", "active", "{bad json"],
  ["wrong_status", "active", JSON.stringify({ plan: { status: "pending" } })],
  ["missing_plan_status", "active", JSON.stringify({ plan: {} })],
];

/** Parse the structured `--json` stdout payload. */
export function parseJsonOutput(stdout: string, exitCode: number): JsonGateOutput {
  const trimmed = stdout.trim();
  let payload: {
    ready: boolean;
    exit_code: number;
    vbrief_path: string;
    message: string;
  };
  try {
    payload = JSON.parse(trimmed) as typeof payload;
  } catch {
    throw new Error(`Expected JSON output but got: ${trimmed.length > 0 ? trimmed : "(empty)"}`);
  }
  return {
    exitCode,
    ready: payload.ready,
    vbriefPath: payload.vbrief_path,
    message: payload.message,
    rawJson: trimmed,
  };
}

/** Diff two gate JSON outputs for one fixture case. */
export function diffOutputs(
  name: string,
  python: JsonGateOutput,
  ts: JsonGateOutput,
): ParityCaseResult {
  const exitMismatch = python.exitCode !== ts.exitCode;
  const readyMismatch = python.ready !== ts.ready;
  const messageMismatch = python.message !== ts.message;
  return {
    name,
    ok: !exitMismatch && !readyMismatch && !messageMismatch,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
    exitMismatch,
    readyMismatch,
    messageMismatch,
  };
}

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

/** Build temp fixture files; returns map of label -> absolute path. */
export function buildFixtures(root: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const [label, folder, content] of PARITY_FIXTURES) {
    const dir = join(root, folder);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${label}.vbrief.json`);
    writeFileSync(file, content, { encoding: "utf8" });
    paths.set(label, file);
  }
  return paths;
}

/** Run both gates against all fixtures and diff them. */

/** Render a human-readable parity report (exported for unit tests). */
export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `vbrief_preflight parity: CLEAN -- Python and TS agree on ${result.cases.length} fixture(s).`;
  }
  const lines = ["vbrief_preflight parity: DIVERGENCE"];
  for (const c of result.cases.filter((x) => !x.ok)) {
    lines.push(`  case ${c.name}:`);
    if (c.exitMismatch) {
      lines.push(`    exit mismatch: python=${c.pythonExit} ts=${c.tsExit}`);
    }
    if (c.readyMismatch) {
      lines.push("    ready mismatch");
    }
    if (c.messageMismatch) {
      lines.push("    message mismatch");
    }
  }
  return lines.join("\n");
}
