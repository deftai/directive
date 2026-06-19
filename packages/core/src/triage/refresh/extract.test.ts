import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractIssueRefs, iterActiveVbriefs } from "./extract.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("iterActiveVbriefs", () => {
  it("returns empty list when active dir is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "extract-missing-"));
    temps.push(root);
    expect(iterActiveVbriefs(join(root, "vbrief", "active"))).toEqual([]);
  });

  it("lists sorted vbrief files", () => {
    const root = mkdtempSync(join(tmpdir(), "extract-active-"));
    temps.push(root);
    const active = join(root, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "b.vbrief.json"), "{}", "utf8");
    writeFileSync(join(active, "a.vbrief.json"), "{}", "utf8");
    writeFileSync(join(active, "skip.txt"), "x", "utf8");
    const paths = iterActiveVbriefs(active);
    expect(paths.map((p) => p.split("/").pop())).toEqual(["a.vbrief.json", "b.vbrief.json"]);
  });
});

describe("extractIssueRefs", () => {
  it("returns empty array for unreadable files", () => {
    expect(extractIssueRefs("/no/such/file.vbrief.json")).toEqual([]);
  });

  it("returns empty array for malformed json", () => {
    const root = mkdtempSync(join(tmpdir(), "extract-bad-json-"));
    temps.push(root);
    const path = join(root, "bad.vbrief.json");
    writeFileSync(path, "{", "utf8");
    expect(extractIssueRefs(path)).toEqual([]);
  });

  it("returns empty array for non-object roots", () => {
    const root = mkdtempSync(join(tmpdir(), "extract-array-"));
    temps.push(root);
    const path = join(root, "arr.vbrief.json");
    writeFileSync(path, "[]", "utf8");
    expect(extractIssueRefs(path)).toEqual([]);
  });

  it("returns empty array when plan or references are invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "extract-plan-"));
    temps.push(root);
    const noPlan = join(root, "no-plan.vbrief.json");
    writeFileSync(noPlan, JSON.stringify({ plan: null }), "utf8");
    expect(extractIssueRefs(noPlan)).toEqual([]);

    const noRefs = join(root, "no-refs.vbrief.json");
    writeFileSync(noRefs, JSON.stringify({ plan: { references: "bad" } }), "utf8");
    expect(extractIssueRefs(noRefs)).toEqual([]);
  });

  it("skips non-github refs and bad uris", () => {
    const root = mkdtempSync(join(tmpdir(), "extract-refs-"));
    temps.push(root);
    const path = join(root, "refs.vbrief.json");
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          references: [
            { type: "other", uri: "https://example.com/1" },
            { type: "x-vbrief/github-issue", uri: "not-a-github-url" },
            null,
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/42/",
            },
          ],
        },
      }),
      "utf8",
    );
    expect(extractIssueRefs(path)).toEqual([["deftai/directive", 42]]);
  });
});
