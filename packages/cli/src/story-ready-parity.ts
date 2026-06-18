#!/usr/bin/env node
/**
 * Golden-output parity harness (#1720): builds throwaway git fixture repos for
 * story-start Gate 0 scenarios, runs BOTH the Python oracle
 * (`scripts/preflight_story_start.py`) and the ported TS gate, and diffs exit
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
  readonly vbriefRel: string;
  readonly vbriefStatus?: string;
  readonly envelopeRel: string | null;
  readonly allowDirty?: boolean;
  readonly dirty?: boolean;
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

function writeVbrief(
  root: string,
  rel: string,
  status: string = "running",
  folder = "active",
): void {
  const full = join(root, "vbrief", folder, rel);
  mkdirSync(dirname(full), { recursive: true });
  const payload = {
    plan: { status, title: "T", items: [] },
    vBRIEFInfo: { version: "0.6" },
  };
  writeFileSync(full, `${JSON.stringify(payload)}\n`, "utf8");
}

function renderAllocation(fields: Record<string, string | null>): string {
  const lines = ["Dispatch envelope.", "", "## Allocation context", ""];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`- ${key}: ${value === null ? "null" : value}`);
  }
  lines.push("", "## Next section", "- trailing: ignored");
  return lines.join("\n");
}

const VALID_COHORT: Record<string, string | null> = {
  allocation_plan_id: "orchestrator-run-019e80bd",
  batching_rationale: "Three disjoint-file-scope stories from #1378.",
  cohort_vbriefs: "[vbrief/active/a.json, vbrief/active/b.json]",
  dispatch_kind: "swarm-cohort",
  operator_approval_evidence: "user directive 2026-06-01T02:26Z",
};

/** Scenarios exercised by the parity harness (mirrors Python contract cases). */
export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: "clean-active-running-solo",
    vbriefRel: "2026-06-01-story.vbrief.json",
    envelopeRel: null,
  },
  {
    name: "dirty-tree",
    vbriefRel: "2026-06-01-story.vbrief.json",
    envelopeRel: null,
    dirty: true,
  },
  {
    name: "non-running-vbrief",
    vbriefRel: "2026-06-01-pending.vbrief.json",
    vbriefStatus: "approved",
    envelopeRel: null,
  },
  {
    name: "satisfied-swarm-cohort",
    vbriefRel: "2026-06-01-story.vbrief.json",
    envelopeRel: "envelope-cohort.md",
  },
  {
    name: "malformed-allocation",
    vbriefRel: "2026-06-01-story.vbrief.json",
    envelopeRel: "envelope-bad.md",
  },
];

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
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

function runCapture(cmd: string, args: string[], cwd: string): Capture {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
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
  return raw.trim().replace(/\s+/g, " ");
}

/** Build a fixture repo for one scenario; return repo root + vbrief absolute path. */
export function buildScenarioRepo(scenario: ParityScenario): {
  root: string;
  vbriefPath: string;
  envelopePath: string | null;
} {
  const root = mkdtempSync(join(tmpdir(), "deft-story-ready-parity-"));
  const vbriefName = scenario.vbriefRel;
  const status = scenario.vbriefStatus ?? "running";
  writeVbrief(root, vbriefName, status);

  if (scenario.dirty) {
    writeFileSync(join(root, "scratch.txt"), "dirty\n", "utf8");
  }

  let envelopePath: string | null = null;
  if (scenario.envelopeRel === "envelope-cohort.md") {
    envelopePath = join(root, scenario.envelopeRel);
    writeFileSync(envelopePath, renderAllocation(VALID_COHORT), "utf8");
  } else if (scenario.envelopeRel === "envelope-bad.md") {
    envelopePath = join(root, scenario.envelopeRel);
    const bad = { ...VALID_COHORT };
    delete bad.dispatch_kind;
    writeFileSync(envelopePath, renderAllocation(bad), "utf8");
  }

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  if (!scenario.dirty) {
    gitCommit(root, "init");
  }

  const vbriefPath = join(root, "vbrief", "active", vbriefName);
  return { root, vbriefPath, envelopePath };
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
  const { root, vbriefPath, envelopePath } = buildScenarioRepo(scenario);
  const pyArgs = [
    "run",
    "python",
    join(deftRoot, "scripts", "preflight_story_start.py"),
    "--vbrief-path",
    vbriefPath,
    "--project-root",
    root,
  ];
  if (envelopePath !== null) {
    pyArgs.push("--allocation-context", envelopePath);
  }
  if (scenario.allowDirty) {
    pyArgs.push("--allow-dirty");
  }

  const tsArgs = [
    join(deftRoot, "packages", "cli", "dist", "verify-story-ready.js"),
    "--vbrief-path",
    vbriefPath,
    "--project-root",
    root,
  ];
  if (envelopePath !== null) {
    tsArgs.push("--allocation-context", envelopePath);
  }
  if (scenario.allowDirty) {
    tsArgs.push("--allow-dirty");
  }

  const py = runCapture("uv", pyArgs, deftRoot);
  const ts = runCapture("node", tsArgs, deftRoot);

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

/** Diff python vs TS gate outputs across all parity scenarios. */
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
    const { root, python, ts } = runScenario(deftRoot, scenario);
    try {
      const diff = diffParity(python, ts);
      scenarios.push({
        name: scenario.name,
        pythonExit: python.exitCode,
        tsExit: ts.exitCode,
        ...diff,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const ok = scenarios.every((s) => !s.exitMismatch && !s.messageMismatch);
  return { ok, scenarios };
}

/** Render a human-readable parity report (exported for unit tests). */
export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `verify_story_ready parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["verify_story_ready parity: DIVERGENCE"];
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
    process.stderr.write(`verify_story_ready parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
