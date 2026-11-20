import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanOriginGrant } from "../authz/types.js";
import { releaseLine } from "../changelog/release-line.js";
import { EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import {
  checkMergeCommit,
  checkReleaseParent,
  findMergedReleasePr,
  pickMergedReleasePr,
  readMergeTree,
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

describe("run-bound finish (#6875)", () => {
  const B = "b".repeat(40);
  const T = "t".repeat(40);
  const RUN_GRANT = "grant-run-6875";

  function grant(id: string, surfaces: string[]): HumanOriginGrant {
    return {
      schemaVersion: 1,
      id,
      origin: {
        kind: "operator-cli",
        actor: "operator",
        mintedAt: "2026-11-20T00:00:00Z",
        mintedVia: "deft authz:grant",
        eventRef: "template:release-publish",
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces,
        operations: ["release-publish"],
        storyIds: [],
        issueIds: [],
        cohortId: null,
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    };
  }

  /** Records git argv; answers M's parent with `parent` and its tree with `tree`. */
  function boundSeams(
    opts: { parent?: string; tree?: string; grants?: HumanOriginGrant[]; show?: string } = {},
  ): ReleaseSeams & { calls: string[][]; err: string[] } {
    const calls: string[][] = [];
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return {
      calls,
      err,
      findMergedReleasePr: () => ({ ok: true, number: 7, mergeCommit: M }),
      checkTagAvailable: () => [true, "ok"],
      namedMergeGateFn: (() => ({ ok: true })) as unknown as ReleaseSeams["namedMergeGateFn"],
      closedVerbEnv: {},
      closedVerbGrants: opts.grants ?? [grant(RUN_GRANT, [`${V}@${T}`])],
      spawnText: (_c, a) => {
        calls.push([...a]);
        if (a.includes("rev-list")) return ok(`${M} ${opts.parent ?? B}\n`);
        if (a.includes("rev-parse")) return ok(`${opts.tree ?? T}\n`);
        if (a.includes("diff")) return ok("M\tCHANGELOG.md\nM\tROADMAP.md\n");
        if (a.includes("show")) return ok(opts.show ?? RELEASED);
        if (a.includes("ls-tree")) return ok("");
        return ok();
      },
    };
  }

  const bound = (): ReleaseConfig =>
    config({ runBinding: { grantId: RUN_GRANT, expectedBase: B } });
  const tagged = (calls: string[][]): boolean => calls.some((a) => a.includes("-a"));
  const pushed = (calls: string[][]): boolean => calls.some((a) => a.includes("push"));

  it("tags M when its parent is B and the run's grant names <version>@<tree of M>", () => {
    const seams = boundSeams();
    expect(runFinish(bound(), seams)).toBe(EXIT_OK);
    expect(tagged(seams.calls)).toBe(true);
    expect(pushed(seams.calls)).toBe(true);
    expect(seams.err.join("")).toContain(`grant=${RUN_GRANT}`);
  });

  it("refuses a version-only release-publish grant under the run and creates no tag", () => {
    const seams = boundSeams({ grants: [grant(RUN_GRANT, [V, `v${V}`])] });
    expect(runFinish(bound(), seams)).toBe(EXIT_VIOLATION);
    expect(tagged(seams.calls)).toBe(false);
    expect(seams.err.join("")).toContain(`--target ${V}@${T}`);
  });

  it("refuses when the tree of M is not T, even with another empty-surface grant active", () => {
    const seams = boundSeams({
      tree: "x".repeat(40),
      grants: [grant(RUN_GRANT, [`${V}@${T}`]), grant("broad-grant", [])],
    });
    expect(runFinish(bound(), seams)).toBe(EXIT_VIOLATION);
    expect(tagged(seams.calls)).toBe(false);
    expect(pushed(seams.calls)).toBe(false);
  });

  it("does not let another grant or an empty-surface run grant stand in for the run's grant", () => {
    const other = boundSeams({ grants: [grant("someone-else", [`${V}@${T}`])] });
    expect(runFinish(bound(), other)).toBe(EXIT_VIOLATION);
    expect(tagged(other.calls)).toBe(false);
    vi.restoreAllMocks();
    const empty = boundSeams({ grants: [grant(RUN_GRANT, [])] });
    expect(runFinish(bound(), empty)).toBe(EXIT_VIOLATION);
    expect(tagged(empty.calls)).toBe(false);
  });

  it("keeps the DEFT_ALLOW_RELEASE_PUBLISH break-glass bypass under the run", () => {
    const seams = boundSeams({ grants: [] });
    const code = runFinish(bound(), {
      ...seams,
      closedVerbEnv: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
    });
    expect(code).toBe(EXIT_OK);
    expect(tagged(seams.calls)).toBe(true);
  });

  it("refuses before the tag when a PR landed ahead and names the break-glass recovery", () => {
    const ahead = `## [Unreleased]\n\n${releaseLine(V)}\n- other change\n\n## [${V}] - d\n`;
    const seams = boundSeams({ parent: "c".repeat(40), show: ahead });
    expect(runFinish(bound(), seams)).toBe(EXIT_VIOLATION);
    expect(tagged(seams.calls)).toBe(false);
    expect(seams.err.join("")).toContain("break-glass");
  });

  it("refuses when M has tree T and no leftover entry but its parent is not B", () => {
    const seams = boundSeams({ parent: "c".repeat(40) });
    expect(runFinish(bound(), seams)).toBe(EXIT_VIOLATION);
    expect(tagged(seams.calls)).toBe(false);
    expect(pushed(seams.calls)).toBe(false);
    const text = seams.err.join("");
    expect(text).toContain(`not the cut base ${B.slice(0, 12)}`);
    expect(text).toContain("break-glass");
  });

  it("keeps the manual --finish path accepting a version-only grant (until S5)", () => {
    const seams = boundSeams({ grants: [grant(RUN_GRANT, [V, `v${V}`])] });
    expect(runFinish(config(), seams)).toBe(EXIT_OK);
    expect(tagged(seams.calls)).toBe(true);
  });

  it("fails closed when the tree of M cannot be read", () => {
    const seams = boundSeams();
    const inner = seams.spawnText;
    const code = runFinish(bound(), {
      ...seams,
      spawnText: (c, a, o) => (a.includes("rev-parse") ? fail("bad") : (inner?.(c, a, o) ?? ok())),
    });
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(tagged(seams.calls)).toBe(false);
  });
});

describe("checkReleaseParent (#6875)", () => {
  const B = "b".repeat(40);
  const seam = (out: SpawnResult): ReleaseSeams => ({ spawnText: () => out });

  it("accepts M whose sole parent is the cut base, in any case", () => {
    expect(checkReleaseParent("/p", M, B.toUpperCase(), seam(ok(`${M} ${B}\n`)))).toEqual({
      ok: true,
    });
  });

  it("refuses another parent or two parents, so a resume never pushes a local-only tag", () => {
    const other = checkReleaseParent("/p", M, B, seam(ok(`${M} ${"c".repeat(40)}\n`)));
    expect(other).toMatchObject({ ok: false, config: false });
    if (!other.ok) expect(other.reason).toContain("break-glass");
    expect(checkReleaseParent("/p", M, B, seam(ok(`${M} ${B} c\n`)))).toMatchObject({ ok: false });
    expect(checkReleaseParent("/p", M, B, seam(ok(`${M}\n`)))).toMatchObject({ ok: false });
  });

  it("reports a git failure as a config error", () => {
    expect(checkReleaseParent("/p", M, B, seam(fail()))).toMatchObject({ ok: false, config: true });
  });
});

describe("readMergeTree (#6875)", () => {
  it("reads the tree with git and refuses an empty answer or a failure", () => {
    expect(readMergeTree("/p", M, { spawnText: () => ok("abc\n") })).toEqual({
      ok: true,
      tree: "abc",
    });
    expect(readMergeTree("/p", M, { spawnText: () => ok("") }).ok).toBe(false);
    expect(readMergeTree("/p", M, { spawnText: () => fail() }).ok).toBe(false);
  });
});

describe("release notes read from M (#6875)", () => {
  it("leads the draft notes with the upgrade banner from M, read with git show", () => {
    let notes = "";
    const shown: string[] = [];
    const seams: ReleaseSeams = {
      whichGh: () => "gh",
      sleep: () => undefined,
      spawnText: (_c, a) => {
        if (a.includes("show")) {
          shown.push(a[a.length - 1] ?? "");
          return ok("Banner at M\n");
        }
        const i = a.indexOf("--notes-file");
        if (i >= 0) notes = readFileSync(a[i + 1] ?? "", "utf8");
        return a.includes("view") ? ok(JSON.stringify({ isDraft: true })) : ok("created\n");
      },
    };
    const code = runGithubReleaseSteps(
      config({ skipRelease: false, repo: "deftai/directive" }),
      RELEASED,
      seams,
      () => undefined,
      M,
    );
    expect(code).toBe(EXIT_OK);
    expect(shown).toEqual([`${M}:.github/release-notes/upgrade-banner.md`]);
    expect(notes.startsWith("Banner at M\n\n")).toBe(true);
    expect(notes).toContain("- shipped");
  });

  it("finish passes M, so the banner is read from M with git show", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const shown: string[] = [];
    const base = gitSeam();
    const seams: ReleaseSeams = {
      whichGh: () => "gh",
      sleep: () => undefined,
      findMergedReleasePr: () => ({ ok: true, number: 1, mergeCommit: M }),
      checkTagAvailable: () => [true, "ok"],
      namedMergeGateFn: (() => ({ ok: true })) as unknown as ReleaseSeams["namedMergeGateFn"],
      closedVerbEnv: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
      closedVerbGrants: [],
      spawnText: (c, a, o) => {
        if (a.includes("show")) shown.push(a[a.length - 1] ?? "");
        if (a.includes("view")) return ok(JSON.stringify({ isDraft: true }));
        return base?.(c, a, o) ?? ok();
      },
    };
    expect(runFinish(config({ skipRelease: false, repo: "deftai/directive" }), seams)).toBe(
      EXIT_OK,
    );
    expect(shown).toContain(`${M}:.github/release-notes/upgrade-banner.md`);
  });
});
