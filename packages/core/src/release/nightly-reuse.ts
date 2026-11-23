/**
 * Nightly lane conjunct of the release CI reuse rule (#6849).
 *
 * `.github/workflows/nightly.yml` runs two lanes once a day on the
 * delivery-branch tip: a Linux coverage lane and a Windows full-suite lane.
 * Release readiness and Step 5 read those runs here, so both apply one rule.
 *
 * For each lane the witness is the newest nightly run whose head commit tree
 * equals the clean Step 5 input tree. The lane is reusable only when the
 * latest attempt of that lane's job in that run concluded `success`. A
 * pending, failed or missing latest attempt is not reusable, and an older
 * success (an earlier attempt, or an older run on the same tree) is never
 * used. Any read that fails makes the lane not reusable; nothing here throws.
 */
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { runGit } from "./git.js";
import type { ReleaseSeams } from "./types.js";

/** Workflow file of the nightly lanes (#6849). */
export const NIGHTLY_WORKFLOW_FILE = "nightly.yml" as const;

/** Job name of the Linux coverage lane. */
export const NIGHTLY_COVERAGE_LANE_NAME = "Nightly coverage (Linux)" as const;

/** Job name of the Windows full-suite lane. */
export const NIGHTLY_WINDOWS_LANE_NAME = "Nightly full suite (Windows)" as const;

export type NightlyLaneId = "coverage" | "windows";

export interface NightlyLaneSpec {
  readonly id: NightlyLaneId;
  readonly jobName: string;
  readonly label: string;
}

/** Both lanes, in print order. */
export const NIGHTLY_LANES: readonly NightlyLaneSpec[] = [
  { id: "coverage", jobName: NIGHTLY_COVERAGE_LANE_NAME, label: "coverage (Linux)" },
  { id: "windows", jobName: NIGHTLY_WINDOWS_LANE_NAME, label: "full suite (Windows)" },
];

/** One lane's reuse status. */
export interface NightlyLaneStatus {
  readonly id: NightlyLaneId;
  readonly jobName: string;
  readonly label: string;
  readonly reusable: boolean;
  /** Why the lane is or is not reusable, in one phrase. */
  readonly reason: string;
  readonly runUrl: string | null;
  readonly headSha: string | null;
}

export interface NightlyReuse {
  /** True only when every lane is reusable. */
  readonly reusable: boolean;
  readonly lanes: readonly NightlyLaneStatus[];
}

/** A nightly workflow run as the runs list returns it (fields we read). */
export interface NightlyRunRecord {
  readonly id: number;
  readonly headSha: string;
  readonly treeId: string | null;
  readonly runAttempt: number | null;
  readonly htmlUrl: string | null;
}

/** A job of a run as the jobs list returns it (fields we read). */
export interface NightlyJobRecord {
  readonly id: number | null;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runAttempt: number | null;
}

export type NightlyJobsRead =
  | { readonly jobs: readonly NightlyJobRecord[] }
  | { readonly error: string };

function laneStatus(
  spec: NightlyLaneSpec,
  reusable: boolean,
  reason: string,
  run: NightlyRunRecord | null,
): NightlyLaneStatus {
  return {
    id: spec.id,
    jobName: spec.jobName,
    label: spec.label,
    reusable,
    reason,
    runUrl: run?.htmlUrl ?? null,
    headSha: run?.headSha ?? null,
  };
}

function allLanes(reason: string, run: NightlyRunRecord | null = null): NightlyReuse {
  return {
    reusable: false,
    lanes: NIGHTLY_LANES.map((spec) => laneStatus(spec, false, reason, run)),
  };
}

/**
 * Latest attempt of a named job. A re-run gets a larger run_attempt; when two
 * records share an attempt, the larger job id wins.
 */
export function selectLatestJob(
  jobs: readonly NightlyJobRecord[],
  name: string,
): NightlyJobRecord | null {
  let best: NightlyJobRecord | null = null;
  for (const job of jobs) {
    if (job.name !== name) continue;
    if (best === null) {
      best = job;
      continue;
    }
    const attempt = job.runAttempt ?? 0;
    const bestAttempt = best.runAttempt ?? 0;
    if (attempt > bestAttempt || (attempt === bestAttempt && (job.id ?? 0) > (best.id ?? 0))) {
      best = job;
    }
  }
  return best;
}

/**
 * Decide each lane from the nightly runs (no git, no network).
 *
 * @param runs nightly runs on the delivery branch, any order
 * @param inputTree the clean Step 5 input tree
 * @param readJobs reads the latest-attempt jobs of one run
 */
export function decideNightlyReuse(
  runs: readonly NightlyRunRecord[],
  inputTree: string,
  readJobs: (run: NightlyRunRecord) => NightlyJobsRead,
): NightlyReuse {
  const witness =
    [...runs]
      .filter((run) => run.treeId !== null && run.treeId === inputTree)
      .sort((a, b) => b.id - a.id)[0] ?? null;
  if (witness === null) {
    return allLanes(`no nightly run on tree ${inputTree.slice(0, 12)}`);
  }
  const read = readJobs(witness);
  if ("error" in read) {
    return allLanes(`jobs of nightly run ${witness.id} unreadable: ${read.error}`, witness);
  }
  const lanes = NIGHTLY_LANES.map((spec) => {
    const job = selectLatestJob(read.jobs, spec.jobName);
    if (job === null) {
      return laneStatus(spec, false, `job missing in nightly run ${witness.id}`, witness);
    }
    if (job.status !== "completed") {
      return laneStatus(
        spec,
        false,
        `latest attempt in nightly run ${witness.id} is ${job.status}, not completed`,
        witness,
      );
    }
    if (job.conclusion !== "success") {
      return laneStatus(
        spec,
        false,
        `latest attempt in nightly run ${witness.id} concluded ${job.conclusion ?? "with no conclusion"}`,
        witness,
      );
    }
    return laneStatus(spec, true, `latest attempt in nightly run ${witness.id} succeeded`, witness);
  });
  return { reusable: lanes.every((lane) => lane.reusable), lanes };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse the workflow runs list body. Null when it is not the expected shape. */
export function parseNightlyRuns(body: string): NightlyRunRecord[] | null {
  const list = asRecord(parseJson(body))?.workflow_runs;
  if (!Array.isArray(list)) return null;
  const runs: NightlyRunRecord[] = [];
  for (const item of list) {
    const row = asRecord(item);
    const id = num(row?.id);
    const headSha = str(row?.head_sha);
    if (row === null || id === null || headSha === null) continue;
    runs.push({
      id,
      headSha,
      treeId: str(asRecord(row.head_commit)?.tree_id),
      runAttempt: num(row.run_attempt),
      htmlUrl: str(row.html_url),
    });
  }
  return runs;
}

/** Parse a run's jobs list body. Null when it is not the expected shape. */
export function parseNightlyJobs(body: string): NightlyJobRecord[] | null {
  const list = asRecord(parseJson(body))?.jobs;
  if (!Array.isArray(list)) return null;
  const jobs: NightlyJobRecord[] = [];
  for (const item of list) {
    const row = asRecord(item);
    const name = str(row?.name);
    if (row === null || name === null) continue;
    jobs.push({
      id: num(row.id),
      name,
      status: str(row.status) ?? "unknown",
      conclusion: str(row.conclusion),
      runAttempt: num(row.run_attempt),
    });
  }
  return jobs;
}

/**
 * Read the nightly runs on the delivery branch and decide each lane for the
 * clean Step 5 input tree. A run whose list entry carries no tree gets its
 * tree from git (`<head_sha>^{tree}`) when the commit is local.
 */
export function evaluateNightlyReuse(
  projectRoot: string,
  repo: string,
  baseBranch: string,
  inputTree: string,
  runGh: RunGhFn,
  seams: ReleaseSeams = {},
): NightlyReuse {
  const listed = runGh([
    "gh",
    "api",
    `repos/${repo}/actions/workflows/${NIGHTLY_WORKFLOW_FILE}/runs?branch=${baseBranch}&per_page=50`,
  ]);
  if (listed.returncode !== 0) {
    return allLanes(`nightly runs unreadable: ${listed.stderr.trim() || "gh api failed"}`);
  }
  const parsed = parseNightlyRuns(listed.stdout);
  if (parsed === null) {
    return allLanes("nightly runs unreadable: unexpected response");
  }
  const runs = parsed.map((run) => {
    if (run.treeId !== null) return run;
    const tree = runGit(projectRoot, ["rev-parse", `${run.headSha}^{tree}`], seams);
    const treeId = tree.status === 0 ? tree.stdout.trim() : "";
    return { ...run, treeId: treeId.length > 0 ? treeId : null };
  });
  return decideNightlyReuse(runs, inputTree, (run) => {
    const jobs = runGh([
      "gh",
      "api",
      `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    ]);
    if (jobs.returncode !== 0) return { error: jobs.stderr.trim() || "gh api failed" };
    const list = parseNightlyJobs(jobs.stdout);
    return list === null ? { error: "unexpected response" } : { jobs: list };
  });
}

/** The command that starts the nightly workflow on the delivery branch. */
export function nightlyDispatchCommand(repo: string, baseBranch: string): string {
  return `gh workflow run ${NIGHTLY_WORKFLOW_FILE} --repo ${repo} --ref ${baseBranch}`;
}

/** One line per lane: status, run URL and head SHA. */
export function formatNightlyLanes(nightly: NightlyReuse | null | undefined): string[] {
  if (nightly === null || nightly === undefined) {
    return ["  Nightly lanes: not read (the CI reuse rule stopped before the nightly read)"];
  }
  return nightly.lanes.map(
    (lane) =>
      `  Nightly ${lane.label}: ${lane.reusable ? "reusable" : "not reusable"} (${lane.reason}); ` +
      `run ${lane.runUrl ?? "none"}; head ${lane.headSha ?? "none"}`,
  );
}

/** True when the Windows lane of this nightly read is reusable. */
export function windowsLaneReusable(nightly: NightlyReuse | null | undefined): boolean {
  return nightly?.lanes.some((lane) => lane.id === "windows" && lane.reusable) ?? false;
}

/**
 * Host boundary (#6849 clause 7): the local fallback on a host that is not
 * Windows does not test Windows. Returns the line to print, or null when the
 * host is Windows or the Windows lane is reusable. It never refuses.
 */
export function windowsSuiteSkippedLine(
  nightly: NightlyReuse | null | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (platform === "win32" || windowsLaneReusable(nightly)) return null;
  return (
    "The Windows suite did not run for this release: the nightly Windows lane is not reusable " +
    `and the local fallback runs on ${platform}, not Windows.`
  );
}
