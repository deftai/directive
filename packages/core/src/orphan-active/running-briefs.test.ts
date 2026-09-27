import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  briefPairingKey,
  briefPlanIdentity,
  completedTwinRelPath,
  listActiveRunningBriefs,
  listActiveRunningBriefsFromLifecycleRoot,
  productPullRequestFromPlan,
  stampProductPullRequestOntoPlan,
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

describe("brief twin identity (#4919)", () => {
  it("pairs by basename family, not issue number", () => {
    expect(briefPairingKey("xbrief/active/story-a.xbrief.json")).toBe(
      "xbrief/story-a.xbrief.json",
    );
    expect(briefPairingKey("xbrief/completed/story-a.xbrief.json")).toBe(
      "xbrief/story-a.xbrief.json",
    );
    expect(completedTwinRelPath("xbrief/pending/story-a.xbrief.json")).toBe(
      "xbrief/completed/story-a.xbrief.json",
    );
    const a = briefPlanIdentity({
      title: "story-a",
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/4919" },
      ],
    });
    const b = briefPlanIdentity({
      title: "story-b",
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/4919" },
      ],
    });
    expect(a).not.toBe(b);
  });
});

describe("stampProductPullRequestOntoPlan (#4864)", () => {
  it("stamps absent metadata, preserves match, refuses overwrite", () => {
    const plan: Record<string, unknown> = { status: "running" };
    expect(stampProductPullRequestOntoPlan(plan, 5100)).toBe(true);
    expect(productPullRequestFromPlan(plan)).toBe(5100);
    expect(stampProductPullRequestOntoPlan(plan, 5100)).toBe(true);
    expect(stampProductPullRequestOntoPlan(plan, 5200)).toBe(false);
    expect(productPullRequestFromPlan(plan)).toBe(5100);
    expect(stampProductPullRequestOntoPlan(plan, 0)).toBe(false);
  });
});
