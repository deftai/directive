import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { defaultGitRunner } from "./index.js";

describe("defaultGitRunner", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("returns parsed tags on success", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "abc\trefs/tags/v1.2.3\n",
      stderr: "",
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toEqual([
      "v1.2.3",
    ]);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--tags", "--refs", "--", "https://example.com/repo.git"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
    );
  });

  it("returns os-error for option-like upstream urls", () => {
    expect(defaultGitRunner().lsRemoteTags("--upload-pack=echo pwned", 5000)).toBe("os-error");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns timeout when spawnSync errors with ETIMEDOUT", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("timeout");
  });

  it("returns timeout when error message mentions timed out", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawnSync timed out after 5000ms"),
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("timeout");
  });

  it("returns os-error for other spawn failures", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("os-error");
  });

  it("returns empty list when git exits non-zero", () => {
    spawnSyncMock.mockReturnValue({
      status: 128,
      stdout: "",
      stderr: "fatal: repository not found",
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toEqual([]);
  });

  it("treats missing stdout as empty", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: undefined,
      stderr: "",
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toEqual([]);
  });

  it("returns os-error when spawnSync throws", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("os-error");
  });

  it("returns timeout when spawnSync throws ETIMEDOUT", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("ETIMEDOUT");
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("timeout");
  });
});
