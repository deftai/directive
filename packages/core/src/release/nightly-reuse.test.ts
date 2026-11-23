import { describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import {
  decideNightlyReuse,
  evaluateNightlyReuse,
  formatNightlyLanes,
  NIGHTLY_COVERAGE_LANE_NAME,
  NIGHTLY_WINDOWS_LANE_NAME,
  type NightlyJobRecord,
  type NightlyRunRecord,
  nightlyDispatchCommand,
  parseNightlyJobs,
  parseNightlyRuns,
  selectLatestJob,
  windowsLaneReusable,
  windowsSuiteSkippedLine,
} from "./nightly-reuse.js";
import type { ReleaseSeams } from "./types.js";

const REPO = "deftai/directive";
const TREE = "2".repeat(40);
const OTHER_TREE = "3".repeat(40);
const SHA_NEW = "a".repeat(40);
const SHA_OLD = "b".repeat(40);

function runRecord(id: number, treeId: string | null, headSha = SHA_NEW): NightlyRunRecord {
  return {
    id,
    headSha,
    treeId,
    runAttempt: 1,
    htmlUrl: `https://github.com/${REPO}/actions/runs/${id}`,
  };
}

function job(
  name: string,
  conclusion: string | null = "success",
  status = "completed",
  runAttempt = 1,
  id = 1,
): NightlyJobRecord {
  return { id, name, status, conclusion, runAttempt };
}

const GREEN_JOBS = [
  job(NIGHTLY_COVERAGE_LANE_NAME),
  job(NIGHTLY_WINDOWS_LANE_NAME, "success", "completed", 1, 2),
];

describe("decideNightlyReuse (#6849 clause 6)", () => {
  it("reuses both lanes when the newest run on the input tree succeeded on its latest attempt", () => {
    const result = decideNightlyReuse([runRecord(7, TREE)], TREE, () => ({ jobs: GREEN_JOBS }));
    expect(result.reusable).toBe(true);
    expect(result.lanes.map((l) => l.id)).toEqual(["coverage", "windows"]);
    expect(result.lanes[0]).toMatchObject({
      reusable: true,
      runUrl: `https://github.com/${REPO}/actions/runs/7`,
      headSha: SHA_NEW,
    });
  });

  it("does not reuse a green run on an ancestor whose tree differs (clause 18)", () => {
    const read: string[] = [];
    const result = decideNightlyReuse([runRecord(7, OTHER_TREE, SHA_OLD)], TREE, (run) => {
      read.push(String(run.id));
      return { jobs: GREEN_JOBS };
    });
    expect(result.reusable).toBe(false);
    expect(result.lanes.every((l) => !l.reusable && /no nightly run on tree/.test(l.reason))).toBe(
      true,
    );
    expect(read).toEqual([]);
  });

  it("uses only the newest matching run, never an older success", () => {
    const runs = [runRecord(5, TREE, SHA_OLD), runRecord(9, TREE)];
    const result = decideNightlyReuse(runs, TREE, (run) =>
      run.id === 9
        ? { jobs: [job(NIGHTLY_COVERAGE_LANE_NAME, "failure"), GREEN_JOBS[1] as NightlyJobRecord] }
        : { jobs: GREEN_JOBS },
    );
    expect(result.reusable).toBe(false);
    expect(result.lanes[0]?.reason).toMatch(/nightly run 9 concluded failure/);
    expect(result.lanes[1]?.reusable).toBe(true);
  });

  it("does not reuse a lane whose latest attempt failed or is pending, even after an earlier success (clause 19)", () => {
    const failedRerun = [
      job(NIGHTLY_COVERAGE_LANE_NAME, "success", "completed", 1, 10),
      job(NIGHTLY_COVERAGE_LANE_NAME, "failure", "completed", 2, 11),
      job(NIGHTLY_WINDOWS_LANE_NAME, "success", "completed", 1, 12),
      job(NIGHTLY_WINDOWS_LANE_NAME, null, "in_progress", 2, 13),
    ];
    const result = decideNightlyReuse([runRecord(7, TREE)], TREE, () => ({ jobs: failedRerun }));
    expect(result.reusable).toBe(false);
    expect(result.lanes[0]?.reason).toMatch(/concluded failure/);
    expect(result.lanes[1]?.reason).toMatch(/is in_progress, not completed/);
  });

  it("marks a missing job and unreadable jobs as not reusable", () => {
    const missing = decideNightlyReuse([runRecord(7, TREE)], TREE, () => ({
      jobs: [job(NIGHTLY_COVERAGE_LANE_NAME)],
    }));
    expect(missing.lanes[1]?.reason).toMatch(/job missing in nightly run 7/);
    const unreadable = decideNightlyReuse([runRecord(7, TREE)], TREE, () => ({
      error: "HTTP 502",
    }));
    expect(unreadable.reusable).toBe(false);
    expect(unreadable.lanes[0]?.reason).toMatch(/unreadable: HTTP 502/);
    const noConclusion = decideNightlyReuse([runRecord(7, TREE)], TREE, () => ({
      jobs: [job(NIGHTLY_COVERAGE_LANE_NAME, null), GREEN_JOBS[1] as NightlyJobRecord],
    }));
    expect(noConclusion.lanes[0]?.reason).toMatch(/with no conclusion/);
  });
});

describe("selectLatestJob", () => {
  it("prefers the larger attempt, then the larger id, and returns null when absent", () => {
    const jobs = [
      job("x", "failure", "completed", 2, 3),
      job("x", "success", "completed", 1, 9),
      job("x", "success", "completed", 2, 4),
    ];
    expect(selectLatestJob(jobs, "x")?.id).toBe(4);
    expect(selectLatestJob(jobs, "y")).toBeNull();
    expect(
      selectLatestJob(
        [
          { id: null, name: "z", status: "completed", conclusion: "success", runAttempt: null },
          { id: 2, name: "z", status: "completed", conclusion: "failure", runAttempt: null },
        ],
        "z",
      )?.conclusion,
    ).toBe("failure");
  });
});

describe("parsing", () => {
  it("parses runs and jobs and rejects other shapes", () => {
    const runs = parseNightlyRuns(
      JSON.stringify({
        workflow_runs: [
          {
            id: 1,
            head_sha: SHA_NEW,
            head_commit: { tree_id: TREE },
            run_attempt: 2,
            html_url: "u",
          },
          { id: 2, head_sha: SHA_OLD },
          { head_sha: "x" },
          null,
        ],
      }),
    );
    expect(runs).toEqual([
      { id: 1, headSha: SHA_NEW, treeId: TREE, runAttempt: 2, htmlUrl: "u" },
      { id: 2, headSha: SHA_OLD, treeId: null, runAttempt: null, htmlUrl: null },
    ]);
    expect(parseNightlyRuns("not json")).toBeNull();
    expect(parseNightlyRuns("{}")).toBeNull();
    const jobs = parseNightlyJobs(
      JSON.stringify({
        jobs: [{ id: 3, name: "n", status: "queued", conclusion: null }, { id: 4 }],
      }),
    );
    expect(jobs).toEqual([
      { id: 3, name: "n", status: "queued", conclusion: null, runAttempt: null },
    ]);
    expect(parseNightlyJobs("[]")).toBeNull();
  });
});

function ghFake(opts: { runs?: unknown; jobs?: unknown; runsFail?: boolean; jobsFail?: boolean }) {
  const calls: string[] = [];
  const runGh: RunGhFn = (cmd) => {
    const joined = cmd.join(" ");
    calls.push(joined);
    if (joined.includes("/actions/workflows/nightly.yml/runs")) {
      return opts.runsFail
        ? { returncode: 1, stdout: "", stderr: "HTTP 404" }
        : { returncode: 0, stdout: JSON.stringify(opts.runs ?? { workflow_runs: [] }), stderr: "" };
    }
    if (joined.includes("/jobs?filter=latest")) {
      return opts.jobsFail
        ? { returncode: 1, stdout: "", stderr: "" }
        : { returncode: 0, stdout: JSON.stringify(opts.jobs ?? { jobs: [] }), stderr: "" };
    }
    return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
  };
  return { runGh, calls };
}

const GREEN_JOBS_BODY = {
  jobs: [
    {
      id: 1,
      name: NIGHTLY_COVERAGE_LANE_NAME,
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
    },
    {
      id: 2,
      name: NIGHTLY_WINDOWS_LANE_NAME,
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
    },
  ],
};

describe("evaluateNightlyReuse", () => {
  it("reads the master runs of nightly.yml and the latest-attempt jobs of the witness", () => {
    const gh = ghFake({
      runs: { workflow_runs: [{ id: 42, head_sha: SHA_NEW, head_commit: { tree_id: TREE } }] },
      jobs: GREEN_JOBS_BODY,
    });
    const result = evaluateNightlyReuse("/repo", REPO, "master", TREE, gh.runGh);
    expect(result.reusable).toBe(true);
    expect(gh.calls[0]).toContain(`repos/${REPO}/actions/workflows/nightly.yml/runs?branch=master`);
    expect(gh.calls[1]).toContain(`repos/${REPO}/actions/runs/42/jobs?filter=latest`);
  });

  it("gets a run's tree from git when the list carries none", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, args) =>
        args.join(" ").endsWith(`rev-parse ${SHA_NEW}^{tree}`)
          ? { status: 0, stdout: `${TREE}\n`, stderr: "" }
          : { status: 1, stdout: "", stderr: "unknown" },
    };
    const gh = ghFake({
      runs: {
        workflow_runs: [
          { id: 42, head_sha: SHA_NEW },
          { id: 41, head_sha: SHA_OLD },
        ],
      },
      jobs: GREEN_JOBS_BODY,
    });
    expect(evaluateNightlyReuse("/repo", REPO, "master", TREE, gh.runGh, seams).reusable).toBe(
      true,
    );
  });

  it("is not reusable, and does not throw, when a read fails", () => {
    expect(
      evaluateNightlyReuse("/repo", REPO, "master", TREE, ghFake({ runsFail: true }).runGh).lanes[0]
        ?.reason,
    ).toMatch(/nightly runs unreadable: HTTP 404/);
    const garbled: RunGhFn = () => ({ returncode: 0, stdout: "<html>", stderr: "" });
    expect(evaluateNightlyReuse("/repo", REPO, "master", TREE, garbled).lanes[0]?.reason).toMatch(
      /unexpected response/,
    );
    const runs = { workflow_runs: [{ id: 42, head_sha: SHA_NEW, head_commit: { tree_id: TREE } }] };
    expect(
      evaluateNightlyReuse("/repo", REPO, "master", TREE, ghFake({ runs, jobsFail: true }).runGh)
        .reusable,
    ).toBe(false);
    expect(
      evaluateNightlyReuse("/repo", REPO, "master", TREE, ghFake({ runs, jobs: { x: 1 } }).runGh)
        .lanes[0]?.reason,
    ).toMatch(/unexpected response/);
  });
});

describe("printing (#6849 clauses 6, 7, 20, 21)", () => {
  const green = decideNightlyReuse([runRecord(7, TREE)], TREE, () => ({ jobs: GREEN_JOBS }));
  const red = decideNightlyReuse([runRecord(7, OTHER_TREE)], TREE, () => ({ jobs: GREEN_JOBS }));

  it("prints each lane with its status, run URL and head SHA", () => {
    const text = formatNightlyLanes(green).join("\n");
    expect(text).toContain("Nightly coverage (Linux): reusable");
    expect(text).toContain("Nightly full suite (Windows): reusable");
    expect(text).toContain(`https://github.com/${REPO}/actions/runs/7`);
    expect(text).toContain(SHA_NEW);
    expect(formatNightlyLanes(red).join("\n")).toContain("run none; head none");
    expect(formatNightlyLanes(null)[0]).toMatch(/not read/);
  });

  it("prints the dispatch command for the delivery branch", () => {
    expect(nightlyDispatchCommand(REPO, "master")).toBe(
      `gh workflow run nightly.yml --repo ${REPO} --ref master`,
    );
  });

  it("says the Windows suite did not run only on a non-Windows host with the Windows lane not reusable", () => {
    expect(windowsLaneReusable(green)).toBe(true);
    expect(windowsLaneReusable(undefined)).toBe(false);
    expect(windowsSuiteSkippedLine(red, "linux")).toMatch(
      /Windows suite did not run for this release/,
    );
    expect(windowsSuiteSkippedLine(null, "darwin")).toMatch(/runs on darwin, not Windows/);
    expect(windowsSuiteSkippedLine(red, "win32")).toBeNull();
    expect(windowsSuiteSkippedLine(green, "linux")).toBeNull();
  });
});
