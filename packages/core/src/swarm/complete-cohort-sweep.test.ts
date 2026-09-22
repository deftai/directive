import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorktreeOccupancy, readOccupancy, releaseOccupancy } from "../session/occupancy.js";

vi.mock("../scope/transition.js", () => ({
  runTransition: vi.fn((verb: string) => ({ ok: true, message: `${verb} ok` })),
}));

import { runTransition } from "../scope/transition.js";
import { completeCohort, sweepCohort } from "./complete-cohort.js";
import { completeCohortMain } from "./complete-cohort-cli.js";
import {
  admitSwarmLaunchPlanSequence,
  LAUNCH_OCCUPANCY_IDENTITY_SWAP,
  launchOccupancyRecordRelpath,
  occupancyCohortKey,
  persistLaunchOccupancyRecord,
  resolveLaunchOccupancySessionId,
  retractLaunchOccupancyRecord,
  swarmLaunch,
} from "./launch.js";

function acceptanceEvidence(pointer: string): Record<string, unknown> {
  return {
    "x-directive/evidence": {
      kind: "test",
      pointer,
      recorded_at: "2026-09-21T00:00:00Z",
      recorded_by: "vitest",
    },
  };
}

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
          items: [
            {
              id: "i1",
              title: "t",
              status: "pending",
              ...acceptanceEvidence("packages/core/src/swarm/complete-cohort-sweep.test.ts"),
            },
          ],
        },
      }),
      "utf8",
    );
    const sweep = sweepCohort([childPath], project, true);
    expect(sweep.stories[0]?.ok).toBe(true);
    expect(sweep.stories[0]?.action).toBe("complete");
    expect(sweep.parents.some((p) => p.action === "complete" && p.ok)).toBe(true);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    rmSync(project, { recursive: true, force: true });
  });

  it("dry-run fails an active story that lacks acceptance evidence (#4839)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-dry-miss-"));
    const storyPath = writeActiveStory(project, "miss-a");
    const raw = JSON.parse(readFileSync(storyPath, "utf8")) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    delete raw.plan.items[0]?.["x-directive/evidence"];
    writeFileSync(storyPath, JSON.stringify(raw), "utf8");
    const before = readFileSync(storyPath, "utf8");
    const sweep = sweepCohort([storyPath], project, true);
    expect(sweep.ok).toBe(false);
    expect(sweep.stories[0]?.action).toBe("failed");
    expect(sweep.stories[0]?.ok).toBe(false);
    expect(sweep.stories[0]?.detail).toContain(
      "Acceptance evidence required for scope:complete (#3240 / #3305)",
    );
    expect(readFileSync(storyPath, "utf8")).toBe(before);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    rmSync(project, { recursive: true, force: true });
  });

  it("dry-run fails an already-active parent after persist on a clone (#4839)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-dry-parent-"));
    mkdirSync(join(project, "xbrief", "completed"), { recursive: true });
    const childPath = join(project, "xbrief", "completed", "child-gap.xbrief.json");
    writeFileSync(
      childPath,
      JSON.stringify({
        plan: {
          id: "child-gap",
          title: "child-gap",
          status: "completed",
          planRef: "active/parent-gap.xbrief.json",
          items: [
            {
              id: "i1",
              title: "t",
              status: "done",
              ...acceptanceEvidence("packages/core/src/swarm/complete-cohort-sweep.test.ts"),
            },
          ],
        },
      }),
      "utf8",
    );
    const parentPath = join(project, "xbrief", "active", "parent-gap.xbrief.json");
    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    writeFileSync(
      parentPath,
      JSON.stringify({
        plan: {
          id: "parent-gap",
          title: "Parent gap",
          status: "running",
          references: [{ type: "x-vbrief/plan", uri: "completed/child-gap.xbrief.json" }],
          metadata: { kind: "epic" },
          acceptance: { clauses: [{ id: 1, text: "clause one" }] },
          items: [],
        },
      }),
      "utf8",
    );
    const before = readFileSync(parentPath, "utf8");
    const sweep = sweepCohort([childPath], project, true);
    const parent = sweep.parents.find((p) => p.path.replace(/\\/g, "/").includes("parent-gap"));
    expect(parent?.action).toBe("failed");
    expect(parent?.ok).toBe(false);
    expect(parent?.detail).toContain(
      "Acceptance evidence required for scope:complete (#3240 / #3305)",
    );
    expect(readFileSync(parentPath, "utf8")).toBe(before);
    expect(before).not.toContain("clause.1");
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
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

  it("keeps refused-stamp activate remediation on activate+complete (#3398)", () => {
    vi.mocked(runTransition).mockImplementation((verb: string) => {
      if (verb === "activate") {
        return {
          ok: true,
          message:
            "Activated pending/parent-notice.xbrief.json -> active/.\nRefused implementation-only clause stamp; derive clauses from the statement's testable constraints.",
        };
      }
      return { ok: true, message: `${verb} ok` };
    });
    const project = mkdtempSync(join(tmpdir(), "sw-act-notice-"));
    mkdirSync(join(project, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(project, "xbrief", "completed"), { recursive: true });
    const childCompleted = join(project, "xbrief", "completed", "child-notice.xbrief.json");
    writeFileSync(
      childCompleted,
      JSON.stringify({
        plan: {
          id: "child-notice",
          title: "child-notice",
          status: "completed",
          planRef: "pending/parent-notice.xbrief.json",
          items: [{ id: "i1", title: "t", status: "done" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(project, "xbrief", "pending", "parent-notice.xbrief.json"),
      JSON.stringify({
        plan: {
          id: "parent-notice",
          title: "parent-notice",
          status: "pending",
          references: [{ type: "x-vbrief/plan", uri: "completed/child-notice.xbrief.json" }],
          metadata: { kind: "epic" },
        },
      }),
      "utf8",
    );
    const sweep = sweepCohort([childCompleted], project, false);
    const parent = sweep.parents.find((p) => p.action === "activate+complete");
    expect(parent?.ok).toBe(true);
    expect(parent?.detail).toContain("derive clauses from the statement's testable constraints");
    expect(parent?.detail).toContain("complete ok");
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

  it("never lets a later ambient owner release another cohort's lease (#3611)", () => {
    const project = mkdtempSync(join(tmpdir(), "sw-close-owner-"));
    const storyId = "cohort-a";
    const storyPath = writeActiveStory(project, storyId);
    const launchOwner = "host:codex:v1:bGF1bmNoLWE";
    const laterOwner = "host:codex:v1:bGF0ZXItYg";
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: launchOwner,
      story_ids: [storyId],
      cohort_key: occupancyCohortKey(null, [storyId]),
    });
    applyWorktreeOccupancy(project, { sessionId: laterOwner, intent: "mutation" });

    const result = completeCohort({
      projectRoot: project,
      stories: [storyPath],
      env: { DEFT_SESSION_ID: laterOwner },
    });

    expect(result.exitCode).toBe(1);
    expect(result.sweep?.errors.join("\n")).toContain("different cohort");
    expect(readOccupancy(project)?.sessionId).toBe(laterOwner);
    rmSync(project, { recursive: true, force: true });
  });
});

describe("launch occupancy record lifecycle (#4595)", () => {
  function writeLaunchStory(project: string, storyId: string, issue: number): void {
    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(project, "xbrief", "active", `${storyId}.xbrief.json`),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          id: storyId,
          title: storyId,
          status: "running",
          references: [
            {
              uri: `https://github.com/deftai/directive/issues/${issue}`,
              type: "x-vbrief/github-issue",
            },
          ],
          metadata: { kind: "story", swarm: { readiness: "ready" } },
        },
      }),
      "utf8",
    );
  }

  function writeProjectDef(project: string): void {
    mkdirSync(join(project, "xbrief"), { recursive: true });
    writeFileSync(
      join(project, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { policy: { swarmSubagentBackend: "grok-build" } },
      }),
      "utf8",
    );
    mkdirSync(join(project, ".deft"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "routing.local.json"),
      JSON.stringify({
        grok: { "leaf-implementation": { model: "grok-4", mode: "pinned" } },
      }),
      "utf8",
    );
  }

  function stubGates() {
    return {
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"] as [string, string],
    };
  }

  it("does not let --group collapse disjoint waves into one roster file", () => {
    expect(occupancyCohortKey("wave7", ["a"])).not.toBe(occupancyCohortKey("wave7", ["b"]));
    expect(occupancyCohortKey("wave7", ["a"])).toBe("plan:wave7:stories:a");
  });

  it("creates, or replaces only when live lease and roster match", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-persist-"));
    applyWorktreeOccupancy(project, { sessionId: "owner-a", intent: "swarm" });
    const record = {
      allocation_plan_id: null,
      occupancy_session_id: "owner-a",
      story_ids: ["story-a"],
      cohort_key: occupancyCohortKey(null, ["story-a"]),
    };
    persistLaunchOccupancyRecord(project, record);
    persistLaunchOccupancyRecord(project, record);
    expect(() =>
      persistLaunchOccupancyRecord(project, { ...record, occupancy_session_id: "owner-b" }),
    ).toThrow(LAUNCH_OCCUPANCY_IDENTITY_SWAP);
    expect(() =>
      persistLaunchOccupancyRecord(project, { ...record, story_ids: ["story-b"] }),
    ).toThrow(LAUNCH_OCCUPANCY_IDENTITY_SWAP);
    rmSync(project, { recursive: true, force: true });
  });

  it("retracts leftover records when live occupancy is gone", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-retract-"));
    applyWorktreeOccupancy(project, { sessionId: "owner-a", intent: "swarm" });
    const key = occupancyCohortKey(null, ["story-a"]);
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: "owner-a",
      story_ids: ["story-a"],
      cohort_key: key,
    });
    releaseOccupancy(project, { sessionId: "owner-a" });
    const resolved = resolveLaunchOccupancySessionId(project, { storyIds: ["story-a"] });
    expect(resolved.reason).toBe("missing");
    expect(existsSync(join(project, ...launchOccupancyRecordRelpath(key)))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("retracts the occupancy record on failAfterClaim after persist", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-fail-"));
    writeProjectDef(project);
    writeLaunchStory(project, "story-a", 4595);
    const outputDirectory = join(project, "existing-output-directory");
    mkdirSync(outputDirectory, { recursive: true });
    const result = swarmLaunch({
      stories: ["story-a"],
      projectRoot: project,
      autonomous: true,
      output: outputDirectory,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not write --output");
    const key = occupancyCohortKey(null, ["story-a"]);
    expect(existsSync(join(project, ...launchOccupancyRecordRelpath(key)))).toBe(false);
    expect(readOccupancy(project)).toBeNull();
    rmSync(project, { recursive: true, force: true });
  });

  it("calls verifyPlanTarget from swarmLaunch and fail-closes unnamed cohort when missing", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-plan-"));
    writeProjectDef(project);
    writeLaunchStory(project, "coh-a", 45951);
    writeLaunchStory(project, "coh-b", 45952);
    const missing = admitSwarmLaunchPlanSequence(project);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected missing sequence");
    expect(missing.code).toBe("missing");
    const denied = swarmLaunch({
      stories: ["coh-a", "coh-b"],
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toContain("ordered-plan sequence");
    const allowed = swarmLaunch({
      stories: ["coh-a", "coh-b"],
      group: "wave7",
      allocationPlanId: "plan-1",
      batchingRationale: "approved",
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(allowed.exitCode).toBe(0);
    rmSync(project, { recursive: true, force: true });
  });

  it("named re-launch retracts a leftover then creates", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-relaunch-"));
    applyWorktreeOccupancy(project, { sessionId: "owner-a", intent: "swarm" });
    const key = occupancyCohortKey(null, ["story-a"]);
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: "owner-a",
      story_ids: ["story-a"],
      cohort_key: key,
    });
    releaseOccupancy(project, { sessionId: "owner-a" });
    expect(retractLaunchOccupancyRecord(project, { cohortKey: key })).toBe(true);
    applyWorktreeOccupancy(project, { sessionId: "owner-b", intent: "swarm" });
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: "owner-b",
      story_ids: ["story-a"],
      cohort_key: key,
    });
    expect(resolveLaunchOccupancySessionId(project, { storyIds: ["story-a"] }).sessionId).toBe(
      "owner-b",
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("retracts leftover roster then creates when a new occupant relaunches", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-relaunch-live-"));
    applyWorktreeOccupancy(project, { sessionId: "owner-a", intent: "swarm" });
    const key = occupancyCohortKey(null, ["story-a"]);
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: "owner-a",
      story_ids: ["story-a"],
      cohort_key: key,
    });
    releaseOccupancy(project, { sessionId: "owner-a" });
    applyWorktreeOccupancy(project, { sessionId: "owner-b", intent: "swarm" });
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: "owner-b",
      story_ids: ["story-a"],
      cohort_key: key,
    });
    expect(resolveLaunchOccupancySessionId(project, { storyIds: ["story-a"] }).sessionId).toBe(
      "owner-b",
    );
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses persist of a stale session while another occupant is live", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-stale-persist-"));
    applyWorktreeOccupancy(project, { sessionId: "owner-a", intent: "swarm" });
    const key = occupancyCohortKey(null, ["story-a"]);
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: "owner-a",
      story_ids: ["story-a"],
      cohort_key: key,
    });
    releaseOccupancy(project, { sessionId: "owner-a" });
    applyWorktreeOccupancy(project, { sessionId: "owner-b", intent: "swarm" });
    expect(() =>
      persistLaunchOccupancyRecord(project, {
        allocation_plan_id: null,
        occupancy_session_id: "owner-a",
        story_ids: ["story-a"],
        cohort_key: key,
      }),
    ).toThrow(LAUNCH_OCCUPANCY_IDENTITY_SWAP);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses a stale recorded session when another occupant holds the live lease", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-stale-"));
    applyWorktreeOccupancy(project, { sessionId: "owner-a", intent: "swarm" });
    const key = occupancyCohortKey(null, ["story-a"]);
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: "owner-a",
      story_ids: ["story-a"],
      cohort_key: key,
    });
    releaseOccupancy(project, { sessionId: "owner-a" });
    applyWorktreeOccupancy(project, { sessionId: "owner-b", intent: "mutation" });
    const resolved = resolveLaunchOccupancySessionId(project, { storyIds: ["story-a"] });
    expect(resolved.reason).toBe("wrong-cohort");
    expect(resolved.sessionId).toBe("");
    expect(existsSync(join(project, ...launchOccupancyRecordRelpath(key)))).toBe(true);
    expect(readOccupancy(project)?.sessionId).toBe("owner-b");
    rmSync(project, { recursive: true, force: true });
  });

  it("does not retract a heartbeat-replaced roster when later --output fails", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-hb-"));
    writeProjectDef(project);
    writeLaunchStory(project, "story-a", 4595);
    const first = swarmLaunch({
      stories: ["story-a"],
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(first.exitCode).toBe(0);
    const key = occupancyCohortKey(null, ["story-a"]);
    expect(existsSync(join(project, ...launchOccupancyRecordRelpath(key)))).toBe(true);
    const outputDirectory = join(project, "existing-output-directory");
    mkdirSync(outputDirectory, { recursive: true });
    const second = swarmLaunch({
      stories: ["story-a"],
      projectRoot: project,
      autonomous: true,
      output: outputDirectory,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(second.exitCode).not.toBe(0);
    expect(existsSync(join(project, ...launchOccupancyRecordRelpath(key)))).toBe(true);
    expect(readOccupancy(project)?.sessionId).toBe("test-session");
    rmSync(project, { recursive: true, force: true });
  });

  it("fail-closes unnamed swarm-cohort when verifyPlanTarget rejects mismatch", () => {
    const project = mkdtempSync(join(tmpdir(), "occ-plan-mm-"));
    writeProjectDef(project);
    writeLaunchStory(project, "coh-a", 45951);
    writeLaunchStory(project, "coh-b", 45952);
    mkdirSync(join(project, ".deft"), { recursive: true });
    writeFileSync(
      join(project, ".deft", "plan-sequence.json"),
      JSON.stringify({
        sequence_id: "seq-1",
        sequence_kind: "delivery",
        entries: [{ id: "other-story", kind: "story" }],
        current_index: 0,
        batching_allowed: false,
        continuation_past_final: false,
        exhausted: false,
        authorized_by: "test",
        created_at: "2026-09-16T00:00:00Z",
        updated_at: "2026-09-16T00:00:00Z",
      }),
      "utf8",
    );
    const denied = swarmLaunch({
      stories: ["coh-a", "coh-b"],
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toContain("ordered-plan sequence");
    const groupOnly = swarmLaunch({
      stories: ["coh-a", "coh-b"],
      group: "wave7",
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(groupOnly.exitCode).not.toBe(0);
    const allowed = swarmLaunch({
      stories: ["coh-a", "coh-b"],
      allocationPlanId: "plan-1",
      batchingRationale: "approved",
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(allowed.exitCode).toBe(0);
    rmSync(project, { recursive: true, force: true });
  });
});
