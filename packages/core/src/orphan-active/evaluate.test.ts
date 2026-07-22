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
    expect(result.message).toContain("task scope:complete");
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
});
