import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectExactLifecycleCommand } from "../hooks/classify/host-session-identity.js";
import { decideHook, type HookPolicySeams, renderHostDecision } from "../hooks/dispatcher.js";
import { DEFAULT_EVENT_LOG, readEvents } from "../lifecycle/events.js";
import { SESSION_START_TRIGGERS } from "../run-summary/types.js";
import { defaultGitRunner, type GitRunner, worktreePath } from "./git.js";
import {
  appendSoftAgentsRebindToMessage,
  applyWorktreeOccupancy,
  depositOpenClawSoftRebindSkill,
  formatOpenClawSoftRebindSkillMarkdown,
  formatSoftAgentsRebindChecklist,
  inspectSessionRitual,
  isManagedOpenClawSoftRebindSkill,
  isSoftAgentsRebindText,
  markRitualStaleAfterCompact,
  newRitualStatePayload,
  OPENCLAW_SOFT_REBIND_SKILL_ID,
  readOccupancy,
  readRitualState,
  ritualStep,
  SOFT_AGENTS_REBIND_CHECKLIST,
  SOFT_AGENTS_REBIND_MARKER,
  SOFT_REBIND_HOST_MATRIX,
  softAgentsRebindForbiddenHits,
  writeRitualState,
} from "./index.js";
import { evaluateOccupancyCeremonyEligibility, grantOccupancyMembership } from "./occupancy.js";
import {
  applyOccupancyEligibilityToDenial,
  fillRecoveryCommandSessionId,
} from "./occupancy-recovery.js";
import { COMPACT_PRIOR_STARTED_AT_KEY, RITUAL_STALE_EPOCH } from "./ritual-sentinel.js";
import { READ_ONLY_ALIGNMENT_MESSAGE } from "./session-start.js";
import { timestampIso } from "./time.js";
import {
  type CompactHealInput,
  type CompactHealOutcome,
  healCompactMarkForOwnerWrite,
  WRITE_GATED_REQUIRED_STEPS,
} from "./verify-session-ritual.js";

const EMPTY_STDERR = "";

function fakeGit(head: string, worktree: string) {
  return (_r: string, args: readonly string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: EMPTY_STDERR };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: EMPTY_STDERR };
    }
    return { code: 0, stdout: "", stderr: EMPTY_STDERR };
  };
}

function runGit(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  if (result.status !== 0) {
    throw new Error((result.stderr ?? result.stdout ?? "git failed").trim());
  }
  return (result.stdout ?? "").trim();
}

function freshRitualRoot(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "compact-ritual-"));
  const started = new Date("2026-07-20T12:00:00Z");
  mkdirSync(join(root, ".deft"), { recursive: true });
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { policy: { sessionRitualStalenessHours: 4 } },
    }),
    "utf8",
  );
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "t@t.local"]);
  runGit(root, ["config", "user.name", "T"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  const head = runGit(root, ["rev-parse", "HEAD"]);
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId: "session-1",
      gitHead: head,
      worktreePath: resolve(root),
      startedAt: started,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: started }),
        branch_policy: ritualStep({ ok: true, ts: started }),
        triage_welcome: ritualStep({ ok: true, ts: started }),
        verify_tools: ritualStep({ ok: true, ts: started }),
      },
      gatedSteps: {
        agent_hooks: ritualStep({ ok: true, ts: started }),
        doctor: ritualStep({ ok: true, ts: started }),
        cache_fresh: ritualStep({ ok: true, ts: started }),
      },
    }),
  );
  return { root, head };
}

describe("markRitualStaleAfterCompact (#2113)", () => {
  it("marks an existing ritual stale and leaves read-only inspection unchanged", () => {
    const { root, head } = freshRitualRoot();
    const now = new Date("2026-07-20T13:00:00Z");
    const fresh = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(fresh.code).toBe(0);

    const result = markRitualStaleAfterCompact(root, { now });
    expect(result.changed).toBe(true);
    expect(result.message).toContain("session:start --rearm");
    expect(result.message).toContain("re-arm");

    const stale = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(stale.code).toBe(1);
    expect(stale.message).toContain("stale");
    expect(stale.recoveryTier).toBe("rearm");
    expect(stale.message).toContain("session:start --rearm");

    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op when ritual state is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "compact-ritual-empty-"));
    const result = markRitualStaleAfterCompact(root);
    expect(result.changed).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("session.compact hook dispatch (#2113)", () => {
  it("invalidates ritual then denies subsequent direct writes until refresh", () => {
    const { root, head } = freshRitualRoot();
    const runGit = fakeGit(head, resolve(root));

    const compact = decideHook({
      host: "cursor",
      event: "session.compact",
      projectRoot: root,
      payload: {},
    });
    expect(compact).toMatchObject({ verdict: "allow", code: "session-compact-rearm" });
    // Soft re-bind does not weaken hard deny (#3171).
    expect(isSoftAgentsRebindText(compact.message)).toBe(true);

    const denied = decideHook({
      host: "cursor",
      event: "tool.before",
      projectRoot: root,
      payload: { tool_name: "Write", workspace_roots: [root] },
    });
    expect(denied).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });

    const refreshedStarted = new Date("2026-07-20T13:05:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "session-2",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: refreshedStarted,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: refreshedStarted }),
          branch_policy: ritualStep({ ok: true, ts: refreshedStarted }),
          triage_welcome: ritualStep({ ok: true, ts: refreshedStarted }),
          verify_tools: ritualStep({ ok: true, ts: refreshedStarted }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: refreshedStarted }),
          doctor: ritualStep({ ok: true, ts: refreshedStarted }),
          cache_fresh: ritualStep({ ok: true, ts: refreshedStarted }),
        },
      }),
    );

    const ready = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now: refreshedStarted,
      runGit,
    });
    expect(ready.code).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("compact stale-mark is fail-open on an unbindable actor (#3769)", () => {
  it("marks the occupant's ritual stale when no acting identity can be bound", () => {
    const { root } = freshRitualRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner", intent: "mutation" });
    // Neither a host payload identity nor DEFT_SESSION_ID: the compact actor
    // cannot be bound. Operator amend 2026-08-28 takes the write anyway.
    const verifyRitual = vi.fn();

    const compact = decideHook(
      {
        host: "cursor",
        event: "session.compact",
        projectRoot: root,
        payload: {},
        environ: {},
      },
      { verifyRitual },
    );

    expect(compact).toMatchObject({ verdict: "allow", code: "session-compact-rearm" });
    // Compact must not route through inspectMutationGates, so the mutation
    // verifier is never consulted and occupancy never denies an owner compact.
    expect(verifyRitual).not.toHaveBeenCalled();

    const [state] = readRitualState(root);
    expect(state?.raw.rearm_needed).toBe(true);
    // The accepted cost: a stranger's compact re-arms the owner. It must not
    // also retitle the record or disturb the lease.
    expect(state?.sessionId).toBe("session-1");
    expect(readOccupancy(root)?.sessionId).toBe("owner");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("soft AGENTS re-bind SoT (#3171 / #2769)", () => {
  it("exposes a single shared checklist with pass-3 obligations", () => {
    const ids = SOFT_AGENTS_REBIND_CHECKLIST.map((item) => item.id);
    expect(ids).toEqual([
      "reread-agents",
      "confirm-learned",
      "deposit-integrity",
      "summary-not-sot",
      "operational-ask-trap",
      "mutation-vs-readonly",
    ]);
    const text = formatSoftAgentsRebindChecklist();
    expect(text).toContain(SOFT_AGENTS_REBIND_MARKER);
    expect(text).toMatch(/AGENTS\.md/i);
    expect(text).toMatch(/Operational-ask trap/i);
    expect(text).toMatch(/Summary/i);
    expect(text).toMatch(/session:ready|session:start --rearm/i);
    expect(softAgentsRebindForbiddenHits(text)).toEqual([]);
  });

  it("documents the five-host matrix including OpenClaw required + Codex gap", () => {
    expect(SOFT_REBIND_HOST_MATRIX.map((row) => row.host)).toEqual([
      "cursor",
      "claude",
      "grok",
      "codex",
      "openclaw",
    ]);
    const codex = SOFT_REBIND_HOST_MATRIX.find((row) => row.host === "codex");
    expect(codex?.hardCompact).toBe("unsupported");
    expect(codex?.softRebind).toBe("docs-best-effort");
    const openclaw = SOFT_REBIND_HOST_MATRIX.find((row) => row.host === "openclaw");
    expect(openclaw?.softRebind).toBe("required");
    expect(openclaw?.hardCompact).toBe("unsupported");
  });

  it("appends soft checklist without dropping hard re-arm recovery text", () => {
    const hard = "Marked session ritual re-arm needed; run session:start --rearm.";
    const combined = appendSoftAgentsRebindToMessage(hard);
    expect(combined.startsWith(hard)).toBe(true);
    expect(isSoftAgentsRebindText(combined)).toBe(true);
    // Idempotent when already present.
    expect(appendSoftAgentsRebindToMessage(combined)).toBe(combined);
  });

  it("surfaces soft checklist on Cursor/Claude/Grok compact without a write tool", () => {
    for (const host of ["cursor", "claude", "grok"] as const) {
      const decision = decideHook({
        host,
        event: "session.compact",
        projectRoot: "/tmp/soft-rebind-no-root",
        payload: {},
      });
      expect(decision.verdict).toBe("allow");
      expect(isSoftAgentsRebindText(decision.message)).toBe(true);
      expect(decision.message).toMatch(/Operational-ask trap/i);
      const wire = renderHostDecision(host, decision);
      expect(wire.length).toBeGreaterThan(0);
      expect(wire).toContain("Soft AGENTS re-bind checklist");
    }
  });

  it("never instructs skipping mutation ritual for writes", () => {
    const checklist = formatSoftAgentsRebindChecklist();
    const skill = formatOpenClawSoftRebindSkillMarkdown();
    for (const text of [checklist, skill]) {
      expect(softAgentsRebindForbiddenHits(text)).toEqual([]);
      expect(text.toLowerCase()).toMatch(/never authorizes skipping/);
    }
  });

  it("keeps the shared checklist and OpenClaw skill free of the Cursor planning line (#1708)", () => {
    expect(formatSoftAgentsRebindChecklist()).not.toContain("/deft:directive:run:interview");
    expect(formatOpenClawSoftRebindSkillMarkdown()).not.toContain("/deft:directive:run:interview");
    expect(SOFT_AGENTS_REBIND_CHECKLIST.map((item) => item.id)).not.toContain(
      "cursor-session-start-planning",
    );
  });
});

describe("OpenClaw soft re-bind skill deposit (#3171)", () => {
  it("generates a managed skill body from the shared checklist SoT", () => {
    const body = formatOpenClawSoftRebindSkillMarkdown();
    expect(isManagedOpenClawSoftRebindSkill(body)).toBe(true);
    expect(body).toContain(OPENCLAW_SOFT_REBIND_SKILL_ID);
    expect(isSoftAgentsRebindText(body)).toBe(true);
    expect(body).toMatch(/Family-2/i);
    expect(body).toMatch(/not.*file-host|does \*\*not\*\* claim file-host/i);
  });

  it("deposits the skill when OpenClaw is forced and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-soft-rebind-"));
    const skillsDir = join(root, "workspace", "skills");
    mkdirSync(skillsDir, { recursive: true });

    const first = depositOpenClawSoftRebindSkill({
      forceDeposit: true,
      skillsDirs: [skillsDir],
    });
    expect(first.skipped).toBe(false);
    expect(first.changed).toBe(true);
    expect(first.writtenPaths.length).toBe(1);

    const skillPath = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID, "SKILL.md");
    const body = readFileSync(skillPath, "utf8");
    expect(isManagedOpenClawSoftRebindSkill(body)).toBe(true);
    expect(isSoftAgentsRebindText(body)).toBe(true);

    const second = depositOpenClawSoftRebindSkill({
      forceDeposit: true,
      skillsDirs: [skillsDir],
    });
    expect(second.changed).toBe(false);
    expect(second.present).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("skips deposit when OpenClaw is not detected", () => {
    const result = depositOpenClawSoftRebindSkill({
      env: {},
      homeDir: join(tmpdir(), "no-openclaw-home-soft-rebind"),
      forceDeposit: false,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("openclaw-not-detected");
  });
});

// --- #6279 compaction heal and runnable recovery commands -------------------

const HEAL_OWNER = "owner";
const HOUR_MS = 60 * 60 * 1000;
const HEAL_EVENT_CODE = "hook-compact-heal";
const healTemps: string[] = [];

function healRitualPayload(root: string, head: string, startedAt: Date, quickOk: boolean) {
  return newRitualStatePayload({
    sessionId: HEAL_OWNER,
    gitHead: head,
    worktreePath: worktreePath(root),
    startedAt,
    quickSteps: {
      alignment: ritualStep({ ok: true, ts: startedAt }),
      branch_policy: ritualStep({ ok: true, ts: startedAt }),
      triage_welcome: ritualStep({ ok: true, ts: startedAt }),
      verify_tools: ritualStep({ ok: quickOk, ts: startedAt }),
    },
    gatedSteps: {
      agent_hooks: ritualStep({ ok: true, ts: startedAt }),
      doctor: ritualStep({ ok: true, ts: startedAt }),
      cache_fresh: ritualStep({ ok: true, ts: startedAt }),
    },
  });
}

function healRoot(
  options: { startedAgoMs?: number; quickOk?: boolean; leaseOwner?: string } = {},
): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "compact-heal-"));
  healTemps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  writeFileSync(join(root, "src", "app.ts"), "export {}\n", "utf8");
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { policy: { sessionRitualStalenessHours: 4 } },
    }),
    "utf8",
  );
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "t@t.local"]);
  runGit(root, ["config", "user.name", "T"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  mkdirSync(join(root, ".deft"), { recursive: true });
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const startedAt = new Date(Date.now() - (options.startedAgoMs ?? HOUR_MS));
  writeRitualState(root, healRitualPayload(root, head, startedAt, options.quickOk ?? true));
  applyWorktreeOccupancy(root, {
    sessionId: options.leaseOwner ?? HEAL_OWNER,
    intent: "mutation",
    env: {},
  });
  return { root, head };
}

function healSeams(): HookPolicySeams {
  return {
    verifyRitual: (root: string) =>
      inspectSessionRitual(root, {
        tier: "gated",
        posture: "mutation",
        requiredGatedSteps: WRITE_GATED_REQUIRED_STEPS,
      }),
    inspectScope: () => ({
      ready: true,
      path: "xbrief/active/story.xbrief.json",
      message: "OK active scope",
    }),
    runningInsideDeftRepo: () => true,
    loadStoryWriteFence: () => ({ fileScope: ["**"], denyPaths: [] }),
  };
}

function healWrite(root: string, sessionId = HEAL_OWNER) {
  return decideHook(
    {
      host: "grok",
      event: "tool.before",
      projectRoot: root,
      payload: { toolName: "Write", file_path: join(root, "src", "app.ts") },
      environ: { DEFT_SESSION_ID: sessionId },
    },
    healSeams(),
  );
}

function healInput(overrides: Partial<CompactHealInput> = {}): CompactHealInput {
  return {
    callerSessionId: HEAL_OWNER,
    callerIdentityIssue: false,
    admitted: "owner",
    boundSessionId: HEAL_OWNER,
    stillLiveOwner: () => null,
    resolveUserMd: () => ({
      path: "/home/u/.config/deft/USER.md",
      rung: "workspace-local",
      found: true,
      diagnostic: "USER.md resolved from workspace-local config",
      searched: [],
    }),
    ...overrides,
  };
}

function rawState(root: string): Record<string, unknown> {
  const [state, err] = readRitualState(root);
  if (state === null) throw new Error(err ?? "ritual state missing");
  return state.raw;
}

function healEventCount(root: string): number {
  return readEvents(join(root, DEFAULT_EVENT_LOG)).filter(
    (record) => (record.payload as Record<string, unknown>).code === HEAL_EVENT_CODE,
  ).length;
}

describe("compaction heal on the owner's next write (#6279)", () => {
  beforeEach(() => {
    vi.stubEnv("DEFT_EVENT_LOG", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of healTemps.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records the overwritten clock once across two compactions", () => {
    const { root } = healRoot();
    const original = rawState(root).started_at;
    markRitualStaleAfterCompact(root);
    markRitualStaleAfterCompact(root);
    const raw = rawState(root);
    expect(raw[COMPACT_PRIOR_STARTED_AT_KEY]).toBe(original);
    expect(raw.started_at).toBe(timestampIso(RITUAL_STALE_EPOCH));
  });

  it("denies once with the alignment lines, restores the clock, then admits the retry", () => {
    const { root } = healRoot();
    const before = rawState(root);
    markRitualStaleAfterCompact(root);

    const first = healWrite(root);
    expect(first).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(first.message).toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    expect(first.message).toMatch(/USER\.md/);
    expect(first.message).toContain("retry this call");
    expect(first.message).toContain("not denied for the compaction again");

    const healed = rawState(root);
    expect(healed.started_at).toBe(before.started_at);
    expect(healed.quick_steps).toEqual(before.quick_steps);
    expect(healed.gated_steps).toEqual(before.gated_steps);
    expect(healed.rearm_needed).toBe(false);
    expect(healed.compact_resume_at).toBeNull();
    expect(healed[COMPACT_PRIOR_STARTED_AT_KEY]).toBeNull();
    expect(SESSION_START_TRIGGERS).toContain(HEAL_EVENT_CODE);
    expect(healEventCount(root)).toBe(1);

    const retry = healWrite(root);
    expect(retry.verdict).toBe("allow");
    expect(healEventCount(root)).toBe(1);
  });

  it("heals a ritual already stale by age, then the retry gets the age denial", () => {
    const { root } = healRoot({ startedAgoMs: 10 * HOUR_MS });
    const before = rawState(root);
    markRitualStaleAfterCompact(root);

    const first = healWrite(root);
    expect(first.message).toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    expect(rawState(root).started_at).toBe(before.started_at);

    const retry = healWrite(root);
    expect(retry).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(retry.message).toContain("older than 4h");
    expect(retry.message).not.toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    expect(retry.message).toContain(`--session-id=${HEAL_OWNER}`);
  });

  it("keeps today's denial for a mark written by an older runtime", () => {
    const { root, head } = healRoot();
    const payload = healRitualPayload(root, head, new Date(), true);
    writeRitualState(root, {
      ...payload,
      started_at: timestampIso(RITUAL_STALE_EPOCH),
      compact_resume_at: timestampIso(new Date()),
      rearm_needed: true,
    });

    const denied = healWrite(root);
    expect(denied).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(denied.message).toContain("Compact/resume marked re-arm needed");
    expect(denied.message).not.toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    expect(rawState(root).started_at).toBe(timestampIso(RITUAL_STALE_EPOCH));
    expect(healEventCount(root)).toBe(0);
  });

  it("does not heal when a quick step failed", () => {
    const { root } = healRoot({ quickOk: false });
    markRitualStaleAfterCompact(root);

    const denied = healWrite(root);
    expect(denied).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(denied.message).not.toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    expect(rawState(root).rearm_needed).toBe(true);
  });

  it("keeps the cold denial after a same-owner branch switch under the mark (#2782)", () => {
    const { root } = healRoot();
    markRitualStaleAfterCompact(root);
    runGit(root, ["checkout", "-q", "--orphan", "side"]);
    writeFileSync(join(root, "side.txt"), "s\n", "utf8");
    runGit(root, ["add", "side.txt"]);
    runGit(root, ["commit", "-q", "-m", "side"]);

    const denied = healWrite(root);
    expect(denied).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(denied.message).toContain("discontinuously");
    expect(denied.message).not.toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    expect(rawState(root).rearm_needed).toBe(true);
    expect(rawState(root).started_at).toBe(timestampIso(RITUAL_STALE_EPOCH));
  });

  it("keeps today's denial for a granted member", () => {
    const { root } = healRoot();
    grantOccupancyMembership(root, {
      sessionId: HEAL_OWNER,
      childSessionId: "child",
      role: "leaf-implementation",
      env: {},
    });
    markRitualStaleAfterCompact(root);

    const denied = healWrite(root, "child");
    expect(denied.verdict).toBe("deny");
    expect(denied.message).not.toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    expect(denied.message).not.toContain("--session-id=child");
    expect(rawState(root).rearm_needed).toBe(true);
  });

  it("keeps today's denial when another session holds the lease", () => {
    const { root } = healRoot({ leaseOwner: "other" });
    markRitualStaleAfterCompact(root);

    const denied = healWrite(root);
    expect(denied).toMatchObject({ verdict: "deny", code: "occupancy-occupied" });
    expect(rawState(root).rearm_needed).toBe(true);
  });

  it("refuses a missing or conflicting identity and a ritual bound elsewhere", () => {
    const { root } = healRoot();
    markRitualStaleAfterCompact(root);
    const cases: Partial<CompactHealInput>[] = [
      { callerIdentityIssue: true },
      { callerSessionId: undefined },
      { admitted: "member" },
      { admitted: null },
      { boundSessionId: "other" },
      { callerSessionId: "other", boundSessionId: "other" },
    ];
    for (const overrides of cases) {
      expect(healCompactMarkForOwnerWrite(root, healInput(overrides)).kind).toBe("none");
    }
    expect(rawState(root).rearm_needed).toBe(true);
  });

  it("writes nothing when the lease is lost between check and write", () => {
    const { root } = healRoot();
    markRitualStaleAfterCompact(root);
    const outcome = healCompactMarkForOwnerWrite(
      root,
      healInput({ stillLiveOwner: () => "the occupancy lease is no longer held by this session" }),
    );
    expect(outcome).toMatchObject({ kind: "none" });
    expect(rawState(root).started_at).toBe(timestampIso(RITUAL_STALE_EPOCH));
    expect(rawState(root).rearm_needed).toBe(true);
  });

  it("heals once when two calls race on the same mark", () => {
    const { root } = healRoot();
    const before = rawState(root);
    markRitualStaleAfterCompact(root);
    let winner: CompactHealOutcome | null = null;
    const racingGit: GitRunner = (cwd, args) => {
      if (winner === null) winner = healCompactMarkForOwnerWrite(root, healInput());
      return defaultGitRunner(cwd, args);
    };

    const loser = healCompactMarkForOwnerWrite(root, healInput({ runGit: racingGit }));
    expect(winner).toMatchObject({ kind: "healed" });
    expect(loser.kind).toBe("already-healed");
    if (loser.kind !== "none") {
      expect(loser.message).toContain(READ_ONLY_ALIGNMENT_MESSAGE);
    }
    expect(rawState(root).started_at).toBe(before.started_at);
  });

  it("names the USER.md diagnostic when USER.md is not found", () => {
    const { root } = healRoot();
    markRitualStaleAfterCompact(root);
    const outcome = healCompactMarkForOwnerWrite(
      root,
      healInput({
        resolveUserMd: () => ({
          path: "/nowhere/USER.md",
          rung: "default",
          found: false,
          diagnostic: "USER.md not found (searched 3 rungs)",
          searched: [],
        }),
      }),
    );
    expect(outcome.kind).toBe("healed");
    if (outcome.kind === "healed") {
      expect(outcome.message).toContain("USER.md not found (searched 3 rungs)");
    }
  });

  it("keeps the heal when USER.md resolution throws", () => {
    const { root } = healRoot();
    markRitualStaleAfterCompact(root);
    const outcome = healCompactMarkForOwnerWrite(
      root,
      healInput({
        resolveUserMd: () => {
          throw new Error("no home");
        },
      }),
    );
    expect(outcome.kind).toBe("healed");
    if (outcome.kind === "healed") {
      expect(outcome.message).toContain("USER.md could not be resolved");
    }
  });
});

describe("ritual recovery commands carry the caller's session id (#6279)", () => {
  afterEach(() => {
    for (const root of healTemps.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("prints commands that run as printed under the caller's id", () => {
    const { root } = healRoot({ startedAgoMs: 10 * HOUR_MS });
    const denied = healWrite(root);
    expect(denied).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    const commands = [...denied.message.matchAll(/`((?:deft|directive|task) session:[^`]+)`/g)].map(
      (match) => match[1] ?? "",
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const inspected = inspectExactLifecycleCommand({
        tool_name: "Bash",
        tool_input: { command },
      });
      expect(inspected).toMatchObject({ sessionIdStatus: "present", sessionId: HEAL_OWNER });
    }
    expect(denied.message).toContain(`deft session:ready --session-id=${HEAL_OWNER}`);
  });

  it("fills bare commands and the template token, and leaves flagged commands alone", () => {
    expect(
      fillRecoveryCommandSessionId(
        "Run `deft session:start --rearm` to re-arm (or `deft session:start` for a full cold ceremony).",
        "s1",
      ),
    ).toBe(
      "Run `deft session:start --rearm --session-id=s1` to re-arm " +
        "(or `deft session:start --session-id=s1` for a full cold ceremony).",
    );
    expect(
      fillRecoveryCommandSessionId(
        "Run `deft session:start --rearm --session-id=<same-session-id>` when eligible.",
        "host:claude:v1:YWJj",
      ),
    ).toBe("Run `deft session:start --rearm --session-id=host:claude:v1:YWJj` when eligible.");
    expect(fillRecoveryCommandSessionId("Recovery: run deft session:ready (one-shot).", "s1")).toBe(
      "Recovery: run deft session:ready --session-id=s1 (one-shot).",
    );
    for (const unchanged of [
      "`deft session:start --session-id=s9`",
      "`deft session:start -- --defer cache_fresh=<reason>`",
      "`deft session:start --primary-claim-exception=operator-default-branch`",
      "`deft verify:session-ritual -- --tier=gated`",
    ]) {
      expect(fillRecoveryCommandSessionId(unchanged, "s1")).toBe(unchanged);
    }
    for (const unsafe of [undefined, null, "", "a b", "`x`"]) {
      expect(fillRecoveryCommandSessionId("`deft session:start`", unsafe)).toBe(
        "`deft session:start`",
      );
    }
  });

  it("leaves the occupancy-aware replacement unchanged when ceremony is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "compact-heal-occ-"));
    healTemps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    applyWorktreeOccupancy(root, { sessionId: HEAL_OWNER, intent: "mutation", env: {} });
    const eligibility = evaluateOccupancyCeremonyEligibility(root, { sessionId: "intruder" });
    expect(eligibility.admitCeremony).toBe(false);
    const stale =
      "Directive denied Write: session ritual state is stale (older than 4h). " +
      "Run `deft session:start --rearm` to re-arm (or `deft session:start` for a full cold ceremony).";
    const replaced = applyOccupancyEligibilityToDenial(stale, eligibility, "rearm");
    expect(fillRecoveryCommandSessionId(replaced, "intruder")).toBe(replaced);
    expect(replaced).not.toMatch(/session:start --rearm/);
  });
});
