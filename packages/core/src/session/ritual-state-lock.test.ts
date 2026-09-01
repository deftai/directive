import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NESTED_HOOK_TIMEOUT_SECONDS } from "../init-deposit/agent-hooks.js";
import { DEFAULT_ACQUISITION_BUDGET_MS, withAppendLock } from "../slice/lock.js";
import {
  mergeSameOwnerRitualPayload,
  newRitualStatePayload,
  RITUAL_LOCK_BUDGET_MS,
  readRitualState,
  recordRitualStep,
  ritualStatePath,
  ritualStep,
  writeRitualState,
  writeRitualStateIfStillOwned,
} from "./ritual-sentinel.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "ritual-lock-"));
  temps.push(root);
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
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

function plant(root: string, head: string, sessionId: string, startedAt: Date) {
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId,
      gitHead: head,
      worktreePath: resolve(root),
      startedAt,
      quickSteps: { alignment: ritualStep({ ok: true, ts: startedAt }) },
    }),
  );
}

describe("ritual-state lock (#3872)", () => {
  it("keeps the ritual acquisition budget inside the nested hook timeout", () => {
    expect(RITUAL_LOCK_BUDGET_MS).toBeLessThan(NESTED_HOOK_TIMEOUT_SECONDS * 1000);
    expect(RITUAL_LOCK_BUDGET_MS).toBeLessThan(DEFAULT_ACQUISITION_BUDGET_MS);
  });

  it("refuses a rival owner write (one loses cleanly)", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-09-01T00:00:00Z");
    plant(root, head, "owner", started);
    const stale = newRitualStatePayload({
      sessionId: "owner",
      gitHead: head,
      worktreePath: resolve(root),
      startedAt: started,
      gatedSteps: { agent_hooks: ritualStep({ ok: true, ts: started, message: "owner-step" }) },
    });
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "rival",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: new Date("2026-09-01T00:01:00Z"),
      }),
    );
    const refusal = writeRitualStateIfStillOwned(root, stale, {
      sessionId: "owner",
      startedAt: started,
    });
    expect(refusal).toContain("re-armed by rival");
    expect(readRitualState(root)[0]?.sessionId).toBe("rival");
  });

  it("merges gated_steps for same-owner co-member writes instead of republishing", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-09-01T00:00:00Z");
    plant(root, head, "owner", started);
    const expected = { sessionId: "owner", startedAt: started };
    const first = writeRitualStateIfStillOwned(
      root,
      {
        ...newRitualStatePayload({
          sessionId: "owner",
          gitHead: head,
          worktreePath: resolve(root),
          startedAt: started,
          gatedSteps: { agent_hooks: ritualStep({ ok: true, ts: started, message: "hooks" }) },
        }),
      },
      expected,
    );
    expect(first).toBeNull();
    const staleSnapshot = newRitualStatePayload({
      sessionId: "owner",
      gitHead: head,
      worktreePath: resolve(root),
      startedAt: started,
      gatedSteps: { cache_fresh: ritualStep({ ok: true, ts: started, message: "cache" }) },
    });
    const second = writeRitualStateIfStillOwned(root, staleSnapshot, expected);
    expect(second).toBeNull();
    const [state] = readRitualState(root);
    expect(state?.gatedSteps.agent_hooks?.message).toBe("hooks");
    expect(state?.gatedSteps.cache_fresh?.message).toBe("cache");
  });

  it("reclaims a dead ritual lock holder inside the ritual budget", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-09-01T00:00:00Z");
    plant(root, head, "owner", started);
    const lockPath = `${ritualStatePath(root)}.lock`;
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(lockPath, "2147483646\ndead-token\n1\n", "utf8");
    let now = 0;
    const refusal = writeRitualStateIfStillOwned(
      root,
      {
        ...newRitualStatePayload({
          sessionId: "owner",
          gitHead: head,
          worktreePath: resolve(root),
          startedAt: started,
          gatedSteps: { doctor: ritualStep({ ok: true, ts: started, message: "ok" }) },
        }),
      },
      { sessionId: "owner", startedAt: started },
      {
        now: () => now,
        sleepMs: (ms) => {
          now += ms;
        },
        acquisitionBudgetMs: RITUAL_LOCK_BUDGET_MS,
      },
    );
    expect(refusal).toBeNull();
    expect(now).toBeLessThan(RITUAL_LOCK_BUDGET_MS);
    expect(readRitualState(root)[0]?.gatedSteps.doctor?.message).toBe("ok");
  });

  it("recordRitualStep compares the owner it just read under the lock", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-09-01T00:00:00Z");
    plant(root, head, "owner", started);
    recordRitualStep(root, {
      tier: "gated",
      stepName: "doctor",
      step: ritualStep({ ok: true, ts: started, message: "recorded" }),
    });
    expect(readRitualState(root)[0]?.gatedSteps.doctor?.message).toBe("recorded");
  });

  it("mergeSameOwnerRitualPayload preserves disk steps the incoming snapshot omitted", () => {
    const merged = mergeSameOwnerRitualPayload(
      {
        session_id: "owner",
        gated_steps: { agent_hooks: { ok: true, ts: "2026-09-01T00:00:00Z", message: "a" } },
      },
      {
        session_id: "owner",
        gated_steps: { cache_fresh: { ok: true, ts: "2026-09-01T00:00:01Z", message: "b" } },
      },
    );
    const gated = merged.gated_steps as Record<string, { message: string }>;
    expect(gated.agent_hooks.message).toBe("a");
    expect(gated.cache_fresh.message).toBe("b");
  });
});

describe("withAppendLock budget (#3872)", () => {
  it("times out at the injected acquisition budget, not the 30s default", () => {
    const path = join(tmpdir(), `deft-lock-budget-${Date.now()}.jsonl`);
    writeFileSync(`${path}.lock`, `${process.pid}\nlive\n${Date.now()}\n`);
    let now = 0;
    expect(() =>
      withAppendLock(path, () => undefined, {
        acquisitionBudgetMs: 50,
        now: () => now,
        sleepMs: (ms) => {
          now += ms;
        },
      }),
    ).toThrow(/timed out acquiring lock/);
    expect(now).toBeGreaterThanOrEqual(50);
    expect(now).toBeLessThan(DEFAULT_ACQUISITION_BUDGET_MS);
  });
});
