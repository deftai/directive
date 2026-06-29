/** Test fixtures extracted from legacy parity harness (#2083). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FixtureOptions {
  readonly plan?: Record<string, unknown>;
  readonly omitProjectDefinition?: boolean;
  readonly rawProjectDefinition?: Record<string, unknown>;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: readonly string[];
  readonly fixture?: FixtureOptions;
  readonly useRepoRoot?: boolean;
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
  return (
    text
      .replace(/project_root=[^\s)]+/g, "project_root=<ROOT>")
      // Match the parity temp root regardless of platform tmpdir prefix
      // (/tmp on Linux, /var/folders/... on macOS, etc.).
      .replace(/\S*deft-triage-classify-parity-[^\s/]+/g, "<TMPROOT>")
  );
}

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], ...plan },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

/** Build a throwaway project root with optional PROJECT-DEFINITION. */
export function buildFixtureRepo(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-triage-classify-parity-"));
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (options.rawProjectDefinition !== undefined) {
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      `${JSON.stringify(options.rawProjectDefinition, null, 2)}\n`,
      { encoding: "utf8" },
    );
  } else if (!options.omitProjectDefinition && options.plan !== undefined) {
    writeProjectDefinition(root, options.plan);
  } else if (!options.omitProjectDefinition) {
    writeProjectDefinition(root, {});
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
    name: "list-default-repo-root",
    argv: ["--list"],
    useRepoRoot: true,
  },
  {
    name: "list-no-project-definition",
    argv: ["--list"],
    fixture: { omitProjectDefinition: true },
  },
  {
    name: "validate-no-project-definition",
    argv: ["--validate"],
    fixture: { omitProjectDefinition: true },
  },
  {
    name: "validate-valid-consumer-rules",
    argv: ["--validate"],
    fixture: {
      plan: {
        policy: {
          triageAutoClassify: [
            {
              match: { labels: { "any-of": ["bug"] } },
              action: "escalate",
              reason: "p0 bug",
            },
          ],
          triageHoldMarkers: ["BLOCKED", "WONTFIX"],
        },
      },
    },
  },
  {
    name: "validate-invalid-empty-match",
    argv: ["--validate"],
    fixture: {
      plan: {
        policy: {
          triageAutoClassify: [{ match: {}, action: "defer", reason: "??" }],
        },
      },
    },
  },
  {
    name: "validate-invalid-hold-markers",
    argv: ["--validate"],
    fixture: {
      plan: {
        policy: {
          triageHoldMarkers: "",
        },
      },
    },
  },
  {
    name: "validate-malformed-plan",
    argv: ["--validate"],
    fixture: {
      rawProjectDefinition: {
        vBRIEFInfo: { version: "0.6" },
        plan: null,
      },
    },
  },
];

/** Run all parity cases; returns aggregate result. */

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `triage:classify parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["triage:classify parity: DIVERGENCE"];
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
