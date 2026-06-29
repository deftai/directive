/** Test fixtures extracted from legacy parity harness (#2083). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
