/**
 * Coarse percent/count ticks for ts:check-lane (#3470).
 *
 * Band math is independent of vitest so tests can cover cadence and flush
 * without running the suite.
 */

import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Relative to the repo root; wired onto `pnpm run test` from the lane. */
export const PROGRESS_REPORTER_RELATIVE_PATH =
  "packages/core/src/ts-check-lane/progress-reporter.ts";

/** One line every 20% of known files -- coarse enough for a log snapshot. */
export const PROGRESS_BAND_PERCENT = 20;

/** Last-completed-file heartbeat cadence (#4567). Complements 20% bands. */
const LAST_FILE_HEARTBEAT = { everyFiles: 10, everyMs: 30_000 };
export const PROGRESS_FILE_HEARTBEAT_EVERY = LAST_FILE_HEARTBEAT.everyFiles;
export const PROGRESS_FILE_HEARTBEAT_MS = LAST_FILE_HEARTBEAT.everyMs;

export const PROGRESS_UNIT = "files";

export interface ProgressTick {
  readonly percent: number;
  readonly completed: number;
  readonly total: number;
}

export interface ProgressLineSink {
  write(chunk: string): void;
  flush?: () => void;
}

export function nextProgressTick(
  completed: number,
  total: number,
  lastEmittedPercent: number,
  bandPercent: number = PROGRESS_BAND_PERCENT,
): ProgressTick | null {
  if (
    !Number.isFinite(completed) ||
    !Number.isFinite(total) ||
    !Number.isFinite(lastEmittedPercent)
  ) {
    return null;
  }
  if (total <= 0 || completed <= 0 || bandPercent <= 0) {
    return null;
  }
  const raw = Math.min(100, Math.floor((completed / total) * 100));
  const band = Math.floor(raw / bandPercent) * bandPercent;
  if (band < bandPercent || band <= lastEmittedPercent) {
    return null;
  }
  return { percent: band, completed, total };
}

export function formatProgressLine(tick: ProgressTick, unit: string = PROGRESS_UNIT): string {
  return `ts:check-lane ${tick.percent}% (${tick.completed}/${tick.total} ${unit})`;
}

export interface LastFileTick {
  readonly completed: number;
  readonly total: number;
  readonly lastFile: string;
}

export function formatLastFileLine(tick: LastFileTick, unit: string = PROGRESS_UNIT): string {
  return `ts:check-lane last-file ${tick.lastFile} (${tick.completed}/${tick.total} ${unit})`;
}

export function nextLastFileTick(
  completed: number,
  total: number,
  lastFile: string,
  lastHeartbeatCompleted: number,
  lastHeartbeatAtMs: number,
  nowMs: number,
  everyN: number = PROGRESS_FILE_HEARTBEAT_EVERY,
  heartbeatMs: number = PROGRESS_FILE_HEARTBEAT_MS,
): LastFileTick | null {
  if (
    !Number.isFinite(completed) ||
    !Number.isFinite(total) ||
    !Number.isFinite(lastHeartbeatCompleted) ||
    !Number.isFinite(lastHeartbeatAtMs) ||
    !Number.isFinite(nowMs)
  ) {
    return null;
  }
  if (completed <= 0 || lastFile.length === 0 || everyN <= 0 || heartbeatMs <= 0) {
    return null;
  }
  const dueByCount =
    lastHeartbeatCompleted === 0 ? completed >= 1 : completed - lastHeartbeatCompleted >= everyN;
  const dueByTime = nowMs - lastHeartbeatAtMs >= heartbeatMs;
  if (!dueByCount && !dueByTime) return null;
  return { completed, total, lastFile };
}

export interface WriteFlushedLineOptions {
  readonly fd?: number;
  readonly syncWrite?: (fd: number, payload: string) => void;
}

/** writeSync so a non-TTY capture sees each tick immediately (#1353). */
export function writeFlushedLine(
  line: string,
  sink?: ProgressLineSink,
  options: WriteFlushedLineOptions = {},
): void {
  const payload = line.endsWith("\n") ? line : `${line}\n`;
  if (sink !== undefined && typeof sink.write === "function") {
    sink.write(payload);
    sink.flush?.();
    return;
  }
  const syncWrite = options.syncWrite ?? writeSync;
  syncWrite(options.fd ?? 1, payload);
  // Hang-detector tees stderr separately from the 256KB stdout coverage dump (#4744).
  if (options.fd === undefined && options.syncWrite === undefined) {
    process.stderr.write(payload);
  }
}

export function buildTestLaneCommand(
  reporterPath: string = PROGRESS_REPORTER_RELATIVE_PATH,
): readonly string[] {
  // Do not insert a standalone "--": pnpm forwards it to vitest, which then
  // treats later --reporter flags as file filters (#3470).
  return ["run", "test", "--reporter", reporterPath, "--reporter", "default"];
}

/** Attach the reporter only when the source file is present (framework checkout). */
export function resolveTestLaneCommand(
  projectRoot: string,
  exists: (path: string) => boolean = existsSync,
): readonly string[] {
  const reporterAbs = join(projectRoot, ...PROGRESS_REPORTER_RELATIVE_PATH.split("/"));
  if (!exists(reporterAbs)) {
    return ["run", "test"];
  }
  return buildTestLaneCommand();
}

/** Release-host timeline prefix. Last-file lines stay on the hang-detector regex. */
export const TIMELINE_PREFIX = "ts:check-lane timeline";

/** Spawn-heavy is the remaining class only when it finishes this far after unit. */
export const SPAWN_HEAVY_TAIL_MS = 5 * 60 * 1000;

export interface LaneTimelineConditions {
  readonly coverage: boolean;
  readonly supervised: boolean;
  readonly host: string;
  readonly cpus: number;
  readonly cold: boolean;
}

export function formatTimelineConditionsLine(conditions: LaneTimelineConditions): string {
  const coverage = conditions.coverage ? "true" : "false";
  const supervised = conditions.supervised ? "true" : "false";
  const cold = conditions.cold ? "true" : "false";
  return `${TIMELINE_PREFIX} conditions coverage=${coverage} supervised=${supervised} host=${conditions.host} cpus=${String(conditions.cpus)} cold=${cold}`;
}

export function formatLanePhaseLine(phase: string, elapsedMs: number): string {
  return `${TIMELINE_PREFIX} ${phase} ${String(elapsedMs)}ms`;
}

export function formatProjectCompleteLine(
  project: string,
  elapsedMs: number,
  files: number,
): string {
  return `${TIMELINE_PREFIX} project ${project} complete ${String(elapsedMs)}ms files=${String(files)}`;
}

export function formatCoverageReportLine(elapsedMs: number): string {
  return `${TIMELINE_PREFIX} coverage-merge-report ${String(elapsedMs)}ms`;
}

export function formatInFlightLine(paths: readonly string[]): string {
  const listed = paths.length > 0 ? paths.join(",") : "(none)";
  return `${TIMELINE_PREFIX} in-flight ${listed}`;
}

export function formatFileDurationLine(file: string, elapsedMs: number, project: string): string {
  return `${TIMELINE_PREFIX} file ${file} ${String(elapsedMs)}ms project=${project}`;
}

export interface TimelineCostSample {
  /** Elapsed ms from the same run start as formatProjectCompleteLine. */
  readonly unitCompleteMs: number | null;
  /** Elapsed ms from the same run start as formatProjectCompleteLine. */
  readonly spawnHeavyCompleteMs: number | null;
  /** Elapsed ms from the same run start as formatCoverageReportLine. */
  readonly coverageMergeReportMs: number | null;
}

export interface NamedCostClass {
  readonly costClass:
    | "unmeasured"
    | "spawn-heavy-project"
    | "coverage-merge-report"
    | "unit-project";
  readonly reason: string;
}

/**
 * Name the next cost class from a release-host timeline.
 * unit/spawn/coverage are all elapsed-from-run-start. Ignore coverage that
 * ends before both projects (mixed-origin / stale sample).
 * Does not bind "spawn-heavy one-worker tail" without a 5-minute tail after unit.
 */
export function nameNextCostClass(sample: TimelineCostSample): NamedCostClass {
  const unit = sample.unitCompleteMs;
  const spawn = sample.spawnHeavyCompleteMs;
  const coverage = sample.coverageMergeReportMs;
  if (unit === null && spawn === null && coverage === null) {
    return { costClass: "unmeasured", reason: "no project or coverage-merge timestamps" };
  }
  if (
    spawn !== null &&
    unit !== null &&
    spawn - unit >= SPAWN_HEAVY_TAIL_MS &&
    (coverage === null || spawn >= coverage)
  ) {
    return {
      costClass: "spawn-heavy-project",
      reason: "spawn-heavy finished 5+ min after unit and was still the tail",
    };
  }
  if (coverage !== null && unit !== null && spawn !== null) {
    const projectsDone = Math.max(unit, spawn);
    if (coverage >= projectsDone && coverage - projectsDone >= 60_000) {
      return {
        costClass: "coverage-merge-report",
        reason: "coverage merge/report continued after both projects",
      };
    }
  }
  if (spawn !== null && unit !== null && spawn > unit && spawn - unit < SPAWN_HEAVY_TAIL_MS) {
    return {
      costClass: "unit-project",
      reason: "spawn-heavy tail is shorter than 5 min; do not bind spawn-heavy one-worker tail",
    };
  }
  return {
    costClass: "unit-project",
    reason: "unit-project completion is the remaining critical path",
  };
}
