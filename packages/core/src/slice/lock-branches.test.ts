import * as fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLock, withAppendLock } from "./lock.js";

describe("lock branches", () => {
  it("times out when sidecar lock already exists", () => {
    const path = join("/tmp", `deft-lock-busy-${Date.now()}.jsonl`);
    fs.writeFileSync(`${path}.lock`, "\0");
    let now = 0;
    expect(() =>
      withAppendLock(path, () => undefined, {
        now: () => {
          now += 31_000;
          return now;
        },
        sleepMs: () => {
          /* no-op */
        },
      }),
    ).toThrow(/timed out acquiring lock/);
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
