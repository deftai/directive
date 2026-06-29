import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawnSync: vi.fn(),
}));

import { defaultGitRunner } from "./index.js";

describe("defaultGitRunner", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("returns parsed tags on success", () => {
    execFileSyncMock.mockReturnValue("abc\trefs/tags/v1.2.3\n");
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toEqual([
      "v1.2.3",
    ]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--tags", "--refs", "--", "https://example.com/repo.git"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
    );
  });

  it("returns os-error for option-like upstream urls", () => {
    expect(defaultGitRunner().lsRemoteTags("--upload-pack=echo pwned", 5000)).toBe("os-error");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns timeout when execFileSync throws ETIMEDOUT", () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("timeout");
  });

  it("returns timeout when error message mentions timed out", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("spawnSync timed out after 5000ms");
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("timeout");
  });

  it("returns os-error for other spawn failures", () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("os-error");
  });

  it("returns os-error when execFileSync throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("os-error");
  });

  it("returns os-error when execFileSync throws ETIMEDOUT message", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ETIMEDOUT");
    });
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toBe("timeout");
  });

  it("treats missing stdout as empty", () => {
    execFileSyncMock.mockReturnValue("");
    expect(defaultGitRunner().lsRemoteTags("https://example.com/repo.git", 5000)).toEqual([]);
  });
});
