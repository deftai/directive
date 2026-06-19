import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitRunner } from "./git.js";
import { buildContext, evaluate, parse, ResumeGrammarError } from "./resume-conditions.js";
import * as ritualSentinel from "./ritual-sentinel.js";
import {
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";
import { defaultBranchSync, runSessionStart } from "./session-start.js";
import { verifySessionRitual } from "./verify-session-ritual.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-br-"));
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

function fakeGit(head: string, worktree: string, overrides?: Partial<GitRunner>): GitRunner {
  const base: GitRunner = (_r, args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return overrides ? (r, a) => overrides(r, a) ?? base(r, a) : base;
}

describe("session branches", () => {
  it("defaultBranchSync ahead and diverged warnings", () => {
    const { root } = initRepo();
    const mk =
      (counts: string): GitRunner =>
      (_r, args) => {
        if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main", stderr: "" };
        if (args[0] === "show-ref") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return { code: 0, stdout: "origin/main", stderr: "" };
        }
        if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-list") return { code: 0, stdout: counts, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      };
    expect(defaultBranchSync(root, mk("2 0")).warning).toContain("ahead");
    expect(defaultBranchSync(root, mk("2 3")).warning).toContain("diverged");
    expect(defaultBranchSync(root, mk("bad")).warning).toContain("parse");
    expect(
      defaultBranchSync(root, (_r, args) =>
        args[0] === "fetch" ? { code: 1, stdout: "", stderr: "fail" } : mk("0 0")(_r, args),
      ).warning,
    ).toContain("refresh");
    expect(
      defaultBranchSync(root, (_r, args) =>
        args[0] === "rev-parse" && args[1] === "--abbrev-ref"
          ? { code: 1, stdout: "", stderr: "" }
          : mk("0 0")(_r, args),
      ).warning,
    ).toContain("upstream");
  });

  it("verify detects head and worktree drift", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: "old-head",
        worktreePath: resolve(root),
        startedAt: now,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: now }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
        },
      }),
    );
    const headDrift = verifySessionRitual(root, {
      bypass: false,
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(headDrift.code).toBe(1);
    expect(headDrift.message).toContain("HEAD changed");

    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: "/other/worktree",
        startedAt: now,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: now }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
        },
      }),
    );
    const wtDrift = verifySessionRitual(root, {
      bypass: false,
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(wtDrift.message).toContain("different worktree");
  });

  it("verify fails quick step and gated write error", () => {
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
          alignment: ritualStep({ ok: false, ts: now, message: "nope" }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
        },
      }),
    );
    expect(
      verifySessionRitual(root, { bypass: false, now, runGit: fakeGit(head, resolve(root)) }).code,
    ).toBe(1);

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
      }),
    );
    vi.spyOn(ritualSentinel, "writeRitualState").mockImplementation(() => {
      throw new Error("disk full");
    });
    const gated = verifySessionRitual(root, {
      bypass: false,
      tier: "gated",
      now,
      runGit: fakeGit(head, resolve(root)),
      runner: () => ({ code: 0, stdout: "ok", stderr: "" }),
    });
    expect(gated.code).toBe(2);
    vi.restoreAllMocks();
  });

  it("runSessionStart triage exception path", () => {
    const { root, head } = initRepo();
    const result = runSessionStart(root, {
      now: new Date("2026-06-09T01:00:00Z"),
      newSessionId: () => "id",
      runGit: fakeGit(head, resolve(root)),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => {
        throw new Error("boom");
      },
      writeHistory: false,
    });
    expect(result.code).toBe(1);
    const [state] = readRitualState(root);
    expect(state?.quickSteps.triage_welcome?.ok).toBe(false);
  });

  it("resume parse slice-wave-ready and evaluate slice gate", () => {
    const sid = "11111111-1111-1111-1111-111111111111";
    const atom = parse(`slice-wave-ready:${sid}:2`);
    expect(atom.left.sliceId).toBe(sid);
    expect(() => parse(`slice-wave-ready:${sid}:0`)).toThrow(ResumeGrammarError);
    const ctx = buildContext("/tmp", {
      today: "2026-06-09",
      slices: [
        {
          slice_id: sid,
          children: [
            { wave: 1, n: 10 },
            { wave: 2, n: 11 },
          ],
        },
      ],
    });
    const expr = parse(`slice-wave-ready:${sid}:2`);
    expect(evaluate(expr, { ...ctx, closedRefs: new Set([10]) })).toBe(true);
    expect(evaluate(expr, { ...ctx, closedRefs: new Set() })).toBe(false);
  });

  it("readRitualState validates step object shapes", () => {
    const { root } = initRepo();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        session_id: "s",
        git_head: "h",
        worktree_path: "w",
        started_at: "2026-06-09T01:00:00Z",
        quick_steps: { bad: { ok: "yes", ts: "2026-06-09T01:00:00Z" } },
        gated_steps: {},
      }),
      "utf8",
    );
    expect(readRitualState(root)[1]).toContain(".ok");
  });
});
