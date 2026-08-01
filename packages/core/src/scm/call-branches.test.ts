import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { call } from "./call.js";

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("call option branches", () => {
  it("throws when check is true and process exits non-zero", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "permission denied",
    });
    expect(() =>
      call("github-issue", "issue", ["view", "1"], {
        binary: "/usr/bin/gh",
        check: true,
      }),
    ).toThrow("permission denied");
  });

  it("uses fallback message when check fails without stderr", () => {
    spawnSyncMock.mockReturnValue({
      status: 2,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });
    expect(() =>
      call("github-issue", "issue", ["view", "1"], {
        binary: "/usr/bin/gh",
        check: true,
        text: false,
      }),
    ).toThrow(/Process exited with code 2/);
  });

  it("supports inherit stdio and custom env/input/timeout", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "ok", stderr: "" });
    const env = { CUSTOM: "1" };
    const result = call("github-issue", "api", null, {
      binary: "/usr/bin/gh",
      captureOutput: false,
      cwd: "/tmp",
      env,
      input: "{}",
      timeout: 1.5,
      text: true,
    });
    expect(result.returncode).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/bin/gh",
      ["api"],
      expect.objectContaining({
        cwd: "/tmp",
        env,
        input: "{}",
        timeout: 1500,
        stdio: "inherit",
      }),
    );
  });

  it("defaults null status to returncode 1 and empty captured strings", () => {
    spawnSyncMock.mockReturnValue({ status: null, stdout: undefined, stderr: undefined });
    const result = call("github-issue", "auth", [], { binary: "/usr/bin/gh", text: false });
    expect(result.returncode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.args).toEqual(["/usr/bin/gh", "auth"]);
  });
});
