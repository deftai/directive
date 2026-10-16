import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withPlanSequenceSidecarLock } from "./mutation-lock.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function lockFile(): string {
  const root = mkdtempSync(join(tmpdir(), "ps-lock-"));
  roots.push(root);
  mkdirSync(join(root, ".deft"), { recursive: true });
  return join(root, ".deft", "plan-sequence.json.lock");
}

describe("plan-sequence sidecar lock (#3907)", () => {
  it("runs the critical section and removes the lock directory", () => {
    const lockPath = lockFile();
    const result = withPlanSequenceSidecarLock(lockPath, () => {
      expect(existsSync(lockPath)).toBe(true);
      return 7;
    });
    expect(result).toEqual({ ok: true, value: 7 });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("returns lock-reentrant when nested on the same thread", () => {
    const lockPath = lockFile();
    const result = withPlanSequenceSidecarLock(lockPath, () =>
      withPlanSequenceSidecarLock(lockPath, () => "nope"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ok).toBe(false);
    if (!result.value.ok) expect(result.value.code).toBe("lock-reentrant");
  });

  it("times out on a live owner, legacy file, and unknown liveness", () => {
    const livePath = lockFile();
    mkdirSync(livePath);
    writeFileSync(join(livePath, `${process.pid}-${"aa".repeat(16)}`), "{}\n");
    const live = withPlanSequenceSidecarLock(livePath, () => "nope", {
      acquisitionBudgetMs: 0,
      sleepMs: () => undefined,
    });
    expect(live.ok).toBe(false);
    if (!live.ok) {
      expect(live.code).toBe("lock-timeout");
      expect(live.message).toContain("plan-sequence");
    }

    const legacyPath = lockFile();
    writeFileSync(legacyPath, "legacy\n");
    const legacy = withPlanSequenceSidecarLock(legacyPath, () => "nope", {
      acquisitionBudgetMs: 0,
      sleepMs: () => undefined,
    });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.message).toContain("legacy-file-sidecar");
    expect(readFileSync(legacyPath, "utf8")).toBe("legacy\n");

    const unknownPath = lockFile();
    mkdirSync(unknownPath);
    writeFileSync(join(unknownPath, `2-${"bb".repeat(16)}`), "{}\n");
    const unknown = withPlanSequenceSidecarLock(unknownPath, () => "nope", {
      acquisitionBudgetMs: 0,
      sleepMs: () => undefined,
      probeProcess: () => "unknown",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("owner-liveness-unknown");
  });

  it("reaps a dead owner and then holds the lock", () => {
    const lockPath = lockFile();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, `999999997-${"cc".repeat(16)}`), "{}\n");
    const result = withPlanSequenceSidecarLock(lockPath, () => "held", {
      probeProcess: () => "dead",
    });
    expect(result).toEqual({ ok: true, value: "held" });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("returns lock-timeout on a short owner write", () => {
    const lockPath = lockFile();
    const short = withPlanSequenceSidecarLock(lockPath, () => "nope", { writeOwner: () => 0 });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.code).toBe("lock-timeout");
      expect(short.message).toMatch(/short write while recording plan-sequence lock owner/);
    }
  });

  it("returns lock-timeout when lock setup mkdir fails without running fn", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-lock-setup-"));
    roots.push(root);
    const blocking = join(root, "blocked");
    writeFileSync(blocking, "file\n");
    const lockPath = join(blocking, "plan-sequence.json.lock");
    let ran = false;
    const result = withPlanSequenceSidecarLock(lockPath, () => {
      ran = true;
      return "nope";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("lock-timeout");
      expect(result.message).toMatch(/setup failed/);
    }
    expect(ran).toBe(false);
  });
});
