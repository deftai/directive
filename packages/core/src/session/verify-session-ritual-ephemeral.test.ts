import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type GitRunner,
  newRitualStatePayload,
  ritualStep,
  verifySessionRitual,
  writeRitualState,
} from "./index.js";

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-ephemeral-"));
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
        policy: { sessionRitualStalenessHours: 4 },
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

function fakeGit(head: string, worktree: string): GitRunner {
  return (_r, args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    // Preserve empty stderr on the success path so parity harnesses can diff it.
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("ephemeral posture verify-session-ritual (#2180)", () => {
  it("stale ritual-state on disk does not satisfy read-only quick tier", () => {
    const { root, head } = initRepo();
    const staleStarted = new Date("2020-01-01T00:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "old-session",
        gitHead: "deadbeef",
        worktreePath: "/other/worktree",
        startedAt: staleStarted,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: staleStarted }),
          branch_policy: ritualStep({ ok: true, ts: staleStarted }),
          triage_welcome: ritualStep({ ok: true, ts: staleStarted }),
        },
      }),
    );
    const result = verifySessionRitual(root, {
      tier: "quick",
      posture: "read-only",
      bypass: false,
      envSkip: "",
      envPosture: "",
      now: new Date("2026-06-09T01:00:00Z"),
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(result.ritualStateRequired).toBe(false);
    expect(result.message).toContain("read-only posture");
    rmSync(root, { recursive: true, force: true });
  });

  it("mutation continuation requires fresh gated ritual state", () => {
    const { root, head } = initRepo();
    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      bypass: false,
      envSkip: "",
      envPosture: "",
      now: new Date("2026-06-09T01:00:00Z"),
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(1);
    expect(result.posture).toBe("mutation");
    expect(result.ritualStateRequired).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("structured read-only handoff stays ceremony-free at quick tier", () => {
    const { root, head } = initRepo();
    const handoff = `
## Structured handoff
posture: read-only
Continue issue discussion only — no code changes.
`;
    const result = verifySessionRitual(root, {
      tier: "quick",
      handoffText: handoff,
      bypass: false,
      envSkip: "",
      envPosture: "",
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(result.posture).toBe("read-only");
    rmSync(root, { recursive: true, force: true });
  });
});
