import { describe, expect, it } from "vitest";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { spawnText } from "./spawn.js";

describe("spawnText maxBuffer (#1867)", () => {
  it("uses a multi-megabyte ceiling, well above Node's 1 MB default", () => {
    // Regression guard for the constant the helper relies on.
    expect(SUBPROCESS_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });

  it("captures stdout larger than Node's 1 MB default without failing", () => {
    // 2 MB overflows the 1 MB default that caused the empty-error publish
    // failure; with SUBPROCESS_MAX_BUFFER applied the capture must succeed cleanly.
    const bytes = 2 * 1024 * 1024;
    const result = spawnText(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(${bytes}))`,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(bytes);
    expect(result.stderr).toBe("");
  });

  it("surfaces a non-empty stderr when the spawn itself errors", () => {
    // ENOENT (binary missing) yields status=null + empty stderr from spawnSync;
    // spawnText must map that to a non-zero status with a real message so the
    // failure is never reported as a blank reason (#1867).
    const result = spawnText("deft-nonexistent-binary-xyz", ["api"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  });
});
