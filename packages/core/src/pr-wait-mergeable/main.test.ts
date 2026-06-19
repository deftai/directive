import { describe, expect, it, vi } from "vitest";
import { EXIT_CONFIG_ERROR, EXIT_MERGED } from "./constants.js";
import { cmdPrWaitMergeable, parseWaitMergeableArgs, runWaitMergeable } from "./main.js";
import type { MergeFn, MonitorFn, ProtectedCheckFn } from "./types.js";

function cleanMonitorPayload(prNumber = 1370): Record<string, unknown> {
  return {
    monitor_result: "CLEAN",
    polls: 1,
    readiness: { merge_ready: true, via: "primary", pr_number: prNumber },
  };
}

function makeProtectedFn(returncode: number): ProtectedCheckFn {
  return () => [returncode, "", ""];
}

function makeMonitorFn(returncode: number, payload: Record<string, unknown>): MonitorFn {
  return () => [returncode, JSON.stringify(payload, null, 2), ""];
}

function makeMergeFn(returncode: number, stdout = ""): MergeFn {
  return () => [returncode, stdout, ""];
}

describe("parseWaitMergeableArgs", () => {
  it("parses minimal argv", () => {
    expect(parseWaitMergeableArgs(["1370", "--repo", "deftai/directive"])).toEqual({
      prNumber: 1370,
      repo: "deftai/directive",
      capMinutes: 60,
      protectedValues: [],
      emitJson: false,
    });
  });

  it("parses protected flags and json", () => {
    expect(
      parseWaitMergeableArgs([
        "1370",
        "--repo",
        "deftai/directive",
        "--protected",
        "1119,1140",
        "--cap-minutes",
        "5",
        "--json",
      ]),
    ).toMatchObject({
      prNumber: 1370,
      capMinutes: 5,
      protectedValues: ["1119,1140"],
      emitJson: true,
    });
  });

  it("requires pr number", () => {
    expect(parseWaitMergeableArgs([]).error).toContain("pr_number");
  });
});

describe("runWaitMergeable", () => {
  it("main without repo exits two", () => {
    const prev = process.env.GH_REPO;
    delete process.env.GH_REPO;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runWaitMergeable(["1370"])).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.mock.calls[0]?.[0]).toContain("--repo");
    stderr.mockRestore();
    stdout.mockRestore();
    if (prev !== undefined) process.env.GH_REPO = prev;
  });

  it("malformed protected token exits two", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runWaitMergeable(["1370", "--repo", "deftai/directive", "--protected", "\u00b2"])).toBe(
      EXIT_CONFIG_ERROR,
    );
    expect(stderr.mock.calls[0]?.[0]).toContain("Invalid protected issue token");
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it("emits json envelope on clean then merged", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = runWaitMergeable(
      ["1370", "--repo", "deftai/directive", "--cap-minutes", "5", "--json"],
      {
        protectedFn: makeProtectedFn(0),
        monitorFn: makeMonitorFn(0, cleanMonitorPayload(1370)),
        mergeFn: makeMergeFn(0, "merged: squash"),
      },
    );

    expect(code).toBe(EXIT_MERGED);
    const out = String(stdout.mock.calls[0]?.[0] ?? "");
    const payload = JSON.parse(out) as Record<string, unknown>;
    expect(payload.pr_number).toBe(1370);
    expect(payload.outcome).toBe("merged");
    expect(payload.exit_code).toBe(0);
    expect(payload.merge_stdout).toBe("merged: squash");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("cmdPrWaitMergeable delegates to runWaitMergeable", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(cmdPrWaitMergeable(["1370"])).toBe(EXIT_CONFIG_ERROR);
    stderr.mockRestore();
    stdout.mockRestore();
  });
});
