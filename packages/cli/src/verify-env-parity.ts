#!/usr/bin/env node
/**
 * Golden-output parity harness (#1783 s1): runs BOTH the Python oracles and the
 * ported TS verify-env gates over shared fixtures (cache-off), asserting
 * byte-identical stdout/stderr and exit codes.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluate as evaluateHooks,
  formatScanResult,
  runToolchainCheck,
  scan,
  verifyRequiredTools,
} from "@deftai/core/verify-env";

export interface Capture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityCase {
  readonly name: string;
  readonly runPython: (deftRoot: string) => Capture;
  readonly runTs: (deftRoot: string) => Capture;
}

export interface ParityDiff {
  readonly name: string;
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

function captureFromRun(exitCode: number, stdout: string, stderr: string): Capture {
  return { exitCode, stdout, stderr };
}

function loadModule(name: string, relPath: string): string {
  return `spec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, root / ${JSON.stringify(relPath)})
mod = importlib.util.module_from_spec(spec)
sys.modules[${JSON.stringify(name)}] = mod
spec.loader.exec_module(mod)`;
}

function runPythonScript(deftRoot: string, script: string): Capture {
  const code = `import importlib.util, sys\nfrom pathlib import Path\nroot = Path(${JSON.stringify(deftRoot)})\n${script}`;
  const result = spawnSync("uv", ["run", "python", "-c", code], {
    cwd: deftRoot,
    encoding: "utf8",
    env: { ...process.env, DEFT_CACHE_DISABLE: "1", PYTHONUTF8: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function probeWith(available: Set<string>) {
  return (command: string) => (available.has(command) ? `/usr/bin/${command}` : null);
}

function makeNoTaskFixture(deftRoot: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-verify-env-notask-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "run"), "#!/usr/bin/env python3\n", "utf8");
  writeFileSync(
    join(root, "scripts", "probe.py"),
    'import subprocess\nimport shutil\nsubprocess.check_output(["task", "check"])\nshutil.which("task")\n',
    "utf8",
  );
  writeFileSync(
    join(root, "scripts", "verify_no_task_runtime.py"),
    readFileSync(join(deftRoot, "scripts", "verify_no_task_runtime.py"), "utf8"),
    "utf8",
  );
  return root;
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "verify-tools-clean-linux",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("verify_tools", "scripts/verify_tools.py")}
available = {"git","uv","python3","gh","apt-get"}
def probe(c):
    return f"/usr/bin/{c}" if c in available else None
lines = []
result = mod.verify_required_tools(platform_id="linux", probe=probe, output_fn=lines.append)
for line in lines:
    print(line)
sys.exit(result.exit_code)`,
      );
    },
    runTs() {
      const lines: string[] = [];
      const result = verifyRequiredTools({
        platformId: "linux",
        probe: probeWith(new Set(["git", "uv", "python3", "gh", "apt-get"])),
        outputFn: (line) => {
          lines.push(line);
        },
      });
      return captureFromRun(result.exitCode, `${lines.join("\n")}\n`, "");
    },
  },
  {
    name: "verify-tools-missing-task",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("verify_tools", "scripts/verify_tools.py")}
available = {"git","uv","python3","gh","apt-get"}
def probe(c):
    return f"/usr/bin/{c}" if c in available else None
lines = []
result = mod.verify_required_tools(platform_id="linux", include_task=True, probe=probe, output_fn=lines.append)
for line in lines:
    print(line)
sys.exit(result.exit_code)`,
      );
    },
    runTs() {
      const lines: string[] = [];
      const result = verifyRequiredTools({
        platformId: "linux",
        includeTask: true,
        probe: probeWith(new Set(["git", "uv", "python3", "gh", "apt-get"])),
        outputFn: (line) => {
          lines.push(line);
        },
      });
      return captureFromRun(result.exitCode, `${lines.join("\n")}\n`, "");
    },
  },
  {
    name: "verify-tools-foundational-git-missing",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("verify_tools", "scripts/verify_tools.py")}
available = {"task","uv","python3","gh","apt-get"}
def probe(c):
    return f"/usr/bin/{c}" if c in available else None
result = mod.verify_required_tools(platform_id="linux", probe=probe)
sys.exit(result.exit_code)`,
      );
    },
    runTs() {
      const result = verifyRequiredTools({
        platformId: "linux",
        probe: probeWith(new Set(["task", "uv", "python3", "gh", "apt-get"])),
      });
      return captureFromRun(result.exitCode, "", "");
    },
  },
  {
    name: "verify-hooks-clean-deft-root",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("verify_hooks_installed", "scripts/verify_hooks_installed.py")}
code, msg = mod.evaluate(root)
print(msg, file=sys.stdout if code == 0 else sys.stderr)
sys.exit(code)`,
      );
    },
    runTs(deftRoot) {
      const result = evaluateHooks(deftRoot);
      if (result.stream === "stdout") {
        return captureFromRun(result.code, `${result.message}\n`, "");
      }
      return captureFromRun(result.code, "", `${result.message}\n`);
    },
  },
  {
    name: "verify-hooks-unset",
    runPython(deftRoot) {
      const fixture = mkdtempSync(join(tmpdir(), "deft-verify-env-hooks-unset-"));
      mkdirSync(fixture, { recursive: true });
      const cap = runPythonScript(
        deftRoot,
        `${loadModule("verify_hooks_installed", "scripts/verify_hooks_installed.py")}
code, msg = mod.evaluate(Path(${JSON.stringify(fixture)}))
print(msg, file=sys.stdout if code == 0 else sys.stderr)
sys.exit(code)`,
      );
      rmSync(fixture, { recursive: true, force: true });
      return cap;
    },
    runTs() {
      const fixture = mkdtempSync(join(tmpdir(), "deft-verify-env-hooks-unset-ts-"));
      const result = evaluateHooks(fixture, {
        gitConfigReader: () => ({ hooksPath: null, error: null }),
      });
      rmSync(fixture, { recursive: true, force: true });
      return captureFromRun(result.code, "", `${result.message}\n`);
    },
  },
  {
    name: "toolchain-empty-path",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("toolchain_check", "scripts/toolchain-check.py")}
from unittest.mock import patch
def fake_run(*args, **kwargs):
    raise FileNotFoundError(args[0][0])
with patch("subprocess.run", fake_run):
    sys.exit(mod.main())`,
      );
    },
    runTs() {
      const result = runToolchainCheck(() => ({ error: "not-found", message: "" }));
      return captureFromRun(result.exitCode, `${result.lines.join("\n")}\n`, "");
    },
  },
  {
    name: "verify-no-task-runtime-clean-deft-root",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("verify_no_task_runtime", "scripts/verify_no_task_runtime.py")}
sys.exit(mod.main())`,
      );
    },
    runTs(deftRoot) {
      const findings = scan({ root: deftRoot });
      const formatted = formatScanResult(findings);
      return captureFromRun(formatted.exitCode, formatted.stdout, formatted.stderr);
    },
  },
  {
    name: "verify-no-task-runtime-findings",
    runPython(deftRoot) {
      const fixture = makeNoTaskFixture(deftRoot);
      const cap = runPythonScript(
        deftRoot,
        `${loadModule("verify_no_task_runtime", "scripts/verify_no_task_runtime.py")}
fixture = Path(${JSON.stringify(fixture)})
mod.ROOT = fixture
mod._python_files = lambda: [fixture / "run", fixture / "scripts" / "probe.py"]
findings = mod.scan()
if not findings:
    print("No runtime go-task subprocess dependencies found")
    sys.exit(0)
print("Runtime go-task dependencies found:", file=sys.stderr)
for finding in findings:
    rel = finding.path.relative_to(mod.ROOT)
    print(f"  {rel}:{finding.line}: {finding.message}", file=sys.stderr)
sys.exit(1)`,
      );
      rmSync(fixture, { recursive: true, force: true });
      return cap;
    },
    runTs(deftRoot) {
      const fixture = makeNoTaskFixture(deftRoot);
      const findings = scan({
        root: fixture,
        pythonFiles: () => [join(fixture, "run"), join(fixture, "scripts", "probe.py")],
      });
      const formatted = formatScanResult(findings);
      rmSync(fixture, { recursive: true, force: true });
      return captureFromRun(formatted.exitCode, formatted.stdout, formatted.stderr);
    },
  },
];

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function diffCase(python: Capture, ts: Capture, name: string): ParityDiff {
  return {
    name,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: python.stdout !== ts.stdout,
    stderrMismatch: python.stderr !== ts.stderr,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
}

export function runParity(deftRoot = resolveDeftRoot()): ParityResult {
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    diffs.push(diffCase(testCase.runPython(deftRoot), testCase.runTs(deftRoot), testCase.name));
  }
  return {
    ok: diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch),
    diffs,
  };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `verify-env parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} case(s).`;
  }
  const lines = ["verify-env parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch) {
      lines.push(`  case: ${d.name}`);
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
    process.stderr.write(`verify-env parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
