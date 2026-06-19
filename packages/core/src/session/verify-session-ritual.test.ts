import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emitVerifyJson,
  type GitRunner,
  newRitualStatePayload,
  ritualStep,
  verifySessionRitual,
  writeRitualState,
} from "./index.js";
import { defaultBranchSync, parseDeferrals, runSessionStart } from "./session-start.js";

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-verify-"));
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
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("verify session ritual", () => {
  it("missing state fails closed", () => {
    const { root, head } = initRepo();
    const result = verifySessionRitual(root, {
      runGit: fakeGit(head, resolve(root)),
      bypass: false,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("deft session:start");
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts fresh quick state", () => {
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
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(emitVerifyJson(result)).ready).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("bypass returns success with would_fail_code", () => {
    const { root, head } = initRepo();
    const result = verifySessionRitual(root, {
      bypass: true,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(result.wouldFailCode).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("session start helpers", () => {
  it("parseDeferrals validates input", () => {
    const bad = parseDeferrals(["nope"]);
    expect(bad.errors.length).toBeGreaterThan(0);
    const ok = parseDeferrals(["alignment=later"]);
    expect(ok.deferrals.alignment).toBe("later");
  });

  it("runSessionStart records state with fakes", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    const result = runSessionStart(root, {
      now,
      newSessionId: () => "fixed-id",
      runGit: fakeGit(head, resolve(root)),
      verifyTools: (output) => {
        output("[deft tools] Required tools are available.");
        return { exitCode: 0 };
      },
      runTriageWelcome: (_r, opts) => {
        opts.output("[triage] ok");
        return { exitCode: 0 };
      },
      writeHistory: false,
    });
    expect(result.code).toBe(0);
    expect(result.payload.ready).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("defaultBranchSync handles missing upstream", () => {
    const { root } = initRepo();
    const sync = defaultBranchSync(root, () => ({
      code: 1,
      stdout: "",
      stderr: "",
    }));
    expect(sync.warning).toContain("default branch");
    rmSync(root, { recursive: true, force: true });
  });
});
