#!/usr/bin/env node
/**
 * Golden-output parity harness (#1721): writes temp fixture vBRIEFs, runs BOTH
 * the Python oracle (`scripts/preflight_implementation.py`) and the ported TS
 * gate with session-ritual bypassed, and diffs structured JSON + exit codes.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function runCapture(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Capture {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
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

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Run both gates against all fixtures and diff them. */
export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const root = mkdtempSync(join(tmpdir(), "deft-vbrief-preflight-parity-"));
  try {
    const fixtures = buildFixtures(root);
    const cases: ParityCaseResult[] = [];
    for (const [label] of PARITY_FIXTURES) {
      const fixturePath = fixtures.get(label);
      if (fixturePath === undefined) {
        throw new Error(`missing fixture path for ${label}`);
      }
      const py = runCapture(
        "uv",
        [
          "run",
          "python",
          join(deftRoot, "scripts", "preflight_implementation.py"),
          "--vbrief-path",
          fixturePath,
          "--json",
        ],
        deftRoot,
        { DEFT_SESSION_RITUAL_SKIP: "1" },
      );
      const ts = runCapture(
        "node",
        [
          join(deftRoot, "packages", "cli", "dist", "vbrief-preflight.js"),
          "--vbrief-path",
          fixturePath,
          "--json",
        ],
        deftRoot,
      );
      cases.push(
        diffOutputs(
          label,
          parseJsonOutput(py.stdout, py.status),
          parseJsonOutput(ts.stdout, ts.status),
        ),
      );
    }
    return { ok: cases.every((c) => c.ok), cases };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
    process.stderr.write(`vbrief_preflight parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
