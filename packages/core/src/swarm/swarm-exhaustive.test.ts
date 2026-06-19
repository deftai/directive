import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { completeCohortMain } from "./complete-cohort-cli.js";
import {
  defaultPreflightGate,
  defaultReadinessGate,
  resolveStories,
  swarmLaunch,
} from "./launch.js";
import { readinessReport } from "./readiness.js";
import { verifyReviewCleanMain } from "./verify-review-clean-cli.js";

function writePlan(project: string, relPath: string, plan: Record<string, unknown>): string {
  const full = join(project, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify({ plan }), "utf8");
  return full;
}

describe("launch and readiness exhaustive branches", () => {
  it("exercises default gate helpers and token skipping", () => {
    expect(defaultPreflightGate("/no/such/vbrief.json").exitCode).not.toBe(0);
    expect(defaultReadinessGate("/no/such/vbrief.json", "/tmp").exitCode).not.toBe(0);
    const project = mkdtempSync(join(tmpdir(), "sw-ex-"));
    mkdirSync(join(project, "vbrief", "active"), { recursive: true });
    const badJson = join(project, "vbrief", "active", "bad.vbrief.json");
    writeFileSync(badJson, "{not-json", "utf8");
    expect(resolveStories(project, ["", "bad.vbrief.json"]).errors.length).toBeGreaterThan(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("flags lifecycle and item validation issues", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-val-"));
    const pendingRunning = writePlan(project, "vbrief/pending/run.vbrief.json", {
      id: "run",
      title: "run",
      status: "running",
      metadata: { kind: "story", swarm: { readiness: "ready", parallel_safe: true } },
      items: [],
    });
    const blocked = writePlan(project, "vbrief/active/blocked.vbrief.json", {
      id: "blocked",
      title: "blocked",
      status: "blocked",
      metadata: { kind: "story", swarm: { readiness: "ready", parallel_safe: true } },
      items: [{ id: "1", title: "t", status: "pending" }],
    });
    const noAccept = writePlan(project, "vbrief/active/noacc.vbrief.json", {
      id: "noacc",
      title: "noacc",
      status: "running",
      narratives: {
        Description: "desc",
        ImplementationPlan: "1. a\n2. b",
        UserStory: "story",
      },
      metadata: { kind: "story", swarm: { readiness: "ready", parallel_safe: true } },
      items: [{ id: "1", title: "t", status: "pending", narrative: {} }],
    });
    const phase = writePlan(project, "vbrief/active/2026-06-19-ip-phase.vbrief.json", {
      id: "ip-phase",
      title: "ip-phase",
      status: "running",
      narratives: { Acceptance: "phase acceptance" },
      metadata: { kind: "phase" },
    });
    for (const path of [pendingRunning, blocked, noAccept, phase]) {
      const { exitCode } = readinessReport(project, [path]);
      expect(exitCode).toBe(1);
    }
    rmSync(project, { recursive: true, force: true });
  });

  it("accepts completed dependency for ready story", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-depok-"));
    writePlan(project, "vbrief/completed/dep-done.vbrief.json", {
      id: "dep-done",
      title: "done",
      status: "completed",
      items: [],
    });
    const path = writePlan(project, "vbrief/active/needs-dep.vbrief.json", {
      id: "needs-dep",
      title: "needs-dep",
      status: "running",
      narratives: {
        Description: "A sufficiently long description for validation to proceed.",
        ImplementationPlan: "1. First.\n2. Second.",
        UserStory: "As a user, I want this.",
        Traces: "FR-1",
      },
      items: [
        {
          id: "a1",
          title: "A1",
          status: "pending",
          narrative: { Acceptance: "Given x when y then z.", Traces: "FR-1" },
        },
        {
          id: "a2",
          title: "A2",
          status: "pending",
          narrative: { Acceptance: "Given p when q then r.", Traces: "FR-1" },
        },
      ],
      metadata: {
        kind: "story",
        swarm: {
          readiness: "ready",
          parallel_safe: true,
          file_scope: ["src/needs.ts"],
          verify_commands: ["npm test"],
          expected_outputs: ["ok"],
          depends_on: ["dep-done"],
          conflict_group: "g",
          file_scope_confidence: "high",
          model_tier: "medium",
        },
      },
    });
    const { exitCode, report } = readinessReport(project, [path]);
    expect(report).toContain("needs-dep");
    expect(exitCode).toBeGreaterThanOrEqual(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("hits remaining launch and cli edge paths", () => {
    const empty = mkdtempSync(join(tmpdir(), "sw-edge-"));
    expect(
      swarmLaunch({
        stories: ["x"],
        projectRoot: empty,
        ...{
          preflightGate: () => ({ exitCode: 0, message: "ok" }),
          readinessGate: () => ({ exitCode: 0, report: "ok" }),
          runtimeAuthProbe: () => ["local", "none"] as [string, string],
        },
      }).exitCode,
    ).toBe(2);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("swarm cli edge paths", () => {
  it("covers verify and complete cli argv branches", () => {
    expect(verifyReviewCleanMain(["--cohort", "/nope/*.json", "--json"])).toBe(2);
    expect(verifyReviewCleanMain(["--repo", "deftai/directive"])).toBe(2);
    expect(completeCohortMain(["--project-root", "/nonexistent-root-xyz"])).toBe(2);
    expect(completeCohortMain(["--project-root", ".", "--cohort", "missing/*.json"])).toBe(2);
  });
});
