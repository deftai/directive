#!/usr/bin/env node
/**
 * Golden-output parity harness (#1730): runs BOTH the Python oracle
 * (`scripts/pr_merge_readiness.py`) and the ported TS CLI with a fake `gh`
 * on PATH (cache-off), then diffs exit codes and byte-identical stdout/stderr.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEAD_SHA = "abc1234567890def1234567890abcdef12345678";

const FAKE_GH_PY = `import json
import os
import sys

def classify(cmd):
    joined = " ".join(cmd)
    if "nameWithOwner" in joined:
        return "repo-view"
    if "headRefOid" in joined:
        return "head-sha"
    if "/check-runs" in joined:
        return "check-runs"
    if "/pulls/" in joined and "/comments" not in joined:
        return "pr-view-rest"
    if "/issues/" in joined and "/comments" in joined and "--jq" in cmd:
        return "comments-jq"
    if "/issues/" in joined and "/comments" in joined:
        return "comments-rest"
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

function cleanJqBody(sha: string = HEAD_SHA, confidence: number = 5, extra = ""): string {
  return (
    "## Greptile Summary\n\n" +
    "No P0 or P1 issues found in this PR.\n\n" +
    `**Confidence Score: ${confidence}/5**\n\n` +
    "Last reviewed commit: [chore: small fix]" +
    `(https://github.com/deftai/directive/commit/${sha})\n` +
    extra
  );
}

function greptileRestPayload(
  sha: string = HEAD_SHA,
  confidence: number = 5,
  bodyExtra = "",
): string {
  return JSON.stringify([
    { user: { login: "greptile-apps[bot]" }, body: cleanJqBody(sha, confidence, bodyExtra) },
    { user: { login: "human-reviewer" }, body: "LGTM" },
  ]);
}

function prRestPayload(sha: string = HEAD_SHA, state = "open", merged = false): string {
  return JSON.stringify({
    state,
    merged,
    mergeable: true,
    mergeable_state: "clean",
    head: { sha, ref: "fix/foo" },
  });
}

function checkRunsPayload(): string {
  return JSON.stringify({
    total_count: 2,
    check_runs: [
      { name: "Greptile Review", status: "completed", conclusion: "success" },
      { name: "CI / build", status: "completed", conclusion: "success" },
    ],
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
  readonly compareStream?: "stdout" | "stderr";
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
    readonly stream: "stdout" | "stderr";
  }>;
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: "primary-clean-json",
    argv: ["1363", "--repo", "deftai/directive", "--json"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody() },
    },
  },
  {
    name: "primary-blocked-confidence-json",
    argv: ["1363", "--repo", "deftai/directive", "--json"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody(HEAD_SHA, 3) },
    },
  },
  {
    name: "fallback1-via-jq-fail-json",
    argv: ["1363", "--repo", "deftai/directive", "--json"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 1, stderr: "decode-crash" },
      "comments-rest": { returncode: 0, stdout: greptileRestPayload() },
    },
  },
  {
    name: "fallback2-never-clean-json",
    argv: ["1363", "--repo", "deftai/directive", "--json"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 1, stderr: "primary boom" },
      "comments-rest": { returncode: 1, stderr: "fallback1 boom" },
      "pr-view-rest": { returncode: 0, stdout: prRestPayload() },
      "check-runs": { returncode: 0, stdout: checkRunsPayload() },
    },
  },
  {
    name: "total-failure-error-json",
    argv: ["1363", "--repo", "deftai/directive", "--json"],
    responses: {
      "head-sha": { returncode: 1, stderr: "all-down" },
      "pr-view-rest": { returncode: 1, stderr: "all-down" },
    },
  },
  {
    name: "non-ascii-utf8-body-json",
    argv: ["1363", "--repo", "deftai/directive", "--json"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": {
        returncode: 0,
        stdout: cleanJqBody(HEAD_SHA, 5, "Review complete — no issues with smart “quotes”.\n"),
      },
    },
  },
  {
    name: "informal-clean-json",
    argv: ["1541", "--repo", "deftai/directive", "--json"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": {
        returncode: 0,
        stdout:
          "The review has completed — both previously flagged issues are now resolved.\n\n" +
          "The current diff is clean. No new issues to flag — looks solid. Good to proceed.\n",
      },
    },
  },
  {
    name: "primary-clean-human",
    argv: ["1363", "--repo", "deftai/directive"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody() },
    },
  },
];

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function installFakeGh(): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "deft-pr-merge-readiness-fake-gh-"));
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

export function pickOutput(result: ScenarioResult, stream: "stdout" | "stderr"): string {
  return stream === "stdout" ? result.stdout : result.stderr;
}

export function diffParity(
  python: ScenarioResult,
  ts: ScenarioResult,
  stream: "stdout" | "stderr",
): {
  exitMismatch: boolean;
  outputMismatch: boolean;
  pythonOutput: string;
  tsOutput: string;
} {
  const pythonOutput = normaliseHarnessNoise(pickOutput(python, stream));
  const tsOutput = normaliseHarnessNoise(pickOutput(ts, stream));
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
      ["run", "python", join(deftRoot, "scripts", "pr_merge_readiness.py"), ...scenario.argv],
      deftRoot,
      env,
    );
    const ts = runCapture(
      "node",
      [join(deftRoot, "packages", "cli", "dist", "pr-merge-readiness.js"), ...scenario.argv],
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
    const stream = scenario.compareStream ?? "stdout";
    scenarios.push({
      name: scenario.name,
      pythonExit: ran.python.exitCode,
      tsExit: ran.ts.exitCode,
      stream,
      ...diffParity(ran.python, ran.ts, stream),
    });
  }
  const ok = scenarios.every((s) => !s.exitMismatch && !s.outputMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `pr_merge_readiness parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["pr_merge_readiness parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.outputMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
      if (s.outputMismatch) {
        lines.push(`    stream: ${s.stream}`);
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
    process.stderr.write(`pr_merge_readiness parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
