import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_DIR_NAME, CANDIDATES_RELPATH, DEFAULT_SOURCE } from "../preflight-cache/evaluate.js";
import type { GitRunner } from "./git.js";
import { defaultRitualRunner } from "./ritual-entrypoint.js";
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
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
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
      posture: "mutation",
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
          verify_tools: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      posture: "mutation",
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
          verify_tools: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      posture: "mutation",
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
          verify_tools: ritualStep({ ok: true, ts: NOW }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: NOW }),
          doctor: ritualStep({ ok: false, ts: NOW, deferredReason: "later" }),
        },
      }),
    );
    const ran: string[] = [];
    const result = verifySessionRitual(root, {
      bypass: false,
      tier: "gated",
      posture: "mutation",
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
      runner: (cmd) => {
        ran.push(cmd[0] ?? "");
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(ran).toEqual(["verify:hooks-installed", "verify:cache-fresh"]);
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
          verify_tools: ritualStep({ ok: true, ts: NOW }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      tier: "gated",
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
      runner: (command) =>
        command[0] === "verify:hooks-installed"
          ? { code: 0, stdout: "hooks ready", stderr: "" }
          : { code: 3, stdout: "   ", stderr: "" },
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("doctor");
  });

  it("reports gated cache_fresh stale recovery with runnable cache fetch-all (#2574)", () => {
    const { root, head } = initRoot();
    const repo = "deftai/cartograph";
    const fetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const [owner, name] = repo.split("/") as [string, string];
    const entryDir = join(root, CACHE_DIR_NAME, DEFAULT_SOURCE, owner, name, "62");
    mkdirSync(entryDir, { recursive: true });
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(entryDir, "meta.json"), JSON.stringify({ fetched_at: fetchedAt }), "utf8");
    writeFileSync(
      join(entryDir, "raw.json"),
      JSON.stringify({ number: 62, state: "open" }),
      "utf8",
    );
    writeFileSync(
      join(root, CANDIDATES_RELPATH),
      JSON.stringify({
        issue: 62,
        repo,
        decision: "accept",
        ts: new Date().toISOString(),
      }),
      "utf8",
    );
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
          verify_tools: ritualStep({ ok: true, ts: NOW }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: NOW }),
          doctor: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      tier: "gated",
      posture: "mutation",
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
      runner: (command, projectRoot) =>
        command[0] === "verify:hooks-installed"
          ? { code: 0, stdout: "hooks ready", stderr: "" }
          : defaultRitualRunner(command, projectRoot),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("cache_fresh");
    expect(result.message).toContain(
      "cache fetch-all --source github-issue --repo deftai/cartograph --force",
    );
    expect(result.message).not.toContain("cache:fetch-all");
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
          verify_tools: ritualStep({ ok: true, ts: NOW }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      envSkip: "1",
      posture: "mutation",
      now: NOW,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(result.bypassed).toBe(true);
    expect(result.wouldFailCode).toBe(1);
  });
});
