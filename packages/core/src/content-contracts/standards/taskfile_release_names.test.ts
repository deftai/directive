import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";
import { blockBody, iterTaskBlocks } from "./_taskfile-helpers.js";

// Every `task` spawn in this file is bounded (#6862). A synchronous spawn cannot be
// interrupted by the vitest test timeout, so an unbounded one can hold the merge gate.
const TASK_SPAWN_LIMIT_MS = 30_000;

interface BoundedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

class SpawnTimeoutError extends Error {}

function runBounded(
  command: string,
  args: readonly string[],
  options: { cwd: string; limitMs?: number },
): BoundedRun {
  const limitMs = options.limitMs ?? TASK_SPAWN_LIMIT_MS;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, PYTHONUTF8: "1" },
    timeout: limitMs,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") {
    throw new SpawnTimeoutError(
      `\`${[command, ...args].join(" ")}\` exceeded the ${limitMs / 1000} s limit and was terminated`,
    );
  }
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runTask(args: readonly string[], cwd: string = repoRoot()): BoundedRun {
  return runBounded("task", args, { cwd });
}

// Only a missing `task` executable skips; a hung or failing probe fails the file.
const taskAvailable = (() => {
  try {
    runTask(["--version"]);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
})();

const CANONICAL = ["release", "release:e2e", "release:publish", "release:rollback"] as const;
const DOUBLED = [
  "release:release",
  "release:release:e2e",
  "release:release:publish",
  "release:release:rollback",
] as const;

type ListedTask = { name?: string; task?: string; desc?: string };
let listAllCache: ListedTask[] | undefined;

function listAllTasks(): ListedTask[] {
  if (listAllCache) {
    return listAllCache;
  }
  const run = runTask(["-t", join(repoRoot(), "Taskfile.yml"), "--list-all", "--json"]);
  expect(run.status, run.stderr).toBe(0);
  const parsed = JSON.parse(run.stdout) as { tasks?: ListedTask[] };
  listAllCache = parsed.tasks ?? [];
  return listAllCache;
}

function listAllTaskNames(): string[] {
  return listAllTasks()
    .map((entry) => entry.task ?? entry.name ?? "")
    .filter(Boolean);
}

/**
 * Return the YAML-quoted `ENGINE_CMD` literal of the `release` task, exactly as
 * written in `Taskfile.yml`. Throws when the task or its ENGINE_CMD is missing, so
 * the fixture never runs a copied command that has drifted from the real one.
 */
function readReleaseEngineCmd(taskfileText: string): string {
  const block = iterTaskBlocks(taskfileText).find((b) => b.name === "release");
  if (!block) {
    throw new Error("Taskfile.yml has no `release` task; the #2547 fixture cannot read ENGINE_CMD");
  }
  const body = blockBody(taskfileText, block.start, block.end);
  const match = body.match(/^\s*ENGINE_CMD:\s*('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s*$/m);
  if (!match?.[1]) {
    throw new Error("Taskfile.yml `release` task has no ENGINE_CMD; the #2547 fixture cannot run");
  }
  return match[1];
}

const fixtureDirs: string[] = [];

/**
 * Build a temp go-task project with copies of the real `tasks/engine.yml` and
 * `tasks/engine-invoke.cjs`, the real release ENGINE_CMD, and a stub `dist/bin.js`
 * that prints its argv as JSON. It has no `packages/` tree, so `engine:invoke`
 * takes its `dist/bin.js` branch: no build, no pin, no release pipeline.
 */
function buildReleaseFixture(): string {
  const root = repoRoot();
  const engineCmd = readReleaseEngineCmd(readFileSync(join(root, "Taskfile.yml"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "deft-release-fixture-"));
  fixtureDirs.push(dir);
  mkdirSync(join(dir, "tasks"));
  mkdirSync(join(dir, "dist"));
  copyFileSync(join(root, "tasks", "engine.yml"), join(dir, "tasks", "engine.yml"));
  copyFileSync(join(root, "tasks", "engine-invoke.cjs"), join(dir, "tasks", "engine-invoke.cjs"));
  writeFileSync(
    join(dir, "dist", "bin.js"),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
  );
  writeFileSync(
    join(dir, "Taskfile.yml"),
    [
      "version: '3'",
      "",
      "includes:",
      "  engine: ./tasks/engine.yml",
      "",
      "tasks:",
      "  release:",
      "    cmds:",
      "      - task: engine:invoke",
      "        vars:",
      `          ENGINE_CMD: ${engineCmd}`,
      "",
    ].join("\n"),
  );
  return dir;
}

function runFixtureRelease(cliArgs: readonly string[]): string[] {
  const dir = buildReleaseFixture();
  const run = runTask(["-t", join(dir, "Taskfile.yml"), "release", "--", ...cliArgs], dir);
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  const argvLine = run.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("["));
  expect(argvLine, run.stdout).toBeDefined();
  return JSON.parse(argvLine ?? "[]") as string[];
}

afterAll(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("test_taskfile_release_names.py", () => {
  it.skipIf(!taskAvailable)("test_canonical_release_task_names_installed", () => {
    const names = listAllTaskNames();
    const missing = CANONICAL.filter((n) => !names.includes(n));
    expect(missing).toEqual([]);
  });

  it.skipIf(!taskAvailable)("test_doubled_release_prefix_names_not_installed", () => {
    const names = new Set(listAllTaskNames());
    const offenders = DOUBLED.filter((n) => names.has(n));
    expect(offenders).toEqual([]);
  });

  it.skipIf(!taskAvailable)("test_release_task_desc_documents_allow_vbrief_drift (#3752)", () => {
    const release = listAllTasks().find((entry) => entry.task === "release");
    expect(release?.desc ?? "").toContain("--allow-vbrief-drift");
  });

  // Dispatch coverage only (#6862): the fixture proves `--help` reaches the CLI
  // after `release`; the help text itself is covered in-process by
  // packages/core/src/release/flags.test.ts.
  it.skipIf(!taskAvailable)("test_task_release_help_dispatch_reaches_cli (fixture)", () => {
    const argv = runFixtureRelease(["--help"]);
    expect(argv[0]).toBe("release");
    expect(argv).toContain("--help");
  });

  // #2547: go-task renders ENGINE_CMD, engine.yml carries it as JSON, and
  // engine-invoke.cjs splits it. A single-quote wrap of ENGINE_CMD in the invoke
  // script (the pre-#2547 shape) breaks on the apostrophe and fails this test.
  it.skipIf(!taskAvailable)(
    "test_task_release_summary_with_apostrophe_does_not_shell_parse_fail (#2547)",
    () => {
      const argv = runFixtureRelease(["0.0.0", "--dry-run", "--summary", "test what's next"]);
      expect(argv[0]).toBe("release");
      const at = argv.indexOf("--summary");
      expect(at).toBeGreaterThan(0);
      expect(argv[at + 1]).toBe("test what's next");
    },
  );

  it("test_release_fixture_requires_release_task_and_engine_cmd", () => {
    expect(() =>
      readReleaseEngineCmd("version: '3'\ntasks:\n  build:\n    cmds: [echo]\n"),
    ).toThrow(/no `release` task/);
    expect(() =>
      readReleaseEngineCmd("version: '3'\ntasks:\n  release:\n    cmds:\n      - echo hi\n"),
    ).toThrow(/no ENGINE_CMD/);
    expect(
      readReleaseEngineCmd(
        "version: '3'\ntasks:\n  release:\n    cmds:\n      - task: engine:invoke\n        vars:\n          ENGINE_CMD: 'release {{.CLI_ARGS}}'\n",
      ),
    ).toBe("'release {{.CLI_ARGS}}'");
  });

  // The CI hang left a process holding the output pipe (#6862). The bounded runner
  // must still return at its limit, with a message naming the command and the limit.
  // POSIX only: on Windows, spawnSync returns when the child exits, so the held-pipe
  // shape does not occur there.
  it.skipIf(process.platform === "win32")(
    "test_bounded_runner_returns_when_a_grandchild_holds_the_output_pipe",
    () => {
      const child = [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit' });",
        "process.exit(0);",
      ].join(" ");
      const started = Date.now();
      let error: unknown;
      try {
        runBounded(process.execPath, ["-e", child], { cwd: repoRoot(), limitMs: 1500 });
      } catch (err) {
        error = err;
      }
      const elapsed = Date.now() - started;
      expect(error).toBeInstanceOf(SpawnTimeoutError);
      expect(String((error as Error).message)).toMatch(
        /exceeded the 1\.5 s limit and was terminated/,
      );
      expect(elapsed).toBeLessThan(4500);
    },
  );
});
