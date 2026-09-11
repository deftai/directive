import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWorktreeOccupancy } from "../session/occupancy.js";
import {
  GROK_CRITIC_SPAWN_NOT_READY_RECOVERY,
  readSpawnReservationIncarnation,
  rerootDestKeyList,
  rerootMissingDestImperative,
} from "../session/spawn-occupancy.js";
import {
  CURSOR_TASK_SPAWN_CLASS_RECOVERY,
  CURSOR_TASK_SPAWN_READ_ONLY_RECOVERY,
  decideHook,
  type HookPolicySeams,
  inspectActiveScope,
  spawnToolArgUpdatedInput,
} from "./index.js";
import { isExploreSpawn, SPAWN_CLASS_RECOVERY } from "./readonly.js";

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

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
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
  it("allows process_only skip class on a linked dest, not dest-path (#4296)", () => {
    const { root, dest } = destFixture();
    const prepareArcDest = vi.fn(() => ({
      dest: {
        destPath: dest,
        dispatchSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        originRef: "origin/main",
        pinKind: "origin-default" as const,
        reused: true,
      },
      record:
        "arc-mode: no-ingest\ndest: " +
        dest +
        "\ndispatch-sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: {
            subagent_type: "general-purpose",
            process_only: true,
            cwd: dest,
            prompt: "git show the dispatch sha",
          },
        },
      },
      readySeams({ prepareArcDest }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-process-only-ready" });
    expect(prepareArcDest).toHaveBeenCalledWith({
      repoRoot: root,
      destPath: dest,
      againstImplementationSha: undefined,
    });
    expect(decision.message).toContain("arc-mode: no-ingest");
    expect(decision.message).toContain("dispatch-sha:");
  });

  it("keeps #2885 on destProven implement-class without process_only (#4296)", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message: "No active xBRIEF artifact was found under xbrief/active/",
    }));
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: {
            subagent_type: "general-purpose",
            cwd: dest,
            prompt: "implement the story",
          },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toMatch(/process_only/);
    expect(decision.message).toMatch(/Dest-path is not that class/);
    expect(decision.message.startsWith(GROK_CRITIC_SPAWN_NOT_READY_RECOVERY)).toBe(true);
    const criticIdx = decision.message.indexOf("grok --cwd --prompt-file");
    const activateIdx = decision.message.indexOf("scope:activate");
    expect(criticIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(criticIdx);
    expect(decision.message).not.toContain("DEFT_ACTIVE_SCOPE_PIN");
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(inspectScope).toHaveBeenCalled();
  });

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

  it("leftover-releases then allows a later same-parent Grok tool.before with no live occupant (#4254)", () => {
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
    const firstIncarnation = readSpawnReservationIncarnation(root, dest);
    const second = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload,
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams(),
    );
    expect(first).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(second).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(second.message).not.toContain("already reserved");
    const secondIncarnation = readSpawnReservationIncarnation(root, dest);
    expect(firstIncarnation).not.toBeNull();
    expect(secondIncarnation).not.toBeNull();
    expect(secondIncarnation).not.toBe(firstIncarnation);
  });

  it("names isolation=worktree plus cwd as invalid-extra-destination, not dest-missing (#4391)", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, isolation: "worktree", prompt: "critic" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("invalid-extra-destination");
    expect(decision.message).toContain("not dest-missing");
    expect(decision.message.startsWith(GROK_CRITIC_SPAWN_NOT_READY_RECOVERY)).toBe(true);
    expect(decision.message).not.toMatch(/no worktree destination on the spawn payload/);
    expect(inspectRitual).toHaveBeenCalled();
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });

  it("does not lead Grok multiple-eligible spawn-not-ready with scope:activate (#4391)", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const inspectScope = vi.fn(() => ({
      ready: false,
      path: null,
      message:
        "Multiple active xBRIEF artifacts are eligible (a-story.xbrief.json, b-story.xbrief.json). " +
        "Set DEFT_ACTIVE_SCOPE to the dispatched story path, or keep one running brief in xbrief/active/.",
    }));
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "critic" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message.startsWith(GROK_CRITIC_SPAWN_NOT_READY_RECOVERY)).toBe(true);
    const criticIdx = decision.message.indexOf("grok --cwd --prompt-file");
    const activateIdx = decision.message.indexOf("scope:activate");
    const pinIdx = decision.message.indexOf("DEFT_ACTIVE_SCOPE");
    expect(criticIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(criticIdx);
    expect(pinIdx).toBeGreaterThan(criticIdx);
    expect(decision.message).not.toContain("DEFT_ACTIVE_SCOPE_PIN");
    expect(inspectRitual).not.toHaveBeenCalled();
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

describe("Grok-applied spawn_subagent handler-runtime identity (#4272)", () => {
  it("applies Grok dest and emits no envelope rewrite when --host is cursor", () => {
    const { root, dest } = destFixture();
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1", GROK_SESSION_ID: "grok-session-a" },
      },
      readySeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(decision.updatedInput).toBeUndefined();
    expect(decision.message).toContain("cannot re-root");
    expect(inspectRitual).not.toHaveBeenCalled();
  });

  it("applies Grok dest and emits no envelope rewrite when --host is claude and GROK_HOOK_EVENT is set", () => {
    const { root, dest } = destFixture();
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: root,
        payload: {
          tool_name: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1", GROK_HOOK_EVENT: "PreToolUse" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(decision.updatedInput).toBeUndefined();
  });

  it("applies Grok dest from the spawn_subagent tool even without Grok env", () => {
    const { root, dest } = destFixture();
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(decision.updatedInput).toBeUndefined();
  });

  it("denies missing dest with Grok cwd text, not Cursor reroot text", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: { toolName: "spawn_subagent", tool_input: { prompt: "implement the story" } },
        environ: { DEFT_SESSION_ID: "parent-1", GROK_SESSION_ID: "grok-session-a" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("tool_input.cwd");
    expect(decision.message).not.toMatch(/isolation=worktree/);
    expect(decision.message).not.toContain("worktree_path");
  });

  it("does not persist dest-lock from a vendor-compat handler on Grok-applied spawn", () => {
    const { root, dest } = destFixture();
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement the story" },
        },
        environ: { DEFT_SESSION_ID: "parent-1", GROK_SESSION_ID: "grok-session-a" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });

  it("leftover-releases a prior dest-lock then allows the applying Grok host", () => {
    const { root, dest } = destFixture();
    const payload = {
      toolName: "spawn_subagent",
      tool_input: { cwd: dest, prompt: "implement the story" },
    };
    const vendor = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload,
        environ: { DEFT_SESSION_ID: "parent-1", GROK_SESSION_ID: "grok-session-a" },
      },
      readySeams(),
    );
    const applying = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload,
        environ: { DEFT_SESSION_ID: "parent-1", GROK_SESSION_ID: "grok-session-a" },
      },
      readySeams(),
    );
    expect(vendor).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(applying).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(applying.updatedInput).toBeUndefined();
    expect(readSpawnReservationIncarnation(root, dest)).not.toBeNull();
  });

  it("does not leftover-release an applying-host dest-lock from a later vendor-compat handler", () => {
    const { root, dest } = destFixture();
    const payload = {
      toolName: "spawn_subagent",
      tool_input: { cwd: dest, prompt: "implement the story" },
    };
    const applying = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload,
        environ: { DEFT_SESSION_ID: "parent-1", GROK_SESSION_ID: "grok-session-a" },
      },
      readySeams(),
    );
    const firstIncarnation = readSpawnReservationIncarnation(root, dest);
    const vendor = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload,
        environ: { DEFT_SESSION_ID: "parent-1", GROK_SESSION_ID: "grok-session-a" },
      },
      readySeams(),
    );
    expect(applying).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(vendor).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(readSpawnReservationIncarnation(root, dest)).toBe(firstIncarnation);
  });

  it("keeps Cursor Task dest occupancy and envelope rewrite", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", isolation: "worktree" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    const rewritten = decision.updatedInput as {
      tool_input?: { isolation?: string; incarnation?: string };
    };
    expect(rewritten?.tool_input?.isolation).toBe("worktree");
    expect(typeof rewritten?.tool_input?.incarnation).toBe("string");
  });

  it("backstop rewrite is the tool-arg object with prompt and dest cwd, not an envelope", () => {
    const rewritten = spawnToolArgUpdatedInput(
      {
        tool_name: "spawn_subagent",
        tool_input: { cwd: "/wt", prompt: "implement the story" },
      },
      "/wt",
      "inc-1",
    );
    expect(rewritten).toMatchObject({
      prompt: "implement the story",
      cwd: "/wt",
      incarnation: "inc-1",
    });
    expect(rewritten).not.toHaveProperty("tool_input");
    expect(rewritten).not.toHaveProperty("tool_name");
  });

  it("backstop rewrite is undefined when prompt is missing", () => {
    expect(
      spawnToolArgUpdatedInput(
        { tool_name: "spawn_subagent", tool_input: { cwd: "/wt" } },
        "/wt",
        "inc-1",
      ),
    ).toBeUndefined();
    expect(spawnToolArgUpdatedInput(null, "/wt", "inc-1")).toBeUndefined();
  });
});

describe("Cursor Task dest-missing deny honesty (#4279 / #4362)", () => {
  it("keeps unmarked generalPurpose fail-closed and names dest-placing, not the reroot imperative", () => {
    const inspectRitual = vi.fn(() => ({
      ...STALE_RITUAL,
      message: "ritual state is stale (older than 4h). Rearm does not clear dest-missing.",
    }));
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", prompt: "implement" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain(CURSOR_TASK_SPAWN_CLASS_RECOVERY);
    expect(decision.message).not.toContain(rerootMissingDestImperative());
    expect(decision.message).not.toContain(
      "Pass a destination field inspectSpawnDestination reads",
    );
    expect(decision.message).not.toMatch(/before the spawn primitive/);
    expect(countOccurrences(decision.message, rerootDestKeyList())).toBe(1);
    expect(decision.message).toMatch(/payload-root/);
    expect(decision.message).toMatch(/Composer already on the reserved linked worktree/);
    expect(decision.message).toMatch(/consult mints the reservation/);
    expect(decision.message).toMatch(/do not pre-mint then Task/);
    expect(decision.message).toMatch(/Agent\.create\(\{ local: \{ cwd \} \}\)/);
    expect(decision.message).toMatch(/cursor-sdk-auth/);
    expect(decision.message).toMatch(/CURSOR_API_KEY/);
    expect(decision.message).toMatch(/fences parent product writes/);
    expect(decision.message).toMatch(/exclusive of a live nursery occupancy grant/);
    const parentIdx = decision.message.indexOf("Continue in the parent");
    const exploreIdx = decision.message.search(/subagent_type explore/i);
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(exploreIdx).toBeGreaterThan(parentIdx);
    expect(decision.message).toContain("ritual telemetry (does not clear dest-missing)");
    expect(decision.message).toContain("ritual state is stale");
    expect(decision.message).not.toMatch(/Also ritual-not-ready:/);
    expect(inspectRitual).toHaveBeenCalled();
  });

  it("keeps the reroot imperative for Claude and Codex dest-missing Task", () => {
    for (const host of ["claude", "codex"] as const) {
      const decision = decideHook(
        {
          host,
          event: "tool.before",
          projectRoot: "/project",
          payload: {
            tool_name: "Task",
            tool_input: { subagent_type: "generalPurpose", prompt: "implement" },
          },
          environ: { DEFT_SESSION_ID: "parent-1" },
        },
        readySeams(),
      );
      expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
      expect(decision.message).toContain(rerootMissingDestImperative());
      expect(countOccurrences(decision.message, rerootDestKeyList())).toBe(2);
      expect(decision.message).toContain(SPAWN_CLASS_RECOVERY);
      expect(decision.message).not.toContain(CURSOR_TASK_SPAWN_CLASS_RECOVERY);
    }
  });

  it("does not explore-allow when implement conflict signals are present", () => {
    expect(
      isExploreSpawn({
        tool_name: "Task",
        tool_input: { subagent_type: "explore", drive_to: "merge-ready" },
      }),
    ).toBe(false);
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "explore", drive_to: "merge-ready" },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      readySeams(),
    );
    expect(decision.code).not.toBe("spawn-explore-ready");
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
  });

  it("shares the recovery inventory on the read-only spawn deny, explore first", () => {
    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Task",
          tool_input: { subagent_type: "generalPurpose", isolation: "worktree" },
        },
        environ: { DEFT_HOOK_READ_ONLY: "1" },
      },
      readySeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "read-only-deny" });
    expect(decision.message).toContain(CURSOR_TASK_SPAWN_READ_ONLY_RECOVERY);
    expect(decision.message).toMatch(/subagent_type explore/);
    expect(decision.message).toMatch(/Do not retry subagent_type plan on Cursor Task/);
    expect(decision.message).not.toMatch(/or subagent_type plan/);
    const parentIdx = decision.message.indexOf("Continue in the parent");
    const exploreIdx = decision.message.search(/subagent_type explore/i);
    expect(exploreIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeGreaterThan(exploreIdx);
  });
});

const runningPlacement = {
  status: "running",
  metadata: {
    intended_placement: {
      schema: "deft.scope.intended_placement.v1",
      files: ["src/new-module.ts"],
      module_boundary: "new focused module",
    },
  },
};

function writeRunning(root: string, name: string, fileScope: readonly string[]): string {
  const active = join(root, "xbrief", "active");
  mkdirSync(active, { recursive: true });
  const path = join(active, name);
  writeFileSync(
    path,
    JSON.stringify({
      plan: {
        ...runningPlacement,
        metadata: {
          ...runningPlacement.metadata,
          swarm: { file_scope: [...fileScope] },
        },
      },
    }),
    "utf8",
  );
  return path;
}

function liveScopeSeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    verifyRitual: () => READY_RITUAL,
    sessionStart: () => ({ code: 0, stdout: "", stderr: "" }),
    runningInsideDeftRepo: () => true,
    realpathLifecycleExecutionRoot: (path) => path,
    ...overrides,
  };
}

describe("dest-proven spawn dest unique-basename pin (#4393)", () => {
  function twoActiveDest(): { root: string; dest: string; storyB: string } {
    const { root, dest } = destFixture();
    writeRunning(root, "a-story.xbrief.json", ["packages/a/**"]);
    const storyB = writeRunning(root, "b-story.xbrief.json", ["packages/b/**"]);
    return { root, dest, storyB };
  }

  it("allows dest-proven spawn when dest unique basename names one of two primary actives", () => {
    const { root, dest, storyB } = twoActiveDest();
    writeRunning(dest, "b-story.xbrief.json", ["packages/b/**"]);
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const inspectScope = vi.fn(
      (projectRoot: string, options?: Parameters<typeof inspectActiveScope>[1]) => {
        expect(resolve(projectRoot)).toBe(resolve(root));
        expect(resolve(projectRoot)).not.toBe(resolve(dest));
        return inspectActiveScope(projectRoot, options);
      },
    );
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
      liveScopeSeams({ inspectRitual, inspectScope }),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(decision.scopePath).toBe(storyB);
    expect(inspectRitual).not.toHaveBeenCalled();
    expect(inspectScope).toHaveBeenCalled();
  });

  it("keeps DEFT_ACTIVE_SCOPE as CLI fallback when dest has no unique basename", () => {
    const { root, dest, storyB } = twoActiveDest();
    const byEnv = decideHook(
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
          DEFT_ACTIVE_SCOPE: "xbrief/active/b-story.xbrief.json",
        },
      },
      liveScopeSeams(),
    );
    expect(byEnv).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(byEnv.scopePath).toBe(storyB);
  });

  it("does not auto-pin when dest holds two active briefs", () => {
    const { root, dest } = twoActiveDest();
    writeRunning(dest, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(dest, "b-story.xbrief.json", ["packages/b/**"]);
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
      liveScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("Multiple active xBRIEF artifacts");
  });

  it("denies unpinned dest-proven spawn with two primary actives", () => {
    const { root, dest } = twoActiveDest();
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
      liveScopeSeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("Multiple active xBRIEF artifacts");
    expect(inspectRitual).not.toHaveBeenCalled();
  });

  it("does not treat prompt, description, or payload boundPath keys as the pin", () => {
    const { root, dest } = twoActiveDest();
    const promptPin = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: {
            cwd: dest,
            prompt: "implement xbrief/active/b-story.xbrief.json",
            description: "b-story.xbrief.json",
          },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      liveScopeSeams(),
    );
    expect(promptPin).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(promptPin.message).toContain("Multiple active xBRIEF artifacts");

    const payloadKeys = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: {
            cwd: dest,
            prompt: "implement",
            boundPath: "xbrief/active/b-story.xbrief.json",
            active_scope: "b-story.xbrief.json",
          },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      liveScopeSeams(),
    );
    expect(payloadKeys).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(payloadKeys.message).toContain("Multiple active xBRIEF artifacts");
  });

  it("lets dest unique basename win over process-wide DEFT_ACTIVE_SCOPE", () => {
    const { root, dest, storyB } = twoActiveDest();
    writeRunning(dest, "b-story.xbrief.json", ["packages/b/**"]);
    const storyA = join(root, "xbrief", "active", "a-story.xbrief.json");
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: { cwd: dest, prompt: "implement" },
        },
        environ: {
          DEFT_SESSION_ID: "parent-1",
          DEFT_ACTIVE_SCOPE: "xbrief/active/a-story.xbrief.json",
        },
      },
      liveScopeSeams(),
    );
    expect(decision).toMatchObject({ verdict: "allow", code: "spawn-ready" });
    expect(decision.scopePath).toBe(storyB);
    expect(decision.scopePath).not.toBe(storyA);
  });

  it("still occupancy-denies extra dest keys when a dest unique-basename pin is present", () => {
    const { root, dest } = twoActiveDest();
    writeRunning(dest, "b-story.xbrief.json", ["packages/b/**"]);
    const inspectRitual = vi.fn(() => STALE_RITUAL);
    const decision = decideHook(
      {
        host: "grok",
        event: "tool.before",
        projectRoot: root,
        payload: {
          toolName: "spawn_subagent",
          tool_input: {
            cwd: dest,
            worktree_path: dest,
            prompt: "implement",
          },
        },
        environ: { DEFT_SESSION_ID: "parent-1" },
      },
      liveScopeSeams({ inspectRitual }),
    );
    expect(decision).toMatchObject({ verdict: "deny", code: "spawn-not-ready" });
    expect(decision.message).toContain("invalid on Grok");
    expect(inspectRitual).toHaveBeenCalled();
    expect(readSpawnReservationIncarnation(root, dest)).toBeNull();
  });
});
