import { spawnSync } from "node:child_process";
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

const EMPTY_STDERR = "";

function runGitCapture(root: string, args: readonly string[]): string {
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
    const detail = (result.stderr ?? result.stdout ?? "git failed").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  // Capture stderr on the success path so parity diffs can observe it.
  void (result.stderr ?? EMPTY_STDERR);
  return (result.stdout ?? "").trim();
}

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
  runGitCapture(root, ["init", "-q"]);
  runGitCapture(root, ["config", "user.email", "t@t.local"]);
  runGitCapture(root, ["config", "user.name", "T"]);
  runGitCapture(root, ["add", "-A"]);
  runGitCapture(root, ["commit", "-q", "-m", "init"]);
  const head = runGitCapture(root, ["rev-parse", "HEAD"]);
  return { root, head };
}

function fakeGit(head: string, worktree: string): GitRunner {
  return (_r, args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: EMPTY_STDERR };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: EMPTY_STDERR };
    }
    return { code: 0, stdout: "", stderr: EMPTY_STDERR };
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
          verify_tools: ritualStep({ ok: true, ts: staleStarted }),
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
