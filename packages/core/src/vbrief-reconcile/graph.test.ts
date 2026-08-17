import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION } from "../intake/clause-derivation.js";
import { reconcileGraph, renderGraphReport } from "./graph.js";
import { candidateDepGraph, markCycles } from "./swarm-deps.js";
import type { Candidate } from "./types.js";

function writeBrief(root: string, storyId: string, folder: string, dependsOn: string[] = []): void {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  const status =
    folder === "completed" ? "completed" : folder === "active" ? "running" : "proposed";
  writeFileSync(
    join(dir, `2026-05-21-${storyId}.xbrief.json`),
    `${JSON.stringify({
      plan: {
        id: storyId,
        title: storyId,
        status,
        metadata: { kind: "story", swarm: { depends_on: dependsOn } },
      },
    })}\n`,
    "utf8",
  );
}

function writeProjectDef(root: string, wipCap: number): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ plan: { policy: { wipCap } } })}\n`,
    "utf8",
  );
}

describe("reconcileGraph", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("returns exit 2 when proposed missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    const [code] = reconcileGraph(root, { dryRun: true });
    expect(code).toBe(2);
  });

  it("promotes when deps resolved (dry-run)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-"));
    roots.push(root);
    writeBrief(root, "dep", "completed");
    writeBrief(root, "child", "proposed", ["dep"]);
    const [code, outcome] = reconcileGraph(root, { dryRun: true });
    expect(code).toBe(0);
    expect(outcome.promoted).toContain("child");
    expect(renderGraphReport(outcome)).toContain("vBRIEF reconcile graph");
  });

  it("detects cycles", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-"));
    roots.push(root);
    writeBrief(root, "a", "proposed", ["b"]);
    writeBrief(root, "b", "proposed", ["a"]);
    const [code, outcome] = reconcileGraph(root, { dryRun: true });
    expect(code).toBe(1);
    expect(outcome.cycles.length).toBeGreaterThan(0);
  });

  it("defers at wip cap", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-"));
    roots.push(root);
    writeProjectDef(root, 0);
    writeBrief(root, "dep", "completed");
    writeBrief(root, "child", "proposed", ["dep"]);
    const [, outcome] = reconcileGraph(root, { dryRun: true });
    expect(outcome.deferredWip).toContain("child");
  });

  it("waits on unresolved deps", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-"));
    roots.push(root);
    writeBrief(root, "dep", "active");
    writeBrief(root, "child", "proposed", ["dep"]);
    const [, outcome] = reconcileGraph(root, { dryRun: true });
    expect(outcome.waiting[0]?.story_id).toBe("child");
  });

  it("skips dependency-free proposed items", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-"));
    roots.push(root);
    writeBrief(root, "solo", "proposed", []);
    const [, outcome] = reconcileGraph(root, { dryRun: true });
    expect(outcome.promoted).toEqual([]);
  });

  it("surfaces refused-stamp remediation from a successful promote in the graph report (#3398)", async () => {
    const transition = await import("../scope/transition.js");
    vi.spyOn(transition, "runTransition").mockReturnValue({
      ok: true,
      message:
        `Promoted child.xbrief.json: proposed/ -> pending/ (status: pending)\n` +
        CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION,
    });
    const root = mkdtempSync(join(tmpdir(), "deft-graph-"));
    roots.push(root);
    writeBrief(root, "dep", "completed");
    writeBrief(root, "child", "proposed", ["dep"]);
    const [, outcome] = reconcileGraph(root, { dryRun: false });
    expect(outcome.promoted).toContain("child");
    expect(outcome.promotedNotices?.some((n) => n.story_id === "child")).toBe(true);
    const report = renderGraphReport(outcome);
    expect(report).toContain("child");
    expect(report).toContain(CLAUSE_STAMP_IMPLEMENTATION_ONLY_REMEDIATION);
  });
});

describe("markCycles", () => {
  it("marks cycle participants", () => {
    const a: Candidate = {
      path: "/a",
      storyId: "a",
      status: "proposed",
      swarm: { depends_on: ["b"] },
      blocked: [],
    };
    const b: Candidate = {
      path: "/b",
      storyId: "b",
      status: "proposed",
      swarm: { depends_on: ["a"] },
      blocked: [],
    };
    markCycles([a, b], { a: ["b"], b: ["a"] });
    expect(a.blocked.some((r) => r.startsWith("dependency cycle:"))).toBe(true);
  });
});

describe("candidateDepGraph external dep status", () => {
  it("blocks when external dep not terminal", () => {
    const a: Candidate = {
      path: "/a",
      storyId: "a",
      status: "proposed",
      swarm: { depends_on: ["ext"] },
      blocked: [],
    };
    candidateDepGraph([a], { ext: ["/xbrief/active/ext.xbrief.json", "running"] });
    expect(a.blocked.length).toBe(1);
  });
});
