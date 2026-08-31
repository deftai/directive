import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHostSessionId } from "../session/host-session-owner.js";
import {
  applyWorktreeOccupancy,
  OCCUPANCY_REFRESH_AFTER_MS,
  readOccupancy,
} from "../session/occupancy.js";
import { decideHook, type HookPolicySeams } from "./dispatcher.js";
import type { OwnerLivenessInput, OwnerLivenessOutcome } from "./owner-liveness.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const RAW_GROK_ID = "01a05852-6241-7892-9981-07ba00db0450";
const GROK_OWNER = canonicalHostSessionId("grok", RAW_GROK_ID);

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

function readySeams(): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    inspectScope: () => ({ ready: true, path: "/story.xbrief.json", message: "OK" }),
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path: string) => resolve(path),
  };
}

/**
 * Lease claimed far enough in the past that the shared refresh floor has passed.
 * Baselines are read back from disk: the record stores whole seconds, so an
 * in-memory `Date` would not round-trip.
 */
function leasedRoot(sessionId: string): { root: string; claimedAt: Date; heartbeatAt: Date } {
  const root = mkdtempSync(join(tmpdir(), "hook-liveness-"));
  temps.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  applyWorktreeOccupancy(root, {
    sessionId,
    intent: "mutation",
    now: new Date(Date.now() - OCCUPANCY_REFRESH_AFTER_MS - 60_000),
  });
  const persisted = readOccupancy(root);
  if (persisted === null) throw new Error("occupancy claim did not persist");
  return { root, claimedAt: persisted.claimedAt, heartbeatAt: persisted.heartbeatAt };
}

function recordingSeams(): {
  seams: HookPolicySeams;
  calls: OwnerLivenessInput[];
} {
  const calls: OwnerLivenessInput[] = [];
  const seams: HookPolicySeams = {
    ...readySeams(),
    restampOwnerLiveness: (input: OwnerLivenessInput): OwnerLivenessOutcome => {
      calls.push(input);
      return { restamped: false, reason: "no-live-lease" };
    },
  };
  return { seams, calls };
}

describe("hook-event owner liveness (#3987)", () => {
  it("renews the lease from a shell call that writes nothing", () => {
    const { root, claimedAt, heartbeatAt } = leasedRoot(GROK_OWNER);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "git status --short --branch" },
        },
        environ: { GROK_SESSION_ID: RAW_GROK_ID },
      },
      readySeams(),
    );
    expect(decision.verdict).toBe("allow");
    const after = readOccupancy(root);
    expect(after?.heartbeatAt.getTime()).toBeGreaterThan(heartbeatAt.getTime());
    // Renewal is not a write: `no recorded write` must survive it.
    expect(after?.lastWriteAt).toBeNull();
    expect(after?.claimedAt.toISOString()).toBe(claimedAt.toISOString());
  });

  it("does not renew from an ambient DEFT_SESSION_ID that names the occupant", () => {
    const { root, heartbeatAt } = leasedRoot("owner");
    decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "git status --short --branch" },
        },
        // No GROK_SESSION_ID: grok falls back to the explicit owner flow, which
        // is not host-authoritative, so it must not renew anything.
        environ: { DEFT_SESSION_ID: "owner" },
      },
      readySeams(),
    );
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(heartbeatAt.toISOString());
  });

  it("does not renew a lease held by another session", () => {
    const { root, heartbeatAt } = leasedRoot("someone-else");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "write", tool_input: { file_path: join(root, "src", "app.ts") } },
        environ: { GROK_SESSION_ID: RAW_GROK_ID },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(readOccupancy(root)?.heartbeatAt.toISOString()).toBe(heartbeatAt.toISOString());
  });

  it("runs after the decision and leaves a deny verdict untouched", () => {
    const { root } = leasedRoot("someone-else");
    const { seams, calls } = recordingSeams();
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "write", tool_input: { file_path: join(root, "src", "app.ts") } },
        environ: { GROK_SESSION_ID: RAW_GROK_ID },
      },
      seams,
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ownerSessionId: GROK_OWNER, hostAuthoritative: true });
  });

  it("reports the actor as non-authoritative when host identity conflicts", () => {
    const { root } = leasedRoot(GROK_OWNER);
    const { seams, calls } = recordingSeams();
    decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "git status --short" },
        },
        environ: { GROK_SESSION_ID: RAW_GROK_ID, DEFT_SESSION_ID: "a-different-owner" },
      },
      seams,
    );
    expect(calls[0]?.hostAuthoritative).toBe(false);
  });

  it("stays out of session.start and session.compact", () => {
    const { root } = leasedRoot(GROK_OWNER);
    const { seams, calls } = recordingSeams();
    for (const event of ["session.start", "session.compact"] as const) {
      decideHook(
        {
          host: "grok",
          event,
          projectRoot: root,
          payload: {},
          environ: { GROK_SESSION_ID: RAW_GROK_ID },
        },
        { ...seams, markCompactStale: () => ({ changed: false, statePath: "/s", message: "ok" }) },
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("stays out of the way when the kill-switch is active", () => {
    const { root } = leasedRoot(GROK_OWNER);
    const { seams, calls } = recordingSeams();
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "git status --short" },
        },
        environ: { GROK_SESSION_ID: RAW_GROK_ID },
      },
      {
        ...seams,
        detectDeftDirectiveDisable: () => ({
          active: true,
          present: true,
          path: join(root, ".deft-directive-disable"),
        }),
      },
    );
    expect(decision.code).toBe("directive-disabled");
    expect(calls).toHaveLength(0);
  });

  it("cannot change a verdict by failing", () => {
    const { root } = leasedRoot(GROK_OWNER);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "run_terminal_command",
          tool_input: { command: "git status --short" },
        },
        environ: { GROK_SESSION_ID: RAW_GROK_ID },
      },
      {
        ...readySeams(),
        restampOwnerLiveness: () => {
          throw new Error("lease file exploded");
        },
      },
    );
    expect(decision.verdict).toBe("allow");
  });
});
