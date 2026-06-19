import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRitualStatePayload, ritualStep, writeRitualState } from "./ritual-sentinel.js";
import { emitBypassWarning, verifySessionRitual } from "./verify-session-ritual.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "verify-br-"));
  temps.push(root);
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
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
  it("returns config error for corrupt ritual state", () => {
    const { root, head } = initRepo();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "ritual-state.json"), "{", "utf8");
    const result = verifySessionRitual(root, {
      bypass: false,
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
        },
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      now: new Date("2026-06-09T01:00:00Z"),
      runGit: (_r, a) =>
        a[2] === "HEAD"
          ? { code: 0, stdout: head, stderr: "" }
          : { code: 0, stdout: resolve(root), stderr: "" },
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("older than 1h");
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
      }),
    ).toBe("");
  });

  it("gated tier accepts pre-completed doctor and cache steps", () => {
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
        },
        gatedSteps: {
          doctor: ritualStep({ ok: true, ts: now, message: "done" }),
          cache_fresh: ritualStep({ ok: true, ts: now, message: "done" }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      tier: "gated",
      now,
      runGit: (_r, a) =>
        a[2] === "HEAD"
          ? { code: 0, stdout: head, stderr: "" }
          : { code: 0, stdout: resolve(root), stderr: "" },
    });
    expect(result.code).toBe(0);
  });
});
