import { execFileSync, spawnSync as execSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENFORCE_NOOP_NOTICE,
  formatGitTimeoutRemedy,
  PHASE_LINE_PREFIX,
  parseArgs,
  reportExtraPaths,
  reportMintLevelAdmits,
  resolveForgeContext,
  run,
} from "./verify-scope-provenance.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-prov-cli-"));
  git(root, ["init", "-q"]);
  git(root, ["checkout", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  return root;
}

function writeTracked(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  git(root, ["add", "--", rel]);
}

function commit(root: string, msg: string): void {
  git(root, ["commit", "-q", "-m", msg, "--allow-empty"]);
}

function xbrief(title: string, fileScope: readonly string[]): string {
  return `${JSON.stringify(
    {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-1",
        status: "running",
        title,
        metadata: { swarm: { file_scope: [...fileScope] } },
      },
    },
    null,
    2,
  )}\n`;
}

function captureRun(argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    stdout += String(c);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    stderr += String(c);
    return true;
  });
  try {
    // Pin a non-merge_group event so a merge_group CI lane still runs the check (#6295).
    return { code: run(argv, { ...process.env, GITHUB_EVENT_NAME: "" }), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("verify-scope-provenance CLI (#3145 / #5057)", () => {
  const roots: string[] = [];

  // CI sets GITHUB_PR_NUMBER for the merge gate; keep these runs off the
  // live forge (#6203).
  beforeEach(() => {
    vi.stubEnv("GITHUB_PR_NUMBER", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses base-ref and enforce", () => {
    const a = parseArgs(["--project-root=.", "--base-ref", "HEAD", "--enforce"]);
    expect(a.error).toBeUndefined();
    expect(a.baseRef).toBe("HEAD");
    expect(a.enforce).toBe(true);
    expect(a.enforcePresent).toBe(true);
  });

  it("keeps --enforce parsed; later --warn wins the boolean (#5057)", () => {
    const a = parseArgs(["--enforce", "--warn"]);
    expect(a.error).toBeUndefined();
    expect(a.enforce).toBe(false);
    expect(a.enforcePresent).toBe(true);
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--bad"]).error).toMatch(/unrecognized/);
  });

  it("parses --pr / --repo for the forge-approval admit (#6203)", () => {
    const a = parseArgs(["--pr", "6203", "--repo", "deftai/directive"]);
    expect(a.error).toBeUndefined();
    expect(a.prNumber).toBe(6203);
    expect(a.repo).toBe("deftai/directive");
    const b = parseArgs(["--pr=12", "--repo=o/r"]);
    expect(b.prNumber).toBe(12);
    expect(b.repo).toBe("o/r");
    expect(parseArgs(["--pr", "abc"]).error).toMatch(/--pr/);
    expect(parseArgs(["--pr", "0"]).error).toMatch(/--pr/);
    expect(parseArgs(["--pr"]).error).toMatch(/--pr/);
    expect(parseArgs(["--repo"]).error).toMatch(/--repo/);
    expect(captureRun(["--pr", "x1"]).code).toBe(2);
  });

  it("resolves forge context from flags, then GITHUB_PR_NUMBER / GITHUB_REPOSITORY (#6203)", () => {
    const none = parseArgs([]);
    expect(resolveForgeContext(none, {})).toBeNull();
    expect(resolveForgeContext(none, { GITHUB_PR_NUMBER: "" })).toBeNull();
    expect(resolveForgeContext(none, { GITHUB_PR_NUMBER: "12abc" })).toBeNull();
    expect(resolveForgeContext(none, { GITHUB_PR_NUMBER: "77", GITHUB_REPOSITORY: "o/r" })).toEqual(
      { prNumber: 77, repo: "o/r" },
    );
    expect(resolveForgeContext(none, { GITHUB_PR_NUMBER: "77" })).toEqual({
      prNumber: 77,
      repo: null,
    });
    const flags = parseArgs(["--pr", "5", "--repo", "a/b"]);
    expect(
      resolveForgeContext(flags, { GITHUB_PR_NUMBER: "77", GITHUB_REPOSITORY: "o/r" }),
    ).toEqual({ prNumber: 5, repo: "a/b" });
  });

  it("task description no longer teaches fail-closed --enforce or missing digests warn (#5057)", () => {
    const yml = readFileSync(join(repoRoot, "tasks/verify.yml"), "utf8");
    const block = yml.split("\n  scope-provenance:\n")[1]?.split("\n  ")[0] ?? "";
    expect(block).toMatch(/desc:/);
    expect(block).not.toMatch(/pass --enforce to fail closed/i);
    expect(block).not.toMatch(/missing digests warn/i);
    expect(block).toMatch(/does not change the exit code/);
  });

  it("prints the --enforce no-op notice on clean, including --quiet (#5057)", () => {
    const root = initRepo();
    roots.push(root);
    writeTracked(root, "README.md", "seed\n");
    commit(root, "seed");
    git(root, ["branch", "base"]);

    const plain = captureRun(["--project-root", root, "--base-ref", "base", "--enforce"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(/clean/i);
    expect(plain.stderr).toContain(ENFORCE_NOOP_NOTICE);
    expect(plain.stderr).not.toMatch(/pass --enforce to fail closed/);

    const quiet = captureRun([
      "--project-root",
      root,
      "--base-ref",
      "base",
      "--enforce",
      "--quiet",
    ]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toContain(ENFORCE_NOOP_NOTICE);
  });

  it("prints the --enforce no-op notice on WARN with identical exit 0 (#5057)", () => {
    const root = initRepo();
    roots.push(root);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      xbrief("old", ["packages/core/src/scope-provenance/evaluate.ts"]),
    );
    commit(root, "base brief");
    git(root, ["branch", "base"]);
    git(root, ["checkout", "-q", "-b", "impl"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      xbrief("changed", ["packages/core/src/scope-provenance/evaluate.ts"]),
    );
    commit(root, "title edit");

    const off = captureRun(["--project-root", root, "--base-ref", "base"]);
    const on = captureRun(["--project-root", root, "--base-ref", "base", "--enforce"]);
    expect(off.code).toBe(0);
    expect(on.code).toBe(0);
    expect(off.code).toBe(on.code);
    expect(off.stdout).toMatch(/WARN/i);
    expect(on.stdout).toMatch(/WARN/i);
    expect(off.stdout).not.toMatch(/--enforce/);
    expect(on.stdout).not.toMatch(/--enforce/);
    expect(off.stderr).not.toContain(ENFORCE_NOOP_NOTICE);
    expect(on.stderr).toContain(ENFORCE_NOOP_NOTICE);

    const quiet = captureRun([
      "--project-root",
      root,
      "--base-ref",
      "base",
      "--enforce",
      "--quiet",
    ]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toContain(ENFORCE_NOOP_NOTICE);
  });

  it("admits one undeclared test modify and lists it with class and spend (#6221)", () => {
    const root = initRepo();
    roots.push(root);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      xbrief("story", ["packages/core/src/a.ts"]),
    );
    writeTracked(root, "packages/core/src/a.ts", "export const a = 1;\n");
    writeTracked(root, "packages/core/src/other.test.ts", "// old\n");
    commit(root, "base");
    git(root, ["branch", "base"]);
    git(root, ["checkout", "-q", "-b", "impl"]);
    writeTracked(root, "packages/core/src/a.ts", "export const a = 2;\n");
    writeTracked(root, "packages/core/src/other.test.ts", "// fixed\n");
    commit(root, "fix");

    const ok = captureRun(["--project-root", root, "--base-ref", "base"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("extra paths for xbrief/active/story.xbrief.json");
    expect(ok.stdout).toContain("packages/core/src/other.test.ts class=test spend=spent");

    // A new undeclared test file warns for one release (#6281): exit 0 and the
    // declared line names the row, the path and the remedy.
    writeTracked(root, "packages/core/src/new.test.ts", "// new\n");
    commit(root, "add test");
    const warned = captureRun(["--project-root", root, "--base-ref", "base"]);
    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain("deft gate extra-path-not-admitted");
    expect(warned.stdout).toContain("packages/core/src/new.test.ts");
    expect(warned.stdout).toContain("can refuse from a later release");
  });

  it("prints the declaration-hides-axis line on exit 0, active and completed (#6591)", () => {
    const root = initRepo();
    roots.push(root);
    const active = "xbrief/active/2026-11-18-story.xbrief.json";
    const done = "xbrief/completed/2026-11-18-story.xbrief.json";
    const story = (item: Record<string, unknown>): string => {
      const payload = JSON.parse(xbrief("story", ["packages/core/src/a.ts"])) as {
        plan: Record<string, unknown>;
      };
      payload.plan.items = [
        { id: "clause.1", title: "Deploy to staging and confirm the site serves it", ...item },
      ];
      return `${JSON.stringify(payload, null, 2)}\n`;
    };
    writeTracked(root, active, story({}));
    commit(root, "base");
    git(root, ["branch", "base"]);
    git(root, ["checkout", "-q", "-b", "impl"]);
    writeTracked(root, active, story({ "x-directive/requires": "merge" }));
    commit(root, "declare merge after activation");

    // The brief stays in active/: the line prints after the intent-pin WARN.
    const stays = captureRun(["--project-root", root, "--base-ref", "base"]);
    expect(stays.code).toBe(0);
    expect(stays.stdout).toMatch(/WARN \d+ intent-pin finding\(s\)/);
    expect(stays.stdout).toContain("deft gate declaration-hides-axis ");
    expect(stays.stdout).toContain(`${active} item clause.1: its declaration hides deploy`);

    // The same edit in the move to completed/: clean, and the line still prints.
    git(root, ["rm", "-q", "--", active]);
    writeTracked(root, done, story({ "x-directive/requires": "merge" }));
    commit(root, "move to completed");
    const moved = captureRun(["--project-root", root, "--base-ref", "base"]);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toMatch(/verify_scope_provenance: clean/);
    expect(moved.stdout).toContain(`${done} item clause.1: its declaration hides deploy`);
  });

  // Windows dest worktrees: one git show per lifecycle brief (~1800) is ~200ms
  // each here (~6 min serial); suite load pushes past the 240s win32 project
  // default. Do not undercut with a tighter per-it timeout (#5391 lane flake).
  it("runs against framework root", { timeout: 900_000 }, () => {
    // Exit 2 is config/network (e.g. PR-aware base resolution) — still a successful CLI smoke.
    const code = run(["--project-root", ".", "--quiet", "--base-ref", "HEAD"]);
    expect([0, 1, 2]).toContain(code);
  });
});

describe("mint-level admit visibility (#6273)", () => {
  const ADMIT = {
    planId: "story-6273",
    xbriefRelPath: "xbrief/active/story.xbrief.json",
    fileScope: ["packages/core/src/feature.ts", "packages/core/src/feature.test.ts"],
    productionFileCount: 1,
    humanMerge: true,
  };
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function capture(fn: () => void): { stdout: string; stderr: string } {
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      stdout += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      stderr += String(c);
      return true;
    });
    fn();
    vi.restoreAllMocks();
    return { stdout, stderr };
  }

  it("prints the plan id, admitted file_scope, production count and the CI limit line", () => {
    const { stdout } = capture(() => reportMintLevelAdmits([ADMIT], {}));
    expect(stdout).toContain("plan id: story-6273");
    expect(stdout).toContain("- packages/core/src/feature.ts");
    expect(stdout).toContain("production files: 1");
    expect(stdout).toContain("merge-base requireHumanMerge: true");
    expect(stdout).toContain(
      "CI cannot tell this mint from a file an agent wrote; the human merge is the control",
    );
  });

  it("prints the local mint gate and write fence control without a human merge (#6354)", () => {
    const { stdout } = capture(() => reportMintLevelAdmits([{ ...ADMIT, humanMerge: false }], {}));
    expect(stdout).toContain("plan id: story-6273");
    expect(stdout).toContain("merge-base requireHumanMerge: not true");
    expect(stdout).toContain("CI verifies nothing human");
    expect(stdout).toContain("the control is the local mint gate and the write fence");
    expect(stdout).not.toContain("the human merge is the control");
  });

  it("appends the same block to $GITHUB_STEP_SUMMARY when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-prov-summary-"));
    dirs.push(dir);
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "# prior step\n", "utf8");
    const { stdout } = capture(() =>
      reportMintLevelAdmits([ADMIT], { GITHUB_STEP_SUMMARY: summary }),
    );
    const written = readFileSync(summary, "utf8");
    expect(written.startsWith("# prior step\n")).toBe(true);
    expect(written).toContain(stdout);
    expect(written).toContain("```text");
  });

  it("writes nothing without an admit, and a summary write failure keeps going", () => {
    const none = capture(() => reportMintLevelAdmits([], { GITHUB_STEP_SUMMARY: "/nope/x.md" }));
    expect(none.stdout).toBe("");
    const dir = mkdtempSync(join(tmpdir(), "scope-prov-summary-bad-"));
    dirs.push(dir);
    const bad = capture(() =>
      reportMintLevelAdmits([ADMIT], { GITHUB_STEP_SUMMARY: join(dir, "missing", "x.md") }),
    );
    expect(bad.stdout).toContain("plan id: story-6273");
    expect(bad.stderr).toContain("GITHUB_STEP_SUMMARY");
  });
});

describe("extra-path success report (#6221)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("prints the lines, appends them to the step summary, and writes nothing when empty", () => {
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      stdout += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      stderr += String(c);
      return true;
    });
    const dir = mkdtempSync(join(tmpdir(), "scope-prov-extra-"));
    dirs.push(dir);
    const summary = join(dir, "summary.md");
    reportExtraPaths([], { GITHUB_STEP_SUMMARY: summary });
    expect(stdout).toBe("");
    reportExtraPaths(["line one", "  - a class=test spend=spent"], {
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(stdout).toBe("line one\n  - a class=test spend=spent\n");
    expect(readFileSync(summary, "utf8")).toContain("```text\nline one\n");
    reportExtraPaths(["x"], { GITHUB_STEP_SUMMARY: join(dir, "missing", "s.md") });
    expect(stderr).toContain("GITHUB_STEP_SUMMARY");
  });
});

describe("verify:scope-provenance on merge_group (#6295)", () => {
  it("skips with exit 0 and never parses arguments", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // An invalid flag would exit 2 if the check ran.
    expect(run(["--nope"], { GITHUB_EVENT_NAME: "merge_group" })).toBe(0);
    expect(stdout.mock.calls.join("")).toContain("verify:scope-provenance: skipped on merge_group");
    stdout.mockRestore();
  });

  it("still runs on pull_request", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--nope"], { GITHUB_EVENT_NAME: "pull_request" })).toBe(2);
    stderr.mockRestore();
  });
});

describe("phase lines and per-call git limit (#6378)", () => {
  const roots: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_EVENT_NAME: "", GITHUB_PR_NUMBER: "" };
  delete env.DEFT_SCOPE_PROVENANCE_GIT_TIMEOUT_SECONDS;

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  /** Repo whose base holds lifecycle briefs, so every phase runs. */
  function fixture(): string {
    const root = initRepo();
    roots.push(root);
    writeTracked(root, "xbrief/active/story.xbrief.json", xbrief("t", ["src/a.ts"]));
    writeTracked(
      root,
      "xbrief/completed/old.xbrief.json",
      xbrief("old", []).replace("story-1", "old-1"),
    );
    writeTracked(root, "src/a.ts", "export const a = 1;\n");
    commit(root, "base");
    git(root, ["branch", "base"]);
    git(root, ["checkout", "-q", "-b", "impl"]);
    writeTracked(root, "src/a.ts", "export const a = 2;\n");
    commit(root, "change");
    return root;
  }

  type Spawn = NonNullable<NonNullable<Parameters<typeof run>[2]>["gitSpawn"]>;

  /** Records phase lines and git calls in one ordered log. */
  function harness(
    rewrite?: (args: readonly string[], timeout: number | undefined) => "timeout" | null,
  ) {
    const log: string[] = [];
    const stderrSync: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const gitSpawn: Spawn = (cmd, args, options) => {
      log.push(`git ${args.join(" ")}`);
      timeouts.push(options.timeout);
      if (rewrite?.(args, options.timeout) === "timeout") {
        const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
        return {
          pid: 1,
          output: [],
          stdout: "",
          stderr: "",
          status: null,
          signal: "SIGKILL",
          error,
        };
      }
      return execSpawn(cmd, [...args], options);
    };
    const writeStderrSync = (text: string): void => {
      stderrSync.push(text);
      if (text.startsWith(PHASE_LINE_PREFIX)) log.push(text.trim());
    };
    return { log, stderrSync, timeouts, seams: { gitSpawn, writeStderrSync } };
  }

  function captured(fn: () => number): { code: number; stdout: string; stderr: string } {
    let stdout = "";
    let stderr = "";
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      stdout += String(c);
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      stderr += String(c);
      return true;
    });
    try {
      return { code: fn(), stdout, stderr };
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  }

  it("parses --git-timeout-seconds", () => {
    expect(parseArgs(["--git-timeout-seconds", "300"]).gitTimeoutSeconds).toBe(300);
    expect(parseArgs(["--git-timeout-seconds=0"]).gitTimeoutSeconds).toBe(0);
    expect(parseArgs([]).gitTimeoutSeconds).toBeNull();
    expect(parseArgs(["--git-timeout-seconds", "x"]).error).toMatch(/whole number of seconds/);
    expect(parseArgs(["--git-timeout-seconds"]).error).toMatch(/whole number of seconds/);
  });

  it("prints the remedy as the run's own argv with a larger limit", () => {
    expect(
      formatGitTimeoutRemedy(
        [
          "--project-root",
          "C:/a b",
          "--git-timeout-seconds",
          "30",
          "--git-timeout-seconds=60",
          "--quiet",
        ],
        240,
      ),
    ).toBe(
      "deft verify:scope-provenance --project-root 'C:/a b' --quiet --git-timeout-seconds 240",
    );
  });

  it("keeps dollar signs, backticks and quotes literal in the printed remedy", () => {
    const remedy = formatGitTimeoutRemedy(["--project-root", "/tmp/$cash/`x`/it's"], 240);
    expect(remedy).toBe(
      "deft verify:scope-provenance --project-root '/tmp/$cash/`x`/it''s' --git-timeout-seconds 240",
    );
  });

  it("writes each phase line before that phase starts", { timeout: 120_000 }, () => {
    const root = fixture();
    const h = harness();
    const r = captured(() => run(["--project-root", root, "--base-ref", "base"], env, h.seams));
    expect(r.code).toBe(0);
    const at = (needle: string): number => h.log.findIndex((l) => l.startsWith(needle));
    const phase = (name: string): number => h.log.indexOf(`${PHASE_LINE_PREFIX}${name}`);
    expect(phase("base resolution")).toBe(0);
    expect(phase("change-set read")).toBeGreaterThan(0);
    expect(phase("change-set read")).toBeLessThan(at("git diff"));
    const census = h.log.findIndex((l) => l.startsWith(`${PHASE_LINE_PREFIX}census (`));
    expect(h.log[census]).toBe(`${PHASE_LINE_PREFIX}census (2 briefs)`);
    expect(census).toBeLessThan(at("git cat-file --batch-check"));
    expect(phase("per-story evaluation")).toBeGreaterThan(phase("change-set read"));
    expect(h.stderrSync.filter((l) => l.startsWith(PHASE_LINE_PREFIX))).toHaveLength(4);
    expect(r.stdout).toMatch(/clean/);
  });

  it("resolves the live delegation for the fence from the project root (#7420 B4)", {
    timeout: 120_000,
  }, () => {
    const root = fixture();
    const h = harness();
    const seen: string[] = [];
    const r = captured(() =>
      run(["--project-root", root, "--base-ref", "base", "--quiet"], env, {
        ...h.seams,
        readLiveDelegation: (projectRoot: string) => {
          seen.push(projectRoot);
          return null;
        },
      }),
    );
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("writes no phase line with --quiet", { timeout: 120_000 }, () => {
    const root = fixture();
    const h = harness();
    const r = captured(() =>
      run(["--project-root", root, "--base-ref", "base", "--quiet"], env, h.seams),
    );
    expect(r.code).toBe(0);
    expect(h.stderrSync.filter((l) => l.startsWith(PHASE_LINE_PREFIX))).toEqual([]);
  });

  it("gives every git call 120 s by default, the flag over the variable, and no limit for 0", {
    timeout: 240_000,
  }, () => {
    const root = fixture();
    const args = ["--project-root", root, "--base-ref", "base", "--quiet"];
    const base = harness();
    captured(() => run(args, env, base.seams));
    expect(base.timeouts.length).toBeGreaterThan(0);
    expect(new Set(base.timeouts)).toEqual(new Set([120_000]));

    const withVar = { ...env, DEFT_SCOPE_PROVENANCE_GIT_TIMEOUT_SECONDS: "60" };
    const both = harness();
    captured(() => run([...args, "--git-timeout-seconds", "300"], withVar, both.seams));
    expect(new Set(both.timeouts)).toEqual(new Set([300_000]));

    const fromEnv = harness();
    captured(() => run(args, withVar, fromEnv.seams));
    expect(new Set(fromEnv.timeouts)).toEqual(new Set([60_000]));

    const none = harness();
    captured(() => run([...args, "--git-timeout-seconds", "0"], env, none.seams));
    expect(new Set(none.timeouts)).toEqual(new Set([undefined]));
  });

  // A census listing call that needs 150 s: it reaches a 120 s limit, not a 240 s one.
  const slowListing = (args: readonly string[], timeout: number | undefined): "timeout" | null =>
    args[0] === "ls-tree" && timeout !== undefined && timeout < 150_000 ? "timeout" : null;

  it("warn mode names the call, runs it again with no limit, and keeps the verdict", {
    timeout: 120_000,
  }, () => {
    const root = fixture();
    const plain = harness();
    const before = captured(() =>
      run(["--project-root", root, "--base-ref", "base"], env, plain.seams),
    );
    const slow = harness(slowListing);
    const after = captured(() =>
      run(["--project-root", root, "--base-ref", "base"], env, slow.seams),
    );
    expect(after.code).toBe(before.code);
    expect(after.stdout).toBe(before.stdout);
    const warns = slow.stderrSync.filter((l) => l.includes("scope-provenance-git-call-timeout"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const line = warns[0] as string;
    expect(line).toContain("(warn)");
    expect(line).toContain('phase "census"');
    expect(line).toContain("`git ls-tree -r --name-only base xbrief/pending`");
    expect(line).toMatch(/after \d+\.\d s/);
    expect(line).toMatch(/later release/);
    expect(line).toContain("--base-ref base --git-timeout-seconds 240");
    // The same command ran once more, with no limit.
    const pending = "git ls-tree -r --name-only base xbrief/pending";
    expect(slow.log.filter((l) => l === pending)).toHaveLength(2);
  });

  it("enforce mode exits 2 with the refusal line, and the printed remedy completes", {
    timeout: 120_000,
  }, () => {
    const root = fixture();
    const slow = harness(slowListing);
    const refused = captured(() =>
      run(["--project-root", root, "--base-ref", "base"], env, {
        ...slow.seams,
        gitTimeoutMode: "enforce",
      }),
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("scope-provenance-git-call-timeout (enforce)");
    expect(refused.stderr).toContain('phase "census"');
    expect(refused.stderr).toContain("`git ls-tree -r --name-only base xbrief/pending`");
    const remedy = /Remedy: (.+)$/m.exec(refused.stderr)?.[1] ?? "";
    expect(remedy).toMatch(/^deft verify:scope-provenance .*--git-timeout-seconds 240$/);
    // Run the remedy exactly as printed: the argv after the verb.
    const argv = (remedy.match(/'(?:[^']|'')*'|\S+/g) ?? [])
      .slice(2)
      .map((a) => (a.startsWith("'") ? a.slice(1, -1).replace(/''/g, "'") : a));
    const again = harness(slowListing);
    const done = captured(() => run(argv, env, { ...again.seams, gitTimeoutMode: "enforce" }));
    expect(done.code).toBe(0);
    expect(done.stdout).toMatch(/clean/);
  });
});
