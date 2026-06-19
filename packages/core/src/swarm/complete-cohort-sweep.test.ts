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
  const full = join(project, "vbrief", "active", `${storyId}.vbrief.json`);
  mkdirSync(join(project, "vbrief", "active"), { recursive: true });
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

  it("completes active story via runTransition", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-live-"));
    const storyPath = writeActiveStory(project, "live-a");
    const sweep = sweepCohort([storyPath], project, false);
    expect(sweep.ok).toBe(true);
    expect(sweep.stories[0]?.action).toBe("complete");
    expect(vi.mocked(runTransition)).toHaveBeenCalledWith("complete", storyPath);
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
    const parentPath = join(project, "vbrief", "active", "parent-act.vbrief.json");
    writeFileSync(
      parentPath,
      JSON.stringify({
        plan: {
          id: "parent-act",
          title: "Parent active",
          status: "running",
          references: [{ type: "x-vbrief/plan", uri: "active/child-act.vbrief.json" }],
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
          planRef: "active/parent-act.vbrief.json",
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
    mkdirSync(join(project, "vbrief", "pending"), { recursive: true });
    mkdirSync(join(project, "vbrief", "completed"), { recursive: true });
    const childCompleted = join(project, "vbrief", "completed", "child-done.vbrief.json");
    writeFileSync(
      childCompleted,
      JSON.stringify({
        plan: {
          id: "child-done",
          title: "child-done",
          status: "completed",
          planRef: "pending/parent-pend.vbrief.json",
          items: [{ id: "i1", title: "t", status: "done" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(project, "vbrief", "pending", "parent-pend.vbrief.json"),
      JSON.stringify({
        plan: {
          id: "parent-pend",
          title: "parent-pend",
          status: "pending",
          references: [{ type: "x-vbrief/plan", uri: "completed/child-done.vbrief.json" }],
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
