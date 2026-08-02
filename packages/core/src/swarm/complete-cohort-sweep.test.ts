import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scope/transition.js", () => ({
  runTransition: vi.fn((verb: string) => ({ ok: true, message: `${verb} ok` })),
}));

import { runTransition } from "../scope/transition.js";
import { completeCohort, sweepCohort } from "./complete-cohort.js";
import { completeCohortMain } from "./complete-cohort-cli.js";

function writeActiveStory(project: string, storyId: string): string {
  const full = join(project, "xbrief", "active", `${storyId}.xbrief.json`);
  mkdirSync(join(project, "xbrief", "active"), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      plan: {
        id: storyId,
        title: storyId,
        status: "running",
        items: [{ id: "i1", title: "t", status: "pending" }],
      },
    }),
    "utf8",
  );
  return full;
}

describe("complete cohort live sweep with mocked transition", () => {
  beforeEach(() => {
    vi.mocked(runTransition).mockClear();
  });

  it("propagates delivery context into runTransition options (#3041)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-delivery-ctx-"));
    const storyPath = writeActiveStory(project, "del-ctx");
    const sweep = sweepCohort([storyPath], project, false, {
      defaultEvidence: {
        prNumber: 1,
        prBase: "master",
        mergeCommit: "abc",
        mergedAt: "2026-08-02T00:00:00Z",
        deliveryBranch: "master",
      },
      assumeEvidenceValidated: true,
      verifier: "test-verifier",
    });
    expect(sweep.ok).toBe(true);
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith(
      "complete",
      storyPath,
      expect.any(Date),
      expect.objectContaining({
        assumeEvidenceValidated: true,
        verifier: "test-verifier",
        deliveryEvidence: expect.objectContaining({ mergeCommit: "abc" }),
      }),
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("sweepCohort returns empty result when no xbrief/ layout found", () => {
    const emptyProject = mkdtempSync(join(tmpdir(), "sw-empty-"));
    const sweep = sweepCohort([], emptyProject, false);
    expect(sweep.ok).toBe(true);
    expect(sweep.stories).toEqual([]);
    rmSync(emptyProject, { recursive: true, force: true });
  });

  it("completes active story via runTransition", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-live-"));
    const storyPath = writeActiveStory(project, "live-a");
    const sweep = sweepCohort([storyPath], project, false);
    expect(sweep.ok).toBe(true);
    expect(sweep.stories[0]?.action).toBe("complete");
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith(
      "complete",
      storyPath,
      expect.any(Date),
      expect.any(Object),
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("completeCohortMain completes cohort in json mode", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-live2-"));
    const storyPath = writeActiveStory(project, "live-b");
    const code = completeCohortMain(["--project-root", project, "--json", storyPath]);
    expect(code).toBe(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("dry-run completes active parent epic when child settles", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-par-act-"));
    const childPath = writeActiveStory(project, "child-act");
    const parentPath = join(project, "xbrief", "active", "parent-act.xbrief.json");
    writeFileSync(
      parentPath,
      JSON.stringify({
        plan: {
          id: "parent-act",
          title: "Parent active",
          status: "running",
          references: [{ type: "x-vbrief/plan", uri: "active/child-act.xbrief.json" }],
          metadata: { kind: "epic" },
        },
      }),
      "utf8",
    );
    writeFileSync(
      childPath,
      JSON.stringify({
        plan: {
          id: "child-act",
          title: "child-act",
          status: "running",
          planRef: "active/parent-act.xbrief.json",
          items: [{ id: "i1", title: "t", status: "pending" }],
        },
      }),
      "utf8",
    );
    const sweep = sweepCohort([childPath], project, true);
    expect(sweep.parents.some((p) => p.action === "complete")).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("reports parent activate failure when child already completed", () => {
    vi.mocked(runTransition).mockImplementation((verb: string) => {
      if (verb === "activate") {
        return { ok: false, message: "activate blocked" };
      }
      return { ok: true, message: `${verb} ok` };
    });
    const project = mkdtempSync(join(tmpdir(), "sw-act-fail-"));
    mkdirSync(join(project, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(project, "xbrief", "completed"), { recursive: true });
    const childCompleted = join(project, "xbrief", "completed", "child-done.xbrief.json");
    writeFileSync(
      childCompleted,
      JSON.stringify({
        plan: {
          id: "child-done",
          title: "child-done",
          status: "completed",
          planRef: "pending/parent-pend.xbrief.json",
          items: [{ id: "i1", title: "t", status: "done" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(project, "xbrief", "pending", "parent-pend.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "parent-pend",
          title: "parent-pend",
          status: "pending",
          references: [{ type: "x-vbrief/plan", uri: "completed/child-done.xbrief.json" }],
          metadata: { kind: "epic" },
        },
      }),
      "utf8",
    );
    const sweep = sweepCohort([childCompleted], project, false);
    expect(sweep.parents.some((p) => p.action === "failed")).toBe(true);
    rmSync(project, { recursive: true, force: true });
  });

  it("reports failed transition", () => {
    vi.mocked(runTransition).mockReturnValueOnce({ ok: false, message: "transition failed" });
    const project = mkdtempSync(join(tmpdir(), "sw-fail-"));
    const storyPath = writeActiveStory(project, "fail-a");
    const result = completeCohort({ projectRoot: project, stories: [storyPath] });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("INCOMPLETE");
    rmSync(project, { recursive: true, force: true });
  });
});
