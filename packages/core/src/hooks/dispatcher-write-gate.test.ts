import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../session/git.js";
import {
  DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  newRitualStatePayload,
  ritualStep,
  writeRitualState,
} from "../session/index.js";
import { decideHook, type HookPolicySeams } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "write-gate-dispatch-"));
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

function seedCleanRearmRitual(root: string, now: Date): void {
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
        doctor: ritualStep({ ok: true, ts: now }),
        cache_fresh: ritualStep({ ok: true, ts: now }),
      },
    }),
    drift_probe: DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION,
  });
}

describe("write-gate dispatch surface (#3738)", () => {
  it("renders allow on the clean-cache re-arm path without forge I/O", () => {
    const root = tempRoot();
    const now = new Date();
    seedCleanRearmRitual(root, now);
    const commands: string[][] = [];

    const seams: HookPolicySeams = {
      inspectScope: () => ({
        ready: true,
        path: join(root, "xbrief", "active", "story.xbrief.json"),
        message: "OK active scope",
      }),
      ritualRunGit: fakeGit(root),
      detectWorkSelection: () => ({ inPlay: true, kind: "active-story" }),
      ritualRunner: (command) => {
        commands.push([...command]);
        if (command[0] === "verify:cache-fresh" || command[0] === "doctor") {
          throw new Error(`write path must not execute ${command[0]}`);
        }
        return { code: 0, stdout: "hooks ready", stderr: "" };
      },
    };

    const decision = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: { toolName: "Write", file_path: join(root, "src", "app.ts") },
      },
      seams,
    );

    expect(decision).toMatchObject({ verdict: "allow", code: "write-ready" });
    expect(commands).toEqual([["verify:hooks-installed", "--scope=agent", "--live"]]);
    expect(commands.some((command) => command[0] === "verify:cache-fresh")).toBe(false);
  });
});
