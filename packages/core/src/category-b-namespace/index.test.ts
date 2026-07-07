import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CategoryBConflictError, migrateCategoryBCorpus, namespaceCategoryBPlan } from "./index.js";

describe("namespaceCategoryBPlan (#1650)", () => {
  it("renames bare policy + completedNote to the x-directive/ namespace", () => {
    const doc = {
      xBRIEFInfo: { version: "0.8" },
      plan: { id: "x", policy: { wipCap: 5 }, completedNote: "done" },
    };
    const result = namespaceCategoryBPlan(doc);
    expect(result.changed).toBe(true);
    expect(result.renamedKeys).toEqual(["x-directive/policy", "x-directive/completedNote"]);
    const plan = result.doc.plan as Record<string, unknown>;
    expect(plan["x-directive/policy"]).toEqual({ wipCap: 5 });
    expect(plan["x-directive/completedNote"]).toBe("done");
    expect("policy" in plan).toBe(false);
    expect("completedNote" in plan).toBe(false);
  });

  it("preserves key order, substituting the namespaced key in the legacy slot", () => {
    const doc = { plan: { id: "x", policy: {}, status: "running" } };
    const result = namespaceCategoryBPlan(doc);
    expect(Object.keys(result.doc.plan as Record<string, unknown>)).toEqual([
      "id",
      "x-directive/policy",
      "status",
    ]);
  });

  it("is idempotent: an already-namespaced plan is unchanged", () => {
    const doc = { plan: { "x-directive/policy": { wipCap: 5 } } };
    const result = namespaceCategoryBPlan(doc);
    expect(result.changed).toBe(false);
    expect(result.renamedKeys).toEqual([]);
  });

  it("throws when both bare and namespaced forms are present", () => {
    const doc = { plan: { policy: { wipCap: 1 }, "x-directive/policy": { wipCap: 2 } } };
    expect(() => namespaceCategoryBPlan(doc)).toThrow(CategoryBConflictError);
  });

  it("no-ops on non-object docs and plan-less docs", () => {
    expect(namespaceCategoryBPlan(null).changed).toBe(false);
    expect(namespaceCategoryBPlan([1]).changed).toBe(false);
    expect(namespaceCategoryBPlan({ vBRIEFInfo: {} }).changed).toBe(false);
    expect(namespaceCategoryBPlan({ plan: "nope" }).changed).toBe(false);
  });
});

describe("migrateCategoryBCorpus (#1650)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "catb-corpus-"));
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, doc: unknown): string {
    const path = join(root, rel);
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    return path;
  }

  it("namespaces every Category B key across the corpus and is idempotent", () => {
    const pd = write("xbrief/PROJECT-DEFINITION.xbrief.json", {
      plan: { id: "pd", policy: { wipCap: 5 } },
    });
    const done = write("xbrief/completed/done.xbrief.json", {
      plan: { id: "done", completedNote: "shipped" },
    });
    write("xbrief/active/clean.xbrief.json", {
      plan: { id: "clean", "x-directive/policy": {} },
    });

    const first = migrateCategoryBCorpus(root);
    expect(first.scanned).toBe(3);
    expect(first.changed).toEqual([
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      "xbrief/completed/done.xbrief.json",
    ]);
    expect(first.conflicts).toEqual([]);

    const pdPlan = (JSON.parse(readFileSync(pd, "utf8")) as { plan: Record<string, unknown> }).plan;
    expect(pdPlan["x-directive/policy"]).toEqual({ wipCap: 5 });
    const donePlan = (JSON.parse(readFileSync(done, "utf8")) as { plan: Record<string, unknown> })
      .plan;
    expect(donePlan["x-directive/completedNote"]).toBe("shipped");

    const second = migrateCategoryBCorpus(root);
    expect(second.changed).toEqual([]);
  });

  it("reports a conflict without rewriting the file", () => {
    write("xbrief/active/conflict.xbrief.json", {
      plan: { policy: { wipCap: 1 }, "x-directive/policy": { wipCap: 2 } },
    });
    const result = migrateCategoryBCorpus(root);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.path).toBe("xbrief/active/conflict.xbrief.json");
    expect(result.changed).toEqual([]);
  });
});
