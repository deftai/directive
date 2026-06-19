import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, evaluate, evaluateResumeEligibility, parse } from "./resume-conditions.js";
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
import { defaultBranchSync, runSessionStart } from "./session-start.js";
import { runSessionStartHookWrite } from "./session-start-hook.js";
import { resolveSessionRitualStalenessHours } from "./staleness.js";
import { parseTimestamp } from "./time.js";
import { verifySessionRitual } from "./verify-session-ritual.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function initRepo(policy: Record<string, unknown> = {}): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-extra-"));
  temps.push(root);
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "T", status: "running", items: [], policy },
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

describe("session extra coverage", () => {
  it("parseTimestamp rejects invalid values", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("not-a-date")).toBeNull();
  });

  it("ritual state step validation errors", () => {
    const { root } = initRepo();
    mkdirSync(join(root, ".deft"), { recursive: true });
    const base = {
      schemaVersion: 1,
      session_id: "s",
      git_head: "h",
      worktree_path: "w",
      started_at: "2026-06-09T01:00:00Z",
      gated_steps: {},
    };
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({ ...base, quick_steps: { "": { ok: true, ts: "2026-06-09T01:00:00Z" } } }),
      "utf8",
    );
    expect(readRitualState(root)[1]).toContain("non-string");
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({ ...base, quick_steps: { a: null } }),
      "utf8",
    );
    expect(readRitualState(root)[1]).toContain("must be an object");
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({
        ...base,
        quick_steps: { a: { ok: true, ts: "2026-06-09T01:00:00Z", exit_code: true } },
      }),
      "utf8",
    );
    expect(readRitualState(root)[1]).toContain("exit_code");
  });

  it("recordRitualStep rejects missing state and bad tier", () => {
    const { root } = initRepo();
    expect(() =>
      recordRitualStep(root, { tier: "bad" as "quick", stepName: "x", step: {} }),
    ).toThrow();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: "h",
        worktreePath: resolve(root),
        startedAt: now,
        quickSteps: { alignment: ritualStep({ ok: true, ts: now }) },
      }),
    );
    recordRitualStep(root, {
      tier: "quick",
      stepName: "alignment",
      step: ritualStep({ ok: true, ts: now, message: "again" }),
    });
    expect(readRitualState(root)[0]?.quickSteps.alignment?.message).toBe("again");
  });

  it("sentinel and detectLatestActiveVbrief edge cases", () => {
    const { root } = initRepo();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "last-session.json"), "[]", "utf8");
    expect(readSentinel(root)).toBeNull();
    expect(detectLatestActiveVbrief(root)).toBeNull();
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "z.vbrief.json"), "{}\n", "utf8");
    expect(detectLatestActiveVbrief(root)).toBe("vbrief/active/z.vbrief.json");
    writeSentinel(root, {
      deftVersion: "1",
      lastActiveVbrief: "vbrief/active/z.vbrief.json",
      lastBranch: "main",
      now: new Date("2026-06-08T00:00:00Z"),
    });
    const sig = computeResumeSignal(readSentinel(root), new Date("2026-06-08T03:00:00Z"), root);
    expect(sig).toContain("3h");
  });

  it("defaultBranchSync uses show-ref fallback when origin HEAD missing", () => {
    const { root } = initRepo();
    const sync = defaultBranchSync(root, (_r, args) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "show-ref") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(sync.branch).toBe("main");
  });

  it("runSessionStart uses branch policy fail-closed path", () => {
    const { root, head } = initRepo();
    const result = runSessionStart(root, {
      now: new Date("2026-06-09T01:00:00Z"),
      newSessionId: () => "id",
      runGit: (_r, args) => {
        if (args[0] === "rev-parse" && args[2] === "HEAD") {
          return { code: 0, stdout: head, stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { code: 0, stdout: resolve(root), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: (_r, o) => {
        o.output("ok");
        return { exitCode: 0 };
      },
      writeHistory: false,
    });
    expect(result.code).toBe(0);
  });

  it("verify stale policy error and git head failure", () => {
    const badPolicy = initRepo({ sessionRitualStalenessHours: 0 });
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      badPolicy.root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: badPolicy.head,
        worktreePath: resolve(badPolicy.root),
        startedAt: now,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: now }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
        },
      }),
    );
    expect(
      verifySessionRitual(badPolicy.root, {
        bypass: false,
        now,
        runGit: (_r, a) =>
          a[2] === "HEAD"
            ? { code: 0, stdout: badPolicy.head, stderr: "" }
            : { code: 0, stdout: resolve(badPolicy.root), stderr: "" },
      }).code,
    ).toBe(2);

    const { root, head } = initRepo();
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
    expect(
      verifySessionRitual(root, {
        bypass: false,
        now,
        runGit: () => ({ code: 1, stdout: "", stderr: "no git" }),
      }).code,
    ).toBe(2);
  });

  it("resume conditions evaluate pending and date branches", () => {
    const ctx = buildContext("/tmp", { today: "2026-06-01" });
    expect(evaluate(parse("date:>=2026-06-09"), ctx)).toBe(false);
    expect(evaluate(parse("pending-count:<=0"), { ...ctx, pendingCount: 0 })).toBe(true);
    expect(evaluate(parse("ref:merged:#9"), { ...ctx, mergedRefs: new Set([9]) })).toBe(true);
    expect(
      evaluateResumeEligibility("/tmp", {
        logModule: {
          readAll: () => [
            {
              decision_id: "d",
              timestamp: "2026-06-01",
              repo: "r",
              issue_number: 1,
              decision: "defer",
              resume_on: "not-valid!!!",
            },
          ],
          append: () => {},
        },
      }),
    ).toEqual([]);
  });

  it("resolveSessionRitualStalenessHours null and missing policy", () => {
    const { root } = initRepo({ sessionRitualStalenessHours: null });
    expect(resolveSessionRitualStalenessHours(root).source).toBe("default");
    const noPlan = mkdtempSync(join(tmpdir(), "session-noplan-"));
    temps.push(noPlan);
    expect(resolveSessionRitualStalenessHours(noPlan).source).toBe("default");
  });

  it("session hook write failure returns code 1", () => {
    const { root } = initRepo();
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "a.vbrief.json"), "{}\n", "utf8");
    const result = runSessionStartHookWrite(root, {
      detectBranchFn: () => "main",
      detectLatestActiveVbriefFn: () => "vbrief/active/a.vbrief.json",
      resolveVersionFn: () => "1.0.0",
      writeSentinelFn: () => {
        throw new Error("fail");
      },
    });
    expect(result.code).toBe(1);
  });

  it("runSessionStart default verifyTools and triage integration", () => {
    const { root, head } = initRepo();
    const result = runSessionStart(root, {
      now: new Date("2026-06-09T01:00:00Z"),
      newSessionId: () => "default-path-id",
      runGit: (_r, args) => {
        if (args[0] === "rev-parse" && args[2] === "HEAD") {
          return { code: 0, stdout: head, stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { code: 0, stdout: resolve(root), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      writeHistory: false,
    });
    expect(String(result.payload.state_path)).toContain("ritual-state.json");
  });

  it("verify gated runner failure still completes tier check", () => {
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
      }),
    );
    const result = verifySessionRitual(root, {
      bypass: false,
      tier: "gated",
      now,
      runGit: (_r, a) =>
        a[2] === "HEAD"
          ? { code: 0, stdout: head, stderr: "" }
          : { code: 0, stdout: resolve(root), stderr: "" },
      runner: (cmd) => ({
        code: 1,
        stdout: "",
        stderr: `${cmd[0] ?? "step"} failed`,
      }),
    });
    expect(result.code).toBe(1);
  });
});
