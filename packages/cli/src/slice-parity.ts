#!/usr/bin/env node
/**
 * Golden-output parity harness (#1727): runs BOTH the Python oracle
 * (`scripts/slice_record_existing.py`) and the ported TS slice CLI with
 * identical argv on throwaway fixtures, then diffs exit codes and
 * normalised stdout/stderr (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

function seedJsonLine(record: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(record)).replace(
    /("(?:[^"\\]|\\.)*")|([:,])/g,
    (_match, str: string | undefined, sep: string | undefined) =>
      str !== undefined ? str : sep === ":" ? ": " : ", ",
  );
}

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SliceFixtureOptions {
  readonly seedRecords?: ReadonlyArray<Record<string, unknown>>;
}

export interface ParityCase {
  readonly name: string;
  readonly argv: string[];
  readonly fixture?: SliceFixtureOptions;
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

/** Strip volatile absolute paths, UUIDs, and timestamps before compare. */
export function normalizeOutput(text: string): string {
  return text
    .replace(/--project-root [^\s]+/g, "--project-root <ROOT>")
    .replace(/slice_id=[0-9a-fA-F-]{36}/g, "slice_id=<UUID>")
    .replace(/slice_id=[0-9a-fA-F-]{36}/g, "slice_id=<UUID>")
    .replace(/"slice_id": "[0-9a-fA-F-]{36}"/g, '"slice_id": "<UUID>"')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<ISO>");
}

function runCapture(cmd: string, args: string[], cwd: string): CommandCapture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export function buildFixtureRepo(options: SliceFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slice-parity-"));
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  mkdirSync(join(root, ".git"));
  const logPath = join(root, "vbrief", ".eval", "slices.jsonl");
  for (const record of options.seedRecords ?? []) {
    appendFileSync(logPath, `${seedJsonLine(record)}\n`, "utf8");
  }
  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonSlice(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  return runCapture(
    "uv",
    [
      "run",
      "python",
      join(deftRoot, "scripts", "slice_record_existing.py"),
      ...argv,
      "--project-root",
      repo,
    ],
    deftRoot,
  );
}

function runTsSlice(deftRoot: string, repo: string, argv: string[]): CommandCapture {
  return runCapture(
    "node",
    [
      join(deftRoot, "packages", "core", "dist", "slice", "cli.js"),
      ...argv,
      "--project-root",
      repo,
    ],
    deftRoot,
  );
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
  { name: "list-empty", argv: ["list"] },
  {
    name: "list-seeded",
    argv: ["list"],
    fixture: {
      seedRecords: [
        {
          slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          umbrella: 10,
          umbrella_url: "https://github.com/owner/repo/issues/10",
          sliced_at: "2026-05-14T17:00:00Z",
          actor: "manual:operator",
          children: [
            { n: 11, url: "https://github.com/owner/repo/issues/11", wave: 1, role: "manual" },
          ],
          expected_close_signal: "all-children-merged",
        },
      ],
    },
  },
  {
    name: "list-json-seeded",
    argv: ["list", "--json"],
    fixture: {
      seedRecords: [
        {
          slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          umbrella: 10,
          umbrella_url: "https://github.com/owner/repo/issues/10",
          sliced_at: "2026-05-14T17:00:00Z",
          actor: "manual:operator",
          children: [
            { n: 11, url: "https://github.com/owner/repo/issues/11", wave: 1, role: "manual" },
          ],
          expected_close_signal: "all-children-merged",
        },
      ],
    },
  },
  {
    name: "record-existing-skip-validation",
    argv: [
      "record-existing",
      "--umbrella=1",
      "--children=2,3",
      "--repo=owner/repo",
      "--skip-validation",
      "--sliced-at=2026-05-14T17:00:00Z",
    ],
  },
  {
    name: "record-existing-idempotent",
    argv: [
      "record-existing",
      "--umbrella=1",
      "--children=2,3",
      "--repo=owner/repo",
      "--skip-validation",
      "--sliced-at=2026-05-14T17:00:00Z",
    ],
    fixture: {
      seedRecords: [
        {
          slice_id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
          umbrella: 1,
          umbrella_url: "https://github.com/owner/repo/issues/1",
          sliced_at: "2026-05-14T17:00:00Z",
          actor: "manual:operator",
          children: [
            { n: 2, url: "https://github.com/owner/repo/issues/2", wave: 1, role: "manual" },
            { n: 3, url: "https://github.com/owner/repo/issues/3", wave: 1, role: "manual" },
          ],
          expected_close_signal: "all-children-merged",
        },
      ],
    },
  },
  {
    name: "record-existing-dry-run",
    argv: [
      "record-existing",
      "--umbrella=42",
      "--children=100,101",
      "--repo=owner/repo",
      "--dry-run",
      "--skip-validation",
      "--sliced-at=2026-05-14T17:00:00Z",
    ],
  },
  {
    name: "duplicate-child",
    argv: [
      "record-existing",
      "--umbrella=1",
      "--children=2,2",
      "--repo=owner/repo",
      "--skip-validation",
    ],
  },
  {
    name: "umbrella-in-children",
    argv: [
      "record-existing",
      "--umbrella=1",
      "--children=1,2",
      "--repo=owner/repo",
      "--skip-validation",
    ],
  },
  {
    name: "wave-member-not-in-children",
    argv: [
      "record-existing",
      "--umbrella=1",
      "--children=2,3",
      "--wave-2=999",
      "--repo=owner/repo",
      "--skip-validation",
    ],
  },
  {
    name: "cross-wave-collision",
    argv: [
      "record-existing",
      "--umbrella=1",
      "--children=2,3",
      "--wave-1=2",
      "--wave-2=2",
      "--repo=owner/repo",
      "--skip-validation",
    ],
  },
  {
    name: "default-subcommand",
    argv: [
      "--umbrella=1",
      "--children=2",
      "--repo=owner/repo",
      "--skip-validation",
      "--sliced-at=2026-05-14T17:00:00Z",
    ],
  },
  {
    name: "missing-project-root",
    argv: ["list", "--project-root", "/no/such/deft-project-root-xyz"],
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
      const python = runPythonSlice(deftRoot, pyRepo, testCase.argv);
      const ts = runTsSlice(deftRoot, tsRepo, testCase.argv);
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
    return `slice parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} case(s).`;
  }
  const lines = ["slice parity: DIVERGENCE"];
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
    process.stderr.write(`slice parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
