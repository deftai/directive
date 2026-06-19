import { vi } from "vitest";

const mockSpawnSync = vi.hoisted(() =>
  vi.fn(() => ({
    status: 0,
    stdout: "",
    stderr: "",
  })),
);

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

import { describe, expect, it } from "vitest";
import { PARITY_CASES, runParity } from "./triage-aux-b-parity.js";

describe("triage-aux-b-parity runner", () => {
  it("runParity reports ok when all mocked invocations agree", () => {
    mockSpawnSync.mockClear();
    const result = runParity();
    expect(result.ok).toBe(true);
    expect(result.diffs).toHaveLength(PARITY_CASES.length);
    expect(mockSpawnSync.mock.calls.length).toBeGreaterThan(0);
  });

  it("runParity reports divergence when exits differ", () => {
    mockSpawnSync.mockImplementation((cmd, _args) => {
      const isNode = cmd === "node";
      return {
        status: isNode ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    });
    const result = runParity();
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => d.exitMismatch)).toBe(true);
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  });
});
