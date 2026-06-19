import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGithubIssueUri } from "./parse-uri.js";
import { reconcile } from "./reconcile.js";

describe("reconcile edge cases", () => {
  it("parses bare numeric github uri", () => {
    expect(parseGithubIssueUri("https://github.com/acme/widgets/issues/99")).toEqual([
      "acme/widgets",
      99,
    ]);
    expect(parseGithubIssueUri("999")).toEqual([null, 999]);
    expect(parseGithubIssueUri("")).toEqual([null, null]);
    expect(parseGithubIssueUri(null)).toEqual([null, null]);
    expect(parseGithubIssueUri("https://github.com/o/r/issues/notnum")).toEqual([null, null]);
  });

  it("reports skipped no repo", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-norepo-"));
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "proposed", "bare.vbrief.json"),
      JSON.stringify({
        plan: { references: [{ type: "x-vbrief/github-issue", uri: "999" }] },
      }),
      "utf8",
    );
    const result = reconcile(root, { repo: null });
    expect(result.skippedNoRepo).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });
});
