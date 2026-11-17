import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IN_PR_POST_MERGE_PATH } from "./lands-with-product.js";
import { LANDS_WITH_PRODUCT } from "./lifecycle-write.js";
import { lifecycleMain } from "./main.js";
import { runTransition } from "./transition.js";
import { formatBriefJson } from "./vbrief-json.js";

const NAME = "2026-11-16-77-story.xbrief.json";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-in-pr-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  return root;
}

function storyPlan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "story 77",
    id: "github.issue.77",
    status: "running",
    references: [{ uri: "https://github.com/acme/app/issues/77", type: "x-xbrief/github-issue" }],
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      ambiguity_attestation: "none_found",
      clauses: [
        { id: 1, text: "Given x, then y returns z.", artifact_path: null, ambiguous: false },
      ],
    },
    items: [
      {
        id: "clause.1",
        title: "Given x, then y returns z.",
        status: "pending",
        "x-directive/evidence": {
          kind: "test",
          pointer: "src/app.test.ts",
          recorded_at: "2026-11-16T00:00:00Z",
          recorded_by: "vitest",
        },
      },
    ],
    metadata: { swarm: { file_scope: ["src/app.ts"] } },
    ...extra,
  };
}

function writeBrief(root: string, folder: string, plan: Record<string, unknown>): string {
  const path = join(root, "xbrief", folder, NAME);
  writeFileSync(path, formatBriefJson({ xBRIEFInfo: { version: "0.8" }, plan }), "utf8");
  return path;
}

function readPlan(path: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(path, "utf8")) as { plan: Record<string, unknown> }).plan;
}

describe("scope:complete --in-pr (#6277 Bound 1)", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
    root = "";
    vi.restoreAllMocks();
  });

  it("moves the brief to completed/ as lands-with-product with no delivered provenance or merge evidence", () => {
    root = makeRepo();
    const path = writeBrief(root, "active", storyPlan());
    const result = runTransition("complete", path, new Date("2026-11-16T01:00:00Z"), {
      inPr: true,
      inPrChangedPaths: ["src/app.ts", `xbrief/active/${NAME}`],
      skipAcceptanceEvidenceGate: true,
    });
    expect(result.ok, result.message).toBe(true);
    expect(existsSync(path)).toBe(false);
    const done = readPlan(join(root, "xbrief", "completed", NAME));
    expect(done.status).toBe("completed");
    const meta = done.metadata as Record<string, unknown>;
    expect(meta.lifecycleWrite).toEqual({
      action: "complete",
      writtenAt: "2026-11-16T01:00:00Z",
      completionDisposition: LANDS_WITH_PRODUCT,
    });
    expect(meta.completionProvenance).toBeUndefined();
    const items = done.items as Record<string, unknown>[];
    expect((items[0]?.["x-directive/evidence"] as Record<string, unknown>).kind).toBe("test");
  });

  it.each([
    [
      "an item that declares the merge requirement",
      {
        items: [{ id: "clause.1", title: "t", status: "pending", "x-directive/requires": "merge" }],
      },
    ],
    [
      "pre-stamped merge evidence",
      {
        items: [
          {
            id: "clause.1",
            title: "t",
            status: "pending",
            "x-directive/evidence": { kind: "merge", pointer: "abc1234" },
          },
        ],
      },
    ],
    [
      "stored completion provenance",
      {
        metadata: {
          swarm: { file_scope: ["src/app.ts"] },
          completionProvenance: { disposition: "delivered" },
        },
      },
    ],
    ["clause-less acceptance", { acceptance: { commands: [], none_stated: true } }],
  ])("refuses %s, names the post-merge path and leaves the brief in active/", (_label, extra) => {
    root = makeRepo();
    const path = writeBrief(root, "active", storyPlan(extra));
    const result = runTransition("complete", path, new Date(), {
      inPr: true,
      inPrChangedPaths: ["src/app.ts"],
      skipAcceptanceEvidenceGate: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(IN_PR_POST_MERGE_PATH);
    expect(result.message).toContain("#6303");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, "xbrief", "completed", NAME))).toBe(false);
  });

  it("refuses a branch with no in-scope production change and a non-active brief", () => {
    root = makeRepo();
    const path = writeBrief(root, "active", storyPlan());
    const noCode = runTransition("complete", path, new Date(), {
      inPr: true,
      inPrChangedPaths: ["docs/elsewhere.md"],
      skipAcceptanceEvidenceGate: true,
    });
    expect(noCode.ok).toBe(false);
    expect(noCode.message).toMatch(/no production file inside the brief's file_scope/);
    const done = writeBrief(root, "completed", { ...storyPlan(), status: "completed" });
    const notActive = runTransition("complete", done, new Date(), { inPr: true });
    expect(notActive.ok).toBe(false);
    expect(notActive.message).toMatch(/must be in active\/, not completed\//);
    const wrongAction = runTransition("block", path, new Date(), { inPr: true });
    expect(wrongAction).toEqual({
      ok: false,
      message: "--in-pr applies only to scope:complete (#6277).",
    });
  });

  it("parses --in-pr only for complete and without merge evidence", () => {
    root = makeRepo();
    const path = writeBrief(root, "active", storyPlan());
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(lifecycleMain(["complete", path, "--in-pr", "--pr", "5"])).toBe(2);
    expect(lifecycleMain(["block", path, "--in-pr"])).toBe(2);
    expect(lifecycleMain(["complete", path, "--in-pr", "--non-delivery", "abandoned"])).toBe(2);
    expect(stderr).toHaveBeenCalled();
    // A well-formed --in-pr reaches the transition; outside git it refuses on unreadable changes.
    expect(lifecycleMain(["complete", path, "--in-pr"])).toBe(1);
    expect(existsSync(path)).toBe(true);
  });
});
