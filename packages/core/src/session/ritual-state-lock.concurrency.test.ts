import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newRitualStatePayload,
  readRitualState,
  ritualStatePath,
  ritualStep,
  writeRitualState,
  writeRitualStateIfStillOwned,
} from "./ritual-sentinel.js";

/**
 * #3872 -- co-member writers serialise behind the occupancy sidecar lock so a
 * stale snapshot cannot drop another member's gated_steps. Rival owners lose.
 */
const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "ritual-lock-conc-"));
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

describe("ritual-state lock concurrency (#3872)", () => {
  it("two same-owner writers compose without losing an update", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-09-01T00:00:00Z");
    const expected = { sessionId: "owner", startedAt: started };
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "owner",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: started,
      }),
    );
    expect(
      writeRitualStateIfStillOwned(
        root,
        newRitualStatePayload({
          sessionId: "owner",
          gitHead: head,
          worktreePath: resolve(root),
          startedAt: started,
          gatedSteps: { agent_hooks: ritualStep({ ok: true, ts: started, message: "a" }) },
        }),
        expected,
      ),
    ).toBeNull();
    expect(
      writeRitualStateIfStillOwned(
        root,
        newRitualStatePayload({
          sessionId: "owner",
          gitHead: head,
          worktreePath: resolve(root),
          startedAt: started,
          gatedSteps: { cache_fresh: ritualStep({ ok: true, ts: started, message: "b" }) },
        }),
        expected,
      ),
    ).toBeNull();
    const [state] = readRitualState(root);
    expect(state?.gatedSteps.agent_hooks?.message).toBe("a");
    expect(state?.gatedSteps.cache_fresh?.message).toBe("b");
    expect(existsSync(`${ritualStatePath(root)}.lock`)).toBe(false);
  });

  it("a serialised second mutation observes the first's on-disk gated_steps", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-09-01T00:00:00Z");
    const expected = { sessionId: "owner", startedAt: started };
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "owner",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: started,
        gatedSteps: { agent_hooks: ritualStep({ ok: true, ts: started, message: "first" }) },
      }),
    );
    writeRitualStateIfStillOwned(
      root,
      newRitualStatePayload({
        sessionId: "owner",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: started,
        gatedSteps: { doctor: ritualStep({ ok: true, ts: started, message: "second" }) },
      }),
      expected,
    );
    const [state] = readRitualState(root);
    expect(state?.gatedSteps.agent_hooks?.message).toBe("first");
    expect(state?.gatedSteps.doctor?.message).toBe("second");
  });

  it("two writers at the same record: the rival owner loses cleanly", () => {
    const { root, head } = initRepo();
    const started = new Date("2026-09-01T00:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "owner",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: started,
      }),
    );
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "rival",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: new Date("2026-09-01T00:01:00Z"),
      }),
    );
    const refusal = writeRitualStateIfStillOwned(
      root,
      newRitualStatePayload({
        sessionId: "owner",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: started,
        gatedSteps: { agent_hooks: ritualStep({ ok: true, ts: started }) },
      }),
      { sessionId: "owner", startedAt: started },
    );
    expect(refusal).toContain("re-armed by rival");
    expect(readRitualState(root)[0]?.sessionId).toBe("rival");
  });
});
