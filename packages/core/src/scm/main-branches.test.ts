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

describe("main exclusive design-critique chip edit (#3642)", () => {
  it("routes catalog-chip --add-label through LabelClient.apply", () => {
    const apply = vi.fn();
    const client = {
      fetchLabels: () => ["bug", "design-critique:mechanism-shaped"],
      apply,
    };
    const code = main(
      [
        "issue",
        "edit",
        "3637",
        "--repo",
        "deftai/directive",
        "--add-label",
        "design-critique:triage-ready",
      ],
      { skipReadiness: true, whichFn: () => "/usr/bin/gh", labelClient: client },
    );
    expect(code).toBe(0);
    expect(apply).toHaveBeenCalledWith(
      "deftai/directive",
      3637,
      ["design-critique:triage-ready"],
      [],
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("forwards non-catalog issue edit to gh", () => {
    vi.spyOn(buildCommand, "buildCommand").mockReturnValue([
      "/usr/bin/gh",
      "issue",
      "edit",
      "1",
      "--add-label",
      "bug",
    ]);
    spawnSyncMock.mockReturnValue({ status: 0 });
    expect(main(["issue", "edit", "1", "--add-label", "bug"], { skipReadiness: true })).toBe(0);
    expect(spawnSyncMock).toHaveBeenCalled();
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
