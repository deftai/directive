import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { evaluate } from "./evaluate.js";
import { collectGithubRefs, parseGithubPrUri } from "./refs.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-orphan-active-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  return root;
}

function writeBrief(root: string, name: string, plan: Record<string, unknown>): void {
  writeFileSync(
    join(root, "xbrief", "active", name),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan,
    }),
    "utf8",
  );
}

function writeCachedIssue(
  root: string,
  repo: string,
  number: number,
  state: "open" | "closed",
): void {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    throw new Error(`invalid repo slug: ${repo}`);
  }
  const dir = join(root, ".deft-cache", "github-issue", owner, name, String(number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify({ number, state }), "utf8");
}

describe("parseGithubPrUri", () => {
  it("parses full GitHub PR URLs", () => {
    expect(parseGithubPrUri("https://github.com/deftai/directive/pull/2753")).toEqual([
      "deftai/directive",
      2753,
    ]);
  });

  it("parses bare PR numbers", () => {
    expect(parseGithubPrUri("2753")).toEqual([null, 2753]);
  });

  it("rejects invalid PR URI shapes", () => {
    expect(parseGithubPrUri("")).toEqual([null, null]);
    expect(parseGithubPrUri(null)).toEqual([null, null]);
    expect(parseGithubPrUri("not-a-number")).toEqual([null, null]);
  });
});

describe("collectGithubRefs", () => {
  it("collects issue, PR, and x-tracking refs", () => {
    const { issues, prs } = collectGithubRefs(
      {
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/2321",
            type: "x-xbrief/github-issue",
          },
          {
            uri: "https://github.com/deftai/directive/pull/9999",
            type: "x-xbrief/github-pr",
          },
        ],
        metadata: {
          "x-tracking": {
            parent_issue: "#2321",
          },
        },
      },
      "deftai/directive",
    );
    expect(issues).toEqual([{ repo: "deftai/directive", number: 2321 }]);
    expect(prs).toEqual([{ repo: "deftai/directive", number: 9999 }]);
  });

  it("collects x-tracking parent issue refs", () => {
    const { issues } = collectGithubRefs(
      {
        metadata: {
          "x-tracking": {
            parent_issue: "#1234",
            decomposition_origin: 5678,
          },
        },
      },
      "deftai/directive",
    );
    expect(issues).toEqual([
      { repo: "deftai/directive", number: 1234 },
      { repo: "deftai/directive", number: 5678 },
    ]);
  });
});

describe("evaluate", () => {
  it("returns 0 when active running brief references open issues", () => {
    const root = makeRepo();
    writeBrief(root, "open-story.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/2321",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 2321, "open");
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true });
    expect(result.code).toBe(0);
    expect(result.orphans).toEqual([]);
  });

  it("flags orphan when all referenced issues are closed", () => {
    const root = makeRepo();
    writeBrief(root, "shipped-story.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/1001",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 1001, "closed");
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true });
    expect(result.code).toBe(1);
    expect(result.orphans).toEqual([
      {
        path: "xbrief/active/shipped-story.xbrief.json",
        reason: "all referenced issues are closed",
      },
    ]);
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/shipped-story.xbrief.json",
    );
  });

  it("fails closed on --issue N when that origin is a closed active brief", () => {
    const root = makeRepo();
    writeBrief(root, "shipped-story.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/1001",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeBrief(root, "other-orphan.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/2002",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 1001, "closed");
    writeCachedIssue(root, "deftai/directive", 2002, "closed");
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true, issue: 1001 });
    expect(result.code).toBe(1);
    expect(result.orphans).toEqual([
      {
        path: "xbrief/active/shipped-story.xbrief.json",
        reason: "issue #1001 is closed",
      },
    ]);
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/shipped-story.xbrief.json",
    );
    expect(result.message).not.toContain("other-orphan.xbrief.json");
  });

  it("returns 0 for --issue N when that origin is still open and the PR is unmerged", () => {
    const root = makeRepo();
    writeBrief(root, "live-story.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/1001",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "https://github.com/deftai/directive/pull/43",
          type: "x-xbrief/github-pr",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 1001, "open");
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/pulls/43")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ merged_at: null }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = evaluate(root, { repo: "deftai/directive", runGh, issue: 1001 });
    expect(result.code).toBe(0);
    expect(result.orphans).toEqual([]);
    expect(result.message).toContain("for issue #1001");
  });

  it("flags orphan when linked PR is merged", () => {
    const root = makeRepo();
    writeBrief(root, "merged-pr-story.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/pull/42",
          type: "x-xbrief/github-pr",
        },
      ],
    });
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/pulls/42")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ merged_at: "2026-07-22T00:00:00Z" }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = evaluate(root, { repo: "deftai/directive", runGh });
    expect(result.code).toBe(1);
    expect(result.orphans[0]?.reason).toBe("linked PR #42 is merged");
  });

  it("ignores non-running active briefs", () => {
    const root = makeRepo();
    writeBrief(root, "blocked-story.xbrief.json", {
      status: "blocked",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/1001",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 1001, "closed");
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true });
    expect(result.code).toBe(0);
  });

  it("fails closed on --issue N when a linked PR lookup fails even if the origin is open", () => {
    const root = makeRepo();
    writeBrief(root, "open-issue-unknown-pr.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/1001",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "https://github.com/deftai/directive/pull/42",
          type: "x-xbrief/github-pr",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 1001, "open");
    const runGh: RunGhFn = () => ({
      returncode: 1,
      stdout: "",
      stderr: "api failed",
    });
    const result = evaluate(root, { repo: "deftai/directive", runGh, issue: 1001 });
    expect(result.code).toBe(1);
    expect(result.orphans[0]?.reason).toBe("linked PR #42 state could not be resolved");
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/open-issue-unknown-pr.xbrief.json",
    );
  });

  it("fails closed on --issue N when a linked PR is merged even if an issue is still open", () => {
    const root = makeRepo();
    writeBrief(root, "open-issue-merged-pr.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/1001",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "https://github.com/deftai/directive/pull/42",
          type: "x-xbrief/github-pr",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 1001, "open");
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/pulls/42")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ merged_at: "2026-08-17T00:00:00Z" }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = evaluate(root, { repo: "deftai/directive", runGh, issue: 1001 });
    expect(result.code).toBe(1);
    expect(result.orphans[0]?.reason).toBe("linked PR #42 is merged");
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/open-issue-merged-pr.xbrief.json",
    );
  });

  it("fails closed on --issue N when origin state cannot be resolved", () => {
    const root = makeRepo();
    writeBrief(root, "unknown-state.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/4040",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true, issue: 4040 });
    expect(result.code).toBe(1);
    expect(result.orphans[0]?.reason).toBe("issue #4040 state could not be resolved");
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/unknown-state.xbrief.json",
    );
  });

  it("fails closed on --issue N when the selected origin is unknown even if a sibling is open", () => {
    const root = makeRepo();
    writeBrief(root, "multi-origin.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/4040",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "https://github.com/deftai/directive/issues/2002",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 2002, "open");
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true, issue: 4040 });
    expect(result.code).toBe(1);
    expect(result.orphans[0]?.reason).toBe("issue #4040 state could not be resolved");
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/multi-origin.xbrief.json",
    );
  });

  it("fails closed on --issue N when the selected origin is closed even if a sibling is open", () => {
    const root = makeRepo();
    writeBrief(root, "closed-origin-open-sibling.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/1001",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "https://github.com/deftai/directive/issues/2002",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 1001, "closed");
    writeCachedIssue(root, "deftai/directive", 2002, "open");
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true, issue: 1001 });
    expect(result.code).toBe(1);
    expect(result.orphans[0]?.reason).toBe("issue #1001 is closed");
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/closed-origin-open-sibling.xbrief.json",
    );
  });

  it("does not orphan when issue state is unknown", () => {
    const root = makeRepo();
    writeBrief(root, "unknown-state.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/4040",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true });
    expect(result.code).toBe(0);
  });

  it("skips cleanly when xbrief layout is absent (legacy vbrief consumer)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-orphan-no-xbrief-"));
    temps.push(root);
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true });
    expect(result.code).toBe(0);
    expect(result.message).toContain("nothing to scan");
  });

  it("returns config error when project root is missing", () => {
    const result = evaluate(join(tmpdir(), "deft-orphan-missing-root-never"), {
      repo: "deftai/directive",
      skipGh: true,
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("does not exist");
  });

  it("quiet mode suppresses success output", () => {
    const root = makeRepo();
    writeBrief(root, "open-story.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/2321",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    writeCachedIssue(root, "deftai/directive", 2321, "open");
    const result = evaluate(root, { repo: "deftai/directive", skipGh: true, quiet: true });
    expect(result.code).toBe(0);
    expect(result.stream).toBe("none");
    expect(result.message).toBe("");
  });

  it("does not orphan when linked PR is still open", () => {
    const root = makeRepo();
    writeBrief(root, "open-pr-story.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/pull/43",
          type: "x-xbrief/github-pr",
        },
      ],
    });
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/pulls/43")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ merged_at: null }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = evaluate(root, { repo: "deftai/directive", runGh });
    expect(result.code).toBe(0);
    expect(result.orphans).toEqual([]);
  });

  it("uses live gh issue state when cache is absent", () => {
    const root = makeRepo();
    writeBrief(root, "live-issue.xbrief.json", {
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/5000",
          type: "x-xbrief/github-issue",
        },
      ],
    });
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/issues/5000")) {
        return { returncode: 0, stdout: JSON.stringify({ state: "open" }), stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const result = evaluate(root, { repo: "deftai/directive", runGh });
    expect(result.code).toBe(0);
  });
});
