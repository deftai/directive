import { describe, expect, it } from "vitest";
import {
  evaluateLifecycleDiff,
  expectedLifecycleRels,
  parseStagedXbriefPaths,
} from "./lifecycle-diff.js";

describe("lifecycle diff (#4714 R7)", () => {
  it("parses renames and ordinary status paths", () => {
    const paths = parseStagedXbriefPaths(
      [
        "R  xbrief/active/a.xbrief.json -> xbrief/completed/a.xbrief.json",
        "M  xbrief/active/b.xbrief.json",
        " M packages/core/src/swarm/finalize-cohort.ts",
      ].join("\n"),
    );
    expect(paths).toEqual([
      "xbrief/active/a.xbrief.json",
      "xbrief/active/b.xbrief.json",
      "xbrief/completed/a.xbrief.json",
    ]);
  });

  it("ignores untracked terminal directory markers before git add", () => {
    const paths = parseStagedXbriefPaths(
      [
        "?? xbrief/completed/",
        "?? xbrief/completed/story-1.xbrief.json",
        " D xbrief/active/story-1.xbrief.json",
        "?? vbrief/cancelled",
      ].join("\n"),
    );
    expect(paths).toEqual([
      "xbrief/active/story-1.xbrief.json",
      "xbrief/completed/story-1.xbrief.json",
    ]);
  });

  it("admits selected story active→completed transitions", () => {
    const allowed = expectedLifecycleRels(["xbrief/active/story-1.xbrief.json"]);
    const staged = ["xbrief/active/story-1.xbrief.json", "xbrief/completed/story-1.xbrief.json"];
    expect(evaluateLifecycleDiff(staged, allowed).ok).toBe(true);
  });

  it("admits derived registry and epic-parent paths with the selected story", () => {
    const allowed = expectedLifecycleRels(
      ["xbrief/active/story-1.xbrief.json"],
      ["xbrief/active/epic-parent.xbrief.json"],
    );
    const staged = [
      "xbrief/active/story-1.xbrief.json",
      "xbrief/completed/story-1.xbrief.json",
      "xbrief/completed/epic-parent.xbrief.json",
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      "xbrief/specification.xbrief.json",
    ];
    expect(evaluateLifecycleDiff(staged, allowed).ok).toBe(true);
  });

  it("refuses unrelated staged xBRIEF paths", () => {
    const allowed = expectedLifecycleRels(["xbrief/active/story-1.xbrief.json"]);
    const result = evaluateLifecycleDiff(
      ["xbrief/active/other.xbrief.json", "xbrief/completed/other.xbrief.json"],
      allowed,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("causal lifecycle diff");
    expect(result.unexpected).toContain("xbrief/active/other.xbrief.json");
  });
});
