import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectOpenPlanItems,
  evaluateCompletedPlanConsistency,
  formatCompletedConsistencyFailure,
  scanCompletedLifecycleConsistency,
} from "./completed-consistency.js";

function seedCompleted(root: string, name: string, plan: Record<string, unknown>): void {
  const dir = join(root, "xbrief", "completed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.xbrief.json`),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }),
    "utf8",
  );
}

describe("completed lifecycle consistency (#3242)", () => {
  it("fails when completed/ plan.status is running (folder vs status)", () => {
    const plan = {
      title: "drift",
      status: "running",
      items: [{ title: "done", status: "completed" }],
    };
    const result = evaluateCompletedPlanConsistency(plan, {
      relPath: "completed/drift.xbrief.json",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("completed/drift.xbrief.json");
    expect(result.message).toContain("folder=completed");
    expect(result.message).toContain("plan.status=running");
    expect(result.findings.some((f) => f.kind === "status_mismatch")).toBe(true);
  });

  it("fails when plan.items has a pending entry", () => {
    const plan = {
      title: "open-checklist",
      status: "completed",
      items: [
        { title: "shipped", status: "completed" },
        { title: "still open", status: "pending" },
      ],
    };
    const result = evaluateCompletedPlanConsistency(plan, {
      relPath: "completed/open.xbrief.json",
      requireStatus: "completed",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("pending");
    expect(result.message).toContain("still open");
    expect(result.findings.some((f) => f.kind === "open_items")).toBe(true);
  });

  it("is green when completed folder + status=completed + all items terminal", () => {
    const plan = {
      title: "clean",
      status: "completed",
      items: [
        { title: "a", status: "completed" },
        { title: "b", status: "cancelled" },
        { title: "c", status: "failed" },
      ],
    };
    const result = evaluateCompletedPlanConsistency(plan, {
      relPath: "completed/clean.xbrief.json",
      requireStatus: "completed",
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.message).toContain("items=terminal");
  });

  it("collectOpenPlanItems walks nested items and subItems", () => {
    const hits = collectOpenPlanItems([
      {
        title: "parent",
        status: "completed",
        items: [{ title: "nested", status: "running" }],
        subItems: [{ title: "legacy", status: "proposed" }],
      },
    ]);
    expect(hits.map((h) => h.status).sort()).toEqual(["proposed", "running"]);
  });

  it("scanCompletedLifecycleConsistency fails closed on corpus drift", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-scan-"));
    seedCompleted(root, "bad-status", {
      title: "bad",
      status: "running",
      items: [],
    });
    seedCompleted(root, "open-items", {
      title: "open",
      status: "completed",
      items: [{ title: "todo", status: "pending" }],
    });
    seedCompleted(root, "good", {
      title: "good",
      status: "completed",
      items: [{ title: "done", status: "completed" }],
    });
    const result = scanCompletedLifecycleConsistency(root);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("completed/bad-status.xbrief.json");
    expect(result.message).toContain("plan.status=running");
    expect(result.message).toContain("completed/open-items.xbrief.json");
    expect(result.message).toContain("status=pending");
    expect(result.message).not.toMatch(/completed\/good\.xbrief\.json.*non-terminal/);
    rmSync(root, { recursive: true, force: true });
  });

  it("scanCompletedLifecycleConsistency is green for clean completed/", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-clean-"));
    seedCompleted(root, "ok", {
      title: "ok",
      status: "completed",
      items: [{ title: "done", status: "completed" }],
    });
    seedCompleted(root, "failed-ok", {
      title: "failed-ok",
      status: "failed",
      items: [{ title: "gave-up", status: "failed" }],
    });
    const result = scanCompletedLifecycleConsistency(root);
    expect(result.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("scan is green when completed/ is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-absent-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    expect(scanCompletedLifecycleConsistency(root).ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("treats empty plan.status as mismatch and labels items by id", () => {
    const result = evaluateCompletedPlanConsistency(
      {
        status: "  ",
        items: [
          { id: "crit-1", status: "pending" },
          null,
          "skip",
          { title: "  ", id: "", status: "" },
        ],
      },
      { requireStatus: "completed" },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("plan.status=(empty)");
    expect(result.message).toContain("crit-1");
    expect(result.message).toContain("expected=completed");
  });

  it("collectOpenPlanItems returns empty for non-array", () => {
    expect(collectOpenPlanItems(undefined)).toEqual([]);
    expect(collectOpenPlanItems(null)).toEqual([]);
    expect(collectOpenPlanItems("nope")).toEqual([]);
  });

  it("scan fails closed on malformed and plan-less files under completed/", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-malformed-"));
    const dir = join(root, "xbrief", "completed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.xbrief.json"), "{not-json", "utf8");
    writeFileSync(join(dir, "no-plan.xbrief.json"), JSON.stringify({ xBRIEFInfo: {} }), "utf8");
    writeFileSync(join(dir, "array-root.xbrief.json"), JSON.stringify([]), "utf8");
    writeFileSync(
      join(dir, "ok.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "ok", status: "completed", items: [] },
      }),
      "utf8",
    );
    const result = scanCompletedLifecycleConsistency(root);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("malformed JSON");
    expect(result.message).toContain("missing or non-object plan");
    expect(result.message).toContain("non-object root");
    expect(result.findings.every((f) => f.kind === "unreadable" || f.relPath.includes("ok"))).toBe(
      true,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("scan is green when completed path is a file not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-file-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "completed"), "not-a-dir", "utf8");
    const result = scanCompletedLifecycleConsistency(root);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/absent|OK/);
    rmSync(root, { recursive: true, force: true });
  });

  it("scan fails closed on legacy vbrief/completed corpus with status drift", () => {
    // legacy-only layout must still be examined (Greptile: no green-skip).
    const root = mkdtempSync(join(tmpdir(), "cc-legacy-only-"));
    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "completed", "legacy.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "legacy", status: "running", items: [] },
      }),
      "utf8",
    );
    const result = scanCompletedLifecycleConsistency(root);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("plan.status=running");
    expect(result.message).toContain("completed/legacy.vbrief.json");
    rmSync(root, { recursive: true, force: true });
  });

  it("scan mixed xbrief+vbrief roots includes legacy completed drift (#3242)", () => {
    // Greptile: when both trees exist, do not only scan xbrief/completed.
    const root = mkdtempSync(join(tmpdir(), "cc-mixed-"));
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "completed", "ok.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "ok", status: "completed", items: [] },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "vbrief", "completed", "legacy.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "legacy", status: "running", items: [] },
      }),
      "utf8",
    );
    const result = scanCompletedLifecycleConsistency(root);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("plan.status=running");
    expect(result.message).toMatch(/vbrief\/completed\/legacy/);
    rmSync(root, { recursive: true, force: true });
  });

  it("default relPath and failed status without requireStatus are green", () => {
    const result = evaluateCompletedPlanConsistency({
      status: "failed",
      items: [{ title: "gave-up", status: "failed" }],
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("plan");
  });

  it("formatCompletedConsistencyFailure lists every finding", () => {
    const msg = formatCompletedConsistencyFailure([
      {
        relPath: "completed/a.xbrief.json",
        planStatus: "running",
        folder: "completed",
        kind: "status_mismatch",
        detail:
          "completed/a.xbrief.json: folder=completed plan.status=running expected=completed|failed (#3242)",
      },
    ]);
    expect(msg).toContain("1 finding");
    expect(msg).toContain("completed/a.xbrief.json");
    expect(msg).toContain("pending|proposed|running");
  });
});
