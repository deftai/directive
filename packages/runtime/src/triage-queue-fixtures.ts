/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface QueueFixtureIssue {
  readonly number: number;
  readonly title?: string;
  readonly state?: string;
  readonly labels?: readonly string[];
  readonly updatedAt?: string;
  readonly createdAt?: string;
  /** Cache author.login for --author filter tests (#3129). */
  readonly author?: string;
}

export interface QueueAuditEntry {
  readonly issueNumber: number;
  readonly decision: string;
  readonly timestamp?: string;
}

export interface QueueFixtureOptions {
  readonly repo?: string;
  readonly issues?: readonly QueueFixtureIssue[];
  readonly auditEntries?: readonly QueueAuditEntry[];
  readonly rankingLabels?: readonly string[];
  readonly activeIssueNumbers?: readonly number[];
  readonly sliceRecords?: readonly Record<string, unknown>[];
  readonly blockedIssueNumbers?: readonly number[];
}

export interface ParityCase {
  readonly name: string;
  readonly argv: readonly string[];
  readonly fixture?: QueueFixtureOptions;
  readonly skipFixture?: boolean;
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
  readonly diffs: readonly ParityDiff[];
}

const DEFAULT_REPO = "owner/repo";

/** Strip volatile absolute paths before compare. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/^WARN [^\n]*\n/gm, "")
    .replace(/project_root=[^\s)]+/g, "project_root=<ROOT>");
}

// biome-ignore lint/correctness/noUnusedVariables: pre-existing fixture type, needed for test structure
interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function writeCachedIssue(root: string, repo: string, issue: QueueFixtureIssue): void {
  const parts = repo.split("/", 2);
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined) {
    throw new Error(`invalid repo slug: ${repo}`);
  }
  const dir = join(root, ".deft-cache", "github-issue", owner, name, String(issue.number));
  mkdirSync(dir, { recursive: true });
  const raw = {
    number: issue.number,
    title: issue.title ?? `Issue ${issue.number}`,
    state: issue.state ?? "open",
    labels: (issue.labels ?? []).map((label) => ({ name: label })),
    updated_at: issue.updatedAt ?? "2026-05-17T20:00:00Z",
    ...(issue.createdAt !== undefined ? { created_at: issue.createdAt } : {}),
    ...(issue.author !== undefined ? { author: { login: issue.author } } : {}),
  };
  writeFileSync(join(dir, "raw.json"), `${JSON.stringify(raw)}\n`, { encoding: "utf8" });
}

function writeAuditLog(root: string, repo: string, entries: readonly QueueAuditEntry[]): void {
  const dir = join(root, "xbrief", ".triage-cache");
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((entry) =>
    JSON.stringify({
      decision_id: `id-${entry.issueNumber}-${entry.decision}`,
      timestamp: entry.timestamp ?? "2026-05-17T20:00:00Z",
      repo,
      issue_number: entry.issueNumber,
      decision: entry.decision,
      actor: "parity",
    }),
  );
  writeFileSync(join(dir, "candidates.jsonl"), `${lines.join("\n")}\n`, { encoding: "utf8" });
}

function writeProjectDefinition(root: string, rankingLabels?: readonly string[]): void {
  const dir = join(root, "xbrief");
  mkdirSync(dir, { recursive: true });
  const plan: Record<string, unknown> = { title: "T", status: "running", items: [] };
  if (rankingLabels !== undefined && rankingLabels.length > 0) {
    plan.policy = { triageRankingLabels: [...rankingLabels] };
  }
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
    { encoding: "utf8" },
  );
}

function writeActiveScope(root: string, repo: string, issueNumber: number, filename: string): void {
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Active scope",
        status: "running",
        references: [
          {
            uri: `https://github.com/${repo}/issues/${issueNumber}`,
            type: "x-vbrief/github-issue",
            title: `Issue #${issueNumber}`,
          },
        ],
      },
    })}\n`,
    { encoding: "utf8" },
  );
}

function writeBlockedScope(
  root: string,
  repo: string,
  issueNumber: number,
  filename: string,
): void {
  const dir = join(root, "xbrief", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Blocked scope",
        status: "blocked",
        references: [
          {
            uri: `https://github.com/${repo}/issues/${issueNumber}`,
            type: "x-vbrief/github-issue",
            title: `Issue #${issueNumber}`,
          },
        ],
      },
    })}\n`,
    { encoding: "utf8" },
  );
}

function writeSliceRecords(root: string, records: readonly Record<string, unknown>[]): void {
  const dir = join(root, "xbrief", ".triage-cache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "slices.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8" },
  );
}

/** Build a throwaway project root with optional queue fixtures. */
export function buildFixtureRepo(options: QueueFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-queue-parity-"));
  const repo = options.repo ?? DEFAULT_REPO;
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeProjectDefinition(root, options.rankingLabels);
  for (const issue of options.issues ?? []) {
    writeCachedIssue(root, repo, issue);
  }
  if (options.auditEntries !== undefined && options.auditEntries.length > 0) {
    writeAuditLog(root, repo, options.auditEntries);
  }
  for (const issueNumber of options.activeIssueNumbers ?? []) {
    writeActiveScope(root, repo, issueNumber, `active-${issueNumber}.xbrief.json`);
  }
  for (const issueNumber of options.blockedIssueNumbers ?? []) {
    writeBlockedScope(root, repo, issueNumber, `blocked-${issueNumber}.xbrief.json`);
  }
  if (options.sliceRecords !== undefined && options.sliceRecords.length > 0) {
    writeSliceRecords(root, options.sliceRecords);
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
    name: "missing-repo",
    argv: ["--project-root", "<ROOT>"],
    skipFixture: true,
  },
  {
    name: "empty-cache",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "0"],
    fixture: {},
  },
  {
    name: "group-order",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "0"],
    fixture: {
      issues: [
        { number: 1, title: "Untriaged", updatedAt: "2026-05-17T12:00:00Z" },
        { number: 2, title: "Resume", updatedAt: "2026-05-17T11:00:00Z" },
        { number: 3, title: "Urgent", updatedAt: "2026-05-15T10:00:00Z" },
        { number: 4, title: "Other", updatedAt: "2026-05-14T10:00:00Z" },
      ],
      auditEntries: [
        { issueNumber: 3, decision: "needs-ac", timestamp: "2026-05-15T11:00:00Z" },
        { issueNumber: 4, decision: "defer", timestamp: "2026-05-14T11:00:00Z" },
      ],
      activeIssueNumbers: [2],
    },
  },
  {
    name: "orphan-above-resume",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "0"],
    fixture: {
      issues: [
        { number: 10, title: "Umbrella closed", state: "closed" },
        { number: 11, title: "Orphan child", state: "open", updatedAt: "2026-05-16T10:00:00Z" },
        { number: 12, title: "Resume child", state: "open", updatedAt: "2026-05-17T10:00:00Z" },
      ],
      activeIssueNumbers: [12],
      sliceRecords: [
        {
          slice_id: "slice-1",
          umbrella: 10,
          umbrella_url: "https://github.com/owner/repo/issues/10",
          children: [
            { n: 11, url: "https://github.com/owner/repo/issues/11", wave: 1, role: "child" },
          ],
        },
      ],
    },
  },
  {
    name: "resume-eligible",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "0"],
    fixture: {
      issues: [
        { number: 20, title: "Resume eligible", updatedAt: "2026-05-17T10:00:00Z" },
        { number: 21, title: "Untriaged", updatedAt: "2026-05-17T11:00:00Z" },
      ],
      auditEntries: [
        { issueNumber: 20, decision: "resume-eligible", timestamp: "2026-05-17T09:00:00Z" },
      ],
    },
  },
  {
    name: "ranking-labels",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "0"],
    fixture: {
      rankingLabels: ["urgent", "breaking-change"],
      issues: [
        { number: 30, title: "Unranked", updatedAt: "2026-05-17T10:00:00Z" },
        {
          number: 31,
          title: "Breaking",
          labels: ["breaking-change"],
          updatedAt: "2026-05-15T10:00:00Z",
        },
        { number: 32, title: "Urgent", labels: ["urgent"], updatedAt: "2026-05-16T10:00:00Z" },
      ],
    },
  },
  {
    name: "limit-cap",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "2"],
    fixture: {
      issues: [
        { number: 40, updatedAt: "2026-05-17T10:00:00Z" },
        { number: 41, updatedAt: "2026-05-16T10:00:00Z" },
        { number: 42, updatedAt: "2026-05-15T10:00:00Z" },
      ],
    },
  },
  {
    name: "blocked-demoted",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "0"],
    fixture: {
      issues: [
        { number: 50, title: "Blocked", updatedAt: "2026-05-17T10:00:00Z" },
        { number: 51, title: "Open", updatedAt: "2026-05-16T10:00:00Z" },
      ],
      blockedIssueNumbers: [50],
    },
  },
  {
    name: "include-blocked",
    argv: ["--project-root", "<ROOT>", "--repo", DEFAULT_REPO, "--limit", "0", "--include-blocked"],
    fixture: {
      issues: [
        { number: 60, title: "Blocked", updatedAt: "2026-05-17T10:00:00Z" },
        { number: 61, title: "Open", updatedAt: "2026-05-16T10:00:00Z" },
      ],
      blockedIssueNumbers: [60],
    },
  },
];

/** Augment argv with fixture audit/slices hooks when present. */
export function augmentParityArgv(testCase: ParityCase, root: string): readonly string[] {
  const argv = testCase.argv.map((arg) => (arg === "<ROOT>" ? root : arg));
  if (testCase.skipFixture || testCase.fixture === undefined) {
    return argv;
  }
  const extras: string[] = [];
  if (testCase.fixture.auditEntries !== undefined && testCase.fixture.auditEntries.length > 0) {
    extras.push("--audit-log", join(root, "xbrief", ".triage-cache", "candidates.jsonl"));
  }
  if (testCase.fixture.sliceRecords !== undefined && testCase.fixture.sliceRecords.length > 0) {
    extras.push("--slices-log", join(root, "xbrief", ".triage-cache", "slices.jsonl"));
  }
  return [...argv, ...extras];
}

/** Run all parity cases; returns aggregate result. */

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `triage:queue parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage:queue parity: DIVERGENCE"];
  for (const diff of result.diffs) {
    if (diff.exitMismatch || diff.stdoutMismatch || diff.stderrMismatch) {
      lines.push(`  case: ${diff.caseName}`);
      if (diff.exitMismatch) {
        lines.push(`    exit: python=${diff.pythonExit} ts=${diff.tsExit}`);
      }
      if (diff.stdoutMismatch) {
        lines.push("    stdout mismatch");
      }
      if (diff.stderrMismatch) {
        lines.push("    stderr mismatch");
      }
    }
  }
  return lines.join("\n");
}
