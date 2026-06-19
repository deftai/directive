import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAuthor,
  extractLabels,
  extractMilestone,
  isOpen,
  issueRepoKey,
  iterCacheIssues,
} from "./cache-walker.js";

describe("cache-walker helpers", () => {
  it("extracts labels milestones and authors from varied shapes", () => {
    expect([...extractLabels({ labels: ["plain"] })]).toEqual(["plain"]);
    expect(extractMilestone({ milestone: "ms-title" })).toBe("ms-title");
    expect(extractMilestone({ milestone: { name: "alt" } })).toBe("alt");
    expect(extractAuthor({ author: "bot" })).toBe("bot");
    expect(isOpen({ state: "closed" })).toBe(false);
    expect(issueRepoKey({ html_url: "https://github.com/o/r/issues/1" })).toContain("github.com");
  });

  it("iterCacheIssues skips invalid raw.json", () => {
    const root = mkdtempSync(join(tmpdir(), "walker-"));
    const issueDir = join(root, "github-issue", "o", "r", "1");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "raw.json"), "{bad", "utf8");
    expect(iterCacheIssues(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
