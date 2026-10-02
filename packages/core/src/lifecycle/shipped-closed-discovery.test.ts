import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import type { RunGhApiFn } from "../scm/gh-rest.js";
import {
  authorMatchesIgnore,
  evaluateShippedClosedDiscovery,
  matchScopeIgnoreAttribution,
  resolveDiscoveryWindow,
} from "./shipped-closed-discovery.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-shipped-discovery-"));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["checkout", "-q", "-b", "master"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function apiPages(pages: unknown[][]): RunGhApiFn {
  let call = 0;
  return () => {
    const page = pages[call] ?? [];
    call += 1;
    return {
      returncode: 0,
      stdout: JSON.stringify(page),
      stderr: "",
    };
  };
}

describe("authorMatchesIgnore (#3495 S2)", () => {
  it("case-folds and tolerates [bot] suffix", () => {
    expect(authorMatchesIgnore("Dependabot[bot]", new Set(["dependabot"]))).toBe(true);
    expect(authorMatchesIgnore("dependabot", new Set(["Dependabot[bot]"]))).toBe(true);
    expect(authorMatchesIgnore("human", new Set(["dependabot[bot]"]))).toBe(false);
  });
});

describe("matchScopeIgnoreAttribution", () => {
  it("attributes label, milestone, and author", () => {
    const ignores = {
      labels: new Set(["noise"]),
      milestones: new Set(["parked"]),
      authors: new Set(["bot[bot]"]),
    };
    expect(
      matchScopeIgnoreAttribution(
        { number: 1, labels: [{ name: "noise" }], user: { login: "a" } },
        ignores,
      ),
    ).toMatchObject({ reason: "label", matchedRule: "noise" });
    expect(
      matchScopeIgnoreAttribution(
        {
          number: 2,
          labels: [],
          milestone: { title: "parked" },
          user: { login: "a" },
        },
        ignores,
      ),
    ).toMatchObject({ reason: "milestone", matchedRule: "parked" });
    expect(
      matchScopeIgnoreAttribution({ number: 3, labels: [], user: { login: "Bot" } }, ignores),
    ).toMatchObject({ reason: "author" });
  });
});

describe("resolveDiscoveryWindow", () => {
  it("uses N=30d for successful empty tag list", () => {
    const root = makeGitRepo();
    const tip = "HEAD";
    const runGit = (cwd: string, args: string[]) => {
      try {
        const stdout = execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout: String(stdout), stderr: "" };
      } catch (caught: unknown) {
        const e = caught as { status?: number; stdout?: string; stderr?: string };
        return {
          code: typeof e.status === "number" ? e.status : 1,
          stdout: typeof e.stdout === "string" ? e.stdout : "",
          stderr: typeof e.stderr === "string" ? e.stderr : "",
        };
      }
    };
    const window = resolveDiscoveryWindow(
      root,
      tip,
      runGit,
      () => new Date("2026-10-02T00:00:00Z"),
    );
    expect(window.status).toBe("ok");
    expect(window.dateField).toBe("fallback-30d");
    expect(window.note).toMatch(/unfetched-or-no-releases indistinguishable/);
    expect(window.tagListCardinality).toBe(0);
    expect(window.publishableCount).toBe(0);
    expect(window.startUtc).toBe("2026-09-02T00:00:00Z");
    expect(window.endUtc).toBe("2026-10-02T00:00:00Z");
    expect(window.tipSha).toMatch(/^[0-9a-f]+$/);
  });

  it("fails closed on git tag-list hard-fail", () => {
    const root = makeGitRepo();
    const runGit = (_cwd: string, args: string[]) => {
      if (args[0] === "tag") {
        return { code: 128, stdout: "", stderr: "fatal" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      return { code: 0, stdout: "true\n", stderr: "" };
    };
    const window = resolveDiscoveryWindow(root, "HEAD", runGit);
    expect(window.status).toBe("failed");
    expect(window.failureReason).toMatch(/git-tag-list-failed/);
  });
});

describe("evaluateShippedClosedDiscovery (#3495)", () => {
  it("warns on merged-closing-pr debt and fails under --enforce", () => {
    const root = makeGitRepo();
    const closedAt = "2026-09-20T12:00:00Z";
    const updatedAt = "2026-09-21T12:00:00Z";
    const issuePage = [
      {
        number: 19,
        state: "closed",
        state_reason: "completed",
        closed_at: closedAt,
        labels: [],
        user: { login: "dev" },
      },
    ];
    const pullPage = [
      {
        number: 20,
        merged_at: closedAt,
        updated_at: updatedAt,
      },
    ];
    let apiCall = 0;
    const runGhApiFn: RunGhApiFn = (args) => {
      const endpoint = String(args[0] ?? "");
      apiCall += 1;
      if (endpoint.includes("/issues")) {
        return { returncode: 0, stdout: JSON.stringify(issuePage), stderr: "" };
      }
      if (endpoint.includes("/pulls")) {
        return { returncode: 0, stdout: JSON.stringify(pullPage), stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected ${endpoint}` };
    };
    const runGh: RunGhFn = (cmd) => {
      if (cmd.includes("closingIssuesReferences")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ closingIssuesReferences: [{ number: 19 }] }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
    };

    const warn = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      runGhApiFn,
      runGh,
      tipOriginNumbers: new Set(),
      scopeIgnores: { labels: new Set(), milestones: new Set(), authors: new Set() },
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(warn.code).toBe(0);
    expect(warn.candidates).toEqual([
      expect.objectContaining({ issue: 19, facet: "merged-closing-pr" }),
    ]);
    expect(warn.counts.missingDebt).toBe(1);
    expect(warn.message).toMatch(/facet=merged-closing-pr/);
    expect(warn.message).toMatch(/pull-walk: outcome=/);
    expect(
      warn.pullWalk.outcome === "list-exhausted" || warn.pullWalk.outcome === "window-exhausted",
    ).toBe(true);

    const enforced = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      enforce: true,
      runGhApiFn,
      runGh,
      tipOriginNumbers: new Set(),
      scopeIgnores: { labels: new Set(), milestones: new Set(), authors: new Set() },
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(enforced.code).toBe(1);
    expect(enforced.message).toMatch(/enforce: FAIL/);
    expect(apiCall).toBeGreaterThan(0);
  });

  it("keeps none report-only under enforce when index is complete", () => {
    const root = makeGitRepo();
    const closedAt = "2026-09-20T12:00:00Z";
    const issuePage = [
      {
        number: 42,
        state: "closed",
        state_reason: "completed",
        closed_at: closedAt,
        labels: [],
        user: { login: "dev" },
      },
    ];
    const runGhApiFn = apiPages([issuePage, []]);
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ closingIssuesReferences: [] }),
      stderr: "",
    });
    const result = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      enforce: true,
      runGhApiFn,
      runGh,
      tipOriginNumbers: new Set(),
      scopeIgnores: { labels: new Set(), milestones: new Set(), authors: new Set() },
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(result.candidates[0]?.facet).toBe("none");
    expect(result.counts.reportOnly).toBe(1);
    expect(result.counts.missingDebt).toBe(0);
    // none is report-only until #4713 — enforce stays green when index complete.
    expect(result.code).toBe(0);
  });

  it("prints mandatory ordering caveat on list-exhausted", () => {
    const root = makeGitRepo();
    const runGhApiFn = apiPages([[], []]);
    const result = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      runGhApiFn,
      runGh: () => ({ returncode: 0, stdout: "{}", stderr: "" }),
      tipOriginNumbers: new Set(),
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(result.pullWalk.outcome).toBe("list-exhausted");
    expect(result.message).toMatch(/ordering race accepted/);
  });

  it("marks skip-gh as unresolved and fails under enforce", () => {
    const root = makeGitRepo();
    const result = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      skipGh: true,
      enforce: true,
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(result.code).toBe(1);
    expect(result.counts.unresolved).toBe(1);
    expect(result.message).toMatch(/skip-gh/);
  });

  it("exempts abandoned-closed and ignored milestone", () => {
    const root = makeGitRepo();
    const closedAt = "2026-09-20T12:00:00Z";
    const issuePage = [
      {
        number: 7,
        state: "closed",
        state_reason: "not_planned",
        closed_at: closedAt,
        labels: [],
        user: { login: "dev" },
      },
      {
        number: 8,
        state: "closed",
        state_reason: "completed",
        closed_at: closedAt,
        labels: [],
        milestone: { title: "backlog" },
        user: { login: "dev" },
      },
    ];
    const runGhApiFn = apiPages([issuePage, []]);
    const result = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      runGhApiFn,
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({ closingIssuesReferences: [] }),
        stderr: "",
      }),
      tipOriginNumbers: new Set(),
      scopeIgnores: {
        labels: new Set(),
        milestones: new Set(["backlog"]),
        authors: new Set(),
      },
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(result.exempt.map((e) => e.reason).sort()).toEqual(["abandoned-closed", "milestone"]);
    expect(result.candidates).toEqual([]);
  });

  it("skips tip-tree origins across five folders", () => {
    const root = makeGitRepo();
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "completed", "landed.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          status: "completed",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/19",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    git(root, ["add", "xbrief/completed/landed.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "land"]);

    const closedAt = "2026-09-20T12:00:00Z";
    const issuePage = [
      {
        number: 19,
        state: "closed",
        state_reason: "completed",
        closed_at: closedAt,
        labels: [],
        user: { login: "dev" },
      },
    ];
    const runGhApiFn = apiPages([issuePage, []]);
    const result = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      runGhApiFn,
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({ closingIssuesReferences: [{ number: 19 }] }),
        stderr: "",
      }),
      scopeIgnores: { labels: new Set(), milestones: new Set(), authors: new Set() },
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(result.candidates).toEqual([]);
  });

  it("does not treat a foreign same-number tip origin as local coverage", () => {
    const root = makeGitRepo();
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "completed", "foreign.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          status: "completed",
          references: [
            {
              uri: "https://github.com/other-org/other-repo/issues/19",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    git(root, ["add", "xbrief/completed/foreign.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "foreign land"]);

    const closedAt = "2026-09-20T12:00:00Z";
    const issuePage = [
      {
        number: 19,
        state: "closed",
        state_reason: "completed",
        closed_at: closedAt,
        labels: [],
        user: { login: "dev" },
      },
    ];
    const runGhApiFn = apiPages([
      issuePage,
      [
        {
          number: 99,
          state: "closed",
          merged_at: closedAt,
          updated_at: closedAt,
        },
      ],
      [],
    ]);
    const result = evaluateShippedClosedDiscovery(root, {
      repo: "deftai/directive",
      tip: "HEAD",
      enforce: true,
      runGhApiFn,
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({ closingIssuesReferences: [{ number: 19 }] }),
        stderr: "",
      }),
      scopeIgnores: { labels: new Set(), milestones: new Set(), authors: new Set() },
      now: () => new Date("2026-10-02T00:00:00Z"),
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({ issue: 19, facet: "merged-closing-pr" }),
    ]);
    expect(result.code).toBe(1);
  });
});
