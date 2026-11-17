import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseLine } from "../changelog/release-line.js";
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import {
  checkMergeCommit,
  findMergedReleasePr,
  pickMergedReleasePr,
  runFinish,
  runGithubReleaseSteps,
} from "./finish.js";
import type { ReleaseConfig, ReleaseSeams, SpawnResult } from "./types.js";

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): SpawnResult => ({ status: 1, stdout: "", stderr });

const V = "1.2.0";
const M = "m".repeat(40);
const RELEASED = `## [Unreleased]\n\n${releaseLine(V)}\n\n### Added\n\n## [${V}] - 2026-11-17\n\n- shipped\n`;

function config(overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    version: V,
    repo: "o/r",
    baseBranch: "master",
    projectRoot: "/p",
    dryRun: false,
    skipTag: false,
    skipRelease: true,
    allowDirty: false,
    draft: true,
    skipCi: false,
    skipBuild: false,
    summary: null,
    allowVbriefDrift: false,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: null,
    ...overrides,
  };
}

/** A git seam answering the merge-commit checks; `answers` override by verb. */
function gitSeam(answers: Record<string, SpawnResult> = {}): ReleaseSeams["spawnText"] {
  return (_c, a) => {
    for (const [verb, result] of Object.entries(answers)) {
      if (a.includes(verb)) return result;
    }
    if (a.includes("rev-list")) return ok(`${M} parent\n`);
    if (a.includes("diff")) return ok("M\tCHANGELOG.md\nM\tROADMAP.md\nD\tchangelog.d/1-a.md\n");
    if (a.includes("show")) return ok(RELEASED);
    if (a.includes("ls-tree")) return ok("");
    return ok();
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickMergedReleasePr", () => {
  it("picks the latest merged PR and skips open ones", () => {
    const rows = [
      { number: 1, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "a" },
      { number: 2, merged_at: null, merge_commit_sha: "b" },
      { number: 3, merged_at: "2026-02-01T00:00:00Z", merge_commit_sha: "c" },
    ];
    expect(pickMergedReleasePr(JSON.stringify(rows), V)).toEqual({
      ok: true,
      number: 3,
      mergeCommit: "c",
    });
  });

  it("reads one object per line from every paginated page", () => {
    const lines = [
      JSON.stringify({ number: 5, merged_at: "2026-03-01T00:00:00Z", merge_commit_sha: "e" }),
      JSON.stringify({ number: 6, merged_at: null, merge_commit_sha: "f" }),
    ].join("\n");
    expect(pickMergedReleasePr(`${lines}\n`, V)).toEqual({ ok: true, number: 5, mergeCommit: "e" });
  });

  it("explains an empty list, a bad payload and a non-array", () => {
    expect(pickMergedReleasePr("[]", V)).toMatchObject({ ok: false });
    expect(pickMergedReleasePr("{", V)).toMatchObject({ ok: false });
    expect(pickMergedReleasePr("{}", V)).toMatchObject({ ok: false });
  });
});

describe("findMergedReleasePr", () => {
  it("reads the REST pulls list for release/v<version>", () => {
    let argv: readonly string[] = [];
    const result = findMergedReleasePr("/p", "o/r", "master", V, {
      whichGh: () => "gh",
      spawnText: (_c, a) => {
        argv = a;
        return ok(JSON.stringify([{ number: 4, merged_at: "2026-01-01", merge_commit_sha: M }]));
      },
    });
    expect(result).toEqual({ ok: true, number: 4, mergeCommit: M });
    expect(argv.join(" ")).toContain("head=o%3Arelease%2Fv1.2.0");
  });

  it("reports gh missing or failing", () => {
    expect(findMergedReleasePr("/p", "o/r", "master", V, { whichGh: () => null }).ok).toBe(false);
    const failed = findMergedReleasePr("/p", "o/r", "master", V, {
      whichGh: () => "gh",
      spawnText: () => fail("rate"),
    });
    expect(failed).toEqual({ ok: false, reason: "gh api pulls failed: rate" });
  });
});

describe("checkMergeCommit (#6296 item 3)", () => {
  it("accepts a release-only, one-parent merge commit with the line alone", () => {
    const result = checkMergeCommit("/p", V, "master", M, { spawnText: gitSeam() });
    expect(result.ok).toBe(true);
  });

  it("refuses a commit not on the base, with two parents, or without heading or line", () => {
    const cases: [Record<string, SpawnResult>, string][] = [
      [{ "--is-ancestor": fail() }, "is not on the fetched origin/master"],
      [{ "rev-list": ok(`${M} p1 p2\n`) }, "has 2 parents"],
      [{ show: ok(`## [Unreleased]\n\n${releaseLine(V)}\n`) }, `no ## [${V}] heading`],
      [{ show: ok(`## [Unreleased]\n\n- x\n\n## [${V}] - d\n`) }, "has no release line"],
    ];
    for (const [answers, reason] of cases) {
      const result = checkMergeCommit("/p", V, "master", M, { spawnText: gitSeam(answers) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(reason);
    }
  });

  it("reports git failures as config errors", () => {
    for (const verb of ["rev-list", "diff", "show", "ls-tree"]) {
      const result = checkMergeCommit("/p", V, "master", M, {
        spawnText: gitSeam({ [verb]: fail() }),
      });
      expect(result).toMatchObject({ ok: false, config: true });
    }
  });
});

describe("runFinish", () => {
  function quiet(): void {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  }

  it("dry-run prints the plan and touches nothing", () => {
    quiet();
    const calls: string[][] = [];
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        calls.push([...a]);
        return ok();
      },
    };
    expect(runFinish(config({ dryRun: true, skipRelease: false }), seams)).toBe(EXIT_OK);
    expect(calls).toEqual([]);
  });

  it("stops at each refusal before the tag", () => {
    quiet();
    const base: ReleaseSeams = {
      spawnText: gitSeam(),
      findMergedReleasePr: () => ({ ok: true, number: 1, mergeCommit: M }),
      checkTagAvailable: () => [true, "ok"],
    };
    expect(runFinish(config(), { ...base, spawnText: gitSeam({ fetch: fail() }) })).toBe(
      EXIT_CONFIG_ERROR,
    );
    expect(
      runFinish(config(), {
        ...base,
        findMergedReleasePr: () => ({ ok: false, reason: "none" }),
      }),
    ).toBe(EXIT_VIOLATION);
    expect(runFinish(config(), { ...base, spawnText: gitSeam({ diff: fail() }) })).toBe(
      EXIT_CONFIG_ERROR,
    );
    expect(runFinish(config(), { ...base, checkTagAvailable: () => [false, "exists"] })).toBe(
      EXIT_VIOLATION,
    );
  });

  it("reports a failed tag or tag push", () => {
    quiet();
    const base: ReleaseSeams = {
      findMergedReleasePr: () => ({ ok: true, number: 1, mergeCommit: M }),
      checkTagAvailable: () => [true, "ok"],
      namedMergeGateFn: (() => ({ ok: true })) as unknown as ReleaseSeams["namedMergeGateFn"],
      closedVerbEnv: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
      closedVerbGrants: [],
    };
    const tagFails = gitSeam({ "-a": fail("tag") });
    expect(runFinish(config(), { ...base, spawnText: tagFails })).toBe(EXIT_VIOLATION);
    const pushFails = gitSeam({ push: fail("push") });
    expect(runFinish(config(), { ...base, spawnText: pushFails })).toBe(EXIT_VIOLATION);
  });
});

describe("runGithubReleaseSteps", () => {
  it("creates the draft release from the given changelog and verifies it", () => {
    const lines: string[] = [];
    const seams: ReleaseSeams = {
      whichGh: () => "gh",
      spawnText: (_c, a) =>
        a.includes("view") ? ok(JSON.stringify({ isDraft: true })) : ok("created\n"),
      sleep: () => undefined,
    };
    const code = runGithubReleaseSteps(
      config({ skipRelease: false, repo: "o/r" }),
      RELEASED,
      seams,
      (step, label, status) => lines.push(`${String(step)} ${label} ${status}`),
    );
    expect(code).toBe(EXIT_OK);
    expect(lines.join("\n")).toContain("12 GitHub release v1.2.0 (draft) OK");
    expect(lines.join("\n")).toContain("13 Verify draft state");
  });

  it("fails when gh release create fails and skips Step 13 for --no-draft", () => {
    const lines: string[] = [];
    const emit = (step: number, _label: string, status: string) =>
      lines.push(`${String(step)} ${status}`);
    const failing: ReleaseSeams = { whichGh: () => "gh", spawnText: () => fail("x") };
    expect(runGithubReleaseSteps(config({ skipRelease: false }), RELEASED, failing, emit)).toBe(
      EXIT_VIOLATION,
    );
    const created: ReleaseSeams = { whichGh: () => "gh", spawnText: () => ok() };
    expect(
      runGithubReleaseSteps(config({ skipRelease: false, draft: false }), RELEASED, created, emit),
    ).toBe(EXIT_OK);
    expect(lines.join("\n")).toContain("SKIP (--no-draft");
  });
});
