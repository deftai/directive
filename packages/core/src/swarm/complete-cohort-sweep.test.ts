import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintAcceptanceDispositionTemplateGrant } from "../policy/acceptance-disposition-grant.js";
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
import { launchCloseoutLockPath } from "./launch-closeout-lock.js";
import {
  findWorkerAuthAssignmentsForStories,
  readWorkerAuthAssignment,
  workerAuthStoreDir,
  writeWorkerAuthAssignment,
} from "./worker-auth-assignment.js";

const TEST_WORKER_AUTH = {
  workerGithubAuthMode: "host-gh" as const,
  expectedPrincipal: { kind: "user" as const, login: "test-worker" },
};
function gitInitIfNeeded(project: string): void {
  try {
    execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: project, stdio: "ignore" });
  } catch {
    execFileSync("git", ["init", "-q"], { cwd: project });
  }
}

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

  it("cleans owner-bound worker auth assignments on terminal close-out", {
    timeout: 60_000, // #5086 suite-load testTimeout
  }, () => {
    const project = mkdtempSync(join(tmpdir(), "sw-auth-clean-"));
    gitInitIfNeeded(project);
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "T"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: project });
    const storyId = "cohort-auth";
    const storyPath = writeActiveStory(project, storyId);
    const launchOwner = "host:codex:v1:YXV0aC1jbGVhbg";
    persistLaunchOccupancyRecord(project, {
      allocation_plan_id: null,
      occupancy_session_id: launchOwner,
      story_ids: [storyId],
      cohort_key: occupancyCohortKey(null, [storyId]),
    });
    applyWorktreeOccupancy(project, { sessionId: launchOwner, intent: "swarm" });
    const written = writeWorkerAuthAssignment({
      projectRoot: project,
      worktreePath: project,
      dispatchId: launchOwner,
      storyId,
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "test-worker" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    const result = completeCohort({
      projectRoot: project,
      stories: [storyPath],
      env: { DEFT_SESSION_ID: launchOwner },
    });
    expect(result.exitCode).toBe(0);
    const read = readWorkerAuthAssignment(project);
    expect(read).toEqual({ ok: true, assignment: null, commonDir: expect.any(String) });
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
    gitInitIfNeeded(project);
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
      ...TEST_WORKER_AUTH,
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
      ...TEST_WORKER_AUTH,
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
      ...TEST_WORKER_AUTH,
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
      ...TEST_WORKER_AUTH,
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
      ...TEST_WORKER_AUTH,
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
      ...TEST_WORKER_AUTH,
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
      ...TEST_WORKER_AUTH,
      stories: ["coh-a", "coh-b"],
      group: "wave7",
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(groupOnly.exitCode).not.toBe(0);
    // #4433 clauses 3/13: while a plan file is present the consent pair is
    // not an admission path; named and unnamed launches share the refuse.
    const named = swarmLaunch({
      ...TEST_WORKER_AUTH,
      stories: ["coh-a", "coh-b"],
      allocationPlanId: "plan-1",
      batchingRationale: "approved",
      projectRoot: project,
      autonomous: true,
      sessionId: "test-session",
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      ...stubGates(),
    });
    expect(named.exitCode).not.toBe(0);
    expect(named.stderr).toContain("not authorized by the active ordered-plan sequence");
    expect(named.stderr).toContain("story:coh-a");
    rmSync(project, { recursive: true, force: true });
  });

  describe("roster admission against the ordered plan (#4433)", () => {
    function writePlan(
      project: string,
      plan: { entries: unknown[]; batching_allowed?: boolean; exhausted?: boolean },
    ): void {
      mkdirSync(join(project, ".deft"), { recursive: true });
      writeFileSync(
        join(project, ".deft", "plan-sequence.json"),
        JSON.stringify({
          sequence_id: "seq-4433",
          sequence_kind: "cohort",
          entries: plan.entries,
          current_index: 0,
          batching_allowed: plan.batching_allowed ?? false,
          continuation_past_final: false,
          exhausted: plan.exhausted ?? false,
          authorized_by: "test",
          created_at: "2026-11-16T00:00:00Z",
          updated_at: "2026-11-16T00:00:00Z",
        }),
        "utf8",
      );
    }

    function launch(project: string, stories: string[], extra: Record<string, unknown> = {}) {
      return swarmLaunch({
        ...TEST_WORKER_AUTH,
        stories,
        projectRoot: project,
        autonomous: true,
        sessionId: "test-session",
        environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
        ...stubGates(),
        ...extra,
      });
    }

    function cohortProject(prefix: string): string {
      const project = mkdtempSync(join(tmpdir(), prefix));
      writeProjectDef(project);
      writeLaunchStory(project, "coh-a", 45951);
      writeLaunchStory(project, "coh-b", 45952);
      writeLaunchStory(project, "coh-c", 45953);
      return project;
    }

    const batchEntries = [
      { id: "coh-a", kind: "story", batch: "w1" },
      { id: "coh-b", kind: "story", batch: "w1" },
      { id: "coh-c", kind: "story", batch: "w2" },
    ];

    it("clauses 9/10: a solo launch is checked; the real roster member must be current", () => {
      const project = cohortProject("plan-solo-");
      writePlan(project, { entries: [{ id: "coh-a", kind: "story" }] });
      const refused = launch(project, ["coh-b"]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain(
        "Launch roster member story:coh-b (issues #45952) is not the current ordered-plan entry (story:coh-a).",
      );
      expect(launch(project, ["coh-a"]).exitCode).toBe(0);
      rmSync(project, { recursive: true, force: true });
    });

    it("clause 7: a current story:swarm-cohort entry does not admit the real roster", () => {
      const project = cohortProject("plan-sentinel-");
      writePlan(project, { entries: [{ id: "swarm-cohort", kind: "story" }] });
      const refused = launch(project, ["coh-a", "coh-b"]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("story:coh-a");
      rmSync(project, { recursive: true, force: true });
    });

    it("clauses 11/30/31: batching_allowed admits the current batch only; false keeps one entry", () => {
      const project = cohortProject("plan-batch-");
      writePlan(project, { entries: batchEntries, batching_allowed: true });
      expect(launch(project, ["coh-a", "coh-b"]).exitCode).toBe(0);
      const later = launch(project, ["coh-a", "coh-c"]);
      expect(later.exitCode).not.toBe(0);
      expect(later.stderr).toContain('in the current ordered-plan batch "w1"');
      writePlan(project, { entries: batchEntries, batching_allowed: false });
      const serial = launch(project, ["coh-a", "coh-b"], {
        allocationPlanId: "plan-1",
        batchingRationale: "approved",
      });
      expect(serial.exitCode).not.toBe(0);
      expect(serial.stderr).toContain("story:coh-b");
      rmSync(project, { recursive: true, force: true });
    });

    it("clause 6: launch admission reads the derived cursor (terminal origins passed)", () => {
      const project = cohortProject("plan-derived-");
      writePlan(project, {
        entries: [
          { id: "prior-story", kind: "story" },
          { id: "coh-a", kind: "story" },
        ],
      });
      mkdirSync(join(project, "xbrief", "completed"), { recursive: true });
      writeFileSync(
        join(project, "xbrief", "completed", "prior-story.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { id: "prior-story", title: "prior-story", status: "completed", items: [] },
        }),
        "utf8",
      );
      expect(launch(project, ["coh-a"]).exitCode).toBe(0);
      rmSync(project, { recursive: true, force: true });
    });

    it("clauses 15/16/17: an exhausted plan is active and refuses even with consent", () => {
      const project = cohortProject("plan-exhausted-");
      writePlan(project, {
        entries: [{ id: "coh-a", kind: "story", status: "completed" }],
        exhausted: true,
      });
      const cohort = launch(project, ["coh-a", "coh-b"], {
        allocationPlanId: "plan-1",
        batchingRationale: "approved",
      });
      expect(cohort.exitCode).not.toBe(0);
      expect(cohort.stderr).toContain("I have completed the approved sequence");
      const single = launch(project, ["coh-a"], { group: "wave7" });
      expect(single.exitCode).not.toBe(0);
      expect(single.stderr).toContain("I have completed the approved sequence");
      expect(admitSwarmLaunchPlanSequence(project, []).ok).toBe(false);
      rmSync(project, { recursive: true, force: true });
    });

    it("clause 19: an issue-kind entry admits the story that resolves to that issue", () => {
      const project = cohortProject("plan-issue-");
      writePlan(project, { entries: [{ id: "45951", kind: "issue", issue: 45951 }] });
      expect(launch(project, ["coh-a"]).exitCode).toBe(0);
      const other = launch(project, ["coh-b"]);
      expect(other.exitCode).not.toBe(0);
      rmSync(project, { recursive: true, force: true });
    });

    it("clause 19: related Traces mentions and PR links do not join the story's issue set", () => {
      const project = cohortProject("plan-traces-");
      writeFileSync(
        join(project, "xbrief", "active", "coh-t.xbrief.json"),
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: {
            id: "coh-t",
            title: "coh-t",
            status: "running",
            narratives: { Traces: "#45951; related #6205, #2402" },
            references: [
              {
                uri: "https://github.com/deftai/directive/issues/45954",
                type: "x-xbrief/github-issue",
              },
              { uri: "https://github.com/deftai/directive/pull/6381", type: "x-xbrief/github-pr" },
            ],
            metadata: { kind: "story", swarm: { readiness: "ready" } },
          },
        }),
        "utf8",
      );
      writePlan(project, { entries: [{ id: "45954", kind: "issue", issue: 45954 }] });
      expect(launch(project, ["coh-t"]).exitCode).toBe(0);
      rmSync(project, { recursive: true, force: true });
    });
  });
});

describe("dry-run applies acceptance-disposition grants on the clone (#6318)", () => {
  function deferralStory(project: string): string {
    const full = join(project, "xbrief", "active", "deferral.xbrief.json");
    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    writeFileSync(
      full,
      JSON.stringify({
        plan: {
          id: "github.issue.6318",
          title: "deferral",
          status: "running",
          acceptance: {
            clauses: [
              { id: 1, text: "Covered by a test." },
              { id: 2, text: "Deferred clause." },
            ],
          },
          items: [
            {
              id: "clause.1",
              title: "Covered by a test.",
              status: "pending",
              ...acceptanceEvidence("packages/core/src/swarm/complete-cohort-sweep.test.ts"),
            },
          ],
        },
      }),
      "utf8",
    );
    return full;
  }

  function mint(project: string, now: Date): void {
    const minted = mintAcceptanceDispositionTemplateGrant({
      projectRoot: project,
      planRef: "github.issue.6318",
      storyIds: ["clause.2"],
      deferredTo: "#6400",
      reason: "operator correction",
      now,
    });
    if (!minted.ok) throw new Error(minted.reason);
  }

  it("passes with a live grant and refuses an expired unused grant without writing", () => {
    vi.mocked(runTransition).mockClear();
    const project = mkdtempSync(join(tmpdir(), "sw-dry-6318-"));
    gitInitIfNeeded(project);
    const storyPath = deferralStory(project);
    const before = readFileSync(storyPath, "utf8");
    // Without a grant the open clause fails the dry run.
    expect(sweepCohort([storyPath], project, true).stories[0]?.ok).toBe(false);
    mint(project, new Date(Date.now() - 3 * 24 * 3600 * 1000));
    const expired = sweepCohort([storyPath], project, true);
    expect(expired.stories[0]?.ok).toBe(false);
    expect(expired.stories[0]?.detail).toMatch(/expired.*re-mint.*authz:revoke/);
    mint(project, new Date());
    const live = sweepCohort([storyPath], project, true);
    expect(live.stories[0]?.ok).toBe(true);
    expect(readFileSync(storyPath, "utf8")).toBe(before);
    expect(vi.mocked(runTransition)).not.toHaveBeenCalled();
    rmSync(project, { recursive: true, force: true });
  });
});

describe("per-story close-out (#6422)", { timeout: 120_000 }, () => {
  const S = "host:claude:v1:c2Vzc2lvbi02NDIy";
  const OTHER = "host:claude:v1:b3RoZXItNjQyMg";
  const LOGIN = { kind: "user" as const, login: "test-worker" };

  beforeEach(() => {
    vi.mocked(runTransition).mockClear();
  });

  function gitProject(prefix: string): string {
    const project = mkdtempSync(join(tmpdir(), prefix));
    gitInitIfNeeded(project);
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "T"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: project });
    return project;
  }

  function storyIn(project: string, folder: string, id: string): string {
    const dir = join(project, "xbrief", folder);
    mkdirSync(dir, { recursive: true });
    const full = join(dir, `${id}.xbrief.json`);
    writeFileSync(
      full,
      JSON.stringify({ plan: { id, title: id, status: "running", items: [] } }),
      "utf8",
    );
    return full;
  }

  function assign(project: string, dispatchId: string, storyId: string): void {
    const written = writeWorkerAuthAssignment({
      projectRoot: project,
      worktreePath: join(project, ".deft-scratch", "worktrees", storyId),
      dispatchId,
      storyId,
      githubAuthMode: "host-gh",
      expectedPrincipal: LOGIN,
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
  }

  function assigned(project: string, storyIds: readonly string[]): string[] {
    return findWorkerAuthAssignmentsForStories({ projectRoot: project, storyIds })
      .map((a) => `${a.story_id}@${a.dispatch_id}`)
      .sort();
  }

  function writeRecord(
    project: string,
    session: string,
    stories: readonly string[],
    closed: readonly string[] = [],
  ): string {
    const key = occupancyCohortKey(null, stories);
    const relpath = launchOccupancyRecordRelpath(key);
    mkdirSync(join(project, ...relpath.slice(0, -1)), { recursive: true });
    const full = join(project, ...relpath);
    writeFileSync(
      full,
      JSON.stringify({
        allocation_plan_id: null,
        occupancy_session_id: session,
        story_ids: stories,
        cohort_key: key,
        ...(closed.length > 0 ? { closed_story_ids: closed } : {}),
      }),
      "utf8",
    );
    return full;
  }

  function readRecord(path: string): { closed_story_ids?: string[]; story_ids: string[] } | null {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }

  function lease(project: string, session: string): void {
    expect(applyWorktreeOccupancy(project, { sessionId: session, intent: "swarm" }).code).toBe(0);
  }

  function holdLock(project: string): void {
    mkdirSync(join(project, ".deft"), { recursive: true });
    writeFileSync(
      launchCloseoutLockPath(project),
      `${String(process.pid)}\nheld-by-test\n${String(Date.now())}\n`,
      "utf8",
    );
  }

  /** Lock deps whose first wait releases the test-held lock and runs `other`. */
  function whileWaiting(project: string, other: () => void) {
    let done = false;
    return {
      sleepMs: () => {
        if (done) return;
        done = true;
        rmSync(launchCloseoutLockPath(project), { force: true });
        other();
      },
    };
  }

  function closeOut(project: string, paths: readonly string[], extra = {}) {
    return completeCohort({ projectRoot: project, stories: [...paths], env: {}, ...extra });
  }

  function launchStory(project: string, storyId: string, issue: number): void {
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
              uri: `https://github.com/deftai/directive/issues/${String(issue)}`,
              type: "x-vbrief/github-issue",
            },
          ],
          metadata: { kind: "story", swarm: { readiness: "ready" } },
        },
      }),
      "utf8",
    );
  }

  function launchProject(prefix: string): string {
    const project = gitProject(prefix);
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
      JSON.stringify({ grok: { "leaf-implementation": { model: "grok-4", mode: "pinned" } } }),
      "utf8",
    );
    return project;
  }

  function launch(
    project: string,
    stories: readonly string[],
    extra: Record<string, unknown> = {},
  ): { exitCode: number } {
    return swarmLaunch({
      ...TEST_WORKER_AUTH,
      stories: [...stories],
      projectRoot: project,
      autonomous: true,
      sessionId: S,
      environ: { DEFT_ROUTING_PATH: join(project, ".deft", "routing.local.json") },
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"] as [string, string],
      ...extra,
    });
  }

  function recordExists(project: string, stories: readonly string[]): boolean {
    return existsSync(
      join(project, ...launchOccupancyRecordRelpath(occupancyCohortKey(null, stories))),
    );
  }

  it("exits 0 and keeps the lease when no launch record lists the story (AC 12)", () => {
    const project = gitProject("sw-6422-unlaunched-");
    const story = storyIn(project, "active", "solo-a");
    lease(project, S);
    const result = closeOut(project, [story]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("missing or belongs to a different cohort");
    expect(result.sweep?.closeout_notes?.join("\n")).toContain("no launch record lists solo-a");
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("reports and leaves a registration a launch in a linked worktree wrote (AC 13)", {
    timeout: 180_000, // launch-heavy under parallel suite load
  }, () => {
    const main = gitProject("sw-6422-main-");
    const second = `${main}-wt2`;
    execFileSync("git", ["worktree", "add", "-q", "-b", "wt2", second], { cwd: main });
    assign(second, OTHER, "shared-s");
    const story = storyIn(main, "completed", "shared-s");
    const result = closeOut(main, [story]);
    expect(result.exitCode).toBe(0);
    const notes = result.sweep?.closeout_notes ?? [];
    expect(notes.filter((n) => n.includes("shared-s"))).toHaveLength(1);
    expect(notes.join("\n")).toContain(`dispatch_id ${OTHER}`);
    expect(assigned(main, ["shared-s"])).toEqual([`shared-s@${OTHER}`]);
    rmSync(second, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  });

  it("fails on an unparseable record, names it, and changes nothing (AC 14, 32)", () => {
    const project = gitProject("sw-6422-badrec-");
    const story = storyIn(project, "active", "bad-a");
    lease(project, S);
    assign(project, S, "bad-a");
    const dir = join(project, ".deft", "swarm-launch-occupancy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
    const text = closeOut(project, [story]);
    expect(text.exitCode).toBe(1);
    expect(text.sweep?.errors.join("\n")).toContain("broken.json");
    expect(text.stdout).toContain("CLOSE-OUT FAILED after a clean sweep");
    expect(text.stdout).toContain("already on disk");
    expect(text.stdout).toContain(
      "xbrief/active/bad-a.xbrief.json -> xbrief/completed/bad-a.xbrief.json",
    );
    const json = closeOut(project, [story], { emitJson: true });
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(json.exitCode).toBe(1);
    expect(parsed.lifecycle_move_notice).toContain("already on disk");
    expect(parsed.lifecycle_moves_on_disk).toEqual([
      {
        source: "xbrief/active/bad-a.xbrief.json",
        destination: "xbrief/completed/bad-a.xbrief.json",
      },
    ]);
    expect(assigned(project, ["bad-a"])).toEqual([`bad-a@${S}`]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("closes one story, then releases on the last one (AC 15, 16)", () => {
    const project = gitProject("sw-6422-cohort-");
    const a = storyIn(project, "active", "coh-a");
    const b = storyIn(project, "active", "coh-b");
    const rec = writeRecord(project, S, ["coh-a", "coh-b"]);
    lease(project, S);
    assign(project, S, "coh-a");
    assign(project, S, "coh-b");
    const first = closeOut(project, [a]);
    expect(first.exitCode).toBe(0);
    expect(assigned(project, ["coh-a", "coh-b"])).toEqual([`coh-b@${S}`]);
    expect(readRecord(rec)?.closed_story_ids).toEqual(["coh-a"]);
    expect(readRecord(rec)?.story_ids).toEqual(["coh-a", "coh-b"]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    const last = closeOut(project, [b]);
    expect(last.exitCode).toBe(0);
    expect(assigned(project, ["coh-a", "coh-b"])).toEqual([]);
    expect(readRecord(rec)).toBeNull();
    expect(readOccupancy(project)).toBeNull();
    rmSync(project, { recursive: true, force: true });
  });

  it("leaves another cohort of the same session alone (AC 17)", () => {
    const project = gitProject("sw-6422-two-cohorts-");
    const a = storyIn(project, "active", "one-a");
    writeRecord(project, S, ["one-a"]);
    const other = writeRecord(project, S, ["two-b"]);
    lease(project, S);
    assign(project, S, "one-a");
    assign(project, S, "two-b");
    expect(closeOut(project, [a]).exitCode).toBe(0);
    expect(assigned(project, ["one-a", "two-b"])).toEqual([`two-b@${S}`]);
    expect(readRecord(other)?.closed_story_ids).toBeUndefined();
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("keeps the record when the release fails and finishes on the next run (AC 18)", () => {
    const project = gitProject("sw-6422-release-fail-");
    const a = storyIn(project, "active", "rel-a");
    const rec = writeRecord(project, S, ["rel-a"]);
    lease(project, S);
    const failed = closeOut(project, [a], {
      releaseSwarmOccupancyFn: () => ({
        action: "denied",
        sessionId: S,
        record: null,
        path: "",
        message: "release refused by test",
        code: 1,
      }),
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.sweep?.errors.join("\n")).toContain("release refused by test");
    expect(readRecord(rec)?.closed_story_ids).toEqual(["rel-a"]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    const again = closeOut(project, [a]);
    expect(again.exitCode).toBe(0);
    expect(readRecord(rec)).toBeNull();
    expect(readOccupancy(project)).toBeNull();
    rmSync(project, { recursive: true, force: true });
  });

  it("removes a fully closed record after a stopped run without releasing (AC 19, 20)", () => {
    const project = gitProject("sw-6422-finish-");
    const a = storyIn(project, "completed", "fin-a");
    const rec = writeRecord(project, S, ["fin-a"], ["fin-a"]);
    const none = closeOut(project, [a]);
    expect(none.exitCode).toBe(0);
    expect(readRecord(rec)).toBeNull();
    expect(readOccupancy(project)).toBeNull();
    const rec2 = writeRecord(project, S, ["fin-a"], ["fin-a"]);
    lease(project, OTHER);
    const taken = closeOut(project, [a]);
    expect(taken.exitCode).toBe(0);
    expect(readRecord(rec2)).toBeNull();
    expect(readOccupancy(project)?.sessionId).toBe(OTHER);
    rmSync(project, { recursive: true, force: true });
  });

  it("removes the second fully closed record left by a stopped removal (AC 21)", () => {
    const project = gitProject("sw-6422-finish-two-");
    const a = storyIn(project, "completed", "fin2-a");
    writeRecord(project, S, ["fin2-a"], ["fin2-a"]);
    const second = writeRecord(project, S, ["fin2-b"], ["fin2-b"]);
    expect(closeOut(project, [a]).exitCode).toBe(0);
    expect(readRecord(second)).toBeNull();
    rmSync(project, { recursive: true, force: true });
  });

  it("waits for a starting launch and then keeps the lease (AC 22)", {
    timeout: 180_000, // launch-heavy under parallel suite load
  }, () => {
    const project = launchProject("sw-6422-wait-launch-");
    const x = storyIn(project, "active", "wait-x");
    launchStory(project, "wait-y", 64221);
    const rec = writeRecord(project, S, ["wait-x"]);
    lease(project, S);
    holdLock(project);
    let launched = -1;
    const result = closeOut(project, [x], {
      lockDeps: whileWaiting(project, () => {
        launched = launch(project, ["wait-y"]).exitCode;
      }),
    });
    expect(launched).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(readRecord(rec)?.closed_story_ids).toEqual(["wait-x"]);
    expect(recordExists(project, ["wait-y"])).toBe(true);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("makes a later launch wait for an earlier launch's rollback (AC 23)", {
    timeout: 180_000, // launch-heavy under parallel suite load
  }, () => {
    const project = launchProject("sw-6422-wait-rollback-");
    launchStory(project, "roll-a", 64222);
    launchStory(project, "roll-b", 64223);
    const outputDirectory = join(project, "existing-output-directory");
    mkdirSync(outputDirectory, { recursive: true });
    holdLock(project);
    let first = -1;
    const second = launch(project, ["roll-b"], {
      closeoutLockDeps: whileWaiting(project, () => {
        first = launch(project, ["roll-a"], { output: outputDirectory }).exitCode;
      }),
    });
    expect(first).not.toBe(0);
    expect(second.exitCode).toBe(0);
    expect(recordExists(project, ["roll-b"])).toBe(true);
    expect(recordExists(project, ["roll-a"])).toBe(false);
    expect(assigned(project, ["roll-a", "roll-b"])).toEqual([`roll-b@${S}`]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("keeps an earlier launch's registration when a repeat launch fails (AC 24)", {
    timeout: 180_000, // launch-heavy under parallel suite load
  }, () => {
    const project = launchProject("sw-6422-repeat-");
    launchStory(project, "rep-a", 64224);
    expect(launch(project, ["rep-a"]).exitCode).toBe(0);
    const outputDirectory = join(project, "existing-output-directory");
    mkdirSync(outputDirectory, { recursive: true });
    const repeat = launch(project, ["rep-a"], { output: outputDirectory });
    expect(repeat.exitCode).not.toBe(0);
    expect(assigned(project, ["rep-a"])).toEqual([`rep-a@${S}`]);
    expect(recordExists(project, ["rep-a"])).toBe(true);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses an open record whose session does not hold the live lease (AC 25, 29)", () => {
    const project = gitProject("sw-6422-other-holder-");
    const b = storyIn(project, "completed", "oh-b");
    const rec = writeRecord(project, S, ["oh-a", "oh-b"], ["oh-a"]);
    assign(project, S, "oh-b");
    lease(project, OTHER);
    const result = closeOut(project, [b]);
    expect(result.exitCode).toBe(1);
    expect(result.sweep?.errors.join("\n")).toContain("different cohort");
    expect(readRecord(rec)?.closed_story_ids).toEqual(["oh-a"]);
    expect(assigned(project, ["oh-b"])).toEqual([`oh-b@${S}`]);
    expect(readOccupancy(project)?.sessionId).toBe(OTHER);
    rmSync(project, { recursive: true, force: true });
  });

  it("counts a cancelled story swept as terminal toward the release (AC 26)", () => {
    const project = gitProject("sw-6422-cancelled-");
    const a = storyIn(project, "active", "can-a");
    const b = storyIn(project, "cancelled", "can-b");
    const rec = writeRecord(project, S, ["can-a", "can-b"]);
    lease(project, S);
    expect(closeOut(project, [a, b]).exitCode).toBe(0);
    expect(readRecord(rec)).toBeNull();
    expect(readOccupancy(project)).toBeNull();
    rmSync(project, { recursive: true, force: true });
  });

  it("leaves a skipped story open (AC 27)", () => {
    const project = gitProject("sw-6422-skipped-");
    const a = storyIn(project, "active", "sk-a");
    const b = storyIn(project, "proposed", "sk-b");
    const rec = writeRecord(project, S, ["sk-a", "sk-b"]);
    lease(project, S);
    assign(project, S, "sk-b");
    expect(closeOut(project, [a, b]).exitCode).toBe(0);
    expect(readRecord(rec)?.closed_story_ids).toEqual(["sk-a"]);
    expect(assigned(project, ["sk-b"])).toEqual([`sk-b@${S}`]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses a run that mixes stories of two records (AC 28)", () => {
    const project = gitProject("sw-6422-mixed-");
    const a = storyIn(project, "active", "mx-a");
    const b = storyIn(project, "active", "mx-b");
    const recA = writeRecord(project, S, ["mx-a"]);
    const recB = writeRecord(project, S, ["mx-b"]);
    lease(project, S);
    assign(project, S, "mx-a");
    assign(project, S, "mx-b");
    const result = closeOut(project, [a, b]);
    expect(result.exitCode).toBe(1);
    const errors = result.sweep?.errors.join("\n") ?? "";
    expect(errors).toContain("mx-a");
    expect(errors).toContain("mx-b");
    expect(errors).toContain("removed nothing and released nothing");
    expect(readRecord(recA)?.closed_story_ids).toBeUndefined();
    expect(readRecord(recB)?.closed_story_ids).toBeUndefined();
    expect(assigned(project, ["mx-a", "mx-b"])).toEqual([`mx-a@${S}`, `mx-b@${S}`]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("serializes two close-outs of one cohort so both stories end closed (AC 30)", () => {
    const project = gitProject("sw-6422-concurrent-");
    const a = storyIn(project, "active", "cc-a");
    const b = storyIn(project, "active", "cc-b");
    const rec = writeRecord(project, S, ["cc-a", "cc-b", "cc-c"]);
    lease(project, S);
    holdLock(project);
    let other = -1;
    const first = closeOut(project, [a], {
      lockDeps: whileWaiting(project, () => {
        other = closeOut(project, [b]).exitCode;
      }),
    });
    expect(other).toBe(0);
    expect(first.exitCode).toBe(0);
    expect(readRecord(rec)?.closed_story_ids).toEqual(["cc-a", "cc-b"]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("keeps closed_story_ids through resolve and a matching rewrite (AC 31)", () => {
    const project = gitProject("sw-6422-keep-field-");
    const rec = writeRecord(project, S, ["kf-a", "kf-b"], ["kf-a"]);
    lease(project, S);
    expect(resolveLaunchOccupancySessionId(project, { storyIds: ["kf-a", "kf-b"] }).sessionId).toBe(
      S,
    );
    expect(
      persistLaunchOccupancyRecord(project, {
        allocation_plan_id: null,
        occupancy_session_id: S,
        story_ids: ["kf-a", "kf-b"],
        cohort_key: occupancyCohortKey(null, ["kf-a", "kf-b"]),
      }),
    ).toBe("replaced");
    expect(readRecord(rec)?.closed_story_ids).toEqual(["kf-a"]);
    rmSync(project, { recursive: true, force: true });
  });

  it("returns a lock failure instead of waiting forever", () => {
    const project = gitProject("sw-6422-busy-");
    const a = storyIn(project, "active", "busy-a");
    writeRecord(project, S, ["busy-a"]);
    lease(project, S);
    holdLock(project);
    let now = 0;
    const result = closeOut(project, [a], {
      lockDeps: {
        now: () => now,
        sleepMs: () => {
          now += 60_000;
        },
        acquisitionBudgetMs: 1,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.sweep?.errors.join("\n")).toContain("launch/close-out lock");
    expect(result.stdout).toContain("already on disk");
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses a record of another allocation plan and an ambient owner conflict", () => {
    const project = gitProject("sw-6422-plan-ambient-");
    const a = storyIn(project, "active", "pa-a");
    const key = occupancyCohortKey("plan-x", ["pa-a"]);
    const relpath = launchOccupancyRecordRelpath(key);
    mkdirSync(join(project, ...relpath.slice(0, -1)), { recursive: true });
    writeFileSync(
      join(project, ...relpath),
      JSON.stringify({
        allocation_plan_id: "plan-x",
        occupancy_session_id: S,
        story_ids: ["pa-a"],
        cohort_key: key,
      }),
      "utf8",
    );
    lease(project, S);
    assign(project, S, "pa-a");
    const wrongPlan = closeOut(project, [a], { allocationPlanId: "plan-y" });
    expect(wrongPlan.exitCode).toBe(1);
    expect(wrongPlan.sweep?.errors.join("\n")).toContain("not plan-y");
    const ambient = completeCohort({
      projectRoot: project,
      stories: [a],
      env: { DEFT_SESSION_ID: OTHER },
    });
    expect(ambient.exitCode).toBe(1);
    expect(ambient.sweep?.errors.join("\n")).toContain(`ambient owner ${OTHER}`);
    expect(assigned(project, ["pa-a"])).toEqual([`pa-a@${S}`]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("marks nothing for an open record whose session holds no live lease", () => {
    const project = gitProject("sw-6422-no-lease-");
    const a = storyIn(project, "active", "nl-a");
    const rec = writeRecord(project, S, ["nl-a", "nl-b"]);
    assign(project, S, "nl-a");
    const result = closeOut(project, [a]);
    expect(result.exitCode).toBe(0);
    expect(result.sweep?.closeout_notes?.join("\n")).toContain("holds no live lease");
    expect(readRecord(rec)?.closed_story_ids).toBeUndefined();
    expect(assigned(project, ["nl-a"])).toEqual([`nl-a@${S}`]);
    rmSync(project, { recursive: true, force: true });
  });

  it("fails without marking when the registration index cannot be read", () => {
    const project = gitProject("sw-6422-bad-index-");
    const a = storyIn(project, "active", "bi-a");
    const rec = writeRecord(project, S, ["bi-a", "bi-b"]);
    lease(project, S);
    assign(project, S, "bi-a");
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: project, encoding: "utf8" },
    ).trim();
    writeFileSync(join(workerAuthStoreDir(commonDir), "index.json"), "{broken", "utf8");
    const result = closeOut(project, [a]);
    expect(result.exitCode).toBe(1);
    expect(result.sweep?.errors.join("\n")).toContain("worker auth index");
    expect(readRecord(rec)?.closed_story_ids).toBeUndefined();
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("keeps a fully closed record of the live session it was not asked about", () => {
    const project = gitProject("sw-6422-live-closed-");
    const solo = storyIn(project, "active", "lc-solo");
    const rec = writeRecord(project, S, ["lc-z"], ["lc-z"]);
    lease(project, S);
    expect(closeOut(project, [solo]).exitCode).toBe(0);
    expect(readRecord(rec)?.closed_story_ids).toEqual(["lc-z"]);
    expect(readOccupancy(project)?.sessionId).toBe(S);
    rmSync(project, { recursive: true, force: true });
  });

  it("skips non-JSON files and refuses a JSON file that is not a record", () => {
    const project = gitProject("sw-6422-not-record-");
    const a = storyIn(project, "active", "nr-a");
    const dir = join(project, ".deft", "swarm-launch-occupancy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not a record", "utf8");
    expect(closeOut(project, [a]).exitCode).toBe(0);
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ story_ids: ["nr-a"] }), "utf8");
    const result = closeOut(project, [a]);
    expect(result.exitCode).toBe(1);
    expect(result.sweep?.errors.join("\n")).toContain("empty.json");
    expect(result.sweep?.errors.join("\n")).toContain("not a launch-occupancy record");
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses a launch when the shared lock stays busy", {
    timeout: 180_000, // launch-heavy under parallel suite load
  }, () => {
    const project = launchProject("sw-6422-launch-busy-");
    launchStory(project, "lb-a", 64225);
    holdLock(project);
    let now = 0;
    const result = launch(project, ["lb-a"], {
      closeoutLockDeps: {
        now: () => now,
        sleepMs: () => {
          now += 60_000;
        },
        acquisitionBudgetMs: 1,
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(recordExists(project, ["lb-a"])).toBe(false);
    expect(readOccupancy(project)).toBeNull();
    rmSync(project, { recursive: true, force: true });
  });

  it("closes a story whose active twin the sweep completed", () => {
    const project = gitProject("sw-6422-twin-");
    const done = storyIn(project, "completed", "tw-a");
    storyIn(project, "active", "tw-a");
    const rec = writeRecord(project, S, ["tw-a", "tw-b"]);
    lease(project, S);
    const result = closeOut(project, [done]);
    expect(result.exitCode).toBe(0);
    expect(result.sweep?.stories.some((r) => r.action === "complete")).toBe(true);
    expect(readRecord(rec)?.closed_story_ids).toEqual(["tw-a"]);
    rmSync(project, { recursive: true, force: true });
  });
});
