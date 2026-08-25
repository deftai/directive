import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "./git.js";
import {
  DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  verifySessionRitual,
  WRITE_GATED_EXECUTE_STEPS,
  WRITE_GATED_REQUIRED_STEPS,
  writeGateRitualOptions,
  writeRitualState,
} from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "write-gate-ritual-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  return root;
}

function fakeGit(root: string, head = HEAD): GitRunner {
  const worktree = resolve(root);
  return (_r, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

function seedRitual(
  root: string,
  now: Date,
  overrides: {
    cacheFreshOk?: boolean;
    doctorOk?: boolean;
    driftProbe?: string;
  } = {},
): void {
  writeRitualState(root, {
    ...newRitualStatePayload({
      sessionId: "s",
      gitHead: HEAD,
      worktreePath: resolve(root),
      startedAt: now,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: now }),
        branch_policy: ritualStep({ ok: true, ts: now }),
        triage_welcome: ritualStep({ ok: true, ts: now }),
        verify_tools: ritualStep({ ok: true, ts: now }),
      },
      gatedSteps: {
        agent_hooks: ritualStep({ ok: true, ts: now }),
        doctor: ritualStep({
          ok: overrides.doctorOk !== false,
          ts: now,
          message: overrides.doctorOk === false ? "doctor red" : "doctor ok",
        }),
        cache_fresh: ritualStep({
          ok: overrides.cacheFreshOk !== false,
          ts: now,
          message: overrides.cacheFreshOk === false ? "cache red" : "cache ok",
        }),
      },
    }),
    ...(overrides.driftProbe !== undefined ? { drift_probe: overrides.driftProbe } : {}),
  });
}

describe("write-gate ritual surface (#3738)", () => {
  it("splits required vs executable gated steps", () => {
    expect(WRITE_GATED_REQUIRED_STEPS).toEqual(["agent_hooks", "doctor"]);
    expect(WRITE_GATED_EXECUTE_STEPS).toEqual(["agent_hooks"]);
    expect(WRITE_GATED_REQUIRED_STEPS).not.toContain("cache_fresh");
    expect(WRITE_GATED_EXECUTE_STEPS).not.toContain("cache_fresh");
    expect(WRITE_GATED_EXECUTE_STEPS).not.toContain("doctor");
    const isolated = writeGateRitualOptions();
    expect(isolated.bypass).toBe(false);
    expect(isolated.envSkip).toBe("");
  });

  it("does not execute cache_fresh on the clean-cache re-arm path", () => {
    const root = tempRoot();
    const now = new Date("2026-08-25T12:00:00Z");
    seedRitual(root, now, { driftProbe: DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION });
    const commands: string[][] = [];
    let forgeIoCalls = 0;

    const result = verifySessionRitual(
      root,
      writeGateRitualOptions({
        now,
        runGit: fakeGit(root),
        detectWorkSelection: () => {
          forgeIoCalls += 1;
          return { inPlay: true, kind: "active-story" };
        },
        runner: (command) => {
          commands.push([...command]);
          if (command[0] === "verify:cache-fresh" || command[0] === "doctor") {
            throw new Error(`write gate must not execute ${command[0]}`);
          }
          return { code: 0, stdout: "hooks ready", stderr: "" };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(commands).toEqual([["verify:hooks-installed", "--scope=agent", "--live"]]);
    expect(commands.some((command) => command[0] === "verify:cache-fresh")).toBe(false);
    expect(readRitualState(root)[0]?.raw.drift_probe).toBe(DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION);
    expect(forgeIoCalls).toBe(0);
  });

  it("does not deny a write when recorded cache_fresh is red", () => {
    const root = tempRoot();
    const now = new Date("2026-08-25T12:00:00Z");
    seedRitual(root, now, { cacheFreshOk: false });
    const commands: string[][] = [];

    const result = verifySessionRitual(
      root,
      writeGateRitualOptions({
        now,
        runGit: fakeGit(root),
        runner: (command) => {
          commands.push([...command]);
          return { code: 0, stdout: "hooks ready", stderr: "" };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(commands).toEqual([["verify:hooks-installed", "--scope=agent", "--live"]]);
    expect(readRitualState(root)[0]?.gatedSteps.cache_fresh?.ok).toBe(false);
  });

  it("still denies when recorded doctor is red without executing doctor", () => {
    const root = tempRoot();
    const now = new Date("2026-08-25T12:00:00Z");
    seedRitual(root, now, { doctorOk: false });
    const commands: string[][] = [];

    const result = verifySessionRitual(
      root,
      writeGateRitualOptions({
        now,
        runGit: fakeGit(root),
        runner: (command) => {
          commands.push([...command]);
          return { code: 0, stdout: "hooks ready", stderr: "" };
        },
      }),
    );

    expect(result.code).toBe(1);
    expect(result.message).toContain("doctor");
    expect(commands).toEqual([["verify:hooks-installed", "--scope=agent", "--live"]]);
    expect(commands.some((command) => command[0] === "doctor")).toBe(false);
  });

  it("fails when agent_hooks is not executed and the runner reports not ready", () => {
    const root = tempRoot();
    const now = new Date("2026-08-25T12:00:00Z");
    seedRitual(root, now);
    const commands: string[][] = [];

    const result = verifySessionRitual(
      root,
      writeGateRitualOptions({
        now,
        runGit: fakeGit(root),
        runner: (command) => {
          commands.push([...command]);
          return { code: 1, stdout: "", stderr: "hooks non-functional" };
        },
      }),
    );

    expect(result.code).toBe(1);
    expect(result.message).toContain("agent_hooks");
    expect(commands).toHaveLength(1);
  });

  it("full gated verify still re-arms cache_fresh when work selection appears", () => {
    const root = tempRoot();
    const now = new Date("2026-08-25T12:00:00Z");
    seedRitual(root, now, { driftProbe: DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION });
    const commands: string[][] = [];

    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(root),
      detectWorkSelection: () => ({ inPlay: true, kind: "active-story" }),
      runner: (command) => {
        commands.push([...command]);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(result.code).toBe(0);
    expect(commands.filter((command) => command[0] === "verify:cache-fresh")).toEqual([
      ["verify:cache-fresh", "--work-selection"],
    ]);
  });
});
