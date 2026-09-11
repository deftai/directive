import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveCliCheckResult } from "./active-cli.js";
import type { GitRunner } from "./git.js";
import {
  emitVerifyJson,
  inspectSessionRitual,
  newRitualStatePayload,
  ritualStep,
  verifySessionRitual,
  writeRitualState,
} from "./index.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ritual-bound-session-"));
  temps.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  return root;
}

function fakeGit(root: string): GitRunner {
  return (_projectRoot, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: HEAD, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: resolve(root), stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unsupported git probe" };
  };
}

function ritualPayload(
  root: string,
  sessionId: string,
  now: Date,
  overrides: { worktreePath?: string } = {},
): Record<string, unknown> {
  return newRitualStatePayload({
    sessionId,
    gitHead: HEAD,
    worktreePath: overrides.worktreePath ?? resolve(root),
    startedAt: now,
    quickSteps: {
      alignment: ritualStep({ ok: true, ts: now }),
      branch_policy: ritualStep({ ok: true, ts: now }),
      triage_welcome: ritualStep({ ok: true, ts: now }),
      verify_tools: ritualStep({ ok: true, ts: now }),
    },
    gatedSteps: {
      agent_hooks: ritualStep({ ok: true, ts: now }),
      doctor: ritualStep({ ok: true, ts: now }),
      cache_fresh: ritualStep({ ok: true, ts: now }),
    },
  });
}

function okActiveCli(): ActiveCliCheckResult {
  return {
    ok: true,
    code: 0,
    active: null,
    candidates: [],
    targetVersion: null,
    message: "active CLI ok",
    lines: [],
  };
}

describe("verified ritual bound session identity (#3611)", () => {
  it("returns the owner from the exact successfully evaluated state", () => {
    const root = tempRoot();
    const now = new Date("2026-08-26T12:00:00Z");
    writeRitualState(root, ritualPayload(root, "owner-a", now));

    const result = verifySessionRitual(root, {
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(root),
    });

    expect(result.code).toBe(0);
    expect(result.boundSessionId).toBe("owner-a");
  });

  it("returns the owner on a stale verdict after worktree binding succeeds", () => {
    const root = tempRoot();
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
    const started = new Date("2026-08-26T06:00:00Z");
    const now = new Date("2026-08-26T12:00:00Z");
    writeRitualState(root, ritualPayload(root, "owner-not-ready", started));

    const result = verifySessionRitual(root, {
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(root),
    });

    expect(result.code).toBe(1);
    expect(result.message).toContain("stale");
    expect(result.boundSessionId).toBe("owner-not-ready");
  });

  it("does not return an owner before a valid current-worktree binding exists", () => {
    const root = tempRoot();
    const now = new Date("2026-08-26T12:00:00Z");

    const missing = verifySessionRitual(root, {
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(root),
    });
    expect(missing).not.toHaveProperty("boundSessionId");

    writeRitualState(
      root,
      ritualPayload(root, "foreign-owner", now, { worktreePath: resolve(root, "other") }),
    );
    const foreign = verifySessionRitual(root, {
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(root),
    });
    expect(foreign.code).toBe(1);
    expect(foreign).not.toHaveProperty("boundSessionId");
  });

  it("inspection carries the owner from the state it evaluated", () => {
    const root = tempRoot();
    const now = new Date("2026-08-26T12:00:00Z");
    writeRitualState(root, ritualPayload(root, "inspected-owner", now));

    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      runGit: fakeGit(root),
    });

    expect(result.code).toBe(0);
    expect(result.boundSessionId).toBe("inspected-owner");
  });

  it("keeps the evaluated owner when the state file changes after the final reload", () => {
    const root = tempRoot();
    const now = new Date("2026-08-26T12:00:00Z");
    writeRitualState(root, ritualPayload(root, "evaluated-owner", now));

    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(root),
      runner: () => ({ code: 0, stdout: "ok", stderr: "" }),
      checkActiveCli: () => {
        writeRitualState(root, ritualPayload(root, "later-owner", now));
        return okActiveCli();
      },
    });

    expect(result.code).toBe(0);
    expect(result.boundSessionId).toBe("evaluated-owner");
  });

  it("never exposes the internal owner in public verification JSON", () => {
    const root = tempRoot();
    const now = new Date("2026-08-26T12:00:00Z");
    writeRitualState(root, ritualPayload(root, "private-owner", now));
    const result = verifySessionRitual(root, {
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(root),
    });

    const emitted = emitVerifyJson(result);
    const payload = JSON.parse(emitted) as Record<string, unknown>;
    expect(result.boundSessionId).toBe("private-owner");
    expect(payload).not.toHaveProperty("boundSessionId");
    expect(payload).not.toHaveProperty("bound_session_id");
    expect(emitted).not.toContain("private-owner");
  });
});
