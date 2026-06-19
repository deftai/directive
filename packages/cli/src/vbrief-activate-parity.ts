#!/usr/bin/env node
/**
 * Golden-output parity harness (#1782 s5): runs BOTH the Python oracle
 * (`scripts/vbrief_activate.py`) and the ported TS vbrief-activate CLI over
 * temp fixture vBRIEF trees, then diffs exit codes and byte-identical
 * stdout/stderr (cache-off). Mutating scenarios also compare destination
 * JSON with the volatile ``vBRIEFInfo.updated`` field stripped.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  readonly folder: string;
  readonly status: string;
  readonly mutates?: boolean;
  readonly rawOverride?: string;
  readonly payloadOverride?: Record<string, unknown>;
  readonly preSeedActive?: boolean;
  readonly missingPath?: boolean;
}

export interface ParityDiff {
  readonly caseName: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly stderrMismatch: boolean;
  readonly sideEffectMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly pythonStdout: string;
  readonly pythonStderr: string;
  readonly tsStdout: string;
  readonly tsStderr: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

const FIXTURE_NAME = "2026-05-01-test.vbrief.json";

export const PARITY_CASES: readonly ParityCase[] = [
  { name: "pending-to-active", folder: "pending", status: "pending", mutates: true },
  { name: "approved-to-active", folder: "pending", status: "approved", mutates: true },
  { name: "already-active-noop", folder: "active", status: "running" },
  { name: "proposed-reject", folder: "proposed", status: "proposed" },
  { name: "completed-reject", folder: "completed", status: "completed" },
  { name: "active-blocked-reject", folder: "active", status: "blocked" },
  { name: "pending-draft-reject", folder: "pending", status: "draft" },
  { name: "nonexistent-reject", folder: "pending", status: "pending", missingPath: true },
  { name: "malformed-json", folder: "pending", status: "pending", rawOverride: "{ not json" },
  {
    name: "missing-plan",
    folder: "pending",
    status: "pending",
    payloadOverride: { vBRIEFInfo: { version: "0.6" } },
  },
  {
    name: "missing-plan-status",
    folder: "pending",
    status: "pending",
    payloadOverride: { vBRIEFInfo: { version: "0.6" }, plan: { title: "T" } },
  },
  {
    name: "destination-collision",
    folder: "pending",
    status: "pending",
    preSeedActive: true,
  },
];

function runCapture(cmd: string, args: string[], cwd: string): CommandCapture {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.status === "number" ? e.status : 2,
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

function writeFixture(repo: string, testCase: ParityCase): string {
  const full = join(repo, "vbrief", testCase.folder, FIXTURE_NAME);
  mkdirSync(dirname(full), { recursive: true });
  if (testCase.rawOverride !== undefined) {
    writeFileSync(full, testCase.rawOverride, "utf8");
    return full;
  }
  if (testCase.payloadOverride !== undefined) {
    writeFileSync(full, JSON.stringify(testCase.payloadOverride), "utf8");
    return full;
  }
  writeFileSync(
    full,
    JSON.stringify({
      vBRIEFInfo: { version: "0.6", updated: "2026-04-30T00:00:00Z" },
      plan: { title: "T", status: testCase.status, items: [] },
    }),
    "utf8",
  );
  return full;
}

function setupRepo(testCase: ParityCase): { repo: string; vbriefPath: string } {
  const repo = mkdtempSync(join(tmpdir(), "deft-vbrief-activate-parity-"));
  mkdirSync(join(repo, "vbrief"), { recursive: true });
  if (testCase.missingPath === true) {
    return { repo, vbriefPath: join(repo, "vbrief", "pending", "missing.vbrief.json") };
  }
  const vbriefPath = writeFixture(repo, testCase);
  if (testCase.preSeedActive === true) {
    const activePath = join(repo, "vbrief", "active", FIXTURE_NAME);
    mkdirSync(dirname(activePath), { recursive: true });
    writeFileSync(activePath, "{}", "utf8");
  }
  return { repo, vbriefPath };
}

function stripUpdatedField(repo: string): string | null {
  const dest = join(repo, "vbrief", "active", FIXTURE_NAME);
  if (!existsSync(dest)) {
    return null;
  }
  const payload = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
  const info = payload.vBRIEFInfo;
  if (info !== null && typeof info === "object" && !Array.isArray(info)) {
    delete (info as Record<string, unknown>).updated;
  }
  return JSON.stringify(payload);
}

function runPython(deftRoot: string, vbriefPath: string): CommandCapture {
  return runCapture(
    "uv",
    ["run", "python", join(deftRoot, "scripts", "vbrief_activate.py"), vbriefPath],
    deftRoot,
  );
}

function runTs(deftRoot: string, vbriefPath: string): CommandCapture {
  return runCapture(
    "node",
    [join(deftRoot, "packages", "cli", "dist", "vbrief-activate.js"), vbriefPath],
    deftRoot,
  );
}

export function diffCase(
  python: CommandCapture,
  ts: CommandCapture,
  caseName: string,
  sideEffectMismatch: boolean,
): ParityDiff {
  return {
    caseName,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: python.stdout !== ts.stdout,
    stderrMismatch: python.stderr !== ts.stderr,
    sideEffectMismatch,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
    pythonStdout: python.stdout,
    pythonStderr: python.stderr,
    tsStdout: ts.stdout,
    tsStderr: ts.stderr,
  };
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];

  for (const testCase of PARITY_CASES) {
    const pySetup = setupRepo(testCase);
    const tsSetup = testCase.mutates === true ? setupRepo(testCase) : pySetup;
    try {
      const py = runPython(deftRoot, pySetup.vbriefPath);
      const ts = runTs(deftRoot, tsSetup.vbriefPath);

      let sideEffectMismatch = false;
      if (testCase.mutates === true && py.exitCode === 0 && ts.exitCode === 0) {
        const pyBody = stripUpdatedField(pySetup.repo);
        const tsBody = stripUpdatedField(tsSetup.repo);
        sideEffectMismatch = pyBody !== tsBody;
        if (pyBody !== null && tsBody !== null) {
          const pyPendingGone = !existsSync(pySetup.vbriefPath);
          const tsPendingGone = !existsSync(tsSetup.vbriefPath);
          sideEffectMismatch =
            sideEffectMismatch ||
            pyPendingGone !== tsPendingGone ||
            !pyPendingGone ||
            !tsPendingGone;
        }
      }

      diffs.push(diffCase(py, ts, testCase.name, sideEffectMismatch));
    } finally {
      rmSync(pySetup.repo, { recursive: true, force: true });
      if (tsSetup.repo !== pySetup.repo) {
        rmSync(tsSetup.repo, { recursive: true, force: true });
      }
    }
  }

  const ok = diffs.every(
    (d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch && !d.sideEffectMismatch,
  );
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `vbrief-activate parity: CLEAN -- Python and TS agree on ${result.diffs.length} scenario(s).`;
  }
  const lines = ["vbrief-activate parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch || d.sideEffectMismatch) {
      lines.push(`  scenario: ${d.caseName}`);
      if (d.exitMismatch) {
        lines.push(`    exit mismatch: python=${d.pythonExit} ts=${d.tsExit}`);
      }
      if (d.stdoutMismatch) {
        lines.push(`    python stdout: ${JSON.stringify(d.pythonStdout)}`);
        lines.push(`    ts stdout:     ${JSON.stringify(d.tsStdout)}`);
      }
      if (d.stderrMismatch) {
        lines.push(`    python stderr: ${JSON.stringify(d.pythonStderr)}`);
        lines.push(`    ts stderr:     ${JSON.stringify(d.tsStderr)}`);
      }
      if (d.sideEffectMismatch) {
        lines.push("    side-effect mismatch (active/ payload or source removal)");
      }
    }
  }
  return lines.join("\n");
}

export function runParityCli(): number {
  try {
    const result = runParity();
    if (result.ok) {
      process.stdout.write(`${renderReport(result)}\n`);
      return 0;
    }
    process.stderr.write(`${renderReport(result)}\n`);
    return 1;
  } catch (err) {
    const msg = String(err).replace(/\r?\n/g, " ");
    process.stderr.write(`vbrief-activate parity: harness error -- ${msg}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runParityCli());
}
