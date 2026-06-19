import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "./git.js";
import { pythonJsonDump, sortKeys, stableJson } from "./json.js";
import { evaluateResumeEligibility, parse, RESUME_ELIGIBLE_DECISION } from "./resume-conditions.js";
import {
  computeResumeSignal,
  detectLatestActiveVbrief,
  newRitualStatePayload,
  readRitualState,
  readSentinel,
  recordRitualStep,
  ritualStep,
  writeRitualState,
  writeSentinel,
} from "./ritual-sentinel.js";
import { defaultBranchSync, parseDeferrals, runSessionStart } from "./session-start.js";
import { runSessionStartHookWrite } from "./session-start-hook.js";
import { resolveSessionRitualStalenessHours } from "./staleness.js";
import {
  ENTRYPOINT_TIMEOUT_EXIT_CODE,
  emitBypassWarning,
  emitVerifyJson,
  verifySessionRitual,
} from "./verify-session-ritual.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
  temps.length = 0;
});

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-cov-"));
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

function fakeGit(head: string, worktree: string): GitRunner {
  return (_r, args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
      return { code: 0, stdout: "origin/main", stderr: "" };
    }
    if (args[0] === "show-ref") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      return { code: 0, stdout: "origin/main", stderr: "" };
    }
    if (args[0] === "fetch") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-list") {
      return { code: 0, stdout: "1 0", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("session coverage boost", () => {
  it("json helpers match python spacing", () => {
    expect(pythonJsonDump({ b: 1, a: 2 })).toBe('{"a": 2, "b": 1}');
    expect(stableJson({ z: 1, a: { c: 2 } }, 2)).toContain('"a"');
    expect(sortKeys([{ b: 1 }])).toEqual([{ b: 1 }]);
  });

  it("readRitualState rejects invalid payloads", () => {
    const { root } = initRepo();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "ritual-state.json"), "{", "utf8");
    expect(readRitualState(root)[0]).toBeNull();
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({ schemaVersion: 9 }),
      "utf8",
    );
    expect(readRitualState(root)[1]).toContain("schemaVersion");
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        session_id: "s",
        git_head: "h",
        worktree_path: "w",
        started_at: "bad",
        quick_steps: {},
        gated_steps: {},
      }),
      "utf8",
    );
    expect(readRitualState(root)[1]).toContain("started_at");
  });

  it("recordRitualStep updates gated tier", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: now,
        quickSteps: { alignment: ritualStep({ ok: true, ts: now }) },
      }),
    );
    recordRitualStep(root, {
      tier: "gated",
      stepName: "doctor",
      step: ritualStep({ ok: true, ts: now, message: "ok" }),
    });
    const [state] = readRitualState(root);
    expect(state?.gatedSteps.doctor?.message).toBe("ok");
  });

  it("sentinel read/write and resume signal guards", () => {
    const { root } = initRepo();
    expect(readSentinel(root)).toBeNull();
    expect(computeResumeSignal(null, new Date(), root)).toBeNull();
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "a.vbrief.json"), "{}\n", "utf8");
    writeSentinel(root, {
      deftVersion: "1",
      lastActiveVbrief: "vbrief/completed/a.vbrief.json",
      lastBranch: "main",
      now: new Date("2026-06-08T00:00:00Z"),
    });
    const sentinel = readSentinel(root);
    expect(computeResumeSignal(sentinel, new Date("2026-06-09T01:00:00Z"), root)).toBeNull();
    writeSentinel(root, {
      deftVersion: "1",
      lastActiveVbrief: "vbrief/active/a.vbrief.json",
      lastBranch: "main",
      now: new Date("2026-06-09T00:30:00Z"),
    });
    expect(
      computeResumeSignal(readSentinel(root), new Date("2026-06-09T01:00:00Z"), root),
    ).toBeNull();
    expect(detectLatestActiveVbrief(root)).toBe("vbrief/active/a.vbrief.json");
  });

  it("defaultBranchSync covers warning branches", () => {
    const { root } = initRepo();
    expect(defaultBranchSync(root, () => ({ code: 1, stdout: "", stderr: "" })).warning).toContain(
      "default branch",
    );
    const behind = defaultBranchSync(root, (_r, args) => {
      if (args[0] === "rev-list") return { code: 0, stdout: "0 2", stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "show-ref") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(behind.warning).toContain("behind");
  });

  it("runSessionStart handles git failure and deferrals", () => {
    const { root } = initRepo();
    const fail = runSessionStart(root, {
      runGit: () => ({ code: 1, stdout: "", stderr: "no head" }),
    });
    expect(fail.code).toBe(2);
    const defer = parseDeferrals(["cache_fresh=later", "bad"]);
    expect(defer.errors.length).toBe(1);
    const ok = runSessionStart(root, {
      now: new Date("2026-06-09T01:00:00Z"),
      newSessionId: () => "id",
      runGit: fakeGit("abc", resolve(root)),
      deferrals: { alignment: "later" },
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: (_r, o) => {
        o.output("line");
        return { exitCode: 0 };
      },
      writeHistory: false,
    });
    expect(ok.code).toBe(0);
    expect(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")).toContain(
      "deferred_reason",
    );
  });

  it("verifySessionRitual covers gated runner and invalid tier", () => {
    const { root, head } = initRepo();
    expect(verifySessionRitual(root, { tier: "bad" as "quick" }).code).toBe(2);
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
      }),
    );
    const gated = verifySessionRitual(root, {
      tier: "gated",
      now,
      runGit: fakeGit(head, resolve(root)),
      runner: () => ({ code: 0, stdout: "OK", stderr: "" }),
    });
    expect(gated.code).toBe(0);
    const bypass = verifySessionRitual(root, {
      bypass: true,
      runGit: fakeGit("other", resolve(root)),
    });
    expect(bypass.bypassed).toBe(true);
    expect(emitBypassWarning(bypass).length).toBeGreaterThan(0);
    expect(JSON.parse(emitVerifyJson(gated)).ready).toBe(true);
  });

  it("resolveSessionRitualStalenessHours and resume evaluator", () => {
    const { root } = initRepo();
    expect(resolveSessionRitualStalenessHours(root).source).toBe("typed");
    const orExpr = parse("ref:closed:#1 OR ref:merged:#2");
    expect(orExpr.op).toBe("OR");
    const log = {
      entries: [] as Record<string, unknown>[],
      readAll: () => log.entries,
      append: (entry: Record<string, unknown>) => {
        log.entries.push(entry);
      },
      newDecisionId: () => "new-id",
    };
    log.entries.push({
      decision_id: "d1",
      timestamp: "2026-06-01T00:00:00Z",
      repo: "deftai/directive",
      issue_number: 1,
      decision: "defer",
      resume_on: "ref:closed:#99",
    });
    mkdirSync(join(root, ".deft-cache", "github-issue", "deftai", "directive", "99"), {
      recursive: true,
    });
    writeFileSync(
      join(root, ".deft-cache", "github-issue", "deftai", "directive", "99", "raw.json"),
      JSON.stringify({ state: "closed" }),
      "utf8",
    );
    const appended = evaluateResumeEligibility(root, {
      logModule: log,
      repo: "deftai/directive",
      today: "2026-06-09",
    });
    expect(appended[0]?.decision).toBe(RESUME_ELIGIBLE_DECISION);
  });

  it("session start hook failure paths", () => {
    const { root } = initRepo();
    expect(
      runSessionStartHookWrite(root, {
        detectBranchFn: () => "main",
        detectLatestActiveVbriefFn: () => null,
      }).code,
    ).toBe(2);
    expect(
      runSessionStartHookWrite(root, {
        detectBranchFn: () => "main",
        detectLatestActiveVbriefFn: () => "vbrief/active/x.json",
        resolveVersionFn: () => {
          throw new Error("boom");
        },
      }).code,
    ).toBe(2);
  });

  it("exports ENTRYPOINT_TIMEOUT_EXIT_CODE", () => {
    expect(ENTRYPOINT_TIMEOUT_EXIT_CODE).toBe(124);
  });
});
