import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "./git.js";
import { newRitualStatePayload, ritualStep, writeRitualState } from "./ritual-sentinel.js";
import { verifySessionRitual } from "./verify-session-ritual.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function initRoot(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "verify-msg-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { sessionRitualStalenessHours: 4 },
      },
    }),
    "utf8",
  );
  return { root, head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" };
}

function fakeGit(head: string, worktree: string): GitRunner {
  return (_r, a) =>
    a[2] === "HEAD"
      ? { code: 0, stdout: head, stderr: "" }
      : { code: 0, stdout: worktree, stderr: "" };
}

const NOW = new Date("2026-06-09T01:00:00Z");

describe("verify-session-ritual failed-step messaging", () => {
  it("reports a missing quick step", () => {
    const { root, head } = initRoot();
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: NOW,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: NOW }),
          branch_policy: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("triage_welcome");
    expect(result.message).toContain("is missing");
  });

  it("reports a failed quick step with its message suffix", () => {
    const { root, head } = initRoot();
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: NOW,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: NOW }),
          branch_policy: ritualStep({ ok: false, ts: NOW, message: "policy off" }),
          triage_welcome: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("failed: policy off");
  });

  it("treats a deferred quick step as passing", () => {
    const { root, head } = initRoot();
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: NOW,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: NOW }),
          branch_policy: ritualStep({ ok: true, ts: NOW }),
          triage_welcome: ritualStep({ ok: false, ts: NOW, deferredReason: "later" }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
  });

  it("skips deferred gated steps and runs only the missing ones", () => {
    const { root, head } = initRoot();
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: NOW,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: NOW }),
          branch_policy: ritualStep({ ok: true, ts: NOW }),
          triage_welcome: ritualStep({ ok: true, ts: NOW }),
        },
        gatedSteps: {
          doctor: ritualStep({ ok: false, ts: NOW, deferredReason: "later" }),
        },
      }),
    );
    const ran: string[] = [];
    const result = verifySessionRitual(root, {
      bypass: false,
      tier: "gated",
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
      runner: (cmd) => {
        ran.push(cmd[0] ?? "");
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(ran).toEqual(["verify:cache-fresh"]);
  });

  it("uses the exit-code fallback message when a gated runner is silent", () => {
    const { root, head } = initRoot();
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: NOW,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: NOW }),
          branch_policy: ritualStep({ ok: true, ts: NOW }),
          triage_welcome: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      tier: "gated",
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
      runner: () => ({ code: 3, stdout: "   ", stderr: "" }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("doctor");
  });

  it("honours an explicit envSkip bypass that records a would-fail code", () => {
    const { root, head } = initRoot();
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: NOW,
        quickSteps: {
          alignment: ritualStep({ ok: false, ts: NOW, message: "nope" }),
          branch_policy: ritualStep({ ok: true, ts: NOW }),
          triage_welcome: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      envSkip: "1",
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(result.bypassed).toBe(true);
    expect(result.wouldFailCode).toBe(1);
  });
});
