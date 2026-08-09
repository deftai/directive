import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  inspectSessionRitual,
  newRitualStatePayload,
  ritualStatePath,
  ritualStep,
  writeRitualState,
} from "./index.js";

it("inspects gated ritual state without auto-running or rewriting missing gated steps", () => {
  const root = mkdtempSync(join(tmpdir(), "session-inspect-"));
  try {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { status: "running", policy: { sessionRitualStalenessHours: 4 } } }),
      "utf8",
    );
    writeFileSync(join(root, "README.md"), "x\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const now = new Date("2026-07-14T12:00:00Z");
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
          verify_tools: ritualStep({ ok: true, ts: now }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: now }),
        },
      }),
    );
    const before = readFileSync(ritualStatePath(root), "utf8");

    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
    });

    expect(result.code).toBe(1);
    expect(result.message).toContain("gated step 'doctor' is missing");
    expect(readFileSync(ritualStatePath(root), "utf8")).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
