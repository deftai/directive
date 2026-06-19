#!/usr/bin/env node
/**
 * Golden-diff parity harness (#1788): runs TS swarm cohort verbs vs the FROZEN
 * Python oracle (cache-off) across launch-manifest, worktree-map collision,
 * readiness three-state, and review-clean fixtures.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEAD_SHA = "abc1234567890def1234567890abcdef12345678";

const FAKE_GH_PY = `import json, os, sys
responses = json.loads(os.environ.get("DEFT_FAKE_GH_RESPONSES", "{}"))
cmd = " ".join(sys.argv[1:])
label = "unknown"
if "headRefOid" in cmd: label = "head-sha"
elif "/issues/" in cmd and "/comments" in cmd and "--jq" in cmd: label = "comments-jq"
resp = responses.get(label, {"returncode": 1, "stderr": f"unexpected: {label}", "stdout": ""})
if resp.get("stdout"): sys.stdout.write(resp["stdout"])
if resp.get("stderr"): sys.stderr.write(resp["stderr"])
sys.exit(int(resp.get("returncode", 0)))
`;

export interface Capture {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ParityCase {
  name: string;
  run: (deftRoot: string) => { python: Capture; ts: Capture };
}

function runCapture(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Capture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 2,
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

export function normalizeOutput(text: string): string {
  return text
    .replace(/--project-root [^\s]+/g, "--project-root <ROOT>")
    .replace(/--repo-root [^\s]+/g, "--repo-root <ROOT>")
    .replace(/\/tmp\/[^\s]+/g, "<TMP>")
    .replace(/\/home\/[^\s]+/g, "<PATH>")
    .trim()
    .replace(/\s+/g, " ");
}

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q", "-b", "master", repo], { encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "parity@test.local"], {
    cwd: repo,
    encoding: "utf8",
  });
  execFileSync("git", ["config", "user.name", "deft-parity"], { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, encoding: "utf8" });
}

function writeReadyStory(project: string, filename: string, storyId: string, issue: number): void {
  const full = join(project, "vbrief", "active", filename);
  mkdirSync(dirname(full), { recursive: true });
  const acceptanceValues = [
    `Given ${storyId} input, when the story runs, then it returns a scoped result.`,
    `Given ${storyId} failure input, when the story runs, then it rejects the request.`,
  ];
  const payload = {
    vBRIEFInfo: { version: "0.6" },
    plan: {
      id: storyId,
      title: storyId,
      status: "running",
      references: [
        {
          uri: `https://github.com/deftai/directive/issues/${issue}`,
          type: "x-vbrief/github-issue",
        },
      ],
      narratives: {
        Description: `${storyId} implements a focused product behavior for the active workflow. The story stays within a narrow code path and includes targeted tests for success and failure behavior.`,
        ImplementationPlan: `1. Update the ${storyId} source path to implement the focused workflow behavior.\n2. Add targeted tests for ${storyId} success and failure outcomes.`,
        Traces: "FR-1",
        UserStory: `As a product user, I want ${storyId} behavior, so that I can complete the workflow.`,
      },
      items: acceptanceValues.map((criterion, index) => ({
        id: `${storyId}-a${index + 1}`,
        title: `Acceptance item ${index + 1}`,
        status: "pending",
        narrative: { Acceptance: criterion, Traces: "FR-1" },
      })),
      metadata: {
        kind: "story",
        swarm: {
          readiness: "ready",
          parallel_safe: true,
          file_scope: [`src/${storyId}.ts`],
          verify_commands: [`npm test -- ${storyId}`],
          expected_outputs: ["focused tests pass"],
          depends_on: [],
          conflict_group: "auth",
          size: "small",
          file_scope_confidence: "high",
          model_tier: "medium",
        },
      },
    },
  };
  writeFileSync(full, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeProjectDef(project: string): void {
  const full = join(project, "vbrief", "PROJECT-DEFINITION.vbrief.json");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { policy: { swarmSubagentBackend: "grok-build" } } }, null, 2)}\n`,
    "utf8",
  );
}

function writeBlockedStory(project: string): void {
  const full = join(project, "vbrief", "active", "blocked.vbrief.json");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          id: "blocked-story",
          title: "blocked",
          status: "running",
          metadata: { kind: "story", swarm: { readiness: "not-ready" } },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function setupFakeGh(tmp: string): string {
  const fakeGh = join(tmp, "fake-gh");
  writeFileSync(fakeGh, FAKE_GH_PY, "utf8");
  chmodSync(fakeGh, 0o755);
  return fakeGh;
}

function cleanGreptileBody(sha: string = HEAD_SHA, confidence: number = 5): string {
  return (
    "## Greptile Summary\n\nNo P0 or P1 issues.\n\n" +
    `**Confidence Score: ${confidence}/5**\n\n` +
    `Last reviewed commit: [fix](https://github.com/deftai/directive/commit/${sha})\n`
  );
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "worktree-map-collision-reject",
    run: (deftRoot) => {
      const repo = mkdtempSync(join(tmpdir(), "swarm-wt-"));
      gitInit(repo);
      const mapPath = join(repo, "map.json");
      const wt = join(repo, "wt-shared");
      writeFileSync(
        mapPath,
        JSON.stringify([
          { story_id: "alpha", worktree_path: wt },
          { story_id: "beta", worktree_path: wt },
        ]),
        "utf8",
      );
      const pyArgs = [
        "run",
        "python",
        join(deftRoot, "scripts", "swarm_worktrees.py"),
        "--map",
        mapPath,
        "--base-branch",
        "master",
        "--repo-root",
        repo,
        "--no-create-missing",
      ];
      const tsArgs = [
        join(deftRoot, "packages", "core", "dist", "swarm", "worktrees-cli.js"),
        "--map",
        mapPath,
        "--base-branch",
        "master",
        "--repo-root",
        repo,
        "--no-create-missing",
      ];
      const python = runCapture("uv", pyArgs, deftRoot);
      const ts = runCapture("node", tsArgs, deftRoot);
      rmSync(repo, { recursive: true, force: true });
      return { python, ts };
    },
  },
  {
    name: "readiness-ready-story",
    run: (deftRoot) => {
      const project = mkdtempSync(join(tmpdir(), "swarm-ready-"));
      mkdirSync(join(project, "vbrief", "active"), { recursive: true });
      writeReadyStory(project, "ready.vbrief.json", "ready-a", 9001);
      const storyPath = join(project, "vbrief", "active", "ready.vbrief.json");
      const py = runCapture(
        "uv",
        [
          "run",
          "python",
          join(deftRoot, "scripts", "swarm_readiness.py"),
          storyPath,
          "--project-root",
          project,
        ],
        deftRoot,
      );
      const ts = runCapture(
        "node",
        [
          join(deftRoot, "packages", "core", "dist", "swarm", "readiness-cli.js"),
          storyPath,
          "--project-root",
          project,
        ],
        deftRoot,
      );
      rmSync(project, { recursive: true, force: true });
      return { python: py, ts };
    },
  },
  {
    name: "readiness-blocked-story",
    run: (deftRoot) => {
      const project = mkdtempSync(join(tmpdir(), "swarm-block-"));
      writeBlockedStory(project);
      const storyPath = join(project, "vbrief", "active", "blocked.vbrief.json");
      const py = runCapture(
        "uv",
        [
          "run",
          "python",
          join(deftRoot, "scripts", "swarm_readiness.py"),
          storyPath,
          "--project-root",
          project,
        ],
        deftRoot,
      );
      const ts = runCapture(
        "node",
        [
          join(deftRoot, "packages", "core", "dist", "swarm", "readiness-cli.js"),
          storyPath,
          "--project-root",
          project,
        ],
        deftRoot,
      );
      rmSync(project, { recursive: true, force: true });
      return { python: py, ts };
    },
  },
  {
    name: "review-clean-cohort-clean",
    run: (deftRoot) => {
      const tmp = mkdtempSync(join(tmpdir(), "swarm-rc-"));
      const fakeGh = setupFakeGh(tmp);
      const env = {
        ...process.env,
        PATH: `${dirname(fakeGh)}:${process.env.PATH ?? ""}`,
        DEFT_FAKE_GH_RESPONSES: JSON.stringify({
          "head-sha": { returncode: 0, stdout: `${HEAD_SHA}\n` },
          "comments-jq": { returncode: 0, stdout: cleanGreptileBody() },
        }),
      };
      const argv = ["1370", "--repo", "deftai/directive"];
      const py = runCapture(
        "uv",
        ["run", "python", join(deftRoot, "scripts", "swarm_verify_review_clean.py"), ...argv],
        deftRoot,
        env,
      );
      const ts = runCapture(
        "node",
        [
          join(deftRoot, "packages", "core", "dist", "swarm", "verify-review-clean-cli.js"),
          ...argv,
        ],
        deftRoot,
        env,
      );
      rmSync(tmp, { recursive: true, force: true });
      return { python: py, ts };
    },
  },
  {
    name: "launch-manifest-solo",
    run: (deftRoot) => {
      const project = mkdtempSync(join(tmpdir(), "swarm-launch-"));
      mkdirSync(join(project, "vbrief", "active"), { recursive: true });
      writeReadyStory(project, "solo.vbrief.json", "solo-a", 8801);
      writeProjectDef(project);
      const env = { ...process.env, DEFT_PROBE_GROK_BUILD: "yes" };
      const argv = ["--stories", "8801", "--project-root", project, "--autonomous"];
      const py = runCapture(
        "uv",
        ["run", "python", join(deftRoot, "scripts", "swarm_launch.py"), ...argv],
        deftRoot,
        env,
      );
      const ts = runCapture(
        "node",
        [join(deftRoot, "packages", "core", "dist", "swarm", "launch-cli.js"), ...argv],
        deftRoot,
        env,
      );
      rmSync(project, { recursive: true, force: true });
      return { python: py, ts };
    },
  },
];

export function diffCase(
  name: string,
  python: Capture,
  ts: Capture,
): {
  name: string;
  ok: boolean;
  exitMismatch: boolean;
  stdoutMismatch: boolean;
  stderrMismatch: boolean;
} {
  const pyStdout = normalizeOutput(python.stdout);
  const tsStdout = normalizeOutput(ts.stdout);
  const pyStderr = normalizeOutput(python.stderr);
  const tsStderr = normalizeOutput(ts.stderr);
  const exitMismatch = python.exitCode !== ts.exitCode;
  const stdoutMismatch = pyStdout !== tsStdout;
  const stderrMismatch = pyStderr !== tsStderr;
  return {
    name,
    ok: !exitMismatch && !stdoutMismatch && !stderrMismatch,
    exitMismatch,
    stdoutMismatch,
    stderrMismatch,
  };
}

export function runParity(): { ok: boolean; cases: ReturnType<typeof diffCase>[] } {
  const deftRoot = resolveDeftRoot();
  const cases = PARITY_CASES.map((c) => {
    const { python, ts } = c.run(deftRoot);
    return diffCase(c.name, python, ts);
  });
  return { ok: cases.every((c) => c.ok), cases };
}

export function runParityCli(): number {
  try {
    const result = runParity();
    if (result.ok) {
      process.stdout.write(
        `swarm parity: CLEAN -- Python and TS agree on ${result.cases.length} case(s).\n`,
      );
      return 0;
    }
    process.stderr.write("swarm parity: DIVERGENCE\n");
    for (const c of result.cases) {
      if (!c.ok) {
        process.stderr.write(`  case: ${c.name}\n`);
        if (c.exitMismatch) {
          process.stderr.write("    exit code mismatch\n");
        }
        if (c.stdoutMismatch) {
          process.stderr.write("    stdout mismatch\n");
        }
        if (c.stderrMismatch) {
          process.stderr.write("    stderr mismatch\n");
        }
      }
    }
    return 1;
  } catch (err) {
    process.stderr.write(`swarm parity: harness error -- ${String(err)}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runParityCli());
}
