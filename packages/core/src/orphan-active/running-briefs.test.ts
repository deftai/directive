import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  listActiveRunningBriefs,
  listActiveRunningBriefsFromLifecycleRoot,
} from "./running-briefs.js";

describe("listActiveRunningBriefs (#4628)", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) {
      rmSync(t, { recursive: true, force: true });
    }
  });
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-running-briefs-"));
    temps.push(root);
    return root;
  }

  it("returns empty when the project has no xbrief layout", () => {
    const root = makeRoot();
    expect(listActiveRunningBriefs(root)).toEqual([]);
  });

  it("returns empty when active/ is missing", () => {
    const root = makeRoot();
    mkdirSync(join(root, "xbrief"));
    expect(listActiveRunningBriefsFromLifecycleRoot(join(root, "xbrief"))).toEqual([]);
  });

  it("skips malformed JSON, non-objects, and non-running plans", () => {
    const root = makeRoot();
    const active = join(root, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "bad.xbrief.json"), "{not json", "utf8");
    writeFileSync(join(active, "array.xbrief.json"), "[]", "utf8");
    writeFileSync(join(active, "plain.xbrief.json"), "null", "utf8");
    writeFileSync(
      join(active, "no-plan.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" } }),
      "utf8",
    );
    writeFileSync(
      join(active, "proposed.xbrief.json"),
      JSON.stringify({ plan: { status: "proposed" } }),
      "utf8",
    );
    writeFileSync(join(active, "notes.txt"), "ignore", "utf8");
    writeFileSync(
      join(active, "b-run.xbrief.json"),
      JSON.stringify({ plan: { status: "running", title: "b" } }),
      "utf8",
    );
    writeFileSync(
      join(active, "a-run.xbrief.json"),
      JSON.stringify({ plan: { status: "Running", title: "a" } }),
      "utf8",
    );
    const listed = listActiveRunningBriefs(root);
    expect(listed.map((b) => b.plan.title)).toEqual(["a", "b"]);
  });

  it("returns empty on a legacy vbrief-only tree", () => {
    const root = makeRoot();
    mkdirSync(join(root, "vbrief"));
    expect(listActiveRunningBriefs(root)).toEqual([]);
  });
});
