import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { SKIP_NOTICE } from "../ts-check-lane/run-lane.js";
import {
  appendBoundedCapture,
  bindWorkerFailureToWaiter,
  boundedCaptureText,
  collectTimedChildResult,
  confirmChildHandleForKill,
  createBoundedCapture,
  isPidRunning,
  killDescendantTree,
  killTreeAndProveEmpty,
  listDescendantPids,
  mintSuiteRunId,
  ownerPidFromTeeName,
  pruneSuiteTees,
  runDeadlineCleanup,
  SUITE_TEE_DIR_REL,
  type SupervisedGateResult,
  sanitizeSessionDirName,
  scanDescendantPids,
  selectFailureSignalLines,
  settleTreeCleanup,
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
  // Prune requires age > SUITE_TEE_HANG_CEILING_MS (= RELEASE_CHECK_TIMEOUT_MS, 60m under #5091).
  const agedBeyondHangCeilingMs = 70 * 60 * 1000;

  it("spares an aged tee whose owning pid is live", () => {
    const root = freshRoot();
    const runId = `${process.pid}-abcd1234`;
    const rel = suiteTeeRelativePath("live-sess", runId);
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "live\n", "utf8");
    touchTeeMtime(abs, Date.now() - agedBeyondHangCeilingMs);
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
    touchTeeMtime(abs, Date.now() - agedBeyondHangCeilingMs);
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

  it("snapshots descendants before the first kill so reparented children stay in the set", () => {
    const order: string[] = [];
    const alive = new Set([2]);
    const result = killTreeAndProveEmpty(1, {
      killTree: (pid) => {
        order.push(`kill:${pid}`);
        alive.delete(pid);
      },
      listDescendants: () => {
        order.push("list");
        return [2];
      },
      isPidAlive: (pid) => alive.has(pid),
    });
    expect(order[0]).toBe("list");
    expect(order[1]).toBe("kill:1");
    expect(order).toEqual(["list", "kill:1", "kill:2"]);
    expect(result.remaining).toEqual([]);
  });

  it("retries a failed root kill", () => {
    const killed: number[] = [];
    let rootAttempts = 0;
    const alive = new Set([1, 2]);
    const result = killTreeAndProveEmpty(1, {
      killTree: (pid) => {
        killed.push(pid);
        if (pid === 1) {
          rootAttempts += 1;
          if (rootAttempts >= 2) alive.delete(1);
          return;
        }
        alive.delete(pid);
      },
      listDescendants: () => [2],
      isPidAlive: (pid) => alive.has(pid),
    });
    expect(killed.filter((id) => id === 1).length).toBeGreaterThanOrEqual(2);
    expect(result.remaining).toEqual([]);
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
    expect(scanDescendantPids(1, "linux", () => [2, 3], -1)).toEqual({ pids: [], complete: false });
  });
});

describe("descendant scan completeness (#6904)", () => {
  it("is complete after a full walk", () => {
    const scan = scanDescendantPids(1, "linux", (pid) => (pid === 1 ? [2] : []));
    expect(scan).toEqual({ pids: [2], complete: true });
  });

  it("is incomplete when a listing fails", () => {
    const scan = scanDescendantPids(1, "linux", (pid) => (pid === 1 ? [2] : null));
    expect(scan).toEqual({ pids: [2], complete: false });
    expect(listDescendantPids(1, "linux", () => null)).toEqual([]);
  });

  it("killTreeAndProveEmpty reports an incomplete scan for a failed listing and an expired budget", () => {
    const noop = () => undefined;
    const dead = () => false;
    expect(
      killTreeAndProveEmpty(1, { killTree: noop, listDirect: () => null, isPidAlive: dead }),
    ).toEqual({ remaining: [], scanComplete: false });
    expect(
      killTreeAndProveEmpty(1, {
        killTree: noop,
        listDirect: () => [],
        scanBudgetMs: -1,
        isPidAlive: dead,
      }),
    ).toEqual({ remaining: [], scanComplete: false });
    expect(
      killTreeAndProveEmpty(1, { killTree: noop, listDirect: () => [], isPidAlive: dead }),
    ).toEqual({ remaining: [], scanComplete: true });
  });
});

describe("tree cleanup outcome (#6904)", () => {
  it("drops the exited root and re-checks the other PIDs after the exit event", () => {
    const base = { unverified: false, rootPid: 10, scanComplete: true };
    expect(settleTreeCleanup({ ...base, remaining: [10] }, () => true)).toEqual({
      treeCleanup: "stopped",
    });
    expect(settleTreeCleanup({ ...base, remaining: [10, 11] }, () => false)).toEqual({
      treeCleanup: "stopped",
    });
    expect(settleTreeCleanup({ ...base, remaining: [10, 11] }, (pid) => pid === 11)).toEqual({
      treeCleanup: "survivors",
      survivorPids: [11],
    });
    expect(settleTreeCleanup({ ...base, scanComplete: false, remaining: [] }, () => false)).toEqual(
      { treeCleanup: "unverified" },
    );
    expect(
      settleTreeCleanup({ unverified: true, remaining: [], scanComplete: false }, () => true),
    ).toEqual({ treeCleanup: "unverified" });
  });

  it("kills nothing and is unverified when the child already exited at the deadline", () => {
    let proofCalls = 0;
    const cleanup = runDeadlineCleanup(
      { exitCode: 0, pid: 4242 },
      { command: "x", args: [], cwd: "." },
      "linux",
      () => {
        proofCalls += 1;
        return { remaining: [], scanComplete: true };
      },
    );
    expect(proofCalls).toBe(0);
    expect(settleTreeCleanup(cleanup, () => false)).toEqual({ treeCleanup: "unverified" });
  });

  it("treats a Linux zombie as not running", () => {
    const stat = (state: string) => () => `${process.pid} (node (x)) ${state} 1 2 3`;
    expect(isPidRunning(process.pid, "linux", stat("Z"))).toBe(false);
    expect(isPidRunning(process.pid, "linux", stat("X"))).toBe(false);
    expect(isPidRunning(process.pid, "linux", stat("S"))).toBe(true);
    expect(isPidRunning(process.pid, "win32")).toBe(true);
    expect(isPidRunning(-1, "linux")).toBe(false);
  });
});

describe("collectTimedChildResult (#6904)", () => {
  const ok: SupervisedGateResult = {
    exitCode: 0,
    timedOut: false,
    signal: null,
    stdout: "done",
    stderr: "",
    teePath: "",
    teeRel: "",
  };

  function drain(
    messages: readonly unknown[],
    wait: { backstopExpired: boolean; failure?: string; timeoutArmed?: boolean },
  ): SupervisedGateResult {
    const channel = new MessageChannel();
    try {
      for (const message of messages) channel.port2.postMessage(message);
      return collectTimedChildResult(channel.port1, { timeoutArmed: true, ...wait });
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }

  it("takes the result message even when a spawned message came first", () => {
    const result = drain(
      [
        { kind: "spawned", pid: 7 },
        { kind: "result", result: ok },
      ],
      { backstopExpired: false },
    );
    expect(result).toEqual(ok);
  });

  it("takes a result message that arrives alone", () => {
    expect(drain([{ kind: "result", result: ok }], { backstopExpired: false })).toEqual(ok);
  });

  it("is unverified with the reported PID when the backstop expires", () => {
    const result = drain([{ kind: "spawned", pid: 7 }], { backstopExpired: true });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.treeCleanup).toBe("unverified");
    expect(result.lastReportedPid).toBe(7);
  });

  it("keeps the last PID when two spawned messages come and no result", () => {
    const result = drain(
      [
        { kind: "spawned", pid: 7 },
        { kind: "spawned", pid: 8 },
      ],
      { backstopExpired: false, failure: "worker exited" },
    );
    expect(result.treeCleanup).toBe("unverified");
    expect(result.lastReportedPid).toBe(8);
    expect(result.spawnError).toBe("worker exited");
  });

  it("is unverified with no PID when the worker failed before any message", () => {
    const result = drain([], { backstopExpired: false, failure: "load failed" });
    expect(result.exitCode).toBe(1);
    expect(result.treeCleanup).toBe("unverified");
    expect(result.lastReportedPid).toBeUndefined();
  });

  it("adds no cleanup field when no timeout was armed", () => {
    const result = drain([], { backstopExpired: false, timeoutArmed: false });
    expect(result.treeCleanup).toBeUndefined();
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
    expect(result.treeCleanup).toBe("unverified");
  }, 15_000);

  it("reports survivors when a known PID stays alive after the kill passes (#6904)", async () => {
    const root = freshRoot();
    const sacrificial = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const target = sacrificial.pid as number;
    try {
      const result = await superviseTimedChild({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30_000)"],
        cwd: root,
        timeoutMs: 200,
        listDescendants: () => [target],
        isPidAlive: (pid) => pid === target,
      });
      expect(result.timedOut).toBe(true);
      expect(result.treeCleanup).toBe("survivors");
      expect(result.survivorPids).toEqual([target]);
    } finally {
      sacrificial.kill("SIGKILL");
    }
  }, 15_000);

  it("is unverified for a failed listing and for an expired scan budget (#6904)", async () => {
    const root = freshRoot();
    const variants = [{ listDirect: () => null }, { listDirect: () => [], scanBudgetMs: -1 }];
    for (const seams of variants) {
      const result = await superviseTimedChild({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30_000)"],
        cwd: root,
        timeoutMs: 200,
        ...seams,
      });
      expect(result.timedOut).toBe(true);
      expect(result.treeCleanup).toBe("unverified");
    }
  }, 15_000);

  it("posts the child PID through onSpawn (#6904)", async () => {
    const root = freshRoot();
    const pids: number[] = [];
    const result = await superviseTimedChild(
      { command: process.execPath, args: ["-e", "0"], cwd: root },
      { onSpawn: (pid) => pids.push(pid) },
    );
    expect(result.exitCode).toBe(0);
    expect(pids).toHaveLength(1);
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
    expect(result.treeCleanup).toBeUndefined();
  }, 15_000);
});
