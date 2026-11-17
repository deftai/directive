import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchCloseoutLockPath, withLaunchCloseoutLock } from "./launch-closeout-lock.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcl-6422-"));
  temps.push(dir);
  return dir;
}

describe("launch/close-out lock (#6422)", () => {
  it("runs the body under the lock and removes the lock file afterwards", () => {
    const root = project();
    const result = withLaunchCloseoutLock(root, () => existsSync(launchCloseoutLockPath(root)));
    expect(result).toEqual({ ok: true, value: true });
    expect(existsSync(launchCloseoutLockPath(root))).toBe(false);
  });

  it("returns a failure naming the lock when another holder keeps it", () => {
    const root = project();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      launchCloseoutLockPath(root),
      `${String(process.pid)}\nheld\n${String(Date.now())}\n`,
      "utf8",
    );
    let now = 0;
    const result = withLaunchCloseoutLock(root, () => "never", {
      now: () => now,
      sleepMs: () => {
        now += 1_000;
      },
      acquisitionBudgetMs: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("swarm-launch-occupancy.lock");
    expect(result.detail).toContain("run the command again");
  });

  it("returns an error raised by the body as a failure and frees the lock", () => {
    const root = project();
    const result = withLaunchCloseoutLock(root, () => {
      throw new Error("body broke");
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("unexpected error under its lock: body broke");
    expect(existsSync(launchCloseoutLockPath(root))).toBe(false);
  });
});
