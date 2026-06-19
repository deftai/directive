import { describe, expect, it } from "vitest";
import { emitReconcileJson, type ReconcileResult, reconcileSummary } from "./types.js";

describe("reconcile json", () => {
  it("matches python spacing", () => {
    const result: ReconcileResult = {
      projectRoot: "/tmp/x",
      defaultRepo: null,
      restored: 0,
      skippedExisting: 0,
      skippedNoRepo: 0,
      dryRun: true,
      items: [],
      error: null,
      exitCode: 0,
    };
    expect(emitReconcileJson(result)).toContain('"default_repo": null');
  });

  it("renders summary recap", () => {
    const text = reconcileSummary({
      projectRoot: "/tmp",
      defaultRepo: null,
      restored: 1,
      skippedExisting: 0,
      skippedNoRepo: 0,
      dryRun: false,
      items: [{ repo: "deftai/directive", issueNumber: 2, folder: "proposed", path: "/x" }],
      error: null,
      exitCode: 0,
    });
    expect(text).toContain("Issues reconciled");
  });
});
