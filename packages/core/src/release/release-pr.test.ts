import { describe, expect, it } from "vitest";
import { parseDocsImpactDeclaration } from "../docs/docs-impact.js";
import { findAllClosingKeywordHits } from "../pr-closing-keywords/detect.js";
import {
  BREAK_GLASS_FLAG,
  buildReleasePrBody,
  checkReleaseBranch,
  finishCommand,
  openReleasePr,
  pushReleaseBranch,
  releaseBranchCreateCommand,
  releaseBranchName,
  releaseBranchRecovery,
  releasePrBodyProblems,
  releasePrTitle,
} from "./release-pr.js";
import type { ReleaseSeams, SpawnResult } from "./types.js";

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): SpawnResult => ({ status: 1, stdout: "", stderr });

describe("release branch names and commands (#6296 item 1)", () => {
  it("names the branch, the create command and the recovery", () => {
    expect(releaseBranchName("1.2.3")).toBe("release/v1.2.3");
    expect(releaseBranchCreateCommand("1.2.3", "master")).toBe(
      "git fetch origin master && git switch -c release/v1.2.3 origin/master",
    );
    const recovery = releaseBranchRecovery("1.2.3", "master");
    expect(recovery).toContain("git branch -D release/v1.2.3");
    expect(recovery).toContain("git push origin --delete release/v1.2.3");
    expect(finishCommand("1.2.3")).toBe("task release -- --finish 1.2.3");
    expect(releasePrTitle("1.2.3")).toBe("chore(release): v1.2.3");
    expect(BREAK_GLASS_FLAG).toBe("--break-glass");
  });

  it("checkReleaseBranch refuses another branch without running git", () => {
    const calls: string[][] = [];
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        calls.push([...a]);
        return ok();
      },
    };
    const result = checkReleaseBranch("/p", "1.2.3", "master", "feature", seams);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("on 'feature'");
    expect(calls).toEqual([]);
  });

  it("checkReleaseBranch fails as config when the base tip cannot be read", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("ls-remote")) return ok("");
        if (a.includes("rev-parse") && a.includes("origin/master")) return fail();
        return ok("x\n");
      },
    };
    const result = checkReleaseBranch("/p", "1.2.3", "master", "release/v1.2.3", seams);
    expect(result).toMatchObject({ ok: false, config: true });
  });
});

describe("release PR body (#6296 item 2)", () => {
  const body = buildReleasePrBody("1.2.3", "master");

  it("passes the docs-impact parse and has no closing keyword", () => {
    expect(releasePrBodyProblems(body)).toEqual([]);
    expect(parseDocsImpactDeclaration(body).declaration?.changeClass).toBe("none");
    expect(findAllClosingKeywordHits(body, "body")).toEqual([]);
  });

  it("carries the version and the finish command but no release notes", () => {
    expect(body).toContain("Release v1.2.3");
    expect(body).toContain("task release -- --finish 1.2.3");
    expect(body).not.toContain("### Added");
  });

  it("reports a body without a declaration", () => {
    expect(releasePrBodyProblems("## Summary\n").length).toBeGreaterThan(0);
  });
});

describe("pushReleaseBranch and openReleasePr", () => {
  it("pushes only the release branch", () => {
    const calls: string[][] = [];
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        calls.push([...a]);
        return ok();
      },
    };
    expect(pushReleaseBranch("/p", "1.2.3", seams)).toEqual([
      true,
      "pushed release/v1.2.3 to origin",
    ]);
    expect(calls).toEqual([["-C", "/p", "push", "-u", "origin", "release/v1.2.3"]]);
    expect(pushReleaseBranch("/p", "1.2.3", { spawnText: () => fail("denied") })[1]).toContain(
      "denied",
    );
  });

  it("opens the PR against the base branch from the release branch", () => {
    let argv: readonly string[] = [];
    const seams: ReleaseSeams = {
      whichGh: () => "gh",
      spawnText: (_c, a) => {
        argv = a;
        return ok("https://github.com/o/r/pull/12\n");
      },
    };
    expect(openReleasePr("/p", "1.2.3", "o/r", "master", seams)).toEqual([
      true,
      "opened https://github.com/o/r/pull/12",
    ]);
    expect(argv).toEqual(
      expect.arrayContaining(["pr", "create", "--base", "master", "--head", "release/v1.2.3"]),
    );
  });

  it("reports gh missing, a failed create and an empty URL", () => {
    expect(openReleasePr("/p", "1.2.3", "o/r", "master", { whichGh: () => null })[0]).toBe(false);
    const failed = openReleasePr("/p", "1.2.3", "o/r", "master", {
      whichGh: () => "gh",
      spawnText: () => fail("no auth"),
    });
    expect(failed).toEqual([false, "gh pr create failed: no auth"]);
    const empty = openReleasePr("/p", "1.2.3", "o/r", "master", {
      whichGh: () => "gh",
      spawnText: () => ok(""),
    });
    expect(empty).toEqual([true, "opened the release PR"]);
  });
});
