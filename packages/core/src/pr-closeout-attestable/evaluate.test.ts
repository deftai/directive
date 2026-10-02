import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import type { GitRunner } from "../session/git.js";
import { ENV_TRIAGE_REPO } from "../triage/queue/constants.js";
import { evaluate, type FetchClosingIssuesFn } from "./evaluate.js";

const gitSpy = vi.hoisted(() => ({ fetchCalls: [] as string[][] }));

vi.mock("../session/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session/git.js")>();
  const wrapped: GitRunner = (root, args) => {
    if (args.includes("fetch")) {
      gitSpy.fetchCalls.push([...args]);
    }
    return actual.defaultGitRunner(root, args);
  };
  return { ...actual, defaultGitRunner: wrapped };
});

const REPO = "deftai/directive";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-closeout-attestable-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  return root;
}

function writeBrief(root: string, name: string, plan: Record<string, unknown>): string {
  const path = join(root, "xbrief", "active", name);
  writeFileSync(
    path,
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

function issueRef(number: number, repo: string = REPO): Record<string, unknown> {
  return {
    uri: `https://github.com/${repo}/issues/${number}`,
    type: "x-xbrief/github-issue",
    title: `Issue #${number}`,
  };
}

/** Five bare `title` + `status: proposed` items — the exact #3609 brief shape. */
function bareItems(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `Acceptance criterion ${i + 1}`,
    status: "proposed",
  }));
}

function attestedItem(title: string): Record<string, unknown> {
  // Empty-axis / undeclared criteria accept non-merge kinds (#5105 dual).
  // kind:merge needs explicit x-directive/requires=merge + a commit-sha pointer.
  return {
    title,
    status: "proposed",
    "x-directive/evidence": {
      kind: "test",
      pointer: "packages/core/src/pr-closeout-attestable/evaluate.test.ts",
      recorded_at: "2026-08-27T02:23:58Z",
      recorded_by: "swarm:finalize-cohort",
    },
  };
}

function closing(...issues: number[]): FetchClosingIssuesFn {
  return () => [...issues];
}

const NEVER_CALLED: RunGhFn = () => {
  throw new Error("runGh must not be called");
};

const MATCHING_HEAD = "a".repeat(40);

function opts(fetchClosingIssues: FetchClosingIssuesFn, proxied = false) {
  return {
    repo: REPO,
    runner: { runGh: NEVER_CALLED, proxied },
    fetchClosingIssues,
    // Hermetic suites pin matching SHAs so the #3875 assert does not hit git/gh.
    prHeadAssert: { localHeadSha: MATCHING_HEAD, prHeadSha: MATCHING_HEAD },
  };
}

describe("pr-closeout-attestable evaluate", () => {
  it("fails closed when the PR closes an issue whose running brief is unattested", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.issue).toBe(3609);
    expect(result.findings[0]?.unattested).toHaveLength(5);
  });

  it("passes when every non-terminal criterion carries evidence", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: [attestedItem("only criterion")],
    });

    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.message).toContain("#3609");
  });

  it("leaves an unattested brief alone when the PR does not close its issue", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(root, 3786, opts(closing(3610)));

    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("ignores a same-numbered issue that belongs to another repository", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609, "otherorg/otherrepo")],
      items: bareItems(5),
    });

    // The PR closes deftai/directive#3609; the brief tracks otherorg/otherrepo#3609.
    // A bare-number match would block this merge on an unrelated brief.
    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("still matches when the brief slug differs from the PR repo only by case", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609, "DeftAI/Directive")],
      items: bareItems(5),
    });

    // GitHub owner/repo slugs are case-insensitive. A case-sensitive compare
    // would miss this brief and fail the gate open on an unattested closeout.
    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(1);
    expect(result.findings[0]?.issue).toBe(3609);
  });

  it("still matches a brief that names the issue as a bare tracking number", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      metadata: { "x-tracking": { parent_issue: "#3609" } },
      items: bareItems(2),
    });

    // A bare number carries no repo of its own, so it reads as this repository.
    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(1);
    expect(result.findings[0]?.issue).toBe(3609);
  });

  it("refuses when OWNER/REPO cannot be resolved for the closing-reference read", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(1),
    });
    // Stop git walking into this checkout, and drop the env fallback, so
    // resolveRepo cannot inherit deftai/directive from the parent tree.
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root, stdio: "ignore" });
    const prevRepo = process.env[ENV_TRIAGE_REPO];
    delete process.env[ENV_TRIAGE_REPO];
    try {
      const result = evaluate(root, 3786, {
        repo: null,
        runner: { runGh: NEVER_CALLED, proxied: false },
        fetchClosingIssues: closing(3609),
      });

      expect(result.code).toBe(2);
      expect(result.message).toContain("cannot resolve OWNER/REPO");
    } finally {
      if (prevRepo === undefined) {
        delete process.env[ENV_TRIAGE_REPO];
      } else {
        process.env[ENV_TRIAGE_REPO] = prevRepo;
      }
    }
  });

  it("passes when the PR closes nothing", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(root, 3786, opts(closing()));

    expect(result.code).toBe(0);
    expect(result.message).toContain("closes no issue");
  });

  it("ignores briefs whose status is not running", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "paused",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    expect(evaluate(root, 3786, opts(closing(3609))).code).toBe(0);
  });

  it("refuses to certify a merge when the closing-reference lookup fails", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(
      root,
      3786,
      opts(() => null),
    );

    expect(result.code).toBe(2);
    expect(result.message).toContain("could not read closing-issue references");
  });

  it("reports config error for a missing project root", () => {
    const result = evaluate(join(tmpdir(), "deft-closeout-absent-root"), 1, opts(closing(1)));
    expect(result.code).toBe(2);
  });

  it("passes cleanly when the project has no xbrief/ lifecycle root", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-closeout-nolayout-"));
    temps.push(root);
    const result = evaluate(root, 1, opts(closing(1)));
    expect(result.code).toBe(0);
    expect(result.message).toContain("nothing to check");
  });

  it("no-xbrief fails closed when OWNER/REPO cannot be resolved (#3875)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-closeout-nolayout-norepo-"));
    temps.push(root);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root, stdio: "ignore" });
    const prevRepo = process.env[ENV_TRIAGE_REPO];
    delete process.env[ENV_TRIAGE_REPO];
    try {
      const result = evaluate(root, 1, {
        repo: null,
        runner: { runGh: NEVER_CALLED, proxied: false },
        fetchClosingIssues: closing(1),
      });
      expect(result.code).toBe(2);
      expect(result.message).toContain("cannot resolve OWNER/REPO");
    } finally {
      if (prevRepo === undefined) {
        delete process.env[ENV_TRIAGE_REPO];
      } else {
        process.env[ENV_TRIAGE_REPO] = prevRepo;
      }
    }
  });

  it("no-xbrief skip wins over a PR-head mismatch when no linked worktree (#3875)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-closeout-nolayout-mismatch-"));
    temps.push(root);
    const result = evaluate(root, 1, {
      repo: REPO,
      runner: { runGh: NEVER_CALLED, proxied: false },
      fetchClosingIssues: closing(1),
      prHeadAssert: {
        localHeadSha: "a".repeat(40),
        prHeadSha: "b".repeat(40),
        resolveWorktreeAtSha: () => null,
      },
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("nothing to check");
  });

  it("no-xbrief fails closed when PR-head SHA lookup fails (#3875)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-closeout-nolayout-fetchfail-"));
    temps.push(root);
    const result = evaluate(root, 1, {
      repo: REPO,
      runner: { runGh: NEVER_CALLED, proxied: false },
      fetchClosingIssues: closing(1),
      prHeadAssert: {
        prHeadSha: null,
        resolveWorktreeAtSha: () => {
          throw new Error("must not probe worktree after failed PR-head lookup");
        },
      },
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("cannot read PR #1 head SHA");
  });

  it("no-xbrief fails closed when a found worktree HEAD mismatches (#3875)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-closeout-nolayout-headfail-"));
    temps.push(root);
    const result = evaluate(root, 1, {
      repo: REPO,
      runner: { runGh: NEVER_CALLED, proxied: false },
      fetchClosingIssues: closing(1),
      prHeadAssert: {
        prHeadSha: "b".repeat(40),
        resolveWorktreeAtSha: () => root,
        resolveLocalHeadSha: () => "a".repeat(40),
      },
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("is not PR #1 head");
  });

  it("no-xbrief caller still reads a linked PR-head worktree with xbrief (#3875)", () => {
    const primary = mkdtempSync(join(tmpdir(), "deft-closeout-primary-"));
    const dest = makeRepo();
    temps.push(primary);
    writeBrief(dest, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(2),
    });
    const prHead = "b".repeat(40);
    const result = evaluate(primary, 3786, {
      repo: REPO,
      runner: { runGh: NEVER_CALLED, proxied: false },
      fetchClosingIssues: closing(3609),
      prHeadAssert: {
        prHeadSha: prHead,
        resolveWorktreeAtSha: () => dest,
        resolveLocalHeadSha: (root) => (root === dest ? prHead : "a".repeat(40)),
        resolveLifecycleDirty: () => null,
      },
    });
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.issue).toBe(3609);
  });

  it("walks nested subItems and items", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: [
        {
          ...attestedItem("parent"),
          subItems: [{ title: "nested", status: "proposed" }],
        },
      ],
    });

    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(1);
    expect(result.findings[0]?.unattested.map((c) => c.path)).toEqual(["items[0].subItems[0]"]);
  });
});

describe("pr-closeout-attestable failure message", () => {
  function refusalFor(items: Record<string, unknown>[]): string {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items,
    });
    const result = evaluate(root, 3786, opts(closing(3609)));
    expect(result.code).toBe(1);
    return result.message;
  }

  it("names every unattested criterion and the shape it needs", () => {
    const message = refusalFor(bareItems(5));

    for (let i = 1; i <= 5; i += 1) {
      expect(message).toContain(`Acceptance criterion ${i}`);
    }
    expect(message).toContain(
      "x-directive/evidence {kind: test|review|merge|deploy|smoke|uat|observed_behavior, pointer, recorded_at, recorded_by}",
    );
    expect(message).toContain(
      "x-directive/disposition {disposition: waived|deferred|not_applicable, reason, " +
        "provenance {kind: operator-cli|operator-session|human-event, actor: <non-agent>}, recorded_at}",
    );
  });

  it("narrows the kind taxonomy for a criterion that requires one strict axis", () => {
    const message = refusalFor([{ title: "Smoke the new worker", status: "proposed" }]);

    expect(message).toContain(
      "x-directive/evidence {kind: smoke, pointer, recorded_at, recorded_by}",
    );
    expect(message).toContain("merge and review evidence cannot satisfy it");
    // The generic taxonomy must not be offered for a strict-axis criterion.
    expect(message).not.toContain("{kind: test|review|merge|");
  });

  it("says no single kind works when a criterion infers two strict axes", () => {
    const message = refusalFor([{ title: "Smoke the deployed worker", status: "proposed" }]);

    expect(message).toContain("requires smoke + deploy");
    expect(message).toContain("no single evidence.kind covers");
    expect(message).toContain('pin one axis with "requires": "smoke"');
    expect(message).toContain("split the criterion one axis per item");
  });

  it("states the trigger and a remediation the PR author can perform", () => {
    const message = refusalFor(bareItems(1));

    expect(message).toContain("closing references, not the branch diff");
    expect(message).toContain("task verify:pr-closeout-attestable -- --pr 3786");
    expect(message).toContain("recorded_by accepts any non-empty string");
    expect(message).toContain("stamp the non-merge criteria above");
    expect(message).not.toContain("cached");
  });

  it("does not tell the PR author to stamp-evidence a merge-declared criterion", () => {
    const message = refusalFor([
      {
        title: "Merge tip ancestry",
        status: "pending",
        "x-directive/requires": "merge",
      },
    ]);

    expect(message).toContain("scope:stamp-evidence");
    expect(message).toContain("no --merge-commit");
    expect(message).not.toContain("stamp the criteria above");
    expect(message).not.toContain("stamp the non-merge criteria");
  });

  it("discloses the ghx cache caveat when the read could not be pinned to gh", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(1),
    });

    const refused = evaluate(root, 3786, opts(closing(3609), true));
    expect(refused.code).toBe(1);
    expect(refused.proxied).toBe(true);
    expect(refused.message).toContain("cached");

    const passed = evaluate(root, 3786, opts(closing(3610), true));
    expect(passed.code).toBe(0);
    expect(passed.message).toContain("cached");
  });
});

/**
 * #3598 regression: the brief landed on master seventeen hours before the PR that
 * closed its issue, so the closing PR's diff never touches it. A diff-keyed gate
 * misses the culprit entirely; the closing reference still fires.
 */
describe("pr-closeout-attestable #3598 shape (brief predates the closing branch)", () => {
  function git(root: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("fires on the closing reference even though the brief is absent from the branch diff", () => {
    const root = makeRepo();
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.email", "ci@example.com"]);
    git(root, ["config", "user.name", "ci"]);

    // The brief lands on master first — the normal promote/activate lifecycle.
    writeBrief(root, "2026-08-25-3598-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3598)],
      items: bareItems(3),
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "chore(xbrief): activate the #3598 brief"]);

    // The closing PR branches later and touches only unrelated source.
    git(root, ["switch", "-q", "-c", "fix/3598-implementation"]);
    writeFileSync(join(root, "src.ts"), "export const fixed = true;\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "fix: implement #3598"]);

    const changed = git(root, ["diff", "--name-only", "master...HEAD"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(changed).toEqual(["src.ts"]);

    const result = evaluate(root, 3775, opts(closing(3598)));

    expect(result.code).toBe(1);
    expect(result.findings[0]?.briefPath).toBe("xbrief/active/2026-08-25-3598-story.xbrief.json");
    expect(result.findings[0]?.unattested).toHaveLength(3);
  });
});

describe("pr-closeout-attestable persisted merge evidence (#5120)", () => {
  function git(root: string, args: string[]): string {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "ci",
        GIT_AUTHOR_EMAIL: "ci@example.com",
        GIT_COMMITTER_NAME: "ci",
        GIT_COMMITTER_EMAIL: "ci@example.com",
      },
    });
  }

  function makeOriginRepo(): { root: string; sha: string } {
    const root = makeRepo();
    const origin = mkdtempSync(join(tmpdir(), "deft-closeout-origin-"));
    temps.push(origin);
    git(origin, ["init", "--bare", "-q", "-b", "master"]);
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.email", "ci@example.com"]);
    git(root, ["config", "user.name", "ci"]);
    writeFileSync(join(root, "README"), "closeout-origin\n", "utf8");
    git(root, ["add", "README"]);
    git(root, ["commit", "-q", "-m", "init"]);
    git(root, ["remote", "add", "origin", origin]);
    git(root, ["push", "-q", "-u", "origin", "master"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();
    return { root, sha };
  }

  function mergeDeclaredPlan(sha: string, withEvidence: boolean): Record<string, unknown> {
    const item: Record<string, unknown> = {
      id: "clause.1",
      title: "Merge tip ancestry",
      status: "pending",
      "x-directive/requires": "merge",
    };
    if (withEvidence) {
      item["x-directive/evidence"] = {
        kind: "merge",
        pointer: sha,
        recorded_at: "2026-09-30T00:00:00Z",
        recorded_by: "scope:complete",
      };
    }
    return {
      title: "story",
      status: "running",
      references: [issueRef(5120)],
      items: [item],
      acceptance: {
        clauses: [{ id: 1, text: "Merge tip ancestry", artifact_path: null, ambiguous: false }],
      },
      metadata: withEvidence
        ? {}
        : {
            completionProvenance: {
              mergeCommit: sha,
              deliveryBranch: "master",
              verifier: "scope:complete",
            },
          },
    };
  }

  it("refuses valid provenance with no persisted evidence and leaves bytes unchanged", () => {
    const { root, sha } = makeOriginRepo();
    const briefPath = writeBrief(
      root,
      "2026-09-30-5120-story.xbrief.json",
      mergeDeclaredPlan(sha, false),
    );
    const before = readFileSync(briefPath, "utf8");
    gitSpy.fetchCalls.length = 0;
    const result = evaluate(root, 5120, opts(closing(5120)));
    expect(result.code).toBe(1);
    expect(result.findings[0]?.unattested).toHaveLength(1);
    expect(readFileSync(briefPath, "utf8")).toBe(before);
    expect(gitSpy.fetchCalls).toEqual([]);
  });

  it("passes when persisted merge evidence is present and does not rewrite the brief", () => {
    const root = makeRepo();
    const sha = "abcdef1";
    const briefPath = writeBrief(
      root,
      "2026-09-30-5120-story.xbrief.json",
      mergeDeclaredPlan(sha, true),
    );
    const before = readFileSync(briefPath, "utf8");
    const result = evaluate(root, 5120, opts(closing(5120)));
    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
    expect(readFileSync(briefPath, "utf8")).toBe(before);
  });
});

describe("one-PR-unit at forge closing references (#4494)", () => {
  it("fails closed when forge closing refs name five origins without a grant", () => {
    const root = makeRepo();
    writeBrief(root, "dummy.xbrief.json", {
      title: "dummy",
      status: "running",
      items: [],
      references: [issueRef(1)],
    });
    const result = evaluate(root, 4492, opts(closing(4204, 4218, 4161, 3918, 3849)));
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/missing one-PR-unit consent/);
  });

  it("allows a single closing origin without a grant", () => {
    const root = makeRepo();
    writeBrief(root, "dummy.xbrief.json", {
      title: "dummy",
      status: "running",
      items: [],
      references: [issueRef(4494)],
    });
    const result = evaluate(root, 1, opts(closing(4494)));
    expect(result.code).toBe(0);
  });

  it("does not attest the wrong PR by substituting the claim node id", () => {
    const root = makeRepo();
    writeBrief(root, "dummy.xbrief.json", {
      title: "dummy",
      status: "running",
      items: [],
      references: [issueRef(1)],
    });
    const grant = {
      schema: "deft.one-pr-unit.v1",
      id: "unit-five",
      origin: {
        kind: "operator-cli",
        actor: "dbcall2",
        mintedAt: "2026-09-14T00:00:00Z",
        mintedVia: "authz:grant/one-pr-unit",
        eventRef: "op",
      },
      approvalRef: "op",
      rationale: "batch",
      origins: [4204, 4218, 4161, 3918, 3849].map((issueId) => ({
        repo: REPO,
        issueId,
      })),
      repo: REPO,
      state: "bound",
      prNodeId: "PR_NODE_A",
      mintedBy: "dbcall2",
      mintedAt: "2026-09-14T00:00:00Z",
      expiresAt: "2026-09-15T00:00:00Z",
      boundAt: "2026-09-14T00:01:00Z",
      spentAt: null,
      revokedAt: null,
      expiredAt: null,
    };
    const result = evaluate(root, 4492, {
      ...opts(closing(4204, 4218, 4161, 3918, 3849)),
      onePrUnitGrant: grant,
    });
    expect(result.code).toBe(1);
    expect(result.message).not.toMatch(/OK:/);
  });
});

describe("pr-closeout-attestable PR-head assert (#3875)", () => {
  it("fails exit 2 when local HEAD is not the PR head", () => {
    const root = makeRepo();
    writeBrief(root, "2026-10-02-3875-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3875)],
      items: [attestedItem("ok")],
    });

    const result = evaluate(root, 99, {
      ...opts(closing(3875)),
      prHeadAssert: {
        localHeadSha: "b".repeat(40),
        prHeadSha: "c".repeat(40),
      },
    });

    expect(result.code).toBe(2);
    expect(result.message).toContain("is not PR #99 head");
    expect(result.message).toContain("tree that merges");
  });

  it("fails exit 2 when the PR head SHA cannot be read", () => {
    const root = makeRepo();
    writeBrief(root, "2026-10-02-3875-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3875)],
      items: [attestedItem("ok")],
    });

    const result = evaluate(root, 99, {
      ...opts(closing(3875)),
      prHeadAssert: {
        localHeadSha: MATCHING_HEAD,
        prHeadSha: null,
      },
    });

    expect(result.code).toBe(2);
    expect(result.message).toContain("cannot read PR #99 head SHA");
  });

  it("passes the assert when abbreviated and full SHAs name the same commit", () => {
    const root = makeRepo();
    writeBrief(root, "2026-10-02-3875-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3875)],
      items: [attestedItem("ok")],
    });

    const full = "abcdef0123456789abcdef0123456789abcdef01";
    const result = evaluate(root, 99, {
      ...opts(closing(3875)),
      prHeadAssert: {
        localHeadSha: full.slice(0, 12),
        prHeadSha: full,
      },
    });

    expect(result.code).toBe(0);
  });
});
