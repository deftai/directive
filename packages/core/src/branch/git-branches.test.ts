import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { currentBranch, GitNotFoundError } from "./git.js";

afterEach(() => {
  execFileSyncMock.mockReset();
});

describe("currentBranch error branches", () => {
  it("returns branch when symbolic-ref succeeds", () => {
    execFileSyncMock.mockReturnValue("feat/coverage\n");
    const state = currentBranch("/tmp");
    expect(state.detached).toBe(false);
    expect(state.branch).toBe("feat/coverage");
  });

  it("raises GitNotFoundError when git is missing", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => currentBranch("/tmp")).toThrow(GitNotFoundError);
  });

  it("raises GitNotFoundError on status 127 with stderr hint", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException & {
        status?: number;
        stderr?: string;
      };
      err.status = 127;
      err.stderr = "git executable not found on PATH";
      throw err;
    });
    expect(() => currentBranch("/tmp")).toThrow(GitNotFoundError);
  });

  it("treats empty branch stdout as detached HEAD", () => {
    execFileSyncMock.mockReturnValue("   \n");
    const state = currentBranch("/tmp");
    expect(state.detached).toBe(true);
    expect(state.branch).toBe("");
  });

  it("treats symbolic-ref failure as detached HEAD", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("not a symbolic ref") as NodeJS.ErrnoException & { status?: number };
      err.status = 1;
      throw err;
    });
    const state = currentBranch("/tmp");
    expect(state.detached).toBe(true);
  });

  it("ignores status 127 without git-not-found stderr", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("other failure") as NodeJS.ErrnoException & {
        status?: number;
        stderr?: string;
      };
      err.status = 127;
      err.stderr = "command not found: other";
      throw err;
    });
    const state = currentBranch("/tmp");
    expect(state.detached).toBe(true);
  });
});
