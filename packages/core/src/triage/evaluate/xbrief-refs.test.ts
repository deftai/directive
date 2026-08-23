import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueNumbersFromXbriefJson, listXbriefHits } from "./xbrief-refs.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("xbrief-refs", () => {
  it("extracts issue numbers from references", () => {
    expect(
      issueNumbersFromXbriefJson({
        plan: { references: [{ uri: "https://github.com/o/r/issues/12", title: "Issue #12" }] },
      }),
    ).toEqual([12]);
    expect(issueNumbersFromXbriefJson(null)).toEqual([]);
  });

  it("skips unreadable JSON in a lifecycle folder", () => {
    const root = mkdtempSync(join(tmpdir(), "refs-"));
    temps.push(root);
    const dir = join(root, "xbrief", "completed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.xbrief.json"), "{", "utf8");
    expect(listXbriefHits(root, "completed")).toEqual([]);
  });
});
