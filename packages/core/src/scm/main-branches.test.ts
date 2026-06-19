import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import * as buildCommand from "./build-command.js";
import { ScmStubError } from "./errors.js";
import { main } from "./main.js";
import * as restDispatch from "./rest-dispatch.js";

afterEach(() => {
  spawnSyncMock.mockReset();
  vi.restoreAllMocks();
});

describe("main non-rest branches", () => {
  it("forwards to gh via buildCommand and returns process status", () => {
    vi.spyOn(buildCommand, "buildCommand").mockReturnValue(["/usr/bin/gh", "issue", "list"]);
    spawnSyncMock.mockReturnValue({ status: 0 });
    expect(main(["issue", "list"], { whichFn: () => "/usr/bin/gh" })).toBe(0);
  });

  it("returns 2 when buildCommand raises ScmStubError", () => {
    vi.spyOn(buildCommand, "buildCommand").mockImplementation(() => {
      throw new ScmStubError("missing gh");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(["issue", "list"])).toBe(2);
    expect(stderr.mock.calls.join("")).toContain("missing gh");
    stderr.mockRestore();
  });

  it("defaults null spawn status to exit code 1", () => {
    vi.spyOn(buildCommand, "buildCommand").mockReturnValue(["/usr/bin/gh", "issue", "view", "1"]);
    spawnSyncMock.mockReturnValue({ status: null });
    expect(main(["issue", "view", "1"])).toBe(1);
  });
});

describe("main rest branches", () => {
  it("writes stderr from REST dispatch failures", () => {
    vi.spyOn(restDispatch, "runRestView").mockReturnValue({
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 404\n",
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(["issue", "view", "--rest", "1", "--repo", "deftai/directive"])).toBe(1);
    expect(stderr.mock.calls.join("")).toContain("HTTP 404");
    stderr.mockRestore();
  });
});
