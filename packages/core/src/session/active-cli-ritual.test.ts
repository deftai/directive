import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveCliCheckResult } from "./active-cli.js";
import type { GitRunner } from "./git.js";
import { newRitualStatePayload, ritualStep, writeRitualState } from "./ritual-sentinel.js";
import { verifySessionRitual } from "./verify-session-ritual.js";

const tempRoots: string[] = [];

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-active-cli-ritual-"));
  tempRoots.push(root);
  writeFileSync(join(root, "AGENTS.md"), "# test\n", "utf8");
  // Minimal .git so path helpers that expect a repo root do not throw.
  writeFileSync(join(root, ".git"), "gitdir: /tmp/fake\n", "utf8");
  return { root, head: "abc123deadbeef" };
}

function fakeGit(head: string, worktree: string): GitRunner {
  return (_projectRoot, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    if (args[0] === "merge-base" || args.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function freshPayload(root: string, head: string, now: Date) {
  return newRitualStatePayload({
    sessionId: "s-active-cli",
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
      agent_hooks: ritualStep({ ok: true, ts: now, message: "hooks ok" }),
      doctor: ritualStep({ ok: true, ts: now, message: "doctor ok" }),
      cache_fresh: ritualStep({ ok: true, ts: now, message: "cache ok" }),
    },
  });
}

function okActiveCli(): ActiveCliCheckResult {
  return {
    ok: true,
    code: 0,
    active: {
      command: "deft",
      path: "/usr/local/bin/deft",
      version: "0.98.1",
      precedence: 0,
    },
    candidates: [],
    targetVersion: null,
    message: "active CLI ok",
    lines: [],
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("verifySessionRitual active CLI gate (#3233)", () => {
  it("fails gated ritual when active CLI is a stale higher-precedence shadow", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-08-10T12:00:00Z");
    writeRitualState(root, freshPayload(root, head, now));

    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(head, resolve(root)),
      runner: () => ({ code: 0, stdout: "OK", stderr: "" }),
      targetEngineVersion: "0.98.1",
      checkActiveCli: (target) => ({
        ok: false,
        code: 1,
        active: {
          command: "deft",
          path: "/opt/homebrew/bin/deft",
          version: "0.97.0",
          precedence: 0,
        },
        candidates: [],
        targetVersion: target,
        message:
          "stale higher-precedence CLI after upgrade: shell-active deft is engine 0.97.0 " +
          "at /opt/homebrew/bin/deft, but upgrade target is 0.98.1",
        lines: [
          "[deft session] FAIL: stale higher-precedence CLI after upgrade",
          "  - /opt/homebrew/bin/deft → engine 0.97.0 (active) [deft]",
          "  - /Users/x/.nvm/bin/deft → engine 0.98.1 [deft]",
          "[deft session] Remediation (higher-precedence CLI shadows the upgraded install):",
          "  1. Align every global prefix to the same engine version, e.g.:",
          "     npm i -g @deftai/directive@latest",
        ],
      }),
    });

    expect(result.code).toBe(1);
    expect(result.message).toMatch(/stale higher-precedence CLI/i);
    expect(result.message).toContain("/opt/homebrew/bin/deft");
    expect(result.message).toContain("Remediation");
    expect(result.message).toContain("npm i -g @deftai/directive@latest");
  });

  it("passes gated ritual when active CLI check is clean", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-08-10T12:00:00Z");
    writeRitualState(root, freshPayload(root, head, now));

    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(head, resolve(root)),
      runner: () => ({ code: 0, stdout: "OK", stderr: "" }),
      targetEngineVersion: "0.98.1",
      checkActiveCli: () => okActiveCli(),
    });

    expect(result.code).toBe(0);
    expect(result.message).toMatch(/OK session ritual gated/i);
  });

  it("does not run active CLI check on quick tier", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-08-10T12:00:00Z");
    writeRitualState(root, freshPayload(root, head, now));
    let called = false;

    const result = verifySessionRitual(root, {
      tier: "quick",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(head, resolve(root)),
      checkActiveCli: () => {
        called = true;
        return {
          ok: false,
          code: 1,
          active: null,
          candidates: [],
          targetVersion: null,
          message: "should not run",
          lines: ["should not run"],
        };
      },
    });

    expect(called).toBe(false);
    expect(result.code).toBe(0);
  });
});
