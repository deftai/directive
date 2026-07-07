import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeReferencedIssueNumbers,
  blockedByIssueNumber,
  issueNumbersFromPlan,
  rankByIssueNumber,
  scopeIsBlocked,
  scopeMetadataRank,
} from "./scope-walk.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-walk-br-"));
  roots.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
  return root;
}

function writeVbrief(root: string, folder: string, name: string, body: unknown): void {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body), "utf8");
}

describe("issueNumbersFromPlan branches", () => {
  it("returns empty set when references are absent or invalid", () => {
    expect(issueNumbersFromPlan({})).toEqual(new Set());
    expect(issueNumbersFromPlan({ references: null })).toEqual(new Set());
    expect(
      issueNumbersFromPlan({
        references: [null, { type: "other" }, { type: "x-vbrief/github-issue", uri: 42 }],
      }),
    ).toEqual(new Set());
  });

  it("ignores uris without numeric tail", () => {
    expect(
      issueNumbersFromPlan({
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/" }],
      }),
    ).toEqual(new Set());
  });
});

describe("scopeMetadataRank branches", () => {
  it("returns null for invalid plan shapes and ranks", () => {
    expect(scopeMetadataRank(null)).toBeNull();
    expect(scopeMetadataRank({ metadata: null })).toBeNull();
    expect(scopeMetadataRank({ metadata: { rank: "not-int" } })).toBeNull();
    expect(scopeMetadataRank({ metadata: { rank: 1.5 } })).toBeNull();
  });
});

describe("scopeIsBlocked branches", () => {
  it("returns false for non-object plans", () => {
    expect(scopeIsBlocked(null, new Set())).toBe(false);
  });

  it("blocks on unresolved swarm dependencies", () => {
    const plan = {
      metadata: { swarm: { depends_on: ["dep-a", "dep-b"] } },
    };
    expect(scopeIsBlocked(plan, new Set(["dep-a"]))).toBe(true);
    expect(scopeIsBlocked(plan, new Set(["dep-a", "dep-b"]))).toBe(false);
  });

  it("treats a non-array depends_on as no dependencies (dependsOnIds branch)", () => {
    const plan = {
      metadata: { swarm: { depends_on: "not-an-array" } },
    };
    expect(scopeIsBlocked(plan, new Set())).toBe(false);
  });
});

describe("walkScopeFolders integration branches", () => {
  it("collects active issue refs and ranks from pending scopes", () => {
    const root = makeRoot();
    writeVbrief(root, "active", "running.xbrief.json", {
      plan: {
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/10" }],
      },
    });
    writeVbrief(root, "pending", "queued.xbrief.json", {
      plan: {
        metadata: { rank: "12" },
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/11/" }],
      },
    });
    expect([...activeReferencedIssueNumbers(root)]).toEqual([10]);
    expect(rankByIssueNumber(root).get(11)).toBe(12);
  });

  it("marks blocked pending scopes using completed dependency ids", () => {
    const root = makeRoot();
    writeVbrief(root, "completed", "done.xbrief.json", {
      plan: { id: "dep-done" },
    });
    writeVbrief(root, "pending", "blocked.xbrief.json", {
      plan: {
        metadata: { swarm: { depends_on: ["dep-done", "dep-missing"] } },
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/99" }],
      },
    });
    expect([...blockedByIssueNumber(root)]).toEqual([99]);
  });

  it("skips corrupt vbrief files and missing folders", () => {
    const root = makeRoot();
    writeVbrief(root, "active", "bad.xbrief.json", "not-json");
    expect(activeReferencedIssueNumbers(root)).toEqual(new Set());
    expect(blockedByIssueNumber(root, ["missing-folder"])).toEqual(new Set());
  });

  it("skips a completed artifact with no plan key when computing completed ids", () => {
    // Covers the completedPlanIds `plan === null` continue branch.
    const root = makeRoot();
    writeVbrief(root, "completed", "no-plan-key.xbrief.json", { notPlan: true });
    writeVbrief(root, "completed", "done.xbrief.json", { plan: { id: "dep-done" } });
    writeVbrief(root, "pending", "blocked.xbrief.json", {
      plan: {
        metadata: { swarm: { depends_on: ["dep-done"] } },
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/7" }],
      },
    });
    expect([...blockedByIssueNumber(root)]).toEqual([]);
  });
});
