import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prWatchHeartbeatAgentId } from "../pr-watch/main.js";
import { hasActivePollingHeartbeat } from "../review-monitor/verify.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED } from "./constants.js";
import { cmdPrWaitMergeable, parseWaitMergeableArgs, runWaitMergeable } from "./main.js";
import type { MergeFn, MonitorFn, ProtectedCheckFn } from "./types.js";

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
      cascadeMode: false,
      requireMasterCiGreen: false,
      baseBranch: null,
      projectRoot: null,
    });
  });

  it("parses --project-root for remote confidence policy (#3102)", () => {
    expect(
      parseWaitMergeableArgs([
        "1370",
        "--repo",
        "deftai/directive",
        "--project-root",
        "/tmp/consumer-project",
      ]),
    ).toMatchObject({
      prNumber: 1370,
      projectRoot: "/tmp/consumer-project",
    });
  });

  it("parses cascade flags", () => {
    expect(
      parseWaitMergeableArgs([
        "1370",
        "--repo",
        "deftai/directive",
        "--cascade",
        "--require-master-ci-green",
        "--base-branch",
        "master",
      ]),
    ).toMatchObject({
      cascadeMode: true,
      requireMasterCiGreen: true,
      baseBranch: "master",
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
  let savedGhRepo: string | undefined;

  beforeEach(() => {
    savedGhRepo = process.env.GH_REPO;
    delete process.env.GH_REPO;
  });

  afterEach(() => {
    if (savedGhRepo === undefined) {
      delete process.env.GH_REPO;
    } else {
      process.env.GH_REPO = savedGhRepo;
    }
  });

  it("main without repo exits two", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runWaitMergeable(["1370"])).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.mock.calls[0]?.[0]).toContain("--repo");
    stderr.mockRestore();
    stdout.mockRestore();
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
        skipHumanMergeGate: true,
        skipMergeApprovalHeadGate: true,
        fetchPrHeadShaFn: () => "a".repeat(40),
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

  it("arms hasActivePollingHeartbeat while running and clears on exit (#5020 post-CLEAN)", () => {
    const root = mkdtempSync(join(tmpdir(), "wait-merge-hb-"));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let sawLive = false;
    const code = runWaitMergeable(
      [
        "5020",
        "--repo",
        "deftai/directive",
        "--cap-minutes",
        "5",
        "--json",
        "--project-root",
        root,
      ],
      {
        protectedFn: makeProtectedFn(0),
        monitorFn: (..._args) => {
          sawLive = hasActivePollingHeartbeat(root, 5020);
          return makeMonitorFn(0, cleanMonitorPayload(5020))();
        },
        mergeFn: makeMergeFn(0, "merged: squash"),
        skipHumanMergeGate: true,
        skipMergeApprovalHeadGate: true,
        fetchPrHeadShaFn: () => "a".repeat(40),
      },
    );
    expect(code).toBe(EXIT_MERGED);
    expect(sawLive).toBe(true);
    expect(hasActivePollingHeartbeat(root, 5020)).toBe(false);
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("refreshes heartbeat while the blocking monitor runs (#5020 P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "wait-merge-hb-refresh-"));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const hbPath = join(
      root,
      ".deft-scratch",
      "subagent-status",
      `${prWatchHeartbeatAgentId(5020)}.json`,
    );
    let firstAt = "";
    let secondAt = "";
    const code = runWaitMergeable(
      [
        "5020",
        "--repo",
        "deftai/directive",
        "--cap-minutes",
        "5",
        "--json",
        "--project-root",
        root,
      ],
      {
        protectedFn: makeProtectedFn(0),
        heartbeatRefreshSeconds: 0.05,
        monitorFn: (..._args) => {
          firstAt = (JSON.parse(readFileSync(hbPath, "utf8")) as { last_heartbeat_at: string })
            .last_heartbeat_at;
          sleepMs(200);
          secondAt = (JSON.parse(readFileSync(hbPath, "utf8")) as { last_heartbeat_at: string })
            .last_heartbeat_at;
          expect(hasActivePollingHeartbeat(root, 5020)).toBe(true);
          return makeMonitorFn(0, cleanMonitorPayload(5020))();
        },
        mergeFn: makeMergeFn(0, "merged: squash"),
        skipHumanMergeGate: true,
        skipMergeApprovalHeadGate: true,
        fetchPrHeadShaFn: () => "a".repeat(40),
      },
    );
    expect(code).toBe(EXIT_MERGED);
    expect(firstAt.length).toBeGreaterThan(0);
    expect(secondAt.length).toBeGreaterThan(0);
    expect(Date.parse(secondAt)).toBeGreaterThan(Date.parse(firstAt));
    expect(hasActivePollingHeartbeat(root, 5020)).toBe(false);
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
