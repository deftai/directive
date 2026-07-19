import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWorkerEntrypoint } from "./entrypoint-worker.js";

describe("runWorkerEntrypoint", () => {
  it("throw test behavior returns boom", () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    const result = runWorkerEntrypoint({
      kind: "test",
      argv: ["0.0.1"],
      cloneDir,
      testBehavior: "throw",
    });
    expect(result.stderr).toContain("boom");
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("release kind delegates to cmdRelease", async () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    vi.spyOn(await import("../release/main.js"), "cmdRelease").mockReturnValue(0);
    const result = runWorkerEntrypoint({
      kind: "release",
      argv: [
        "0.0.1",
        "--dry-run",
        "--skip-ci",
        "--skip-build",
        "--repo",
        "deftai/x",
        "--allow-vbrief-drift",
      ],
      cloneDir,
    });
    expect(result.code).toBe(0);
    vi.restoreAllMocks();
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it("rollback kind delegates to rollbackMain", async () => {
    const cloneDir = mkdtempSync(join(tmpdir(), "deft-worker-"));
    vi.spyOn(await import("./rollback-bridge.js"), "rollbackMain").mockReturnValue(0);
    const result = runWorkerEntrypoint({
      kind: "rollback",
      argv: ["0.0.1", "--repo", "deftai/x"],
      cloneDir,
    });
    expect(result.code).toBe(0);
    vi.restoreAllMocks();
    rmSync(cloneDir, { recursive: true, force: true });
  });
});
