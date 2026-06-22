import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitRunner } from "./git.js";
import { defaultGitRunner } from "./git.js";
import {
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  verifySessionRitual,
  writeRitualState,
} from "./index.js";
import { callMain, defaultRitualRunner, runCacheFreshMain } from "./ritual-entrypoint.js";

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-default-runner-"));
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

function repoGitRunner(root: string): GitRunner {
  return (projectRoot, args) => defaultGitRunner(projectRoot ?? root, args);
}

describe("defaultRitualRunner", () => {
  it("runs cache-fresh with allow-missing-bootstrap on a fresh repo", () => {
    const { root } = initRepo();
    const result = defaultRitualRunner(["verify:cache-fresh"], root);
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/cache-fresh/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unknown gated commands", () => {
    const result = defaultRitualRunner(["future:gated"], "/tmp");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown session ritual command: future:gated");
  });

  it("captures stdout and stderr from entrypoints", () => {
    const result = callMain(
      (argv) => {
        process.stdout.write(`echo ${argv.join(" ")}\n`);
        process.stderr.write("warn\n");
        return 0;
      },
      ["--flag"],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("echo --flag");
    expect(result.stderr).toContain("warn");
  });

  it("maps thrown errors to exit code 2", () => {
    const result = callMain(() => {
      throw new Error("boom");
    }, []);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Error: boom");
  });
});

describe("verifySessionRitual gated tier via defaultRitualRunner", () => {
  it("records cache_fresh via defaultRitualRunner without an injected runner", () => {
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
          doctor: ritualStep({ ok: true, ts: now, message: "seeded for test" }),
        },
      }),
    );

    const result = verifySessionRitual(root, {
      tier: "gated",
      now,
      bypass: false,
      envSkip: "",
      runGit: repoGitRunner(root),
    });
    expect(result.code).toBe(0);
    const [state] = readRitualState(root);
    expect(state).not.toBeNull();
    expect(state?.gatedSteps.doctor?.ok).toBe(true);
    expect(state?.gatedSteps.cache_fresh?.ok).toBe(true);
    expect(state?.gatedSteps.cache_fresh?.command).toEqual(["verify:cache-fresh"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("defaultRitualRunner invokes doctor on a real repo", () => {
    const { root, head } = initRepo();
    const headResult = defaultGitRunner(root, ["rev-parse", "--verify", "HEAD"]);
    expect(headResult.code).toBe(0);
    expect(headResult.stdout).toBe(head);
    const doctor = defaultRitualRunner(["doctor"], root);
    expect(doctor.code).toBeGreaterThanOrEqual(0);
    expect(`${doctor.stdout}${doctor.stderr}`).toMatch(/doctor|Deft|agents-md/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("runCacheFreshMain honours allow-missing-bootstrap", () => {
    const { root } = initRepo();
    const code = runCacheFreshMain(["--allow-missing-bootstrap", "--project-root", root]);
    expect(code).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
