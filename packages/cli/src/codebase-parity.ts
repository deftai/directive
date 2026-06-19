#!/usr/bin/env node
/**
 * Golden-output parity harness (#1786): runs BOTH the frozen Python codebase/capacity
 * modules and the ported TS CLIs over shared fixtures, cache-off.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  readonly script: string;
  readonly argv: string[];
  readonly setup?: (root: string) => void;
  readonly env?: Record<string, string | undefined>;
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
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      env: merged as NodeJS.ProcessEnv,
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

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const TS_CLI: Record<string, string> = {
  codebase_projection_registry: "codebase-projection-registry.js",
  codebase_default_extractor: "codebase-default-extractor.js",
  codebase_provider: "codebase-provider.js",
  capacity_show: "capacity-show.js",
  capacity_backfill: "capacity-backfill.js",
};

const NO_PROJECT_ROOT = new Set(["codebase_projection_registry"]);

function runPython(deftRoot: string, script: string, repo: string, argv: string[]): CommandCapture {
  const args = ["run", "python", join(deftRoot, "scripts", `${script}.py`), ...argv];
  if (!NO_PROJECT_ROOT.has(script)) {
    args.push("--project-root", repo);
  }
  const cap = runCapture("uv", args, deftRoot);
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function runTs(deftRoot: string, script: string, repo: string, argv: string[]): CommandCapture {
  const cli = TS_CLI[script];
  if (cli === undefined) {
    throw new Error(`no TS CLI mapped for ${script}`);
  }
  const args = [join(deftRoot, "packages", "cli", "dist", cli), ...argv];
  if (!NO_PROJECT_ROOT.has(script)) {
    args.push("--project-root", repo);
  }
  const cap = runCapture("node", args, deftRoot);
  return { exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
}

function writeCapacityProject(root: string): void {
  const vbrief = join(root, "vbrief");
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(vbrief, folder), { recursive: true });
  }
  writeFileSync(
    join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "Capacity parity",
          status: "running",
          items: [],
          policy: {
            capacityAllocation: {
              unit: "vbrief-count",
              window: 30,
              enforcement: "advise",
              minSampleSize: 2,
              defaultBucket: "feature",
              buckets: [
                { id: "debt", target: 0.4, match: { labels: { "any-of": ["tech-debt"] } } },
                { id: "feature", target: 0.6, match: { labels: { "any-of": ["feature"] } } },
              ],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

function writeCodeStructureProject(root: string): void {
  const vbrief = join(root, "vbrief");
  mkdirSync(vbrief, { recursive: true });
  writeFileSync(
    join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "Fixture",
          status: "running",
          architecture: {
            codeStructure: {
              version: "0.1",
              modules: [
                {
                  id: "app",
                  name: "App",
                  purpose: "Application entry points.",
                  pathGlobs: ["app/**/*.py"],
                },
              ],
              pathOwnership: [],
              allowedPatterns: [],
              projectionManifest: [],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "main.py"), "from lib.util import thing\n", { encoding: "utf8" });
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "projection-registry-list",
    script: "codebase_projection_registry",
    argv: ["--list"],
  },
  {
    name: "projection-registry-kind",
    script: "codebase_projection_registry",
    argv: ["--kind", "codebase-map"],
  },
  {
    name: "default-extractor-curated",
    script: "codebase_default_extractor",
    argv: [],
    setup: writeCodeStructureProject,
  },
  {
    name: "provider-default-fallback",
    script: "codebase_provider",
    argv: [],
    setup: writeCodeStructureProject,
  },
  {
    name: "capacity-show-advisory",
    script: "capacity_show",
    argv: [],
    setup: writeCapacityProject,
  },
  {
    name: "capacity-backfill-dry-run",
    script: "capacity_backfill",
    argv: [],
    setup: writeCapacityProject,
  },
  {
    name: "capacity-backfill-json",
    script: "capacity_backfill",
    argv: ["--json"],
    setup: writeCapacityProject,
  },
];

export function diffCase(python: CommandCapture, ts: CommandCapture, caseName: string): ParityDiff {
  return {
    caseName,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: python.stdout !== ts.stdout,
    stderrMismatch: python.stderr !== ts.stderr,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    const repo = mkdtempSync(join(tmpdir(), "deft-codebase-parity-"));
    try {
      testCase.setup?.(repo);
      const argv = testCase.argv.filter((a) => a !== "--project-root");
      const python = runPython(deftRoot, testCase.script, repo, argv);
      const ts = runTs(deftRoot, testCase.script, repo, argv);
      diffs.push(diffCase(python, ts, testCase.name));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
  const ok = diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch);
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `codebase parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["codebase parity: DIVERGENCE"];
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
    process.stderr.write(`codebase parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
