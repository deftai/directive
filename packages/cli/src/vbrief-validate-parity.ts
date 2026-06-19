#!/usr/bin/env node
/**
 * Golden-output parity harness (#1782 s3): runs BOTH the Python oracles
 * (scripts/vbrief_validate.py + scripts/verify_vbrief_conformance.py) and
 * the ported TS vbrief-validate CLI over the repository vbrief/ tree, then
 * diffs exit codes and byte-identical stdout/stderr (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GateCapture {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GateParity {
  readonly name: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly stderrMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly pythonStdout: string;
  readonly tsStdout: string;
  readonly pythonStderr: string;
  readonly tsStderr: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly gates: readonly GateParity[];
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
  env: Record<string, string>,
): Capture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function normaliseHarnessNoise(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Using CPython") &&
        !line.startsWith("Creating virtual environment") &&
        !line.startsWith("Installed "),
    )
    .join("\n");
}

export function diffGate(python: GateCapture, ts: GateCapture): GateParity {
  const pythonStdout = normaliseHarnessNoise(python.stdout);
  const tsStdout = normaliseHarnessNoise(ts.stdout);
  const pythonStderr = normaliseHarnessNoise(python.stderr);
  const tsStderr = normaliseHarnessNoise(ts.stderr);
  return {
    name: python.name,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pythonStdout !== tsStdout,
    stderrMismatch: pythonStderr !== tsStderr,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
    pythonStdout,
    tsStdout,
    pythonStderr,
    tsStderr,
  };
}

export function runParity(deftRoot = resolveDeftRoot()): ParityResult {
  const envBase = {
    DEFT_CACHE_DISABLE: "1",
    PYTHONUTF8: "1",
    DEFT_ROOT: deftRoot,
  };
  const vbriefDir = join(deftRoot, "vbrief");

  const validatePy = runCapture(
    "uv",
    ["run", "python", "scripts/vbrief_validate.py", "--vbrief-dir", vbriefDir],
    deftRoot,
    envBase,
  );
  const validateTs = runCapture(
    "node",
    [join(deftRoot, "packages", "cli", "dist", "vbrief-validate.js"), "--vbrief-dir", vbriefDir],
    deftRoot,
    envBase,
  );

  const conformancePy = runCapture(
    "uv",
    ["run", "python", "scripts/verify_vbrief_conformance.py", "--all", "--project-root", deftRoot],
    deftRoot,
    envBase,
  );
  const conformanceTs = runCapture(
    "node",
    [
      join(deftRoot, "packages", "cli", "dist", "vbrief-validate.js"),
      "conformance",
      "--all",
      "--project-root",
      deftRoot,
    ],
    deftRoot,
    envBase,
  );

  const gates = [
    diffGate(
      { name: "vbrief_validate", ...validatePy, exitCode: validatePy.status },
      { name: "vbrief_validate", ...validateTs, exitCode: validateTs.status },
    ),
    diffGate(
      { name: "verify_vbrief_conformance", ...conformancePy, exitCode: conformancePy.status },
      { name: "verify_vbrief_conformance", ...conformanceTs, exitCode: conformanceTs.status },
    ),
  ];

  const ok = gates.every((g) => !g.exitMismatch && !g.stdoutMismatch && !g.stderrMismatch);
  return { ok, gates };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return "vbrief_validate parity: CLEAN -- Python and TS agree on validate + conformance over vbrief/.";
  }
  const lines = ["vbrief_validate parity: DIVERGENCE"];
  for (const g of result.gates) {
    if (g.exitMismatch || g.stdoutMismatch || g.stderrMismatch) {
      lines.push(`  gate: ${g.name}`);
      if (g.exitMismatch) {
        lines.push(`    exit mismatch: python=${g.pythonExit} ts=${g.tsExit}`);
      }
      if (g.stdoutMismatch) {
        lines.push(
          `    stdout mismatch (python ${g.pythonStdout.length} vs ts ${g.tsStdout.length} bytes)`,
        );
        lines.push(g.pythonStdout.slice(0, 400));
        lines.push("---");
        lines.push(g.tsStdout.slice(0, 400));
      }
      if (g.stderrMismatch) {
        lines.push(
          `    stderr mismatch (python ${g.pythonStderr.length} vs ts ${g.tsStderr.length} bytes)`,
        );
      }
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
    const msg = String(err).replace(/\r?\n/g, " ");
    process.stderr.write(`vbrief_validate parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
