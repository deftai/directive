import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKIP_NOTICE } from "../ts-check-lane/run-lane.js";
import {
  killDescendantTree,
  mintSuiteRunId,
  ownerPidFromTeeName,
  pruneSuiteTees,
  SUITE_TEE_DIR_REL,
  sanitizeSessionDirName,
  selectFailureSignalLines,
  suiteActuallyRan,
  suiteTeeRelativePath,
  superviseChild,
  touchTeeMtime,
} from "./suite-gate-supervisor.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "suite-gate-"));
  temps.push(dir);
  mkdirSync(join(dir, ".deft", "check-tees"), { recursive: true });
  return dir;
}

describe("suite tee path", () => {
  it("rejects separators and traversal in sessionId", () => {
    expect(() => sanitizeSessionDirName("a/b")).toThrow(/separators or traversal/);
    expect(() => sanitizeSessionDirName("..\\x")).toThrow(/separators or traversal/);
  });

  it("uses sessionId as a directory prefix and a per-invocation filename", () => {
    const a = suiteTeeRelativePath("sess-1", mintSuiteRunId(11));
    const b = suiteTeeRelativePath("sess-1", mintSuiteRunId(12));
    expect(a).toMatch(new RegExp(`^${SUITE_TEE_DIR_REL}/sess-1/11-`));
    expect(a).not.toBe(b);
  });
});

describe("killDescendantTree", () => {
  it("uses win32 taskkill /T /F /PID", () => {
    const args: string[][] = [];
    killDescendantTree(4242, {
      platform: "win32",
      taskkill: (a) => {
        args.push([...a]);
      },
    });
    expect(args).toEqual([["/T", "/F", "/PID", "4242"]]);
  });

  it("uses POSIX process-group kill (-pid)", () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    killDescendantTree(99, {
      platform: "linux",
      posixKill: (pid, signal) => {
        calls.push({ pid, signal });
      },
    });
    expect(calls[0]).toEqual({ pid: -99, signal: "SIGKILL" });
  });
});

describe("selectFailureSignalLines / suiteActuallyRan", () => {
  it("prefers FAIL or Tests lines from the tee tail", () => {
    const text = ["banner", "check: starting", "FAIL packages/core/src/foo.test.ts", "done"].join(
      "\n",
    );
    expect(selectFailureSignalLines(text)).toContain("FAIL packages/core/src/foo.test.ts");
  });

  it("does not treat status run plus SKIP_NOTICE as executed", () => {
    expect(suiteActuallyRan({ status: "run", teeText: SKIP_NOTICE })).toBe(false);
    expect(suiteActuallyRan({ status: "run", teeText: "ok\n" })).toBe(true);
    expect(suiteActuallyRan({ status: "skipped", teeText: "ok\n" })).toBe(false);
  });
});

describe("pruneSuiteTees", () => {
  it("spares an aged tee whose owning pid is live", () => {
    const root = freshRoot();
    const runId = `${process.pid}-abcd1234`;
    const rel = suiteTeeRelativePath("live-sess", runId);
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "live\n", "utf8");
    touchTeeMtime(abs, Date.now() - 40 * 60 * 1000);
    const removed = pruneSuiteTees({
      projectRoot: root,
      nowMs: Date.now(),
      isPidAlive: (pid) => pid === process.pid,
    });
    expect(removed).toEqual([]);
    expect(ownerPidFromTeeName(`${runId}.log`)).toBe(process.pid);
  });

  it("removes an expired tee whose owner is dead", () => {
    const root = freshRoot();
    const runId = "1-deadbeef";
    const rel = suiteTeeRelativePath("dead-sess", runId);
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "stale\n", "utf8");
    touchTeeMtime(abs, Date.now() - 40 * 60 * 1000);
    const removed = pruneSuiteTees({
      projectRoot: root,
      nowMs: Date.now(),
      isPidAlive: () => false,
    });
    expect(removed.some((p) => p.endsWith(`${runId}.log`))).toBe(true);
  });
});

describe("superviseChild", () => {
  it("kills a hung child at timeoutMs and reports 124", async () => {
    const root = freshRoot();
    const result = await superviseChild({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      cwd: root,
      projectRoot: root,
      timeoutMs: 200,
      sessionId: "hang-sess",
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  }, 15_000);

  it("does not arm a timeout when timeoutMs is omitted", async () => {
    const root = freshRoot();
    const result = await superviseChild({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok\\n')"],
      cwd: root,
      projectRoot: root,
      sessionId: "no-timeout",
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  }, 15_000);

  it("creates two exclusive tees for two runs in one session", async () => {
    const root = freshRoot();
    const a = await superviseChild({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a\\n')"],
      cwd: root,
      projectRoot: root,
      sessionId: "same-sess",
    });
    const b = await superviseChild({
      command: process.execPath,
      args: ["-e", "process.stdout.write('b\\n')"],
      cwd: root,
      projectRoot: root,
      sessionId: "same-sess",
    });
    expect(a.teeRel).not.toBe(b.teeRel);
    expect(a.teeRel).toContain("same-sess");
    expect(b.teeRel).toContain("same-sess");
  }, 15_000);
});
