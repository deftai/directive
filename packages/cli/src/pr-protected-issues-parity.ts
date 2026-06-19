#!/usr/bin/env node
/**
 * Golden-output parity harness (#1730): runs BOTH the Python oracle
 * (`scripts/pr_check_protected_issues.py`) and the ported TS CLI with a fake `gh`
 * on PATH (cache-off), then diffs exit codes and byte-identical stderr.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_GH_PY = `import json
import os
import sys

def classify(cmd):
    joined = " ".join(cmd)
    if "closingIssuesReferences" in joined:
        return "closing-refs"
    return "unknown"

responses = json.loads(os.environ.get("DEFT_FAKE_GH_RESPONSES", "{}"))
label = classify(sys.argv[1:])
resp = responses.get(label, {"returncode": 1, "stderr": f"unexpected gh call: {label}", "stdout": ""})
stdout = resp.get("stdout", "")
stderr = resp.get("stderr", "")
if stdout:
    sys.stdout.write(stdout)
if stderr:
    sys.stderr.write(stderr)
sys.exit(int(resp.get("returncode", 0)))
`;

function closingRefsPayload(...issueNumbers: number[]): string {
  return JSON.stringify({
    closingIssuesReferences: issueNumbers.map((n) => ({
      number: n,
      title: `Issue #${n}`,
      url: `https://example/issues/${n}`,
    })),
  });
}

export interface FakeGhResponses {
  readonly [label: string]: {
    readonly returncode: number;
    readonly stdout?: string;
    readonly stderr?: string;
  };
}

export interface ParityScenario {
  readonly name: string;
  readonly argv: readonly string[];
  readonly responses: FakeGhResponses;
}

export interface ScenarioResult {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly scenarios: Array<{
    readonly name: string;
    readonly exitMismatch: boolean;
    readonly pythonExit: number;
    readonly tsExit: number;
    readonly outputMismatch: boolean;
    readonly pythonOutput: string;
    readonly tsOutput: string;
  }>;
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: "skip-no-protected",
    argv: ["701"],
    responses: {},
  },
  {
    name: "allow-clean-no-overlap",
    argv: ["701", "--protected", "167,698,642"],
    responses: {
      "closing-refs": { returncode: 0, stdout: closingRefsPayload(701) },
    },
  },
  {
    name: "refuse-protected-overlap",
    argv: ["401", "--protected", "642"],
    responses: {
      "closing-refs": { returncode: 0, stdout: closingRefsPayload(642) },
    },
  },
  {
    name: "allow-multi-protected-flags",
    argv: ["701", "--protected", "642", "--protected", "167,698"],
    responses: {
      "closing-refs": { returncode: 0, stdout: closingRefsPayload(701) },
    },
  },
  {
    name: "refuse-multi-protected-flags",
    argv: ["701", "--protected", "642", "--protected", "167,698"],
    responses: {
      "closing-refs": { returncode: 0, stdout: closingRefsPayload(167) },
    },
  },
];

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function installFakeGh(): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "deft-pr-protected-issues-fake-gh-"));
  const ghBin = join(binDir, "gh");
  const ghxBin = join(binDir, "ghx");
  writeFileSync(ghBin, `#!/usr/bin/env python3\n${FAKE_GH_PY}`, "utf8");
  writeFileSync(ghxBin, `#!/usr/bin/env python3\n${FAKE_GH_PY}`, "utf8");
  chmodSync(ghBin, 0o755);
  chmodSync(ghxBin, 0o755);
  return {
    binDir,
    cleanup: () => {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
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

export function diffParity(
  python: ScenarioResult,
  ts: ScenarioResult,
): {
  exitMismatch: boolean;
  outputMismatch: boolean;
  pythonOutput: string;
  tsOutput: string;
} {
  const pythonOutput = normaliseHarnessNoise(python.stderr);
  const tsOutput = normaliseHarnessNoise(ts.stderr);
  return {
    exitMismatch: python.exitCode !== ts.exitCode,
    outputMismatch: pythonOutput !== tsOutput,
    pythonOutput,
    tsOutput,
  };
}

function runScenario(
  deftRoot: string,
  scenario: ParityScenario,
): { python: ScenarioResult; ts: ScenarioResult } {
  const fake = installFakeGh();
  try {
    const pathPrefix = `${fake.binDir}:${process.env.PATH ?? ""}`;
    const env = {
      DEFT_CACHE_DISABLE: "1",
      PYTHONUTF8: "1",
      PATH: pathPrefix,
      DEFT_FAKE_GH_RESPONSES: JSON.stringify(scenario.responses),
    };
    const py = runCapture(
      "uv",
      [
        "run",
        "python",
        join(deftRoot, "scripts", "pr_check_protected_issues.py"),
        ...scenario.argv,
      ],
      deftRoot,
      env,
    );
    const ts = runCapture(
      "node",
      [join(deftRoot, "packages", "cli", "dist", "pr-protected-issues.js"), ...scenario.argv],
      deftRoot,
      env,
    );
    return {
      python: {
        name: scenario.name,
        exitCode: py.status,
        stdout: py.stdout,
        stderr: py.stderr,
      },
      ts: {
        name: scenario.name,
        exitCode: ts.status,
        stdout: ts.stdout,
        stderr: ts.stderr,
      },
    };
  } finally {
    fake.cleanup();
  }
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const scenarios: ParityResult["scenarios"] = [];
  for (const scenario of PARITY_SCENARIOS) {
    const ran = runScenario(deftRoot, scenario);
    scenarios.push({
      name: scenario.name,
      pythonExit: ran.python.exitCode,
      tsExit: ran.ts.exitCode,
      ...diffParity(ran.python, ran.ts),
    });
  }
  const ok = scenarios.every((s) => !s.exitMismatch && !s.outputMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `pr_check_protected_issues parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["pr_check_protected_issues parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.outputMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
      if (s.outputMismatch) {
        lines.push(`    stderr:`);
        lines.push(`    python (${s.pythonOutput.length} bytes):`);
        lines.push(s.pythonOutput.slice(0, 500));
        lines.push(`    ts (${s.tsOutput.length} bytes):`);
        lines.push(s.tsOutput.slice(0, 500));
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
    process.stderr.write(`pr_check_protected_issues parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
