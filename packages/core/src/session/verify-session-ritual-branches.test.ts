import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRitualStatePayload, ritualStep, writeRitualState } from "./ritual-sentinel.js";
import {
  emitBypassWarning,
  inspectSessionRitual,
  verifySessionRitual,
} from "./verify-session-ritual.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "verify-br-"));
  temps.push(root);
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { sessionRitualStalenessHours: 1 },
      },
    }),
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
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
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
}

describe("verify-session-ritual branches", () => {
  it("defaults inspection to read-only posture outside an authorized mutation boundary", () => {
    const { root } = initRepo();

    const result = inspectSessionRitual(root);

    expect(result).toMatchObject({ code: 0, tier: "quick", posture: "read-only" });
  });

  it("uses default quick inspection options for a missing state", () => {
    const { root } = initRepo();

    const result = inspectSessionRitual(root, { posture: "mutation" });

    expect(result.code).toBe(1);
    expect(result.tier).toBe("quick");
  });

  it("returns config error for corrupt ritual state", () => {
    const { root, head } = initRepo();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "ritual-state.json"), "{", "utf8");
    const result = verifySessionRitual(root, {
      bypass: false,
      posture: "mutation",
      runGit: (_r, a) =>
        a[2] === "HEAD"
          ? { code: 0, stdout: head, stderr: "" }
          : { code: 0, stdout: resolve(root), stderr: "" },
    });
    expect(result.code).toBe(2);
  });

  it("flags stale ritual by configured hours", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-06-08T00:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: started,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: started }),
          branch_policy: ritualStep({ ok: true, ts: started }),
          triage_welcome: ritualStep({ ok: true, ts: started }),
          verify_tools: ritualStep({ ok: true, ts: started }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      posture: "mutation",
      now: new Date("2026-06-09T01:00:00Z"),
      runGit: (_r, a) =>
        a[2] === "HEAD"
          ? { code: 0, stdout: head, stderr: "" }
          : { code: 0, stdout: resolve(root), stderr: "" },
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("older than 1h");
  });

  it("reports a message-less quick failure and blocks gated precheck", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: now,
        quickSteps: {
          alignment: ritualStep({ ok: false, ts: now }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
          verify_tools: ritualStep({ ok: true, ts: now }),
        },
      }),
    );

    const inspected = inspectSessionRitual(root, { posture: "mutation", now });
    const verified = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
    });

    expect(inspected.message).toBe("session ritual quick step 'alignment' failed");
    expect(verified.code).toBe(1);
    expect(verified.message).toContain("alignment");
  });

  it("emitBypassWarning is empty without would_fail_code", () => {
    expect(
      emitBypassWarning({
        code: 0,
        message: "ok",
        tier: "quick",
        statePath: "/x",
        bypassed: true,
        wouldFailCode: null,
        posture: "read-only",
        ritualStateRequired: false,
      }),
    ).toBe("");
  });

  it("reruns non-deferrable agent-hook readiness while reusing doctor and cache steps", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: now,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: now }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
          verify_tools: ritualStep({ ok: true, ts: now }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: now, message: "done" }),
          doctor: ritualStep({ ok: true, ts: now, message: "done" }),
          cache_fresh: ritualStep({ ok: true, ts: now, message: "done" }),
        },
      }),
    );
    const commands: string[][] = [];
    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: (_r, a) =>
        a[2] === "HEAD"
          ? { code: 0, stdout: head, stderr: "" }
          : { code: 0, stdout: resolve(root), stderr: "" },
      runner: (command) => {
        commands.push([...command]);
        return { code: 0, stdout: "hooks ready", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(commands).toEqual([["verify:hooks-installed", "--scope=agent", "--live"]]);
  });

  it("creates a missing gated-step object and records empty runner output", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    const payload = newRitualStatePayload({
      sessionId: "s",
      gitHead: head,
      worktreePath: resolve(root),
      startedAt: now,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: now }),
        branch_policy: ritualStep({ ok: true, ts: now }),
        triage_welcome: ritualStep({ ok: true, ts: now }),
        verify_tools: ritualStep({ ok: true, ts: now }),
      },
    });
    payload.gated_steps = {};
    writeRitualState(root, payload);

    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runner: () => ({ code: 1, stdout: "", stderr: "" }),
    });

    expect(result.code).toBe(1);
    expect(result.message).toContain("verify:hooks-installed exited 1");
  });

  it("returns a clean bypass projection for a fresh ritual", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: now,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: now }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
          verify_tools: ritualStep({ ok: true, ts: now }),
        },
      }),
    );

    const result = verifySessionRitual(root, { bypass: true, posture: "mutation", now });

    expect(result.code).toBe(0);
    expect(result.bypassed).toBe(true);
    expect(result.wouldFailCode).toBeNull();
  });
});
