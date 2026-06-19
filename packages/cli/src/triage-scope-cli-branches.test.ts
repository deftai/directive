import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { run } from "./triage-scope.js";

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("triage-scope thin CLI branches", () => {
  it("writes captured stdout/stderr and defaults null status to 2", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "hello\n",
      stderr: "warn\n",
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => {
      stdout.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      stderr.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(run(["--list"])).toBe(2);
      expect(stdout.join("")).toBe("hello\n");
      expect(stderr.join("")).toBe("warn\n");
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  });

  it("skips empty stdout and stderr buffers", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect(run(["--help"])).toBe(0);
  });

  it("ignores non-string stdout and stderr payloads", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: undefined, stderr: undefined });
    expect(run(["--list"])).toBe(0);
  });

  it("returns explicit non-zero exit codes", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "err\n", stderr: "" });
    expect(run(["--project-root", "/tmp"])).toBe(1);
  });
});
