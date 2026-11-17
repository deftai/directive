import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scm/gh-rest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scm/gh-rest.js")>();
  return { ...actual, runGhApi: vi.fn() };
});

import { COMPOSED_GATE_IDS } from "../presentation-coverage/gates.js";
import { runGhApi } from "../scm/gh-rest.js";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";
import { checkGateId, FRAMEWORK_CHECK_GATES, noSuiteGateList } from "./gate-lists.js";
import {
  clearNoSuiteEnv,
  NO_SUITE_MASTER_REFSPEC,
  type NoSuiteGhGetFn,
  type NoSuiteGitFn,
  openPullsAtHead,
  prepareNoSuiteRun,
  repoSlugFromRemoteUrl,
} from "./no-suite.js";
import { dispatchTaskCheck } from "./orchestrator.js";

const HEAD = "abc123def4567890abc123def4567890abc12345";
const ROOT = "/fw-root-6469";

let stderr: string[] = [];
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderr = [];
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  errSpy.mockRestore();
  outSpy.mockRestore();
  vi.mocked(runGhApi).mockReset();
});

interface GitCall {
  readonly args: readonly string[];
}

function fakeGit(options: { failFetch?: string; remote?: string } = {}): {
  git: NoSuiteGitFn;
  calls: GitCall[];
} {
  const calls: GitCall[] = [];
  const git: NoSuiteGitFn = (args) => {
    calls.push({ args });
    if (args[0] === "fetch") {
      return args[2] === options.failFetch
        ? { status: 128, stdout: "", stderr: "fatal: could not read from remote" }
        : { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (args[0] === "remote") {
      return {
        status: 0,
        stdout: `${options.remote ?? "https://github.com/deftai/directive.git"}\n`,
        stderr: "",
      };
    }
    if (args[0] === "merge-base") return { status: 0, stdout: "base0000sha\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  return { git, calls };
}

function pr(number: number, base = "master", sha = HEAD, state = "open"): Record<string, unknown> {
  return {
    number,
    state,
    head: { sha },
    base: { ref: base },
    body: `Refs #6469\n\ndeft-story: 6469\n\nbody of #${number}`,
  };
}

function fakeGh(pulls: unknown[], detailOk = true): { ghGet: NoSuiteGhGetFn; paths: string[] } {
  const paths: string[] = [];
  const ghGet: NoSuiteGhGetFn = (path) => {
    paths.push(path);
    if (path.endsWith("/pulls")) return { ok: true, json: pulls };
    const n = Number(path.split("/").pop());
    const found = pulls.find((p) => (p as { number: number }).number === n);
    return detailOk && found !== undefined
      ? { ok: true, json: found }
      : { ok: false, error: "HTTP 404" };
  };
  return { ghGet, paths };
}

const callerEnv: NodeJS.ProcessEnv = {
  PATH: "/bin",
  DEFT_ACTIVE_SCOPE: "xbrief/active/x.xbrief.json",
  DEFT_BASE_REF: "origin/stale",
  GITHUB_PR_NUMBER: "1",
  GITHUB_REPOSITORY: "someone/else",
  GITHUB_BASE_REF: "old",
  GITHUB_EVENT_NAME: "push",
  GITHUB_EVENT_PATH: "/tmp/old.json",
};

describe("no-suite helpers (#6469)", () => {
  it("parses GitHub remote URLs", () => {
    expect(repoSlugFromRemoteUrl("https://github.com/deftai/directive.git")).toBe(
      "deftai/directive",
    );
    expect(repoSlugFromRemoteUrl("git@github.com:deftai/directive.git\n")).toBe("deftai/directive");
    expect(repoSlugFromRemoteUrl("https://github.com/deftai/directive")).toBe("deftai/directive");
    expect(repoSlugFromRemoteUrl("https://gitlab.com/a/b.git")).toBeNull();
  });

  it("keeps only open pulls whose head is HEAD", () => {
    expect(
      openPullsAtHead(
        [pr(1), pr(2, "master", "other"), pr(3, "master", HEAD, "closed"), null],
        HEAD,
      ),
    ).toEqual([1]);
    expect(openPullsAtHead({ not: "a list" }, HEAD)).toEqual([]);
  });

  it("clears the worker pin and inherited PR context", () => {
    const env = clearNoSuiteEnv(callerEnv);
    expect(env).toEqual({ PATH: "/bin" });
    expect(callerEnv.DEFT_ACTIVE_SCOPE).toBeDefined();
  });
});

describe("prepareNoSuiteRun (#6469)", () => {
  it("fetches origin/master with CI's refspec as its first git call", () => {
    const { git, calls } = fakeGit();
    const prep = prepareNoSuiteRun({ projectRoot: ROOT, env: {}, git, ghGet: fakeGh([]).ghGet });
    expect(prep.ok).toBe(true);
    expect(calls[0]?.args).toEqual(["fetch", "origin", NO_SUITE_MASTER_REFSPEC]);
    expect(NO_SUITE_MASTER_REFSPEC).toBe("master:refs/remotes/origin/master");
  });

  it("fetches a non-master PR base branch too", () => {
    const { git, calls } = fakeGit();
    const prep = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git,
      ghGet: fakeGh([pr(42, "release/1.2")]).ghGet,
      writeEvent: () => ({ path: "/tmp/e.json", cleanup: () => {} }),
    });
    expect(prep.ok).toBe(true);
    const fetches = calls.filter((c) => c.args[0] === "fetch").map((c) => c.args[2]);
    expect(fetches).toEqual([
      "master:refs/remotes/origin/master",
      "release/1.2:refs/remotes/origin/release/1.2",
    ]);
    expect(calls.find((c) => c.args[0] === "merge-base")?.args).toEqual([
      "merge-base",
      "HEAD",
      "origin/release/1.2",
    ]);
    if (prep.ok) {
      expect(prep.env.GITHUB_BASE_REF).toBe("release/1.2");
      expect(prep.header[0]).toContain("and origin/release/1.2");
    }
  });

  it("exits 2 naming the failed fetch, for master and for the base branch", () => {
    const master = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: fakeGit({ failFetch: NO_SUITE_MASTER_REFSPEC }).git,
      ghGet: fakeGh([]).ghGet,
    });
    expect(master.ok).toBe(false);
    if (!master.ok) {
      expect(master.exitCode).toBe(2);
      expect(master.message).toContain("git fetch origin master:refs/remotes/origin/master failed");
      expect(master.message).toContain("no gate ran");
      expect(master.message).toContain("could not read from remote");
    }
    const base = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: fakeGit({ failFetch: "dev:refs/remotes/origin/dev" }).git,
      ghGet: fakeGh([pr(7, "dev")]).ghGet,
    });
    expect(base.ok).toBe(false);
    if (!base.ok) expect(base.message).toContain("dev:refs/remotes/origin/dev");
  });

  it("gives CI's pull-request context when exactly one open PR has HEAD", () => {
    const { ghGet, paths } = fakeGh([pr(42)]);
    const prep = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: callerEnv,
      git: fakeGit().git,
      ghGet,
    });
    expect(paths).toEqual([
      `repos/deftai/directive/commits/${HEAD}/pulls`,
      "repos/deftai/directive/pulls/42",
    ]);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    try {
      expect(prep.env.DEFT_ACTIVE_SCOPE).toBeUndefined();
      expect(prep.env.DEFT_BASE_REF).toBeUndefined();
      expect(prep.env.GITHUB_PR_NUMBER).toBe("42");
      expect(prep.env.GITHUB_REPOSITORY).toBe("deftai/directive");
      expect(prep.env.GITHUB_BASE_REF).toBe("master");
      expect(prep.env.GITHUB_EVENT_NAME).toBe("pull_request");
      const eventPath = prep.env.GITHUB_EVENT_PATH ?? "";
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
        number: number;
        pull_request: { body: string };
      };
      expect(event.number).toBe(42);
      expect(event.pull_request.body).toContain("deft-story: 6469");
      expect(prep.pullRequest).toEqual({
        number: 42,
        repository: "deftai/directive",
        baseRef: "master",
      });
      expect(prep.header.join("\n")).toContain("merge base base0000sha with origin/master");
      expect(prep.header.join("\n")).toContain("pull request #42 (deftai/directive, base master)");
      prep.cleanup();
      expect(existsSync(eventPath)).toBe(false);
    } finally {
      prep.cleanup();
    }
  });

  it.each([
    ["no open PR", [] as unknown[], "no open pull request has head"],
    ["two open PRs", [pr(1), pr(2)], "2 open pull requests have head"],
  ])("runs in the no-PR form with %s", (_label, pulls, reason) => {
    const prep = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: callerEnv,
      git: fakeGit().git,
      ghGet: fakeGh(pulls).ghGet,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    for (const key of [
      "GITHUB_PR_NUMBER",
      "GITHUB_REPOSITORY",
      "GITHUB_BASE_REF",
      "GITHUB_EVENT_NAME",
      "GITHUB_EVENT_PATH",
    ]) {
      expect(prep.env[key]).toBeUndefined();
    }
    const text = prep.header.join("\n");
    expect(text).toContain("no pull request used");
    expect(text).toContain(reason);
    expect(text).toContain("open the PR, then run again");
    prep.cleanup();
  });

  it("names lookup failures and non-GitHub remotes in the no-PR line", () => {
    const failedList: NoSuiteGhGetFn = () => ({ ok: false, error: "HTTP 502" });
    const a = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: fakeGit().git,
      ghGet: failedList,
    });
    expect(a.ok && a.header.join("\n")).toContain("pull request lookup failed (HTTP 502)");
    const b = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: fakeGit().git,
      ghGet: fakeGh([pr(5)], false).ghGet,
    });
    expect(b.ok && b.header.join("\n")).toContain("reading pull request #5 failed (HTTP 404)");
    const c = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: fakeGit({ remote: "https://example.com/x.git" }).git,
      ghGet: fakeGh([pr(5)]).ghGet,
    });
    expect(c.ok && c.header.join("\n")).toContain("origin is not a GitHub remote");
    const notObject: NoSuiteGhGetFn = (path) =>
      path.endsWith("/pulls") ? { ok: true, json: [pr(9)] } : { ok: true, json: [] };
    const d = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: fakeGit().git,
      ghGet: notObject,
    });
    expect(d.ok && d.header.join("\n")).toContain("reading pull request #9 failed (not an object)");
    const noHead: NoSuiteGitFn = (args) =>
      args[0] === "rev-parse" ? { status: 1, stdout: "", stderr: "" } : fakeGit().git(args, ROOT);
    const e = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: noHead,
      ghGet: fakeGh([]).ghGet,
    });
    expect(e.ok && e.header.join("\n")).toContain("HEAD could not be read");
  });

  it("reads the PR live through gh api, not the ghx cache", () => {
    vi.mocked(runGhApi).mockImplementation((args) => {
      const path = args[0] ?? "";
      if (path.endsWith("/pulls")) {
        return { returncode: 0, stdout: JSON.stringify([pr(11)]), stderr: "" };
      }
      return { returncode: 0, stdout: JSON.stringify(pr(11)), stderr: "" };
    });
    const prep = prepareNoSuiteRun({
      projectRoot: ROOT,
      env: {},
      git: fakeGit().git,
      writeEvent: () => ({ path: "/tmp/e.json", cleanup: () => {} }),
    });
    expect(prep.ok && prep.pullRequest?.number).toBe(11);
    const opts = vi.mocked(runGhApi).mock.calls[0]?.[1];
    expect(opts?.whichFn?.("ghx")).toBeNull();
    vi.mocked(runGhApi).mockReturnValue({ returncode: 1, stdout: "", stderr: "" });
    const failed = prepareNoSuiteRun({ projectRoot: ROOT, env: {}, git: fakeGit().git });
    expect(failed.ok && failed.header.join("\n")).toContain("gh api exit 1");
    vi.mocked(runGhApi).mockReturnValue({ returncode: 0, stdout: "not json", stderr: "" });
    const garbled = prepareNoSuiteRun({ projectRoot: ROOT, env: {}, git: fakeGit().git });
    expect(garbled.ok && garbled.header.join("\n")).toContain("non-JSON response");
  });

  it("uses real git by default: a repository with no origin exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-6469-nogit-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      const prep = prepareNoSuiteRun({ projectRoot: dir, env: {} });
      expect(prep.ok).toBe(false);
      if (!prep.ok) expect(prep.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Orchestrator: gate set, modes, every failure, env ---

function okSpawn(gateId: string): { exitCode: number; stdout: string; stderr: string } {
  return {
    exitCode: 0,
    stdout:
      gateId === "verify:presentation-coverage"
        ? JSON.stringify({ code: 0, armed: false, coverage: [] })
        : "",
    stderr: "",
  };
}

const cachedSeams = {
  skipSanctionedSkipBaseline: true,
  skipCitedSkipScan: true,
  noCache: true,
  preflight: null,
  emitRunSummary: false,
} as const;

describe("dispatchCachedTaskCheck under noSuite (#6469)", () => {
  it("runs FRAMEWORK_CHECK_GATES without the AC gate and ts:check-lane --no-test", () => {
    const spawned: { id: string; args: string[] }[] = [];
    const code = dispatchCachedTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      noSuite: true,
      env: {},
      gateSpawnFn: (gateId, _bin, args) => {
        spawned.push({ id: gateId, args });
        return okSpawn(gateId);
      },
    });
    expect(code).toBe(0);
    expect(spawned.map((s) => s.id)).toEqual(
      noSuiteGateList(FRAMEWORK_CHECK_GATES).map(checkGateId),
    );
    expect(spawned.map((s) => s.id)).not.toContain("verify:ac");
    const lane = spawned.find((s) => s.id === "ts:check-lane");
    expect(lane?.args.slice(-2)).toEqual(["--", "--no-test"]);
  });

  it.each([
    ["DEFT_CHECK_MODE=rapid", { DEFT_CHECK_MODE: "rapid" }],
    ["DEFT_CHECK_MODE=pressure", { DEFT_CHECK_MODE: "pressure" }],
    ["DEFT_CHECK_AC_ONLY", { DEFT_CHECK_AC_ONLY: "1" }],
  ])("ignores %s: every gate runs and a failing hygiene gate fails", (_label, env) => {
    const spawned: string[] = [];
    const code = dispatchCachedTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      noSuite: true,
      env,
      gateSpawnFn: (gateId) => {
        spawned.push(gateId);
        return gateId === "verify:stubs"
          ? { exitCode: 1, stdout: "", stderr: "stub found\n" }
          : okSpawn(gateId);
      },
    });
    expect(code).toBe(1);
    expect(spawned).toEqual(noSuiteGateList(FRAMEWORK_CHECK_GATES).map(checkGateId));
    expect(stderr.join("")).not.toContain("ADVISORY");
  });

  it("runs every gate after two failures and exits with the first failed gate's code", () => {
    const spawned: string[] = [];
    const code = dispatchCachedTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      noSuite: true,
      env: {},
      gateSpawnFn: (gateId) => {
        spawned.push(gateId);
        if (gateId === "verify:branch") return { exitCode: 3, stdout: "", stderr: "BRANCH-OUT\n" };
        if (gateId === "verify:links") return { exitCode: 1, stdout: "LINKS-OUT\n", stderr: "" };
        return okSpawn(gateId);
      },
    });
    expect(code).toBe(3);
    expect(spawned).toEqual(noSuiteGateList(FRAMEWORK_CHECK_GATES).map(checkGateId));
    const text = stderr.join("");
    expect(text).toContain("BRANCH-OUT");
    expect(text).toContain("check --no-suite: gate verify:branch failed (exit 3)");
    expect(text).toContain("check --no-suite: gate verify:links failed (exit 1)");
    expect(text).toContain("2 gate(s) failed: verify:branch, verify:links; exit 3");
    const outText = vi
      .mocked(process.stdout.write)
      .mock.calls.map((c) => String(c[0]))
      .join("");
    expect(outText).toContain("LINKS-OUT");
  });

  it("records a presentation-coverage parse error and keeps going", () => {
    const spawned: string[] = [];
    const code = dispatchCachedTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      noSuite: true,
      env: {},
      gateSpawnFn: (gateId) => {
        spawned.push(gateId);
        return gateId === "verify:presentation-coverage"
          ? { exitCode: 0, stdout: "not json", stderr: "" }
          : okSpawn(gateId);
      },
    });
    expect(code).toBe(2);
    expect(spawned[spawned.length - 1]).toBe("ts:check-lane");
  });

  it("records an armed presentation-coverage refusal and keeps going", () => {
    const spawned: string[] = [];
    const code = dispatchCachedTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      noSuite: true,
      env: {},
      gateSpawnFn: (gateId) => {
        spawned.push(gateId);
        if (gateId === "verify:presentation-ceiling") {
          return { exitCode: 1, stdout: "", stderr: "ceiling\n" };
        }
        if (gateId === "verify:presentation-coverage") {
          const coverage = COMPOSED_GATE_IDS.map((id) => ({
            gateId: id,
            status: "evaluated",
            code: 0,
            analyzedPaths: [],
            cannotEvaluatePaths: [],
            message: "",
          }));
          return {
            exitCode: 0,
            stdout: JSON.stringify({ code: 0, armed: true, coverage, uncoveredPaths: [] }),
            stderr: "",
          };
        }
        return okSpawn(gateId);
      },
    });
    expect(code).toBe(1);
    expect(spawned[spawned.length - 1]).toBe("ts:check-lane");
    expect(stderr.join("")).toContain("gate verify:presentation-coverage failed (exit 1)");
  });

  it("without noSuite keeps the AC gate first, the full lane, modes and the first-failure stop", () => {
    const spawned: { id: string; args: string[] }[] = [];
    const code = dispatchCachedTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      env: {},
      gateSpawnFn: (gateId, _bin, args) => {
        spawned.push({ id: gateId, args });
        return gateId === "verify:links"
          ? { exitCode: 1, stdout: "", stderr: "links\n" }
          : okSpawn(gateId);
      },
    });
    expect(code).toBe(1);
    const ids = spawned.map((s) => s.id);
    expect(ids[0]).toBe("verify:ac");
    expect(ids[ids.length - 1]).toBe("verify:links");
    expect(ids).not.toContain("ts:check-lane");

    const full: { id: string; args: string[] }[] = [];
    expect(
      dispatchCachedTaskCheck(ROOT, ROOT, {
        ...cachedSeams,
        env: {},
        gateSpawnFn: (gateId, _bin, args) => {
          full.push({ id: gateId, args });
          return okSpawn(gateId);
        },
      }),
    ).toBe(0);
    expect(full.map((s) => s.id)).toEqual(FRAMEWORK_CHECK_GATES.map(checkGateId));
    expect(full.find((s) => s.id === "ts:check-lane")?.args).not.toContain("--no-test");

    const advisory: string[] = [];
    expect(
      dispatchCachedTaskCheck(ROOT, ROOT, {
        ...cachedSeams,
        env: { DEFT_CHECK_MODE: "pressure" },
        gateSpawnFn: (gateId) => {
          advisory.push(gateId);
          return gateId === "verify:stubs"
            ? { exitCode: 1, stdout: "", stderr: "stub\n" }
            : okSpawn(gateId);
        },
      }),
    ).toBe(0);
    expect(stderr.join("")).toContain("ADVISORY");
  });
});

describe("dispatchTaskCheck --no-suite (#6469)", () => {
  it("fetches before any gate, then gives every gate the cleared PR-context env", () => {
    const order: string[] = [];
    const { git } = fakeGit();
    const tracingGit: NoSuiteGitFn = (args, cwd) => {
      order.push(`git ${args.join(" ")}`);
      return git(args, cwd);
    };
    const envs: NodeJS.ProcessEnv[] = [];
    let eventBody = "";
    const code = dispatchTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      noSuite: true,
      env: callerEnv,
      prepareNoSuite: (input) =>
        prepareNoSuiteRun({ ...input, git: tracingGit, ghGet: fakeGh([pr(77)]).ghGet }),
      gateSpawnFn: (gateId, _bin, _args, opts) => {
        order.push(`gate ${gateId}`);
        envs.push(opts.env ?? {});
        if (gateId === "verify:completed-write-guard") {
          const event = JSON.parse(readFileSync(opts.env?.GITHUB_EVENT_PATH ?? "", "utf8")) as {
            pull_request: { body: string };
          };
          eventBody = event.pull_request.body;
        }
        return okSpawn(gateId);
      },
    });
    expect(code).toBe(0);
    expect(order[0]).toBe("git fetch origin master:refs/remotes/origin/master");
    const firstGate = order.findIndex((entry) => entry.startsWith("gate "));
    expect(order.slice(0, firstGate).every((entry) => entry.startsWith("git "))).toBe(true);
    expect(envs.length).toBe(noSuiteGateList(FRAMEWORK_CHECK_GATES).length);
    for (const env of envs) {
      expect(env.DEFT_ACTIVE_SCOPE).toBeUndefined();
      expect(env.DEFT_BASE_REF).toBeUndefined();
      expect(env.GITHUB_PR_NUMBER).toBe("77");
      expect(env.GITHUB_REPOSITORY).toBe("deftai/directive");
      expect(env.GITHUB_EVENT_NAME).toBe("pull_request");
    }
    expect(eventBody).toContain("body of #77");
    expect(stderr.join("")).toContain("check --no-suite: pull request #77");
    expect(existsSync(envs[0]?.GITHUB_EVENT_PATH ?? "")).toBe(false);
  });

  it("runs no gate and exits 2 when the fetch fails", () => {
    const spawned: string[] = [];
    const code = dispatchTaskCheck(ROOT, ROOT, {
      ...cachedSeams,
      noSuite: true,
      env: {},
      prepareNoSuite: (input) =>
        prepareNoSuiteRun({
          ...input,
          git: fakeGit({ failFetch: NO_SUITE_MASTER_REFSPEC }).git,
          ghGet: fakeGh([]).ghGet,
        }),
      gateSpawnFn: (gateId) => {
        spawned.push(gateId);
        return okSpawn(gateId);
      },
    });
    expect(code).toBe(2);
    expect(spawned).toEqual([]);
    expect(stderr.join("")).toContain("git fetch origin master:refs/remotes/origin/master failed");
  });
});
