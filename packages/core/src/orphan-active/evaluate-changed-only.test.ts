/**
 * Merge-chokepoint candidate scoping for verify:orphan-active (#3893).
 *
 * The unscoped sweep gave a brief stranded by one merge authority over every
 * other open PR, and made N single-brief lifecycle PRs mutually unmergeable.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import type { GitRunner, GitRunResult } from "../session/git.js";
import { evaluate } from "./evaluate.js";

const REPO = "deftai/directive";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-orphan-scope-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  return root;
}

function writeBrief(root: string, name: string, plan: Record<string, unknown>): void {
  writeFileSync(
    join(root, "xbrief", "active", name),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }),
    "utf8",
  );
}

function writeCachedIssue(root: string, number: number, state: "open" | "closed"): void {
  const dir = join(root, ".deft-cache", "github-issue", "deftai", "directive", String(number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify({ number, state }), "utf8");
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ fetched_at: new Date().toISOString() }),
    "utf8",
  );
}

function issuePlan(number: number): Record<string, unknown> {
  return {
    status: "running",
    references: [
      {
        uri: `https://github.com/deftai/directive/issues/${number}`,
        type: "x-xbrief/github-issue",
      },
    ],
  };
}

function ok(stdout = ""): GitRunResult {
  return { code: 0, stdout, stderr: "" };
}

/**
 * Git seam for the candidate scope: `changed` is the branch's own diff under
 * `xbrief/active/`, `onDeliveryLine` puts HEAD at the delivery tip.
 */
function scopeGit(
  root: string,
  options: { readonly changed?: readonly string[]; readonly onDeliveryLine?: boolean } = {},
): GitRunner {
  return (_cwd, args) => {
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return ok(root);
    if (key.startsWith("rev-parse --verify -q origin/master")) return ok("sha");
    if (key === "merge-base --is-ancestor HEAD origin/master") {
      return options.onDeliveryLine === true ? ok("") : { code: 1, stdout: "", stderr: "" };
    }
    if (key === "merge-base HEAD origin/master") return ok("basesha");
    if (key.startsWith("diff --name-only")) return ok((options.changed ?? []).join("\n"));
    if (key.startsWith("ls-files --others")) return ok("");
    return { code: 1, stdout: "", stderr: `unstubbed: ${key}` };
  };
}

describe("verify:orphan-active --changed-only (#3893)", () => {
  it("lets two single-brief lifecycle candidates pass independently", () => {
    // Master strands briefs A and B. PR-1 removes A, so its worktree still
    // carries B; PR-2 removes B and still carries A. Under the repo-wide
    // predicate neither can go green -- each leaves the other orphan.
    const prOne = makeRepo();
    writeBrief(prOne, "stranded-b.xbrief.json", issuePlan(2002));
    writeCachedIssue(prOne, 2002, "closed");

    const prTwo = makeRepo();
    writeBrief(prTwo, "stranded-a.xbrief.json", issuePlan(2001));
    writeCachedIssue(prTwo, 2001, "closed");

    expect(evaluate(prOne, { repo: REPO, skipGh: true }).code).toBe(1);
    expect(evaluate(prTwo, { repo: REPO, skipGh: true }).code).toBe(1);

    const scopedOne = evaluate(prOne, {
      repo: REPO,
      skipGh: true,
      changedOnly: true,
      baseRef: "origin/master",
      runGit: scopeGit(prOne, { changed: ["xbrief/active/stranded-a.xbrief.json"] }),
    });
    const scopedTwo = evaluate(prTwo, {
      repo: REPO,
      skipGh: true,
      changedOnly: true,
      baseRef: "origin/master",
      runGit: scopeGit(prTwo, { changed: ["xbrief/active/stranded-b.xbrief.json"] }),
    });

    expect(scopedOne.code).toBe(0);
    expect(scopedTwo.code).toBe(0);
    expect(scopedOne.scope).toEqual({
      kind: "diff",
      baseRef: "origin/master",
      reason: null,
      skipped: 1,
    });
    expect(scopedOne.message).toContain("Scope: candidate diff against origin/master");
    expect(scopedOne.message).toContain("1 running brief outside this branch's diff was not");
  });

  it("still fails a candidate for residue inside its own diff", () => {
    const root = makeRepo();
    writeBrief(root, "mine.xbrief.json", issuePlan(3001));
    writeBrief(root, "other.xbrief.json", issuePlan(3002));
    writeCachedIssue(root, 3001, "closed");
    writeCachedIssue(root, 3002, "closed");

    const result = evaluate(root, {
      repo: REPO,
      skipGh: true,
      changedOnly: true,
      baseRef: "origin/master",
      runGit: scopeGit(root, { changed: ["xbrief/active/mine.xbrief.json"] }),
    });

    expect(result.code).toBe(1);
    expect(result.orphans.map((orphan) => orphan.path)).toEqual(["xbrief/active/mine.xbrief.json"]);
    expect(result.message).not.toContain("other.xbrief.json");
  });

  it("preserves the merged-PR / open-issue signature inside the candidate diff", () => {
    const root = makeRepo();
    writeBrief(root, "open-issue-merged-pr.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/4001",
          type: "x-xbrief/github-issue",
        },
        { uri: "https://github.com/deftai/directive/pull/42", type: "x-xbrief/github-pr" },
      ],
    });
    writeCachedIssue(root, 4001, "open");
    const runGh: RunGhFn = (cmd) =>
      cmd.join(" ").includes("/pulls/42")
        ? {
            returncode: 0,
            stdout: JSON.stringify({ merged_at: "2026-08-28T21:14:00Z" }),
            stderr: "",
          }
        : { returncode: 1, stdout: "", stderr: "unexpected" };

    const result = evaluate(root, {
      repo: REPO,
      runGh,
      changedOnly: true,
      baseRef: "origin/master",
      runGit: scopeGit(root, { changed: ["xbrief/active/open-issue-merged-pr.xbrief.json"] }),
    });

    expect(result.code).toBe(1);
    expect(result.orphans[0]?.reason).toBe("linked PR #42 is merged");
    expect(result.orphans[0]?.kind).toBe("shipped");
  });

  it("keeps repo-wide truth when HEAD is on the delivery line", () => {
    const root = makeRepo();
    writeBrief(root, "stranded.xbrief.json", issuePlan(5001));
    writeCachedIssue(root, 5001, "closed");

    const result = evaluate(root, {
      repo: REPO,
      skipGh: true,
      changedOnly: true,
      baseRef: "origin/master",
      runGit: scopeGit(root, { onDeliveryLine: true }),
    });

    expect(result.code).toBe(1);
    expect(result.orphans).toHaveLength(1);
    expect(result.scope?.kind).toBe("sweep");
    expect(result.message).toContain("Scope: repo-wide sweep");
    expect(result.message).toContain("delivery-tip check");
  });

  it("falls back to the repo-wide sweep when the base ref is unresolvable", () => {
    const root = makeRepo();
    writeBrief(root, "stranded.xbrief.json", issuePlan(6001));
    writeCachedIssue(root, 6001, "closed");

    const result = evaluate(root, {
      repo: REPO,
      skipGh: true,
      changedOnly: true,
      baseRef: "origin/absent",
      runGit: (_cwd, args) =>
        args.join(" ") === "rev-parse --show-toplevel"
          ? ok(root)
          : { code: 1, stdout: "", stderr: "no" },
    });

    expect(result.code).toBe(1);
    expect(result.scope?.kind).toBe("sweep");
    expect(result.scope?.skipped).toBe(0);
    expect(result.message).toContain("origin/absent");
  });

  it("ignores changedOnly for the after-merge one-origin scan", () => {
    const root = makeRepo();
    writeBrief(root, "mine.xbrief.json", issuePlan(7001));
    writeCachedIssue(root, 7001, "closed");

    const result = evaluate(root, {
      repo: REPO,
      skipGh: true,
      issue: 7001,
      changedOnly: true,
      runGit: () => {
        throw new Error("git must not be consulted for --issue N");
      },
    });

    expect(result.code).toBe(1);
    expect(result.scope).toBeNull();
  });

  it("reports a null scope when changedOnly is off", () => {
    const root = makeRepo();
    const result = evaluate(root, { repo: REPO, skipGh: true });
    expect(result.scope).toBeNull();
  });
});
