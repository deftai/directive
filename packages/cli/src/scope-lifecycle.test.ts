import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { run } from "./scope-lifecycle.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

describe("scope-lifecycle CLI", () => {
  it("returns usage error for incomplete argv", () => {
    expect(run(["promote"])).toBe(2);
  });

  it("forwards stdout and stderr from child process", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "Promoted x.vbrief.json\n",
      stderr: "warning\n",
      pid: 1,
      output: [null, "Promoted x.vbrief.json\n", "warning\n", null],
      signal: null,
      error: undefined,
    });
    expect(run(["promote", "/tmp/x.vbrief.json", "--project-root", "/tmp"])).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("defaults to exit 2 when status is null", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [null, "", "", null],
      signal: null,
      error: undefined,
    });
    expect(run([])).toBe(2);
  });
});
