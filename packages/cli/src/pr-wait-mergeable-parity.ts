#!/usr/bin/env node
/**
 * Golden-output parity harness (#1730): runs BOTH the Python oracle
 * (`scripts/pr_wait_mergeable.py`) and the ported TS CLI with a fake `gh`
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
    if "closingIssuesReferences" in joined:
        return "closing-refs"
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
    if "pr" in cmd and "merge" in cmd:
        return "merge"
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

function cleanJqBody(sha: string = HEAD_SHA, confidence: number = 5): string {
  return (
    "## Greptile Summary\n\n" +
    "No P0 or P1 issues found in this PR.\n\n" +
    `**Confidence Score: ${confidence}/5**\n\n` +
    "Last reviewed commit: [chore: small fix]" +
    `(https://github.com/deftai/directive/commit/${sha})\n`
  );
}

function greptileRestPayload(sha: string = HEAD_SHA, confidence: number = 5): string {
  return JSON.stringify([
    { user: { login: "greptile-apps[bot]" }, body: cleanJqBody(sha, confidence) },
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
  readonly stripGhRepo?: boolean;
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
    readonly stdoutMismatch: boolean;
    readonly stderrMismatch: boolean;
    readonly pythonStdout: string;
    readonly tsStdout: string;
    readonly pythonStderr: string;
    readonly tsStderr: string;
  }>;
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: "merged-clean-json",
    argv: ["1370", "--repo", "deftai/directive", "--json", "--cap-minutes", "60"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody() },
      merge: { returncode: 0, stdout: "merged via squash\n" },
    },
  },
  {
    name: "merged-clean-human",
    argv: ["1370", "--repo", "deftai/directive", "--cap-minutes", "60"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody() },
      merge: { returncode: 0, stdout: "merged via squash\n" },
    },
  },
  {
    name: "protected-link-json",
    argv: ["1370", "--repo", "deftai/directive", "--protected", "1119", "--json"],
    responses: {
      "closing-refs": { returncode: 0, stdout: closingRefsPayload(1119) },
    },
  },
  {
    name: "missing-repo-config-error",
    argv: ["1370", "--json"],
    responses: {},
    stripGhRepo: true,
  },
  {
    name: "cap-zero-timeout-json",
    argv: ["1370", "--repo", "deftai/directive", "--json", "--cap-minutes", "0"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody(HEAD_SHA, 3) },
    },
  },
  {
    name: "malformed-protected-config-error",
    argv: ["1370", "--repo", "deftai/directive", "--protected", "\u00b2"],
    responses: {},
  },
  {
    name: "sibling-merged-json",
    argv: ["1370", "--repo", "deftai/directive", "--json", "--cap-minutes", "60"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 1, stderr: "primary boom" },
      "comments-rest": { returncode: 1, stderr: "fallback1 boom" },
      "pr-view-rest": {
        returncode: 0,
        stdout: prRestPayload(HEAD_SHA, "closed", true),
      },
      "check-runs": { returncode: 0, stdout: checkRunsPayload() },
    },
  },
  {
    name: "merge-failed-escalation-json",
    argv: ["1370", "--repo", "deftai/directive", "--json", "--cap-minutes", "60"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody() },
      merge: { returncode: 1, stderr: "branch protection refused\n" },
    },
  },
  {
    name: "protected-clean-then-merged-json",
    argv: [
      "1370",
      "--repo",
      "deftai/directive",
      "--protected",
      "1119,1140",
      "--json",
      "--cap-minutes",
      "60",
    ],
    responses: {
      "closing-refs": { returncode: 0, stdout: closingRefsPayload(701) },
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 0, stdout: cleanJqBody() },
      merge: { returncode: 0, stdout: "merged via squash\n" },
    },
  },
  {
    name: "fallback1-clean-then-merged-json",
    argv: ["1363", "--repo", "deftai/directive", "--json", "--cap-minutes", "60"],
    responses: {
      "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
      "comments-jq": { returncode: 1, stderr: "decode-crash" },
      "comments-rest": { returncode: 0, stdout: greptileRestPayload() },
      merge: { returncode: 0, stdout: "merged via squash\n" },
    },
  },
];

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function installFakeGh(): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "deft-pr-wait-mergeable-fake-gh-"));
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

export function normaliseHarnessNoise(text: string): string {
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
  stdoutMismatch: boolean;
  stderrMismatch: boolean;
} {
  const pythonStdout = normaliseHarnessNoise(python.stdout);
  const tsStdout = normaliseHarnessNoise(ts.stdout);
  const pythonStderr = normaliseHarnessNoise(python.stderr);
  const tsStderr = normaliseHarnessNoise(ts.stderr);
  return {
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pythonStdout !== tsStdout,
    stderrMismatch: pythonStderr !== tsStderr,
  };
}

function runScenario(
  deftRoot: string,
  scenario: ParityScenario,
): { python: ScenarioResult; ts: ScenarioResult } {
  const fake = installFakeGh();
  try {
    const pathPrefix = `${fake.binDir}:${process.env.PATH ?? ""}`;
    const env: Record<string, string> = {
      DEFT_CACHE_DISABLE: "1",
      PYTHONUTF8: "1",
      PATH: pathPrefix,
      DEFT_FAKE_GH_RESPONSES: JSON.stringify(scenario.responses),
    };
    if (scenario.stripGhRepo) {
      delete env.GH_REPO;
    }
    const py = runCapture(
      "uv",
      ["run", "python", join(deftRoot, "scripts", "pr_wait_mergeable.py"), ...scenario.argv],
      deftRoot,
      env,
    );
    const ts = runCapture(
      "node",
      [join(deftRoot, "packages", "cli", "dist", "pr-wait-mergeable.js"), ...scenario.argv],
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
    const diff = diffParity(ran.python, ran.ts);
    scenarios.push({
      name: scenario.name,
      pythonExit: ran.python.exitCode,
      tsExit: ran.ts.exitCode,
      pythonStdout: normaliseHarnessNoise(ran.python.stdout),
      tsStdout: normaliseHarnessNoise(ran.ts.stdout),
      pythonStderr: normaliseHarnessNoise(ran.python.stderr),
      tsStderr: normaliseHarnessNoise(ran.ts.stderr),
      ...diff,
    });
  }
  const ok = scenarios.every((s) => !s.exitMismatch && !s.stdoutMismatch && !s.stderrMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `pr_wait_mergeable parity: CLEAN -- Python and TS agree on ${result.scenarios.length} scenario(s).`;
  }
  const lines = ["pr_wait_mergeable parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.stdoutMismatch || s.stderrMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
      if (s.stdoutMismatch) {
        lines.push("    stdout mismatch:");
        lines.push(`    python (${s.pythonStdout.length} bytes):`);
        lines.push(s.pythonStdout.slice(0, 500));
        lines.push(`    ts (${s.tsStdout.length} bytes):`);
        lines.push(s.tsStdout.slice(0, 500));
      }
      if (s.stderrMismatch) {
        lines.push("    stderr mismatch:");
        lines.push(`    python (${s.pythonStderr.length} bytes):`);
        lines.push(s.pythonStderr.slice(0, 500));
        lines.push(`    ts (${s.tsStderr.length} bytes):`);
        lines.push(s.tsStderr.slice(0, 500));
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
    process.stderr.write(`pr_wait_mergeable parity: harness error -- ${msg}\n`);
    process.exit(2);
  }
}
