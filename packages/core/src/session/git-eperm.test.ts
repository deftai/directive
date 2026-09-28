import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawnSync: vi.fn(),
}));

import { CODEX_RITUAL_GIT_EPERM_TIP, defaultGitRunner, gitIsAncestor } from "./git.js";

describe("session git EPERM spawn path (#4664)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("maps spawn EPERM to code 2 with tip, not git exit 1", () => {
    const err = Object.assign(new Error("spawnSync git EPERM"), {
      code: "EPERM",
      message: "spawnSync git EPERM",
    });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    const result = defaultGitRunner("/tmp", ["merge-base", "--is-ancestor", "old", "new"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("spawnSync git EPERM");
    expect(result.stderr).toContain(CODEX_RITUAL_GIT_EPERM_TIP);
    expect(gitIsAncestor("/tmp", "old", "new", () => result)).toBeNull();
  });

  it("never collapses EPERM status 1 into gitIsAncestor false", () => {
    const err = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
      status: 1,
      stderr: "blocked by sandbox",
    });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    const result = defaultGitRunner("/tmp", ["merge-base", "--is-ancestor", "a", "b"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("blocked by sandbox");
    expect(result.stderr).toContain(CODEX_RITUAL_GIT_EPERM_TIP);
    expect(gitIsAncestor("/tmp", "a", "b", () => result)).toBeNull();
  });

  it("never treats EPERM status 0 as git success / confirmed ancestry", () => {
    // status:0 is still a spawn failure; resolveCaptureFailureStderr keeps
    // empty captured stderr when status is numeric, so tip-only is expected.
    const err = Object.assign(new Error("spawnSync git EPERM"), {
      code: "EPERM",
      status: 0,
      message: "spawnSync git EPERM",
    });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    const result = defaultGitRunner("/tmp", ["merge-base", "--is-ancestor", "old", "new"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(CODEX_RITUAL_GIT_EPERM_TIP);
    expect(gitIsAncestor("/tmp", "old", "new", () => result)).toBeNull();
  });
});
