import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decideHook } from "../hooks/dispatcher.js";
import {
  inspectSessionRitual,
  markRitualStaleAfterCompact,
  newRitualStatePayload,
  ritualStep,
  writeRitualState,
} from "./index.js";

const EMPTY_STDERR = "";

function fakeGit(head: string, worktree: string) {
  return (_r: string, args: readonly string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: EMPTY_STDERR };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: EMPTY_STDERR };
    }
    return { code: 0, stdout: "", stderr: EMPTY_STDERR };
  };
}

function runGit(root: string, args: readonly string[]): string {
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
    throw new Error((result.stderr ?? result.stdout ?? "git failed").trim());
  }
  return (result.stdout ?? "").trim();
}

function freshRitualRoot(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "compact-ritual-"));
  const started = new Date("2026-07-20T12:00:00Z");
  mkdirSync(join(root, ".deft"), { recursive: true });
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { policy: { sessionRitualStalenessHours: 4 } },
    }),
    "utf8",
  );
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "t@t.local"]);
  runGit(root, ["config", "user.name", "T"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  const head = runGit(root, ["rev-parse", "HEAD"]);
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId: "session-1",
      gitHead: head,
      worktreePath: resolve(root),
      startedAt: started,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: started }),
        branch_policy: ritualStep({ ok: true, ts: started }),
        triage_welcome: ritualStep({ ok: true, ts: started }),
      },
      gatedSteps: {
        doctor: ritualStep({ ok: true, ts: started }),
        cache_fresh: ritualStep({ ok: true, ts: started }),
      },
    }),
  );
  return { root, head };
}

describe("markRitualStaleAfterCompact (#2113)", () => {
  it("marks an existing ritual stale and leaves read-only inspection unchanged", () => {
    const { root, head } = freshRitualRoot();
    const now = new Date("2026-07-20T13:00:00Z");
    const fresh = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(fresh.code).toBe(0);

    const result = markRitualStaleAfterCompact(root, { now });
    expect(result.changed).toBe(true);
    expect(result.message).toContain("session:start --rearm");
    expect(result.message).toContain("re-arm");

    const stale = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(stale.code).toBe(1);
    expect(stale.message).toContain("stale");
    expect(stale.recoveryTier).toBe("rearm");
    expect(stale.message).toContain("session:start --rearm");

    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op when ritual state is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "compact-ritual-empty-"));
    const result = markRitualStaleAfterCompact(root);
    expect(result.changed).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("session.compact hook dispatch (#2113)", () => {
  it("invalidates ritual then denies subsequent direct writes until refresh", () => {
    const { root, head } = freshRitualRoot();
    const runGit = fakeGit(head, resolve(root));

    const compact = decideHook({
      host: "cursor",
      event: "session.compact",
      projectRoot: root,
      payload: {},
    });
    expect(compact).toMatchObject({ verdict: "allow", code: "session-compact-rearm" });

    const denied = decideHook({
      host: "cursor",
      event: "tool.before",
      projectRoot: root,
      payload: { tool_name: "Write", workspace_roots: [root] },
    });
    expect(denied).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });

    const refreshedStarted = new Date("2026-07-20T13:05:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "session-2",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: refreshedStarted,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: refreshedStarted }),
          branch_policy: ritualStep({ ok: true, ts: refreshedStarted }),
          triage_welcome: ritualStep({ ok: true, ts: refreshedStarted }),
        },
        gatedSteps: {
          doctor: ritualStep({ ok: true, ts: refreshedStarted }),
          cache_fresh: ritualStep({ ok: true, ts: refreshedStarted }),
        },
      }),
    );

    const ready = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now: refreshedStarted,
      runGit,
    });
    expect(ready.code).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });
});
