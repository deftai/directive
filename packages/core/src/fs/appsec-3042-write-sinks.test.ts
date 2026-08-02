/**
 * Regression: AppSec #3042 — projectRoot containment for residual parent-as-root
 * and bare-write sinks (atomicWriteText, writeRitualState, writeSession).
 * Force-added xbrief/ or .deft/ directory symlinks must fail closed with no
 * outside overwrite.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteText } from "../cache/io.js";
import { writeSession } from "../orchestration/probe-session.js";
import { atomicWriteBrief } from "../scope/brief-io.js";
import { newRitualStatePayload, ritualStep, writeRitualState } from "../session/ritual-sentinel.js";
import { ContainedWriteError } from "./contained-write.js";
import { ProjectionContainmentError } from "./projection-containment.js";

const itSymlink = it.skipIf(process.platform === "win32");

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function isContainmentRefusal(err: unknown): boolean {
  return (
    err instanceof ProjectionContainmentError ||
    err instanceof ContainedWriteError ||
    (err instanceof Error &&
      (/projection write refused|contained write refused|symlink/i.test(err.message) ||
        /not nested under/i.test(err.message)))
  );
}

describe("AppSec write sinks projectRoot containment (#3042)", () => {
  itSymlink("atomicWriteText refuses an escaping xbrief/ directory symlink", () => {
    const root = temp("deft-3042-atomic-root-");
    const outsideDir = temp("deft-3042-atomic-escape-");
    writeFileSync(join(outsideDir, "poisoned.xbrief.json"), "KEEP\n", "utf8");
    symlinkSync(outsideDir, join(root, "xbrief"), "dir");

    const target = join(root, "xbrief", "active", "escape.xbrief.json");
    try {
      atomicWriteText(target, '{"pwn":true}\n', { projectRoot: root });
      expect.fail("expected containment refusal");
    } catch (err) {
      expect(isContainmentRefusal(err)).toBe(true);
    }

    expect(readFileSync(join(outsideDir, "poisoned.xbrief.json"), "utf8")).toBe("KEEP\n");
    expect(existsSync(join(outsideDir, "active"))).toBe(false);
  });

  itSymlink("atomicWriteBrief stay-path refuses an escaping xbrief/ directory symlink", () => {
    const root = temp("deft-3042-brief-root-");
    const outsideDir = temp("deft-3042-brief-escape-");
    writeFileSync(join(outsideDir, "poisoned.xbrief.json"), "KEEP\n", "utf8");
    symlinkSync(outsideDir, join(root, "xbrief"), "dir");

    const vbriefRoot = join(root, "xbrief");
    // lexical path under symlink; force-create would land outside without projectRoot.
    const target = join(vbriefRoot, "pending", "stay.xbrief.json");
    const brief = {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "pending", items: [] },
    };

    const result = atomicWriteBrief(target, brief, vbriefRoot, { projectRoot: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/refused|symlink|nested under|Failed to write/i);
    }
    expect(readFileSync(join(outsideDir, "poisoned.xbrief.json"), "utf8")).toBe("KEEP\n");
    expect(existsSync(join(outsideDir, "pending"))).toBe(false);
  });

  itSymlink("writeRitualState refuses an escaping .deft/ directory symlink", () => {
    const root = temp("deft-3042-ritual-root-");
    const outsideDir = temp("deft-3042-ritual-escape-");
    writeFileSync(join(outsideDir, "ritual-state.json"), "KEEP\n", "utf8");
    symlinkSync(outsideDir, join(root, ".deft"), "dir");

    const now = new Date("2026-08-02T00:00:00Z");
    try {
      writeRitualState(
        root,
        newRitualStatePayload({
          sessionId: "s-3042",
          gitHead: "deadbeef",
          worktreePath: root,
          startedAt: now,
          quickSteps: { alignment: ritualStep({ ok: true, ts: now }) },
        }),
      );
      expect.fail("expected containment refusal");
    } catch (err) {
      expect(isContainmentRefusal(err)).toBe(true);
    }

    expect(readFileSync(join(outsideDir, "ritual-state.json"), "utf8")).toBe("KEEP\n");
  });

  itSymlink("writeSession refuses an escaping .deft/ directory symlink", () => {
    const root = temp("deft-3042-probe-root-");
    const outsideDir = temp("deft-3042-probe-escape-");
    writeFileSync(join(outsideDir, "probe-session.json"), "KEEP\n", "utf8");
    symlinkSync(outsideDir, join(root, ".deft"), "dir");

    const session = {
      schema_version: 1,
      state: "interrogate" as const,
      target: "scope-a",
      current_branch: "main",
      resolved_decisions: [],
      started_at: new Date("2026-08-02T00:00:00Z"),
      completed_at: null,
    };

    try {
      writeSession(root, session);
      expect.fail("expected containment refusal");
    } catch (err) {
      expect(isContainmentRefusal(err)).toBe(true);
    }

    expect(readFileSync(join(outsideDir, "probe-session.json"), "utf8")).toBe("KEEP\n");
  });

  it("atomicWriteText with projectRoot writes inside a normal tree", () => {
    const root = temp("deft-3042-ok-root-");
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    const target = join(root, "xbrief", "pending", "ok.txt");
    atomicWriteText(target, "hello-3042\n", { projectRoot: root });
    expect(readFileSync(target, "utf8")).toBe("hello-3042\n");
  });
});
