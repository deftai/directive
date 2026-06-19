#!/usr/bin/env node
/**
 * Golden-output parity harness (#1725): runs BOTH Python oracles and ported TS
 * CLIs for triage aux verbs B (bulk / subscribe / help / smoketest).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const PY_SCRIPT: Record<ParityCase["verb"], string> = {
  help: "triage_help.py",
  subscribe: "triage_subscribe.py",
  bulk: "triage_bulk.py",
  smoketest: "triage_smoketest.py",
};

const TS_CLI: Record<ParityCase["verb"], string> = {
  help: "triage-help.js",
  subscribe: "triage-subscribe.js",
  bulk: "triage-bulk.js",
  smoketest: "triage-smoketest.js",
};

function runPython(deftRoot: string, testCase: ParityCase, repo: string): CommandCapture {
  const script = join(deftRoot, "scripts", PY_SCRIPT[testCase.verb]);
  if (testCase.verb === "help") {
    const cap = runCapture(
      "uv",
      ["run", "python", script, ...testCase.argv],
      deftRoot,
      testCase.env,
    );
    return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  if (testCase.verb === "bulk") {
    const cap = runCapture("uv", ["run", "python", script, ...testCase.argv], repo, {
      ...testCase.env,
      DEFT_ROOT: deftRoot,
    });
    return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  if (testCase.verb === "smoketest") {
    const cap = runCapture(
      "uv",
      ["run", "python", script, ...testCase.argv],
      deftRoot,
      testCase.env,
    );
    return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  const cap = runCapture(
    "uv",
    ["run", "python", script, ...testCase.argv, "--project-root", repo],
    deftRoot,
    testCase.env,
  );
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTs(deftRoot: string, testCase: ParityCase, repo: string): CommandCapture {
  const cli = join(deftRoot, "packages", "cli", "dist", TS_CLI[testCase.verb]);
  const argv = [...testCase.argv];
  if (testCase.verb === "subscribe") {
    argv.push("--project-root", repo);
  }
  const cwd = testCase.verb === "bulk" ? repo : deftRoot;
  const cap = runCapture("node", [cli, ...argv], cwd, {
    ...testCase.env,
    DEFT_ROOT: deftRoot,
  });
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

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

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  const fixtureCache = new Map<string, string>();

  for (const testCase of PARITY_CASES) {
    let pyRepo = deftRoot;
    let tsRepo = deftRoot;
    let ownsFixture = false;

    if (testCase.fixtureRoot !== undefined) {
      if (!fixtureCache.has(testCase.fixtureRoot)) {
        fixtureCache.set(
          testCase.fixtureRoot,
          buildFixtureRepo(testCase.fixtureRoot as "subscribe" | "bulk-empty" | "bulk-filter"),
        );
      }
      const template = fixtureCache.get(testCase.fixtureRoot);
      if (template === undefined) {
        throw new Error(`missing fixture template ${testCase.fixtureRoot}`);
      }
      pyRepo = mkdtempSync(join(tmpdir(), "deft-parity-py-"));
      tsRepo = mkdtempSync(join(tmpdir(), "deft-parity-ts-"));
      for (const dest of [pyRepo, tsRepo]) {
        mkdirSync(dest, { recursive: true });
        for (const name of ["vbrief", ".deft-cache"]) {
          const src = join(template, name);
          if (existsSync(src)) {
            cpRecursive(src, join(dest, name));
          }
        }
      }
      ownsFixture = true;
      if (testCase.name === "subscribe-label-idempotent") {
        for (const repo of [pyRepo, tsRepo]) {
          const setup = runCapture(
            "uv",
            [
              "run",
              "python",
              join(deftRoot, "scripts", "triage_subscribe.py"),
              "subscribe",
              "--label",
              "dup-label",
              "--project-root",
              repo,
            ],
            deftRoot,
          );
          if (setup.status !== 0) {
            throw new Error(
              `subscribe-label-idempotent setup failed for ${repo}: ${setup.stderr || setup.stdout}`,
            );
          }
        }
      }
    }

    try {
      const python = runPython(deftRoot, testCase, pyRepo);
      const ts = runTs(deftRoot, testCase, tsRepo);
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

function cpRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      cpRecursive(s, d);
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
    process.stderr.write(`triage-aux-b parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
