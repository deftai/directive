import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLock, withAppendLock } from "./lock.js";

function instantTimeoutDeps(): { now: () => number; sleepMs: () => void } {
  let now = 0;
  return {
    now: () => {
      now += 31_000;
      return now;
    },
    sleepMs: () => {
      /* no-op */
    },
  };
}

describe("lock branches", () => {
  it("times out when sidecar lock already exists", () => {
    const path = join(tmpdir(), `deft-lock-busy-${Date.now()}.jsonl`);
    fs.writeFileSync(`${path}.lock`, "\0");
    expect(() => withAppendLock(path, () => undefined, instantTimeoutDeps())).toThrow(
      /timed out acquiring lock/,
    );
    expect(fs.existsSync(`${path}.lock`)).toBe(true);
  });

  it("does not unlink a lock whose owner PID is still live", () => {
    const path = join(tmpdir(), `deft-lock-live-${Date.now()}.jsonl`);
    const lockPath = `${path}.lock`;
    fs.writeFileSync(lockPath, `${process.pid}\n`);
    expect(() => withAppendLock(path, () => undefined, instantTimeoutDeps())).toThrow(
      /timed out acquiring lock/,
    );
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toContain(String(process.pid));
  });

  it("reclaims a lock only when the owner PID is proven dead", () => {
    const path = join(tmpdir(), `deft-lock-dead-${Date.now()}.jsonl`);
    fs.writeFileSync(`${path}.lock`, "2147483646\n1\n");
    expect(withAppendLock(path, () => "reclaimed", instantTimeoutDeps())).toBe("reclaimed");
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
  });

  it("does not reclaim a live holder just because the lock is old", () => {
    const path = join(tmpdir(), `deft-lock-live-old-${Date.now()}.jsonl`);
    const lockPath = `${path}.lock`;
    fs.writeFileSync(lockPath, `${process.pid}\n1\n`);
    expect(() => withAppendLock(path, () => undefined, instantTimeoutDeps())).toThrow(
      /timed out acquiring lock/,
    );
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toContain(String(process.pid));
  });

  it("appendLock alias matches withAppendLock", () => {
    const path = join("/tmp", `deft-lock-alias-${Date.now()}.jsonl`);
    expect(appendLock(path, () => 42)).toBe(42);
  });

  it("defaultSleep path completes a normal lock cycle", () => {
    const path = join("/tmp", `deft-lock-default-${Date.now()}.jsonl`);
    expect(withAppendLock(path, () => "ok")).toBe("ok");
  });
});
