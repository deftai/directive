import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectWipCensus, wipHitsForIssue } from "./wip-census.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("collectWipCensus", () => {
  it("returns empty hits when lifecycle folders are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "wip-"));
    temps.push(root);
    const census = collectWipCensus(root, [1]);
    expect(census.active).toEqual([]);
    expect(wipHitsForIssue(census, 1)).toEqual([]);
  });

  it("finds a pending xbrief", () => {
    const root = mkdtempSync(join(tmpdir(), "wip-"));
    temps.push(root);
    const dir = join(root, "xbrief", "pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-08-23-4-x.xbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { uri: "https://github.com/deftai/directive/issues/4", type: "x-xbrief/github-issue" },
          ],
        },
      }),
      "utf8",
    );
    expect(collectWipCensus(root, [4]).pending).toHaveLength(1);
  });
});
