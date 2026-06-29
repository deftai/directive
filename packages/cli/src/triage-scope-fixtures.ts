/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScopeFixtureOptions {
  readonly policy?: Record<string, unknown>;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: string[];
  readonly fixture?: ScopeFixtureOptions;
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
    .replace(/--project-root [^\s]+/g, "--project-root <ROOT>")
    .replace(/--cache-root [^\s]+/g, "--cache-root <ROOT>")
    .replace(/path=[^\s\n]+coverage\.json/g, "path=<ROOT>/coverage.json");
}

function writeProjectDefinition(root: string, policy: Record<string, unknown> = {}): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
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
    "utf8",
  );
}

export function buildFixtureRepo(options: ScopeFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-scope-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeProjectDefinition(root, options.policy ?? {});
  return root;
}

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
    name: "list-default",
    argv: ["--list"],
  },
  {
    name: "list-custom-scope-ignores",
    argv: ["--list"],
    fixture: {
      policy: {
        triageScope: [{ rule: "labels", "any-of": ["bug"] }],
        triageScopeIgnores: [
          { label: "wontfix" },
          { rule: "author", "any-of": ["dependabot[bot]"] },
        ],
      },
    },
  },
  {
    name: "add-label",
    argv: ["--add-label=priority:p0"],
  },
  {
    name: "add-milestone",
    argv: ["--add-milestone=v2.0-blocker"],
  },
  {
    name: "ignore-label",
    argv: ["--ignore-label=wontfix"],
  },
  {
    name: "mutations-mutually-exclusive",
    argv: ["--add-label=bug", "--ignore-label=wontfix"],
  },
  {
    name: "diff-from-upstream-missing-repo",
    argv: ["--diff-from-upstream"],
    fixture: { policy: {} },
  },
  {
    name: "refresh-denominator-missing-repo",
    argv: ["--refresh-denominator", "--count", "10"],
  },
  {
    name: "invalid-project-root",
    argv: ["--list"],
    fixture: undefined,
  },
  {
    name: "schema-error",
    argv: ["--list"],
    fixture: {
      policy: {
        triageScope: [{ rule: "bogus-type" }],
      },
    },
  },
  {
    name: "refresh-denominator-success",
    argv: [
      "--refresh-denominator",
      "--repo",
      "deftai/directive",
      "--count",
      "247",
      "--source",
      "github-issue",
    ],
    fixture: {
      policy: { triageScope: [{ rule: "all-open" }] },
    },
  },
];

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `triage:scope parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage:scope parity: DIVERGENCE"];
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
