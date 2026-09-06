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
  it("dispatches issue design-critique-chip without forwarding to gh (#3642)", () => {
    const apply = vi.fn();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      main(
        [
          "issue",
          "design-critique-chip",
          "--issue",
          "3642",
          "--chip",
          "triage-ready",
          "--repo",
          "deftai/directive",
        ],
        {
          skipReadiness: true,
          labelClient: {
            fetchLabels: () => ["bug", "design-critique:mechanism-shaped"],
            apply,
          },
        },
      ),
    ).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.slice(2)).toEqual([
      ["design-critique:triage-ready"],
      ["design-critique:mechanism-shaped"],
    ]);
    stdout.mockRestore();
  });

  it("dispatches issue work-claim without forwarding to gh (#4200)", () => {
    const apply = vi.fn();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      main(["issue", "work-claim", "claim", "--issue", "4200", "--repo", "deftai/directive"], {
        skipReadiness: true,
        occupancyLive: () => true,
        labelClient: {
          fetchLabels: () => ["bug"],
          apply,
        },
      }),
    ).toBe(0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.slice(2)).toEqual([["status:claimed"], []]);
    stdout.mockRestore();
  });

  it("returns 2 for unknown design-critique-chip names without spawning gh", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      main(
        [
          "issue",
          "design-critique-chip",
          "--issue",
          "1",
          "--chip",
          "halted",
          "--repo",
          "deftai/directive",
        ],
        { skipReadiness: true },
      ),
    ).toBe(2);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join("")).toMatch(/unknown design-critique chip/);
    stderr.mockRestore();
  });

  it("forwards to gh via buildCommand and returns process status", () => {
    vi.spyOn(buildCommand, "buildCommand").mockReturnValue(["/usr/bin/gh", "issue", "list"]);
    spawnSyncMock.mockReturnValue({ status: 0 });
    expect(main(["issue", "list"], { whichFn: () => "/usr/bin/gh", skipReadiness: true })).toBe(0);
  });

  it("returns 2 when buildCommand raises ScmStubError", () => {
    vi.spyOn(buildCommand, "buildCommand").mockImplementation(() => {
      throw new ScmStubError("missing gh");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(["issue", "list"], { skipReadiness: true })).toBe(2);
    expect(stderr.mock.calls.join("")).toContain("missing gh");
    stderr.mockRestore();
  });

  it("defaults null spawn status to exit code 1", () => {
    vi.spyOn(buildCommand, "buildCommand").mockReturnValue(["/usr/bin/gh", "issue", "view", "1"]);
    spawnSyncMock.mockReturnValue({ status: null });
    expect(main(["issue", "view", "1"], { skipReadiness: true })).toBe(1);
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
    expect(
      main(["issue", "view", "--rest", "1", "--repo", "deftai/directive"], {
        skipReadiness: true,
      }),
    ).toBe(1);
    expect(stderr.mock.calls.join("")).toContain("HTTP 404");
    stderr.mockRestore();
  });
});
