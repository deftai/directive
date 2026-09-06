import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import { readSpawnReservationIncarnation } from "../session/spawn-occupancy.js";
import { decideHook, type HookPolicySeams } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const READY_RITUAL = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation" as const,
  ritualStateRequired: true,
};

const STALE_RITUAL = {
  ...READY_RITUAL,
  code: 1,
  message: "HEAD discontinuous / ritual stale",
};

const READY_SCOPE = {
  ready: true,
  path: "/project/xbrief/active/story.xbrief.json",
  message: "OK active scope",
};

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
  });
}

function addLinkedWorktree(root: string, dest: string): void {
  execFileSync("git", ["worktree", "add", "--detach", dest, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
}

function destFixture(): { root: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "spawn-dest-"));
  temps.push(root);
  gitInit(root);
  const dest = join(root, "wt");
  addLinkedWorktree(root, dest);
  return { root, dest };
}

function readySeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    ...(overrides.inspectRitual ? {} : { verifyRitual: () => READY_RITUAL }),
    inspectScope: () => READY_SCOPE,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => path,
    ...overrides,
  };
}

describe("dest-proven implement spawn (#4215)", () => {
  it("skips parent ritual when Grok cwd is dest-proven and parent identity is set", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const inspectScope = vi.fn(() => READY_SCOPE);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(inspectScope).toHaveBeenCalled();
    expect(readSpawnReservationIncarnation(root, dest)).not.toBeNull();
  });

  it("keeps parent ritual when dest-proven but parent identity is none", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: {},
      },
      readySeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(inspectRitual).toHaveBeenCalled();
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });

  it("does not skip ritual for pathless isolation=worktree on reroot hosts", () => {
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const inspectScope = vi.fn(() => READY_SCOPE);
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", isolation: "worktree" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(inspectRitual).toHaveBeenCalled();
    expect(inspectScope).not.toHaveBeenCalled();
  });

  it("does not mint or persist when parent-root scope denies after dest-proven consult", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({
        inspectRitual,
        inspectScope: () => ({
          ready: false,
          path: null,
          message: "No active/running xBRIEF is available.",
        }),
      }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });

  it("does not mint or persist when intent ceiling denies after dest-proven consult", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: {
          DEFT_SESSION_ID: "parent-1",
          DEFT_SESSION_SLASH_VERB: "github-issue",
        },
      },
      readySeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "intent-ceiling-deny" });
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });

  it("denies dest-proven spawn when dest is live occupied", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    applyWorktreeOccupancy(dest, { sessionId: "foreign", env: {} });
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toMatch(/occupied/i);
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });

  it("keeps persist/reservation-conflict as the final launch refusal after two dest-proven consults", () => {
    const { root, dest } = destFixture();
    const payload = {
      toolName: "spawn_subagent",
      tool_input: { cwd: dest, prompt: "implement the story" },
    };
    const first = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload,
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams(),
    );
    const second = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload,
        environ: { DEFT_SESSION_ID: "parent-2" },
      },
      readySeams(),
    );
    expect(first).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(second).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(second.message).toContain("already reserved");
  });

  it("occupancy-denies Grok cwd plus worktree_path without skipping ritual or dest-lock", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, worktree_path: dest, prompt: "implement" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("cwd");
    expect(decision.message).toContain("invalid on Grok");
    expect(decision.message).not.toMatch(/pass isolation=worktree/i);
    expect(inspectRitual).toHaveBeenCalled();
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });

  it("keeps capability-mode implement spawn denied", () => {
    const { root, dest } = destFixture();
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          capability_mode: "read-only",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "read-only-deny" });
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });
});
