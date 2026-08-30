import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
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

  it("passes the shared subprocess ceiling to spawnSync (#3903)", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "ok", stderr: "" });
    call("github-issue", "api", ["--paginate", "repos/o/r/issues"], { binary: "/usr/bin/gh" });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/usr/bin/gh",
      ["api", "--paginate", "repos/o/r/issues"],
      expect.objectContaining({ maxBuffer: SUBPROCESS_MAX_BUFFER }),
    );
  });

  it("surfaces the spawn error message on an ENOBUFS overflow (#3903)", () => {
    const error = Object.assign(new Error("spawnSync /usr/bin/gh ENOBUFS"), { code: "ENOBUFS" });
    spawnSyncMock.mockReturnValue({ status: null, stdout: "truncated", stderr: "", error });
    const result = call("github-issue", "api", ["--paginate", "repos/o/r/issues"], {
      binary: "/usr/bin/gh",
    });
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("ENOBUFS");
  });

  it("throws the spawn error message when check is set and status is null (#3903)", () => {
    const error = Object.assign(new Error("spawnSync /usr/bin/gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    spawnSyncMock.mockReturnValue({ status: null, stdout: "", stderr: "", error });
    expect(() =>
      call("github-issue", "api", ["repos/o/r/issues"], { binary: "/usr/bin/gh", check: true }),
    ).toThrow(/ETIMEDOUT/);
  });

  it("defaults null status to returncode 1 and names the binary when stderr is empty", () => {
    spawnSyncMock.mockReturnValue({ status: null, stdout: undefined, stderr: undefined });
    const result = call("github-issue", "auth", [], { binary: "/usr/bin/gh", text: false });
    expect(result.returncode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("/usr/bin/gh");
    expect(result.stderr).toMatch(/spawn-failed|failed/);
    expect(result.args).toEqual(["/usr/bin/gh", "auth"]);
  });

  it("falls back from ghx to gh on a simulated spawn failure (#3737)", () => {
    spawnSyncMock.mockImplementation((command: string) => {
      if (command === "ghx") {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawn ghx ENOENT"), { code: "ENOENT" }),
        };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    });
    const result = call("github-issue", "api", ["repos/o/r/issues/1"], {
      whichFn: (name) => `/usr/bin/${name}`,
    });
    expect(spawnSyncMock.mock.calls.map((c) => c[0])).toEqual(["ghx", "gh"]);
    expect(result.args[0]).toBe("gh");
    expect(result.returncode).toBe(0);
    expect(result.stdout).toBe("{}");
  });
});
