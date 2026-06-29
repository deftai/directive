/** Test fixtures extracted from legacy parity harness (#2083). */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityCase {
  readonly name: string;
  readonly verb: "help" | "subscribe" | "bulk" | "smoketest";
  readonly argv: readonly string[];
  readonly fixtureRoot?: string;
  readonly env?: Record<string, string>;
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

export function normalizeOutput(text: string): string {
  return text
    .replace(/project_root=[^\s)]+/g, "project_root=<ROOT>")
    .replace(/\/tmp\/deft-[^\s/]+/g, "<TMPROOT>")
    .replace(/change_id": "[^"]+"/g, 'change_id": "<UUID>"')
    .replace(/Using CPython[^\n]*\n/g, "")
    .replace(/Creating virtual environment[^\n]*\n/g, "")
    .replace(/Installed \d+ packages[^\n]*\n/g, "");
}

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function writeProjectDefinition(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
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

function populateCache(
  cacheRoot: string,
  repo: string,
  issues: Array<Record<string, unknown>>,
): void {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined) {
    throw new Error(`invalid repo ${repo}`);
  }
  for (const issue of issues) {
    const n = String(issue.number);
    const entryDir = join(cacheRoot, "github-issue", owner, name, n);
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, "raw.json"), JSON.stringify(issue), { encoding: "utf8" });
    writeFileSync(
      join(entryDir, "meta.json"),
      JSON.stringify({
        source: "github-issue",
        key: `${repo}/${n}`,
        fetched_at: "2026-05-05T00:00:00Z",
        ttl_seconds: 604800,
        expires_at: "2099-01-01T00:00:00Z",
        scan_result: {
          passed: true,
          scanned_at: "2026-05-05T00:00:00Z",
          scanner_version: "2.0.0",
          flags: [],
        },
        size_bytes: 100,
        stale: false,
      }),
      { encoding: "utf8" },
    );
  }
}

export function buildFixtureRepo(kind: "subscribe" | "bulk-empty" | "bulk-filter"): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-aux-b-parity-"));
  if (kind === "subscribe") {
    writeProjectDefinition(root);
    return root;
  }
  if (kind === "bulk-empty") {
    writeProjectDefinition(root);
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    return root;
  }
  writeProjectDefinition(root);
  populateCache(join(root, ".deft-cache"), "deftai/parity", [
    {
      number: 99,
      title: "parity issue",
      labels: [{ name: "other-label" }],
      author: { login: "bot" },
      createdAt: "2020-01-01T00:00:00Z",
    },
  ]);
  return root;
}

const _PY_SCRIPT: Record<ParityCase["verb"], string> = {
  help: "triage_help.py",
  subscribe: "triage_subscribe.py",
  bulk: "triage_bulk.py",
  smoketest: "triage_smoketest.py",
};

const _TS_CLI: Record<ParityCase["verb"], string> = {
  help: "triage-help.js",
  subscribe: "triage-subscribe.js",
  bulk: "triage-bulk.js",
  smoketest: "triage-smoketest.js",
};

export function diffCase(python: CommandCapture, ts: CommandCapture, caseName: string): ParityDiff {
  return {
    caseName,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: normalizeOutput(python.stdout) !== normalizeOutput(ts.stdout),
    stderrMismatch: normalizeOutput(python.stderr) !== normalizeOutput(ts.stderr),
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
}

export const PARITY_CASES: readonly ParityCase[] = [
  { name: "help-triage-list", verb: "help", argv: ["triage"] },
  { name: "help-scope-list", verb: "help", argv: ["scope"] },
  { name: "help-verb-queue", verb: "help", argv: ["help", "task triage:queue"] },
  { name: "help-registry-list", verb: "help", argv: ["list"] },
  { name: "help-bulk-intercept", verb: "bulk", argv: ["accept", "--help"] },
  {
    name: "subscribe-label-create",
    verb: "subscribe",
    argv: ["subscribe", "--label", "area:parity"],
    fixtureRoot: "subscribe",
  },
  {
    name: "subscribe-label-idempotent",
    verb: "subscribe",
    argv: ["subscribe", "--label", "dup-label"],
    fixtureRoot: "subscribe",
    env: { DEFT_TRIAGE_ACTOR: "agent:parity" },
  },
  {
    name: "subscribe-unsubscribe-missing",
    verb: "subscribe",
    argv: ["unsubscribe", "--label", "ghost"],
    fixtureRoot: "subscribe",
  },
  {
    name: "bulk-empty-cache",
    verb: "bulk",
    argv: ["accept", "--repo", "deftai/parity"],
    fixtureRoot: "bulk-empty",
  },
  {
    name: "bulk-zero-match",
    verb: "bulk",
    argv: ["defer", "--repo", "deftai/parity", "--label", "no-such-label"],
    fixtureRoot: "bulk-filter",
  },
  {
    name: "smoketest-missing-fixture",
    verb: "smoketest",
    argv: ["--fixture", "/nonexistent/deft-smoketest-fixture"],
  },
];

function _cpRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      _cpRecursive(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `triage-aux-b parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage-aux-b parity: DIVERGENCE"];
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
