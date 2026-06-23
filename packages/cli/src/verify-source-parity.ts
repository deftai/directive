#!/usr/bin/env node
/**
 * Golden-output parity harness (#1783 s2): runs BOTH the frozen Python source-tree
 * scanner gates and the ported TS verify-source module over the repository tree,
 * then diffs exit codes + byte-identical stdout/stderr (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCodeStructure,
  evaluateRuleOwnership,
  evaluateScmBoundary,
  evaluateVerifyStubs,
} from "@deftai/directive-core/verify-source";

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
  env: Record<string, string> = {},
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

export function captureTsGate(name: string, deftRoot: string): GateCapture {
  if (name === "verify_scm_boundary") {
    const result = evaluateScmBoundary(deftRoot);
    return {
      name,
      exitCode: result.code,
      stdout: result.stream === "stdout" ? `${result.message}\n` : "",
      stderr: result.stream === "stderr" ? `${result.message}\n` : "",
    };
  }
  if (name === "rule_ownership_lint") {
    const result = evaluateRuleOwnership(deftRoot, { root: deftRoot });
    return {
      name,
      exitCode: result.code,
      stdout: result.stream === "stdout" ? `${result.message}\n` : "",
      stderr: result.stream === "stderr" ? `${result.message}\n` : "",
    };
  }
  if (name === "code_structure_validate") {
    const result = evaluateCodeStructure(deftRoot);
    return {
      name,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (name === "verify-stubs") {
    const result = evaluateVerifyStubs(deftRoot);
    const msg = result.message.endsWith("\n") ? result.message : `${result.message}\n`;
    return {
      name,
      exitCode: result.code,
      stdout: msg,
      stderr: "",
    };
  }
  return { name, exitCode: 2, stdout: "", stderr: `unknown gate: ${name}\n` };
}

export function capturePythonGate(name: string, deftRoot: string): GateCapture {
  const env = { DEFT_CACHE_DISABLE: "1", PYTHONUTF8: "1" };
  if (name === "verify_scm_boundary") {
    const cap = runCapture(
      "uv",
      [
        "run",
        "python",
        join(deftRoot, "scripts", "verify_scm_boundary.py"),
        "--project-root",
        deftRoot,
      ],
      deftRoot,
      env,
    );
    return { name, exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  if (name === "rule_ownership_lint") {
    const cap = runCapture(
      "uv",
      ["run", "python", join(deftRoot, "scripts", "rule_ownership_lint.py"), "--root", deftRoot],
      deftRoot,
      env,
    );
    return { name, exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  if (name === "code_structure_validate") {
    const cap = runCapture(
      "uv",
      [
        "run",
        "python",
        join(deftRoot, "scripts", "code_structure_validate.py"),
        "--project-root",
        deftRoot,
      ],
      deftRoot,
      env,
    );
    return { name, exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  if (name === "verify-stubs") {
    const cap = runCapture(
      "uv",
      ["run", "python", join(deftRoot, "scripts", "verify-stubs.py")],
      deftRoot,
      env,
    );
    return { name, exitCode: cap.status, stdout: cap.stdout, stderr: cap.stderr };
  }
  return { name, exitCode: 2, stdout: "", stderr: `unknown gate: ${name}\n` };
}

export const PARITY_GATES = [
  "verify_scm_boundary",
  "rule_ownership_lint",
  "code_structure_validate",
  "verify-stubs",
] as const;

export function diffGate(python: GateCapture, ts: GateCapture): GateParity {
  const pyOut = normaliseHarnessNoise(python.stdout);
  const tsOut = normaliseHarnessNoise(ts.stdout);
  const pyErr = normaliseHarnessNoise(python.stderr);
  const tsErr = normaliseHarnessNoise(ts.stderr);
  return {
    name: python.name,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pyOut !== tsOut,
    stderrMismatch: pyErr !== tsErr,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
}

export function runParity(deftRoot = resolveDeftRoot()): ParityResult {
  const gates: GateParity[] = [];
  for (const name of PARITY_GATES) {
    const python = capturePythonGate(name, deftRoot);
    const ts = captureTsGate(name, deftRoot);
    gates.push(diffGate(python, ts));
  }
  const ok = gates.every((g) => !g.exitMismatch && !g.stdoutMismatch && !g.stderrMismatch);
  return { ok, gates };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `verify-source parity: CLEAN -- Python and TS agree on ${PARITY_GATES.length} gate(s).`;
  }
  const lines = ["verify-source parity: DIVERGENCE"];
  for (const g of result.gates) {
    if (g.exitMismatch || g.stdoutMismatch || g.stderrMismatch) {
      lines.push(`  gate: ${g.name}`);
      if (g.exitMismatch) {
        lines.push(`    exit: python=${g.pythonExit} ts=${g.tsExit}`);
      }
      if (g.stdoutMismatch) {
        lines.push("    stdout mismatch");
      }
      if (g.stderrMismatch) {
        lines.push("    stderr mismatch");
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
    process.stderr.write(`verify-source parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
