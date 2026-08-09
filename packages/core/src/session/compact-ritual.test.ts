import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decideHook, renderHostDecision } from "../hooks/dispatcher.js";
import {
  appendSoftAgentsRebindToMessage,
  depositOpenClawSoftRebindSkill,
  formatOpenClawSoftRebindSkillMarkdown,
  formatSoftAgentsRebindChecklist,
  inspectSessionRitual,
  isManagedOpenClawSoftRebindSkill,
  isSoftAgentsRebindText,
  markRitualStaleAfterCompact,
  newRitualStatePayload,
  OPENCLAW_SOFT_REBIND_SKILL_ID,
  ritualStep,
  SOFT_AGENTS_REBIND_CHECKLIST,
  SOFT_AGENTS_REBIND_MARKER,
  SOFT_REBIND_HOST_MATRIX,
  softAgentsRebindForbiddenHits,
  writeRitualState,
} from "./index.js";

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
