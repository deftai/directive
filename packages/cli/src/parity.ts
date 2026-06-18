#!/usr/bin/env node
/**
 * Golden-output parity harness (#1718): builds a throwaway git repo of
 * known-corruption fixtures, runs BOTH the Python oracle
 * (`scripts/verify_encoding.py`) and the ported TS gate against it with the
 * cache off, and diffs structured findings + exit codes. A clean run proves
 * the TS port detects identically to the Python implementation it replaces.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ParityFinding {
  readonly path: string;
  readonly line: number;
  readonly label: string;
}

export interface GateOutput {
  readonly exitCode: number;
  readonly findings: ParityFinding[];
}

export interface ParityResult {
  readonly ok: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly exitMismatch: boolean;
  readonly onlyPython: string[];
  readonly onlyTs: string[];
}

// Finding render is `  path:line [label] context`; capture path / line / label.
const FINDING_RE = /^ {2}(.+?):(\d+) \[(.+?)\] /;

/** Parse the rendered finding lines out of a gate's stderr. */
export function parseFindings(stderr: string): ParityFinding[] {
  const out: ParityFinding[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = FINDING_RE.exec(line);
    if (m !== null) {
      out.push({ path: m[1] as string, line: Number(m[2]), label: m[3] as string });
    }
  }
  return out;
}

/** Stable key for a finding (path:line:label). */
export function findingKey(f: ParityFinding): string {
  return `${f.path}:${f.line}:${f.label}`;
}

/** Diff two gate outputs into a structured parity result. */
export function diffGates(python: GateOutput, ts: GateOutput): ParityResult {
  const pyKeys = new Set(python.findings.map(findingKey));
  const tsKeys = new Set(ts.findings.map(findingKey));
  const onlyPython = [...pyKeys].filter((k) => !tsKeys.has(k)).sort();
  const onlyTs = [...tsKeys].filter((k) => !pyKeys.has(k)).sort();
  const exitMismatch = python.exitCode !== ts.exitCode;
  return {
    ok: !exitMismatch && onlyPython.length === 0 && onlyTs.length === 0,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
    exitMismatch,
    onlyPython,
    onlyTs,
  };
}

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCapture(cmd: string, args: string[], cwd: string): Capture {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
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

const BOM = "\ufeff";

/**
 * Fixture corpus exercised by the parity harness. Each entry maps a repo-rel
 * path to its exact textual content. Covers: clean files, U+FFFD, cp437/cp1252
 * mojibake, unexpected/ tolerated BOM, vBRIEF narrative control chars, markdown
 * code-span false-positive guard, and the `-798-` allow-list carve-out.
 */
export const PARITY_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ["clean.md", "# Title\n\nplain ascii prose\n"],
  ["ufffd.txt", "line one\nbroken \ufffd marker\n"],
  ["cp437.md", "a cp437 glyph \u0393\u00a3\u00f4 in prose\n"],
  ["cp1252.txt", "a smart \u00e2\u20ac\u2122 quote in prose\n"],
  ["bom.json", `${BOM}{"a": 1}\n`],
  ["tolerated-bom.ps1", `${BOM}Write-Host 'ok'\n`],
  ["md-quoted.md", "see the bigon `\u0393\u00a3\u00f4` inside a code span\n"],
  [
    "vbrief/active/2026-01-01-1-x.vbrief.json",
    `${JSON.stringify({ plan: { narratives: { problem: "has a \u000b vtab" } } }, null, 2)}\n`,
  ],
  [
    "vbrief/active/2026-01-01-798-recurrence.vbrief.json",
    `${JSON.stringify({ plan: { narratives: { problem: "catalogs \u0393\u00a3\u00f4" } } }, null, 2)}\n`,
  ],
];

/** Build the throwaway git repo with all fixtures; return its root path. */
export function buildFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-encoding-parity-"));
  // mkdtempSync already created the dir, so any failure below (a write error or
  // git not being on PATH) must clean it up here -- the try/finally in
  // runParity only fires once this function returns the path successfully.
  try {
    for (const [rel, content] of PARITY_FIXTURES) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, { encoding: "utf8" });
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return root;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  // dist layout: packages/cli/dist/parity.js -> repo root is three levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Run both gates against a fresh fixture repo and diff them. */
export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const repo = buildFixtureRepo();
  try {
    const py = runCapture(
      "uv",
      [
        "run",
        "python",
        join(deftRoot, "scripts", "verify_encoding.py"),
        "--all",
        "--project-root",
        repo,
      ],
      deftRoot,
    );
    const ts = runCapture(
      "node",
      [
        join(deftRoot, "packages", "cli", "dist", "verify-encoding.js"),
        "--all",
        "--project-root",
        repo,
      ],
      deftRoot,
    );
    return diffGates(
      { exitCode: py.status, findings: parseFindings(py.stderr) },
      { exitCode: ts.status, findings: parseFindings(ts.stderr) },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `verify_encoding parity: CLEAN -- Python and TS agree (exit ${result.pythonExit}).`;
  }
  const lines = ["verify_encoding parity: DIVERGENCE"];
  if (result.exitMismatch) {
    lines.push(`  exit mismatch: python=${result.pythonExit} ts=${result.tsExit}`);
  }
  for (const k of result.onlyPython) {
    lines.push(`  only python: ${k}`);
  }
  for (const k of result.onlyTs) {
    lines.push(`  only ts:     ${k}`);
  }
  return lines.join("\n");
}

// Normalize via fileURLToPath so this fires on Windows too (see verify-encoding.ts).
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
    process.stderr.write(`verify_encoding parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
