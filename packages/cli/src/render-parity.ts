#!/usr/bin/env node
/**
 * Golden-output parity harness (#1785): runs BOTH the Python oracles
 * (frozen render/spec modules) and the ported TS render family over shared
 * fixtures, then diffs exit codes + rendered bytes / stdout/stderr (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderPrd,
  renderProjectDefinition,
  renderRoadmap,
  renderSpec,
  runFrameworkCommand,
  validateSpec,
} from "@deftai/directive-core/render";

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly bytes?: Buffer;
}

export interface ParityCase {
  readonly gate:
    | "spec-validate"
    | "spec-render"
    | "prd-render"
    | "project-render"
    | "roadmap-render"
    | "framework-commands";
  readonly name: string;
  readonly setup: (root: string) => {
    specPath?: string;
    outPath?: string;
    extra?: Record<string, string>;
  };
}

export interface ParityDiff {
  readonly gate: string;
  readonly caseName: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly stderrMismatch: boolean;
  readonly bytesMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

const MINIMAL_SPEC = {
  vBRIEFInfo: { version: "0.6" },
  plan: {
    title: "Parity Spec",
    status: "approved",
    narratives: {
      Overview: "Parity overview.",
      Goals: "Ship byte-identical renders.",
    },
    items: [
      {
        id: "T1",
        title: "First task",
        status: "pending",
        narrative: { Description: "Do the thing.", Acceptance: "- Done when green" },
      },
    ],
  },
};

const FIXED_NOW = "2026-06-04T12:00:00Z";

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPython(code: string, deftRoot: string): CommandCapture {
  try {
    const stdout = execFileSync("uv", ["run", "python", "-c", code], {
      cwd: deftRoot,
      encoding: "utf8",
      env: { ...process.env, DEFT_CACHE_DISABLE: "1", PYTHONUTF8: "1" },
    });
    return { exitCode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 2,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

function scriptsPrefix(deftRoot: string): string {
  const scriptsDir = join(deftRoot, "scripts").replace(/\\/g, "/");
  return `import sys; sys.path.insert(0, ${JSON.stringify(scriptsDir)})`;
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    gate: "spec-validate",
    name: "valid-spec",
    setup: (root) => {
      const specPath = join(root, "spec.json");
      writeFileSync(specPath, JSON.stringify(MINIMAL_SPEC), "utf8");
      return { specPath };
    },
  },
  {
    gate: "spec-validate",
    name: "missing-spec",
    setup: (root) => ({ specPath: join(root, "missing.json") }),
  },
  {
    gate: "spec-render",
    name: "approved-spec",
    setup: (root) => {
      mkdirSync(join(root, "vbrief"), { recursive: true });
      const specPath = join(root, "vbrief", "specification.vbrief.json");
      const outPath = join(root, "SPECIFICATION.md");
      writeFileSync(specPath, JSON.stringify(MINIMAL_SPEC), "utf8");
      return { specPath, outPath };
    },
  },
  {
    gate: "prd-render",
    name: "basic-prd",
    setup: (root) => {
      const specPath = join(root, "spec.json");
      const outPath = join(root, "PRD.md");
      writeFileSync(specPath, JSON.stringify(MINIMAL_SPEC), "utf8");
      return { specPath, outPath };
    },
  },
  {
    gate: "project-render",
    name: "skeleton-projdef",
    setup: (root) => {
      const vbrief = join(root, "vbrief");
      for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
        mkdirSync(join(vbrief, f), { recursive: true });
      }
      return { extra: { vbriefDir: vbrief } };
    },
  },
  {
    gate: "roadmap-render",
    name: "phase-grouped",
    setup: (root) => {
      const pending = join(root, "vbrief", "pending");
      mkdirSync(pending, { recursive: true });
      writeFileSync(
        join(pending, "2026-01-01-a.vbrief.json"),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "Story A",
            status: "pending",
            metadata: { "x-migrator": { Phase: "Phase 2", PhaseDescription: "Wave 6" } },
            references: [{ uri: "https://github.com/deftai/directive/issues/1785" }],
          },
        }),
        "utf8",
      );
      const outPath = join(root, "ROADMAP.md");
      return { outPath, extra: { pendingDir: pending } };
    },
  },
  {
    gate: "framework-commands",
    name: "unknown-command",
    setup: () => ({}),
  },
];

function runPythonGate(
  deftRoot: string,
  testCase: ParityCase,
  paths: ReturnType<ParityCase["setup"]>,
  repoRoot: string,
): CommandCapture {
  const scripts = scriptsPrefix(deftRoot);
  if (testCase.gate === "spec-validate") {
    const code = [
      scripts,
      "from spec_validate import validate_spec",
      `ok, msg = validate_spec(${JSON.stringify(paths.specPath ?? "")})`,
      "import sys",
      "stream = sys.stdout if ok else sys.stderr",
      "stream.write(msg + '\\n')",
      "sys.exit(0 if ok else 1)",
    ].join("\n");
    return runPython(code, deftRoot);
  }
  if (testCase.gate === "spec-render") {
    const code = [
      scripts,
      "from spec_render import render_spec",
      `ok, msg = render_spec(${JSON.stringify(paths.specPath ?? "")}, ${JSON.stringify(paths.outPath ?? "")}, include_scopes=False)`,
      "import sys",
      "print(msg)",
      "sys.exit(0 if ok else 1)",
    ].join("\n");
    const cap = runPython(code, deftRoot);
    if (cap.exitCode === 0 && paths.outPath && existsSync(paths.outPath)) {
      return { ...cap, bytes: readFileSync(paths.outPath) };
    }
    return cap;
  }
  if (testCase.gate === "prd-render") {
    const code = [
      scripts,
      "from pathlib import Path",
      "from prd_render import render_prd",
      `render_prd(Path(${JSON.stringify(paths.specPath ?? "")}), Path(${JSON.stringify(paths.outPath ?? "")}))`,
    ].join("\n");
    const cap = runPython(code, deftRoot);
    if (paths.outPath && existsSync(paths.outPath)) {
      return { ...cap, bytes: readFileSync(paths.outPath) };
    }
    return cap;
  }
  if (testCase.gate === "project-render") {
    const vbriefDir = paths.extra?.vbriefDir ?? join(repoRoot, "vbrief");
    const code = [
      scripts,
      "from project_render import render_project_definition",
      `ok, msg = render_project_definition(${JSON.stringify(vbriefDir)})`,
      "import sys",
      "print(msg)",
      "sys.exit(0 if ok else 1)",
    ].join("\n");
    const cap = runPython(code, deftRoot);
    const full = join(vbriefDir, "PROJECT-DEFINITION.vbrief.json");
    if (existsSync(full)) return { ...cap, bytes: readFileSync(full) };
    return cap;
  }
  if (testCase.gate === "roadmap-render") {
    const pendingDir = paths.extra?.pendingDir ?? join(repoRoot, "vbrief", "pending");
    const outPath = paths.outPath ?? join(repoRoot, "ROADMAP.md");
    const code = [
      scripts,
      "from roadmap_render import render_roadmap",
      `ok, msg = render_roadmap(${JSON.stringify(pendingDir)}, ${JSON.stringify(outPath)})`,
      "import sys",
      "print(msg)",
      "sys.exit(0 if ok else 1)",
    ].join("\n");
    const cap = runPython(code, deftRoot);
    if (existsSync(outPath)) return { ...cap, bytes: readFileSync(outPath) };
    return cap;
  }
  const code = [
    scripts,
    "from framework_commands import run_framework_command",
    "result = run_framework_command('__missing__', capture=True)",
    "import sys",
    "if result.stdout: sys.stdout.write(result.stdout)",
    "if result.stderr: sys.stderr.write(result.stderr)",
    "sys.exit(result.code)",
  ].join("\n");
  return runPython(code, deftRoot);
}

function runTsGate(
  testCase: ParityCase,
  paths: ReturnType<ParityCase["setup"]>,
  repoRoot: string,
): CommandCapture {
  if (testCase.gate === "spec-validate") {
    const [ok, msg] = validateSpec(paths.specPath ?? "");
    return {
      exitCode: ok ? 0 : 1,
      stdout: ok ? `${msg}\n` : "",
      stderr: ok ? "" : `${msg}\n`,
    };
  }
  if (testCase.gate === "spec-render") {
    const [ok, msg] = renderSpec(paths.specPath ?? "", paths.outPath ?? "", {
      includeScopes: false,
    });
    const cap: CommandCapture = {
      exitCode: ok ? 0 : 1,
      stdout: `${msg}\n`,
      stderr: "",
    };
    if (ok && paths.outPath && existsSync(paths.outPath)) {
      return { ...cap, bytes: readFileSync(paths.outPath) };
    }
    return cap;
  }
  if (testCase.gate === "prd-render") {
    const chunks = { out: "", err: "" };
    const prevOut = process.stdout.write.bind(process.stdout);
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c: string | Uint8Array) => {
      chunks.out += String(c);
      return true;
    };
    process.stderr.write = (c: string | Uint8Array) => {
      chunks.err += String(c);
      return true;
    };
    let exitCode = 0;
    try {
      renderPrd(paths.specPath ?? "", paths.outPath ?? "");
    } catch {
      exitCode = 1;
    } finally {
      process.stdout.write = prevOut;
      process.stderr.write = prevErr;
    }
    const cap: CommandCapture = { exitCode, stdout: chunks.out, stderr: chunks.err };
    if (paths.outPath && existsSync(paths.outPath)) {
      return { ...cap, bytes: readFileSync(paths.outPath) };
    }
    return cap;
  }
  if (testCase.gate === "project-render") {
    const vbriefDir = paths.extra?.vbriefDir ?? join(repoRoot, "vbrief");
    const [ok, msg] = renderProjectDefinition(vbriefDir, { now: new Date(FIXED_NOW) });
    const full = join(vbriefDir, "PROJECT-DEFINITION.vbrief.json");
    const cap: CommandCapture = { exitCode: ok ? 0 : 1, stdout: `${msg}\n`, stderr: "" };
    if (ok && existsSync(full)) return { ...cap, bytes: readFileSync(full) };
    return cap;
  }
  if (testCase.gate === "roadmap-render") {
    const pendingDir = paths.extra?.pendingDir ?? join(repoRoot, "vbrief", "pending");
    const outPath = paths.outPath ?? join(repoRoot, "ROADMAP.md");
    const [ok, msg] = renderRoadmap(pendingDir, outPath);
    const cap: CommandCapture = { exitCode: ok ? 0 : 1, stdout: `${msg}\n`, stderr: "" };
    if (ok && existsSync(outPath)) return { ...cap, bytes: readFileSync(outPath) };
    return cap;
  }
  const result = runFrameworkCommand("__missing__", [], { capture: true, projectRoot: repoRoot });
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

function normalizeProjectBytes(bytes: Buffer): Buffer {
  let text = bytes.toString("utf8");
  text = text.replace(/"updated": "[^"]+"/g, '"updated": "<TS>"');
  text = text.replace(/"created": "[^"]+"/g, '"created": "<TS>"');
  return Buffer.from(text, "utf8");
}

function normalizeMessage(text: string): string {
  return text.replace(/\/tmp\/deft-render-parity-(py|ts)-[^/\s]+/g, "<TMP>");
}

export function diffCase(
  python: CommandCapture,
  ts: CommandCapture,
  gate: string,
  caseName: string,
): ParityDiff {
  let bytesMismatch = false;
  if (python.bytes !== undefined && ts.bytes !== undefined) {
    const pyBytes = gate === "project-render" ? normalizeProjectBytes(python.bytes) : python.bytes;
    const tsBytes = gate === "project-render" ? normalizeProjectBytes(ts.bytes) : ts.bytes;
    bytesMismatch = !pyBytes.equals(tsBytes);
  } else if (python.bytes !== undefined || ts.bytes !== undefined) {
    bytesMismatch = true;
  }
  const pyStdout = normalizeMessage(python.stdout);
  const tsStdout = normalizeMessage(ts.stdout);
  const pyStderr = normalizeMessage(python.stderr);
  const tsStderr = normalizeMessage(ts.stderr);
  return {
    gate,
    caseName,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pyStdout !== tsStdout,
    stderrMismatch: pyStderr !== tsStderr,
    bytesMismatch,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];

  for (const testCase of PARITY_CASES) {
    const pyRepo = mkdtempSync(join(tmpdir(), "deft-render-parity-py-"));
    const tsRepo = mkdtempSync(join(tmpdir(), "deft-render-parity-ts-"));
    try {
      const pyPaths = testCase.setup(pyRepo);
      const tsPaths = testCase.setup(tsRepo);
      const python = runPythonGate(deftRoot, testCase, pyPaths, pyRepo);
      const ts = runTsGate(testCase, tsPaths, tsRepo);
      diffs.push(diffCase(python, ts, testCase.gate, testCase.name));
    } finally {
      rmSync(pyRepo, { recursive: true, force: true });
      rmSync(tsRepo, { recursive: true, force: true });
    }
  }

  const ok = diffs.every(
    (d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch && !d.bytesMismatch,
  );
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `render parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["render parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch || d.bytesMismatch) {
      lines.push(`  gate: ${d.gate} case: ${d.caseName}`);
      if (d.exitMismatch) lines.push(`    exit: python=${d.pythonExit} ts=${d.tsExit}`);
      if (d.stdoutMismatch) lines.push("    stdout mismatch");
      if (d.stderrMismatch) lines.push("    stderr mismatch");
      if (d.bytesMismatch) lines.push("    rendered bytes mismatch");
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
    process.stderr.write(`render parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
