import { describe, expect, it } from "vitest";
import { emitReconcileJson, type ReconcileResult, reconcileSummary } from "./types.js";

function baseResult(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    projectRoot: "/tmp/x",
    defaultRepo: null,
    restored: 0,
    skippedExisting: 0,
    skippedNoRepo: 0,
    dryRun: false,
    items: [],
    error: null,
    exitCode: 0,
    ...overrides,
  };
}

describe("reconcileSummary branches", () => {
  it("uses dry-run wording and failure mark", () => {
    const text = reconcileSummary(
      baseResult({ dryRun: true, restored: 2, skippedExisting: 1, exitCode: 1 }),
    );
    expect(text).toContain("would restore");
    expect(text).toContain("✗");
  });

  it("includes skipped-no-repo and error lines", () => {
    const text = reconcileSummary(
      baseResult({
        skippedNoRepo: 3,
        error: "boom",
        items: [{ repo: "o/r", issueNumber: 9, folder: "pending", path: "/p" }],
      }),
    );
    expect(text).toContain("skipped 3 vBRIEF(s)");
    expect(text).toContain("error: boom");
    expect(text).toContain("#9 (o/r)");
  });

  it("notes when nothing needed reconciliation", () => {
    const text = reconcileSummary(baseResult({ exitCode: 0, items: [] }));
    expect(text).toContain("Nothing to reconcile");
  });
});

describe("emitReconcileJson branches", () => {
  it("serializes booleans, numbers, arrays, and nested objects", () => {
    const json = emitReconcileJson(
      baseResult({
        defaultRepo: "deftai/directive",
        dryRun: true,
        restored: 1,
        skippedExisting: 2,
        skippedNoRepo: 0,
        exitCode: 0,
        items: [{ repo: "deftai/directive", issueNumber: 4, folder: "active", path: "/x" }],
      }),
    );
    expect(json).toContain('"default_repo": "deftai/directive"');
    expect(json).toContain('"dry_run": true');
    expect(json).toContain('"issue_number": 4');
  });

  it("handles null error via python-style encoder", () => {
    expect(emitReconcileJson(baseResult({ error: null }))).toContain('"error": null');
  });
});
