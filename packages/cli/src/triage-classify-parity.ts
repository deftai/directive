#!/usr/bin/env node
/**
 * Golden-output parity harness (#1725): runs BOTH the Python oracle
 * (`scripts/triage_classify.py`) and the ported TS triage-classify CLI with
 * identical argv, then diffs exit codes and normalised stdout/stderr.
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
  return text
    .replace(/project_root=[^\s)]+/g, "project_root=<ROOT>")
    // Match the parity temp root regardless of platform tmpdir prefix
    // (/tmp on Linux, /var/folders/... on macOS, etc.).
    .replace(/\S*deft-triage-classify-parity-[^\s/]+/g, "<TMPROOT>");
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

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonClassify(
  deftRoot: string,
  repo: string,
  argv: readonly string[],
): CommandCapture {
  const cap = runCapture(
    "uv",
    [
      "run",
      "python",
      join(deftRoot, "scripts", "triage_classify.py"),
      ...argv,
      "--project-root",
      repo,
    ],
    deftRoot,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTsClassify(deftRoot: string, repo: string, argv: readonly string[]): CommandCapture {
  const cap = runCapture(
    "node",
    [
      join(deftRoot, "packages", "cli", "dist", "triage-classify.js"),
      ...argv,
      "--project-root",
      repo,
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
export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    const pyRepo =
      testCase.useRepoRoot === true ? deftRoot : buildFixtureRepo(testCase.fixture ?? {});
    const tsRepo =
      testCase.useRepoRoot === true ? deftRoot : buildFixtureRepo(testCase.fixture ?? {});
    const ownsFixture = testCase.useRepoRoot !== true;
    try {
      const python = runPythonClassify(deftRoot, pyRepo, testCase.argv);
      const ts = runTsClassify(deftRoot, tsRepo, testCase.argv);
      diffs.push(diffCase(python, ts, testCase.name));
    } finally {
      if (ownsFixture) {
        rmSync(pyRepo, { recursive: true, force: true });
        rmSync(tsRepo, { recursive: true, force: true });
      }
    }
  }
  const ok = diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch);
  return { ok, diffs };
}

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
    process.stderr.write(`triage:classify parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
