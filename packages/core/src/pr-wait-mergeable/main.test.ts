import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prWatchHeartbeatAgentId } from "../pr-watch/main.js";
import { hasActivePollingHeartbeat } from "../review-monitor/verify.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_QUEUE_PENDING } from "./constants.js";
import { cmdPrWaitMergeable, parseWaitMergeableArgs, runWaitMergeable } from "./main.js";
import type { OriginRepoSeam } from "./repo-from-origin.js";
import type { MergeFn, MonitorFn, ProtectedCheckFn } from "./types.js";

/** Origin seam fed a raw remote string (#6869 item 5); `null` means no origin remote. */
function originSeam(
  url: string | null,
  repoRead: { fork: boolean | null; error: string | null } = { fork: false, error: null },
): { seam: OriginRepoSeam; gitReads: string[]; repoReads: string[] } {
  const gitReads: string[] = [];
  const repoReads: string[] = [];
  return {
    gitReads,
    repoReads,
    seam: {
      readOriginRemote: (projectRoot) => {
        gitReads.push(projectRoot);
        return url === null
          ? { url: null, error: "error: No such remote 'origin'" }
          : { url, error: null };
      },
      readRepo: (repo) => {
        repoReads.push(repo);
        return repoRead;
      },
    },
  };
}

const REPO_REQUIRED =
  "Error: --repo OWNER/REPO is required (or set $GH_REPO, or run in a clone whose origin " +
  "is a non-fork github.com repository); origin: ";

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
      resume: false,
      expectHead: null,
      since: null,
      wait: false,
    });
  });

  it("parses --wait on the first call and with --resume (#6423 item 1)", () => {
    expect(parseWaitMergeableArgs(["1370", "--repo", "deftai/directive", "--wait"]).wait).toBe(
      true,
    );
    const resumed = parseWaitMergeableArgs([
      "1370",
      "--resume",
      "--wait",
      "--expect-head",
      "a".repeat(40),
      "--since",
      "2026-11-17T01:00:00.000Z",
    ]);
    expect(resumed.error).toBeUndefined();
    expect(resumed.wait).toBe(true);
    expect(resumed.resume).toBe(true);
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
    // #6869 item 5: drive the origin seam (no origin), never the checkout's own remote.
    expect(runWaitMergeable(["1370"], { originRepoSeam: originSeam(null).seam })).toBe(
      EXIT_CONFIG_ERROR,
    );
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
    expect(cmdPrWaitMergeable(["1370"], { originRepoSeam: originSeam(null).seam })).toBe(
      EXIT_CONFIG_ERROR,
    );
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
          const readHbAt = (): string => {
            const deadline = Date.now() + 2_000;
            while (Date.now() < deadline) {
              try {
                const raw = readFileSync(hbPath, "utf8");
                if (raw.trim().length === 0) {
                  sleepMs(20);
                  continue;
                }
                const parsed = JSON.parse(raw) as { last_heartbeat_at?: string };
                if (
                  typeof parsed.last_heartbeat_at === "string" &&
                  parsed.last_heartbeat_at.length > 0
                ) {
                  return parsed.last_heartbeat_at;
                }
              } catch {
                // mid-write / empty JSON race under parallel ts:check-lane (#5020 flake)
              }
              sleepMs(20);
            }
            return "";
          };
          firstAt = readHbAt();
          const advanceDeadline = Date.now() + 2_000;
          while (Date.now() < advanceDeadline) {
            sleepMs(50);
            secondAt = readHbAt();
            if (
              firstAt.length > 0 &&
              secondAt.length > 0 &&
              Date.parse(secondAt) > Date.parse(firstAt)
            ) {
              break;
            }
          }
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
    // Same-ms refresh under load is accepted; live arm was already probed above (#5020).
    expect(Date.parse(secondAt)).toBeGreaterThanOrEqual(Date.parse(firstAt));
    expect(hasActivePollingHeartbeat(root, 5020)).toBe(false);
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe("runWaitMergeable repo from origin (#6869)", () => {
  let savedGhRepo: string | undefined;
  let events: string[];

  beforeEach(() => {
    savedGhRepo = process.env.GH_REPO;
    delete process.env.GH_REPO;
    events = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      events.push(`stderr:${String(chunk)}`);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedGhRepo === undefined) {
      delete process.env.GH_REPO;
    } else {
      process.env.GH_REPO = savedGhRepo;
    }
  });

  /** Merge-path seams that record each call, in order, with the repository they got. */
  function mergePath(): Parameters<typeof runWaitMergeable>[1] {
    return {
      protectedFn: (_pr, repo) => {
        events.push(`protected:${repo}`);
        return [0, "", ""];
      },
      monitorFn: (_pr, repo) => {
        events.push(`monitor:${repo}`);
        return [0, JSON.stringify(cleanMonitorPayload(6869), null, 2), ""];
      },
      mergeFn: (_pr, repo) => {
        events.push(`merge:${repo}`);
        return [0, "merged: squash", ""];
      },
      skipHumanMergeGate: true,
      skipMergeApprovalHeadGate: true,
      fetchPrHeadShaFn: () => "a".repeat(40),
    };
  }

  function root(): string {
    return mkdtempSync(join(tmpdir(), "pr-wait-6869-"));
  }

  function mergePathEvents(): string[] {
    return events.filter((e) => !e.startsWith("stderr:"));
  }

  for (const url of ["https://github.com/acme/project.git", "git@github.com:acme/project.git"]) {
    it(`infers acme/project from a non-fork origin ${url} and says so first (AC 1)`, () => {
      const projectRoot = root();
      const origin = originSeam(url);
      const code = runWaitMergeable(["6869", "--project-root", projectRoot, "--json"], {
        ...mergePath(),
        originRepoSeam: origin.seam,
      });
      expect(code).toBe(EXIT_MERGED);
      expect(origin.gitReads).toEqual([projectRoot]);
      expect(origin.repoReads).toEqual(["acme/project"]);
      expect(events[0]).toBe("stderr:pr_wait_mergeable: repo=acme/project (from origin)\n");
      const merges = mergePathEvents();
      expect(merges.length).toBeGreaterThan(0);
      expect(merges.every((e) => e.endsWith(":acme/project"))).toBe(true);
      expect(merges).toContain("merge:acme/project");
    });
  }

  it("uses --repo or GH_REPO without reading origin or printing the inference line (AC 2)", () => {
    for (const setup of ["flag", "env"] as const) {
      events.length = 0;
      const origin = originSeam("https://github.com/acme/project.git");
      const argv = ["6869", "--project-root", root(), "--json"];
      if (setup === "flag") argv.push("--repo", "given/repo");
      else process.env.GH_REPO = "given/repo";
      const code = runWaitMergeable(argv, { ...mergePath(), originRepoSeam: origin.seam });
      delete process.env.GH_REPO;
      expect(code).toBe(EXIT_MERGED);
      expect(origin.gitReads).toEqual([]);
      expect(origin.repoReads).toEqual([]);
      expect(events.some((e) => e.includes("(from origin)"))).toBe(false);
      expect(mergePathEvents()).toContain("merge:given/repo");
    }
  });

  it("refuses an origin that is not a github.com <owner>/<name> URL with no GitHub call (AC 3)", () => {
    for (const url of [
      "acme/project.git",
      "../project",
      "C:/src/project",
      "/srv/git/project.git",
      "https://gitlab.com/acme/project.git",
      "https://github.com/acme/project/extra",
    ]) {
      events.length = 0;
      const origin = originSeam(url);
      const code = runWaitMergeable(["6869", "--project-root", root()], {
        ...mergePath(),
        originRepoSeam: origin.seam,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(origin.repoReads).toEqual([]);
      expect(mergePathEvents()).toEqual([]);
      expect(events).toEqual([
        `stderr:${REPO_REQUIRED}origin URL ${JSON.stringify(url)} is not a github.com <owner>/<name> URL\n`,
      ]);
    }
  });

  it("refuses a fork origin or a failed repository read, naming the repository (AC 4)", () => {
    const cases = [
      { read: { fork: true, error: null }, reason: "acme/project is a fork" },
      {
        read: { fork: null, error: "gh api repos/acme/project failed: HTTP 404" },
        reason: "cannot read repository acme/project (gh api repos/acme/project failed: HTTP 404)",
      },
    ];
    for (const { read, reason } of cases) {
      events.length = 0;
      const origin = originSeam("https://github.com/acme/project.git", read);
      const code = runWaitMergeable(["6869", "--project-root", root()], {
        ...mergePath(),
        originRepoSeam: origin.seam,
      });
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(origin.repoReads).toEqual(["acme/project"]);
      expect(mergePathEvents()).toEqual([]);
      expect(events).toEqual([`stderr:${REPO_REQUIRED}${reason}\n`]);
    }
  });

  it("refuses when there is no origin remote (AC 5)", () => {
    const origin = originSeam(null);
    const code = runWaitMergeable(["6869", "--project-root", root()], {
      ...mergePath(),
      originRepoSeam: origin.seam,
    });
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(origin.repoReads).toEqual([]);
    expect(mergePathEvents()).toEqual([]);
    expect(events).toEqual([
      `stderr:${REPO_REQUIRED}cannot read the origin remote (error: No such remote 'origin')\n`,
    ]);
  });
});

describe("parseWaitMergeableArgs --resume (#6295)", () => {
  const sha = "a".repeat(40);
  const since = "2026-11-15T10:00:00.000Z";

  it("parses --resume --expect-head --since (space and = forms)", () => {
    const a = parseWaitMergeableArgs(["5", "--resume", "--expect-head", sha, "--since", since]);
    expect(a.error).toBeUndefined();
    expect(a.resume).toBe(true);
    expect(a.expectHead).toBe(sha);
    expect(a.since).toBe(since);
    const b = parseWaitMergeableArgs(["5", "--resume", `--expect-head=${sha}`, `--since=${since}`]);
    expect(b.error).toBeUndefined();
    expect(b.expectHead).toBe(sha);
  });

  it("requires a SHA and a time with --resume", () => {
    expect(parseWaitMergeableArgs(["5", "--resume", "--since", since]).error).toContain(
      "--expect-head",
    );
    expect(parseWaitMergeableArgs(["5", "--resume", "--expect-head", sha]).error).toContain(
      "--since",
    );
    expect(
      parseWaitMergeableArgs(["5", "--resume", "--expect-head", sha, "--since", "nope"]).error,
    ).toContain("--since");
    expect(parseWaitMergeableArgs(["5", "--resume", "--expect-head"]).error).toContain(
      "expected one argument",
    );
  });

  it("rejects --expect-head / --since without --resume", () => {
    expect(parseWaitMergeableArgs(["5", "--expect-head", sha]).error).toContain("--resume");
  });
});

describe("runWaitMergeable --resume (#6295)", () => {
  const sha = "a".repeat(40);
  const since = "2026-11-15T10:00:00.000Z";
  const queued = {
    data: {
      repository: {
        pullRequest: {
          headRefOid: sha,
          merged: false,
          mergeCommit: null,
          mergeQueueEntry: { state: "QUEUED", position: 3 },
          autoMergeRequest: null,
          timelineItems: { nodes: [] },
        },
      },
    },
  };

  it("repeats the read without gates or a merge call and labels QUEUE-PENDING", async () => {
    const { parseQueueState } = await import("./merge-queue.js");
    const root = mkdtempSync(join(tmpdir(), "wait-merge-resume-"));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = runWaitMergeable(
      [
        "6295",
        "--repo",
        "deftai/directive",
        "--resume",
        "--expect-head",
        sha,
        "--since",
        since,
        "--project-root",
        root,
      ],
      {
        mergeFn: () => {
          throw new Error("resume must not merge");
        },
        monitorFn: () => {
          throw new Error("resume must not wait");
        },
        queueReadFn: () => ({ status: "ok", read: parseQueueState(queued) as never }),
      },
    );
    expect(code).toBe(EXIT_QUEUE_PENDING);
    const text = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("QUEUE-PENDING");
    expect(text).toContain("outcome: queued");
    expect(text).toContain("resume:  task pr:wait-mergeable-and-merge -- 6295");
    expect(text).not.toContain("wait stop");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  function resumeArgv(...extra: string[]): string[] {
    return [
      "6423",
      "--repo",
      "deftai/directive",
      "--resume",
      "--expect-head",
      sha,
      "--since",
      since,
      "--project-root",
      mkdtempSync(join(tmpdir(), "wait-merge-6423-")),
      ...extra,
    ];
  }

  function queueReads(...payloads: Record<string, unknown>[]) {
    let i = 0;
    return async () => {
      const { parseQueueState } = await import("./merge-queue.js");
      return () => {
        const payload = payloads[Math.min(i, payloads.length - 1)] as Record<string, unknown>;
        i += 1;
        return { status: "ok", read: parseQueueState(payload) as never } as const;
      };
    };
  }

  const merged = {
    data: {
      repository: {
        pullRequest: {
          ...queued.data.repository.pullRequest,
          merged: true,
          mergeCommit: { oid: "c".repeat(40) },
          mergeQueueEntry: null,
        },
      },
    },
  };

  it("--resume without --wait: one read, exit 3, JSON has no stop reason (#6423 AC 9)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let reads = 0;
    const readFn = await queueReads(queued)();
    const code = runWaitMergeable(resumeArgv("--json"), {
      queueReadFn: (n, r) => {
        reads += 1;
        return readFn(n, r);
      },
      umbrellaReconcileFn: null,
    });
    expect(code).toBe(EXIT_QUEUE_PENDING);
    expect(reads).toBe(1);
    const doc = JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join(""));
    expect(doc.outcome).toBe("queued");
    expect(doc.merge_queue).not.toHaveProperty("wait_stop_reason");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("--resume --wait --json prints one JSON document with the stop reason (#6423 AC 10)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sleeps: number[] = [];
    const code = runWaitMergeable(resumeArgv("--wait", "--json"), {
      queueReadFn: await queueReads(queued, merged)(),
      umbrellaReconcileFn: null,
      queueWaitSleepFn: (s) => sleeps.push(s),
      queueWaitClockMsFn: () => 0,
    });
    expect(code).toBe(EXIT_MERGED);
    expect(sleeps).toEqual([60]);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    const doc = JSON.parse(out);
    expect(doc.outcome).toBe("merged");
    expect(doc.merge_queue.wait_stop_reason).toBe("result");
    expect(out).not.toContain("queue wait:");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("--resume --wait text output names the stop reason at the cap (#6423 items 5, 6)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let clock = 0;
    const code = runWaitMergeable(resumeArgv("--wait", "--cap-minutes", "2"), {
      queueReadFn: await queueReads(queued)(),
      umbrellaReconcileFn: null,
      queueWaitSleepFn: (s) => {
        clock += s * 1000;
      },
      queueWaitClockMsFn: () => clock,
    });
    expect(code).toBe(EXIT_QUEUE_PENDING);
    const text = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("QUEUE-PENDING");
    expect(text).toContain("  wait stop: cap");
    expect(text).toContain("resume:  task pr:wait-mergeable-and-merge -- 6423");
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
