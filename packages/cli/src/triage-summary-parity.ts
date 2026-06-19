#!/usr/bin/env node
/**
 * Golden-output parity harness (#1725): builds throwaway fixture repos, runs
 * BOTH the Python oracle (`scripts/triage_summary.py`) and the ported TS
 * triage:summary CLI, and diffs stdout (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SummaryFixtureOptions {
  readonly wipCap?: number;
  readonly triageScope?: Record<string, unknown>[] | null;
  readonly cachedIssues?: ReadonlyArray<{ repo: string; number: number }>;
  readonly auditEntries?: Record<string, unknown>[];
  readonly pendingVbriefs?: number;
  readonly activeVbriefs?: ReadonlyArray<{ name: string; status?: string }>;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: string[];
  readonly fixture?: SummaryFixtureOptions;
}

export interface ParityDiff {
  readonly caseName: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly stderrMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly pythonStdout: string;
  readonly tsStdout: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

/** Strip volatile fields before compare. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/"emitted_at": "[^"]+"/g, '"emitted_at": "<TS>"')
    .trimEnd();
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

function writeProjectDefinition(
  root: string,
  options: { wipCap?: number; triageScope?: Record<string, unknown>[] | null },
): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  const policy: Record<string, unknown> = {};
  if (options.wipCap !== undefined) {
    policy.wipCap = options.wipCap;
  }
  if (options.triageScope !== undefined && options.triageScope !== null) {
    policy.triageScope = options.triageScope;
  }
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], policy },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

function makeCachedIssue(cacheRoot: string, repo: string, number: number): void {
  const [owner, name] = repo.split("/", 2);
  const entry = join(cacheRoot, "github-issue", owner ?? "", name ?? "", String(number));
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "meta.json"), "{}\n", { encoding: "utf8" });
  writeFileSync(join(entry, "raw.json"), "{}\n", { encoding: "utf8" });
}

function writeAuditLog(root: string, entries: Record<string, unknown>[]): void {
  const logDir = join(root, "vbrief", ".eval");
  mkdirSync(logDir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e, Object.keys(e).sort())).join("\n");
  writeFileSync(join(logDir, "candidates.jsonl"), lines.length > 0 ? `${lines}\n` : "", {
    encoding: "utf8",
  });
}

function writeActiveVbrief(root: string, name: string, status: string): void {
  const dir = join(root, "vbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.vbrief.json`),
    `${JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { status, title: name },
    })}\n`,
    { encoding: "utf8" },
  );
}

function writePendingVbriefs(root: string, count: number): void {
  const dir = join(root, "vbrief", "pending");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(
      join(dir, `pending-${i}.vbrief.json`),
      `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { status: "approved" } })}\n`,
      { encoding: "utf8" },
    );
  }
}

/** Build a throwaway project root with optional cache / audit / vBRIEF state. */
export function buildFixtureRepo(options: SummaryFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-summary-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });

  if (options.wipCap !== undefined || options.triageScope !== undefined) {
    writeProjectDefinition(root, {
      wipCap: options.wipCap,
      triageScope: options.triageScope,
    });
  }

  const cacheRoot = join(root, ".deft-cache");
  for (const issue of options.cachedIssues ?? []) {
    makeCachedIssue(cacheRoot, issue.repo, issue.number);
  }

  if (options.auditEntries !== undefined && options.auditEntries.length > 0) {
    writeAuditLog(root, options.auditEntries);
  }

  if (options.pendingVbriefs !== undefined && options.pendingVbriefs > 0) {
    writePendingVbriefs(root, options.pendingVbriefs);
  }

  for (const vb of options.activeVbriefs ?? []) {
    writeActiveVbrief(root, vb.name, vb.status ?? "running");
  }

  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonSummary(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  const cap = runCapture(
    "uv",
    [
      "run",
      "python",
      join(deftRoot, "scripts", "triage_summary.py"),
      ...argv,
      "--project-root",
      repo,
      "--no-history",
    ],
    deftRoot,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTsSummary(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  const cap = runCapture(
    "node",
    [
      join(deftRoot, "packages", "cli", "dist", "triage-summary.js"),
      ...argv,
      "--project-root",
      repo,
      "--no-history",
    ],
    deftRoot,
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
    pythonStdout: pyOut,
    tsStdout: tsOut,
  };
}

const auditEntry = (
  repo: string,
  issueNumber: number,
  decision: string,
  decisionId: string,
): Record<string, unknown> => ({
  actor: "agent:test",
  decision,
  decision_id: decisionId,
  issue_number: issueNumber,
  repo,
  timestamp: "2026-05-17T20:00:00Z",
});

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "empty-cache",
    argv: [],
    fixture: {},
  },
  {
    name: "populated-zero-wip",
    argv: [],
    fixture: {
      cachedIssues: [
        { repo: "deftai/directive", number: 100 },
        { repo: "deftai/directive", number: 101 },
        { repo: "deftai/directive", number: 102 },
      ],
      auditEntries: [
        auditEntry("deftai/directive", 100, "accept", "11111111-1111-1111-1111-111111111101"),
        auditEntry("deftai/directive", 101, "accept", "11111111-1111-1111-1111-111111111102"),
      ],
    },
  },
  {
    name: "zero-untriaged-still-prints",
    argv: [],
    fixture: {
      cachedIssues: [{ repo: "deftai/directive", number: 200 }],
      auditEntries: [
        auditEntry("deftai/directive", 200, "accept", "22222222-2222-2222-2222-222222222200"),
      ],
    },
  },
  {
    name: "wip-at-cap-warning",
    argv: [],
    fixture: {
      wipCap: 12,
      cachedIssues: [{ repo: "deftai/directive", number: 500 }],
      pendingVbriefs: 12,
    },
  },
  {
    name: "wip-above-cap-warning",
    argv: [],
    fixture: {
      wipCap: 5,
      cachedIssues: [{ repo: "deftai/directive", number: 501 }],
      activeVbriefs: Array.from({ length: 7 }, (_, i) => ({ name: `active-${i}` })),
    },
  },
  {
    name: "filesystem-in-flight-divergence",
    argv: [],
    fixture: {
      cachedIssues: [
        { repo: "deftai/directive", number: 600 },
        { repo: "deftai/directive", number: 601 },
        { repo: "deftai/directive", number: 602 },
      ],
      auditEntries: [
        auditEntry("deftai/directive", 600, "accept", "66666666-6666-6666-6666-666666666600"),
        auditEntry("deftai/directive", 601, "accept", "66666666-6666-6666-6666-666666666601"),
      ],
      activeVbriefs: [{ name: "only-running", status: "running" }],
    },
  },
  {
    name: "configured-scope-divergence",
    argv: [],
    fixture: {
      triageScope: [{ rule: "labels", "any-of": ["phase-1"] }],
      cachedIssues: [{ repo: "deftai/directive", number: 700 }],
      auditEntries: [
        auditEntry("deftai/directive", 700, "accept", "77777777-7777-7777-7777-777777777700"),
      ],
      activeVbriefs: [
        { name: "one-running", status: "running" },
        { name: "two-running", status: "running" },
      ],
    },
  },
  {
    name: "json-mode",
    argv: ["--json"],
    fixture: {
      cachedIssues: [{ repo: "deftai/directive", number: 900 }],
    },
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
      const python = runPythonSummary(deftRoot, pyRepo, testCase.argv);
      const ts = runTsSummary(deftRoot, tsRepo, testCase.argv);
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
    return `triage:summary parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage:summary parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch) {
      lines.push(`  case: ${d.caseName}`);
      if (d.exitMismatch) lines.push(`    exit: python=${d.pythonExit} ts=${d.tsExit}`);
      if (d.stdoutMismatch) {
        lines.push(`    python stdout: ${d.pythonStdout}`);
        lines.push(`    ts stdout:     ${d.tsStdout}`);
      }
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
    const msg = String(err).replace(/\r?\n/g, " ");
    process.stderr.write(`triage:summary parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
