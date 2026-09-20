import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKIP_NOTICE } from "../ts-check-lane/run-lane.js";
import {
  appendBoundedCapture,
  bindWorkerFailureToWaiter,
  boundedCaptureText,
  confirmChildHandleForKill,
  createBoundedCapture,
  killDescendantTree,
  killTreeAndProveEmpty,
  listDescendantPids,
  mintSuiteRunId,
  ownerPidFromTeeName,
  pruneSuiteTees,
  SUITE_TEE_DIR_REL,
  sanitizeSessionDirName,
  selectFailureSignalLines,
  suiteActuallyRan,
  suiteTeeRelativePath,
  superviseChild,
  superviseTimedChild,
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

describe("bounded diagnostic capture", () => {
  it("keeps the tail when chunks exceed the byte cap", () => {
    const acc = createBoundedCapture();
    appendBoundedCapture(acc, Buffer.from("aaaa"), 6);
    appendBoundedCapture(acc, Buffer.from("bbbb"), 6);
    const text = boundedCaptureText(acc);
    expect(text.length).toBeLessThanOrEqual(8);
    expect(text.endsWith("bbbb")).toBe(true);
  });
});

describe("bindWorkerFailureToWaiter", () => {
  it("records a worker error and notifies the waiter", () => {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const record: { failure?: string } = {};
    const fake = new EventEmitter();
    bindWorkerFailureToWaiter(fake, signal, record);
    fake.emit("error", new Error("load failed"));
    expect(record.failure).toBe("load failed");
    expect(Atomics.load(signal, 0)).toBe(1);
  });

  it("records a non-zero exit when the worker dies before posting", () => {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const record: { failure?: string } = {};
    const fake = new EventEmitter();
    bindWorkerFailureToWaiter(fake, signal, record);
    fake.emit("exit", 1);
    expect(record.failure).toMatch(/exited before posting/);
    expect(Atomics.load(signal, 0)).toBe(1);
  });

  it("ignores a zero exit after a successful post", () => {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const record: { failure?: string } = {};
    const fake = new EventEmitter();
    bindWorkerFailureToWaiter(fake, signal, record);
    fake.emit("exit", 0);
    expect(record.failure).toBeUndefined();
    expect(Atomics.load(signal, 0)).toBe(0);
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

describe("confirmChildHandleForKill (#4801)", () => {
  it("returns null when the child already exited", () => {
    expect(confirmChildHandleForKill({ exitCode: 0, pid: 12 })).toBeNull();
  });

  it("returns the pid when the handle is still live", () => {
    expect(confirmChildHandleForKill({ exitCode: null, pid: 12 })).toBe(12);
  });

  it("returns null when pid is missing", () => {
    expect(confirmChildHandleForKill({ exitCode: null })).toBeNull();
  });
});

describe("killTreeAndProveEmpty (#4801)", () => {
  it("kills the root and reports an empty tree", () => {
    const killed: number[] = [];
    const alive = new Set([1, 2, 3]);
    const result = killTreeAndProveEmpty(1, {
      killTree: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      listDescendants: () => [2, 3],
      isPidAlive: (pid) => alive.has(pid),
    });
    expect(killed[0]).toBe(1);
    expect(result.remaining).toEqual([]);
  });

  it("kills the root before enumerating descendants", () => {
    const order: string[] = [];
    killTreeAndProveEmpty(1, {
      killTree: (pid) => {
        order.push(`kill:${pid}`);
      },
      listDescendants: () => {
        order.push("list");
        return [];
      },
      isPidAlive: () => false,
    });
    expect(order[0]).toBe("kill:1");
    expect(order).toEqual(["kill:1", "list"]);
  });

  it("escalates leftover descendants with a second kill", () => {
    const killed: number[] = [];
    const alive = new Set([1, 2, 3]);
    const result = killTreeAndProveEmpty(1, {
      killTree: (pid) => {
        killed.push(pid);
        if (pid !== 1) alive.delete(pid);
        else alive.delete(1);
      },
      listDescendants: () => [2, 3],
      isPidAlive: (pid) => alive.has(pid),
    });
    expect(killed).toEqual([1, 2, 3]);
    expect(result.remaining).toEqual([]);
  });
});

describe("listDescendantPids (#4801)", () => {
  it("walks injected children without looping", () => {
    const ids = listDescendantPids(1, "linux", (pid) => {
      if (pid === 1) return [2];
      if (pid === 2) return [3];
      return [];
    });
    expect(ids).toEqual([2, 3]);
  });

  it("stops walking when the verification budget has already expired", () => {
    const ids = listDescendantPids(1, "linux", () => [2, 3], -1);
    expect(ids).toEqual([]);
  });
});

describe("superviseTimedChild (#4801)", () => {
  it("kills a hung child at timeoutMs, reports 124, and does not create a suite tee", async () => {
    const root = freshRoot();
    const result = await superviseTimedChild({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      cwd: root,
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.teeRel).toBe("");
    expect(result.teePath).toBe("");
  }, 15_000);

  it("reconfirms the child handle is live before taskkill", async () => {
    const root = freshRoot();
    const handles: Array<{ exitCode: number | null; pid: number }> = [];
    const result = await superviseTimedChild({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      cwd: root,
      timeoutMs: 200,
      killTree: (pid, handle) => {
        handles.push({ exitCode: handle.exitCode, pid });
        killDescendantTree(pid);
      },
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.exitCode).toBeNull();
  }, 15_000);

  it("does not arm a timeout when timeoutMs is omitted and leaves tee paths empty", async () => {
    const root = freshRoot();
    const result = await superviseTimedChild({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok\\n')"],
      cwd: root,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
    expect(result.teeRel).toBe("");
  }, 15_000);
});
