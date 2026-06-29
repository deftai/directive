/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: string[];
  readonly fixture?: FixtureOptions;
}

export interface FixtureOptions {
  readonly scopeVbriefs?: Array<{ folder: string; slug: string; issue: number }>;
  readonly preRunBootstrap?: boolean;
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
    .replace(/project_root": "[^"]+"/g, 'project_root": "<ROOT>"')
    .replace(/"project_root": "[^"]+"/g, '"project_root": "<ROOT>"')
    .replace(/project_root=[^\s)]+/g, "project_root=<ROOT>")
    .replace(/under \/tmp\/[^\s)]+/g, "under <ROOT>")
    .replace(/under \/var\/[^\s)]+/g, "under <ROOT>");
}

/** Compare stdout, parsing JSON payloads when present. */
export function normalizeStdout(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.project_root === "string") {
        parsed.project_root = "<ROOT>";
      }
      const steps = parsed.steps;
      if (Array.isArray(steps)) {
        for (const step of steps) {
          if (typeof step !== "object" || step === null) continue;
          const record = step as Record<string, unknown>;
          if (typeof record.message === "string") {
            record.message = normalizeOutput(record.message);
          }
          const details = record.details;
          if (typeof details === "object" && details !== null) {
            const detailRecord = details as Record<string, unknown>;
            if (typeof detailRecord.audit_path === "string") {
              detailRecord.audit_path = "<ROOT>/vbrief/.eval/candidates.jsonl";
            }
            if (typeof detailRecord.fetch_timeout_s === "number") {
              detailRecord.fetch_timeout_s = Math.trunc(detailRecord.fetch_timeout_s);
            }
            if (typeof detailRecord.elapsed_s === "number") {
              detailRecord.elapsed_s = Number(detailRecord.elapsed_s.toFixed(3));
            }
          }
        }
      }
      return JSON.stringify(parsed);
    } catch {
      return normalizeOutput(text);
    }
  }
  return normalizeOutput(text);
}

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function writeScopeVbrief(root: string, folder: string, slug: string, issueNumber: number): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.vbrief.json`),
    `${JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        id: slug,
        title: slug,
        status: "proposed",
        references: [
          {
            type: "x-vbrief/github-issue",
            uri: `https://github.com/deftai/directive/issues/${issueNumber}`,
          },
        ],
      },
    })}\n`,
    { encoding: "utf8" },
  );
}

/** Build a throwaway project root with optional vBRIEF fixtures. */
export function buildFixtureRepo(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-bootstrap-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  for (const item of options.scopeVbriefs ?? []) {
    writeScopeVbrief(root, item.folder, item.slug, item.issue);
  }
  return root;
}

/** Diff one parity case between Python oracle and TS CLI. */
export function diffCase(python: CommandCapture, ts: CommandCapture, caseName: string): ParityDiff {
  const pyOut = normalizeStdout(python.stdout);
  const tsOut = normalizeStdout(ts.stdout);
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
    name: "json-no-repo-quiet",
    argv: ["--json", "--quiet"],
  },
  {
    name: "recap-no-repo-quiet",
    argv: ["--quiet"],
  },
  {
    name: "config-error-bad-root",
    argv: ["--json", "--project-root", "/nonexistent-deft-bootstrap-parity-root"],
  },
  {
    name: "json-invalid-repo-quiet",
    argv: ["--json", "--quiet", "--repo", "bad"],
  },
  {
    name: "json-idempotent-rerun",
    argv: ["--json", "--quiet"],
    fixture: { preRunBootstrap: true },
  },
];

/** Run all parity cases; returns aggregate result. */

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `triage:bootstrap parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage:bootstrap parity: DIVERGENCE"];
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
