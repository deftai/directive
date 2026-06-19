import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countReconcilable, findReconcilable, reconcile } from "./index.js";

function scopeVbrief(folder: string, slug: string, issue: number, repo = "deftai/directive"): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${slug}.vbrief.json`),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        references: [
          { type: "x-vbrief/github-issue", uri: `https://github.com/${repo}/issues/${issue}` },
        ],
      },
    }),
    "utf8",
  );
}

describe("reconcile", () => {
  it("restores missing accepts", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-"));
    scopeVbrief(join(root, "vbrief", "proposed"), "a", 2);
    scopeVbrief(join(root, "vbrief", "proposed"), "b", 3);
    const result = reconcile(root, { repo: "deftai/directive" });
    expect(result.exitCode).toBe(0);
    expect(result.restored).toBe(2);
    const log = readFileSync(join(root, "vbrief", ".eval", "candidates.jsonl"), "utf8");
    expect(log).toContain('"decision":"accept"');
    rmSync(root, { recursive: true, force: true });
  });

  it("finds reconcilable items read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-"));
    scopeVbrief(join(root, "vbrief", "pending"), "c", 4);
    const items = findReconcilable(root, { defaultRepo: "deftai/directive" });
    expect(items).toHaveLength(1);
    expect(items[0]?.issueNumber).toBe(4);
    rmSync(root, { recursive: true, force: true });
  });

  it("countReconcilable honors restrictTo", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-restrict-"));
    scopeVbrief(join(root, "vbrief", "pending"), "c", 4);
    scopeVbrief(join(root, "vbrief", "pending"), "d", 5);
    const count = countReconcilable(root, {
      defaultRepo: "deftai/directive",
      restrictTo: [["deftai/directive", 4]],
    });
    expect(count).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
