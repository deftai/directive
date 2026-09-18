/**
 * Vitest reporter that emits coarse flushed progress for ts:check-lane (#3470).
 *
 * Wired from the lane via --reporter so vitest.config.ts stays unchanged.
 * Does not print test names and does not change pass/fail.
 *
 * Timeline lines (#4744 leftover) separate unit-project completion,
 * spawn-heavy-project completion, and coverage merge/report. They do not
 * change last-file format used by named-cause.
 */

import { cpus } from "node:os";
import {
  formatCoverageReportLine,
  formatFileDurationLine,
  formatInFlightLine,
  formatLastFileLine,
  formatProgressLine,
  formatProjectCompleteLine,
  formatTimelineConditionsLine,
  nextLastFileTick,
  nextProgressTick,
  PROGRESS_FILE_HEARTBEAT_EVERY,
  PROGRESS_FILE_HEARTBEAT_MS,
  type ProgressLineSink,
  writeFlushedLine,
} from "./progress.js";

export interface ProgressReporterClock {
  readonly now?: () => number;
  readonly everyN?: number;
  readonly heartbeatMs?: number;
  readonly timeline?: boolean;
  readonly coverage?: boolean;
  readonly supervised?: boolean;
  readonly host?: string;
  readonly cpus?: number;
  readonly cold?: boolean;
}

function moduleFilePath(mod: unknown): string {
  if (typeof mod !== "object" || mod === null) return "";
  const rec = mod as Record<string, unknown>;
  if (typeof rec.moduleId === "string" && rec.moduleId.length > 0) return rec.moduleId;
  if (typeof rec.filepath === "string" && rec.filepath.length > 0) return rec.filepath;
  if (typeof rec.id === "string" && rec.id.length > 0) return rec.id;
  return "";
}

function projectNameOf(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const rec = value as Record<string, unknown>;
  if (typeof rec.projectName === "string" && rec.projectName.length > 0) return rec.projectName;
  const project = rec.project;
  if (typeof project === "object" && project !== null) {
    const named = project as Record<string, unknown>;
    if (typeof named.name === "string" && named.name.length > 0) return named.name;
  }
  return "";
}

function isLineSink(value: unknown): value is ProgressLineSink {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProgressLineSink).write === "function"
  );
}

interface ProjectBucket {
  expected: number;
  completed: number;
  startedAt: number;
  endedAt: number | null;
}

export class TsCheckLaneProgressReporter {
  private total = 0;
  private completed = 0;
  private lastEmittedPercent = 0;
  private lastHeartbeatCompleted = 0;
  private lastHeartbeatAtMs = 0;
  private readonly sink?: ProgressLineSink;
  private readonly now: () => number;
  private readonly everyN: number;
  private readonly heartbeatMs: number;
  private timeline: boolean;
  private readonly coverage: boolean;
  private readonly supervised: boolean;
  private readonly host: string;
  private readonly cpus: number;
  private readonly cold: boolean;
  private runStartedAt = 0;
  private lastModuleEndAt = 0;
  private coverageReported = false;
  private conditionsEmitted = false;
  private readonly projects = new Map<string, ProjectBucket>();
  private readonly inFlight = new Map<string, { startedAt: number; project: string }>();

  constructor(sink?: unknown, clock: ProgressReporterClock = {}) {
    this.sink = isLineSink(sink) ? sink : undefined;
    this.now = clock.now ?? Date.now;
    this.everyN = clock.everyN ?? PROGRESS_FILE_HEARTBEAT_EVERY;
    this.heartbeatMs = clock.heartbeatMs ?? PROGRESS_FILE_HEARTBEAT_MS;
    this.timeline = clock.timeline === true;
    this.coverage =
      clock.coverage ??
      process.argv.some((arg) => arg === "--coverage" || arg.startsWith("--coverage."));
    this.supervised = clock.supervised ?? process.env.DEFT_TS_LANE_SUPERVISED === "1";
    this.host = clock.host ?? process.platform;
    this.cpus = clock.cpus ?? Number(process.env.DEFT_TS_LANE_CPUS || cpus().length);
    this.cold = clock.cold ?? process.env.DEFT_TS_LANE_COLD === "1";
  }

  private emit(line: string): void {
    writeFlushedLine(line, this.sink);
  }

  private emitConditions(): void {
    if (!this.timeline || this.conditionsEmitted) return;
    this.conditionsEmitted = true;
    this.emit(
      formatTimelineConditionsLine({
        coverage: this.coverage,
        supervised: this.supervised,
        host: this.host,
        cpus: this.cpus,
        cold: this.cold,
      }),
    );
  }

  onTestRunStart(specifications: ReadonlyArray<unknown> = []): void {
    this.total = specifications.length;
    this.completed = 0;
    this.lastEmittedPercent = 0;
    this.lastHeartbeatCompleted = 0;
    this.lastHeartbeatAtMs = this.now();
    this.runStartedAt = this.now();
    this.lastModuleEndAt = this.runStartedAt;
    this.coverageReported = false;
    this.conditionsEmitted = false;
    this.projects.clear();
    this.inFlight.clear();
    for (const spec of specifications) {
      const project = projectNameOf(spec);
      if (project.length > 0) this.timeline = true;
      if (project.length === 0) continue;
      const bucket = this.projects.get(project);
      if (bucket === undefined) {
        this.projects.set(project, {
          expected: 1,
          completed: 0,
          startedAt: this.runStartedAt,
          endedAt: null,
        });
      } else {
        bucket.expected += 1;
      }
    }
    this.emitConditions();
  }

  onTestModuleStart(mod?: unknown): void {
    const file = moduleFilePath(mod);
    const project = projectNameOf(mod);
    if (project.length > 0) this.timeline = true;
    const startedAt = this.now();
    if (file.length > 0) {
      this.inFlight.set(file, { startedAt, project: project.length > 0 ? project : "unknown" });
    }
    if (project.length > 0) {
      const bucket = this.projects.get(project);
      if (bucket === undefined) {
        this.projects.set(project, {
          expected: 0,
          completed: 0,
          startedAt,
          endedAt: null,
        });
      }
    }
    this.emitConditions();
  }

  onTestModuleEnd(mod?: unknown): void {
    this.completed += 1;
    const lastFile = moduleFilePath(mod);
    const started = this.inFlight.get(lastFile);
    this.inFlight.delete(lastFile);
    const endedAt = this.now();
    this.lastModuleEndAt = endedAt;
    if (this.timeline && started !== undefined) {
      const elapsed = endedAt - started.startedAt;
      if (elapsed >= PROGRESS_FILE_HEARTBEAT_MS && lastFile.length > 0) {
        this.emit(formatFileDurationLine(lastFile, elapsed, started.project));
      }
    }
    const project = projectNameOf(mod) || started?.project || "";
    if (project.length > 0) {
      let bucket = this.projects.get(project);
      if (bucket === undefined) {
        bucket = { expected: 0, completed: 0, startedAt: this.runStartedAt, endedAt: null };
        this.projects.set(project, bucket);
      }
      bucket.completed += 1;
      if (bucket.expected > 0 && bucket.completed >= bucket.expected && bucket.endedAt === null) {
        bucket.endedAt = endedAt;
        if (this.timeline) {
          this.emit(
            formatProjectCompleteLine(project, endedAt - bucket.startedAt, bucket.completed),
          );
        }
      }
    }
    const heartbeat = nextLastFileTick(
      this.completed,
      this.total,
      lastFile,
      this.lastHeartbeatCompleted,
      this.lastHeartbeatAtMs,
      this.now(),
      this.everyN,
      this.heartbeatMs,
    );
    if (heartbeat !== null) {
      this.lastHeartbeatCompleted = heartbeat.completed;
      this.lastHeartbeatAtMs = this.now();
      this.emit(formatLastFileLine(heartbeat));
      if (this.timeline) {
        this.emit(formatInFlightLine([...this.inFlight.keys()]));
      }
    }
    const tick = nextProgressTick(this.completed, this.total, this.lastEmittedPercent);
    if (tick === null) {
      return;
    }
    this.lastEmittedPercent = tick.percent;
    this.emit(formatProgressLine(tick));
  }

  onCoverage(_coverage?: unknown): void {
    this.reportCoverageMerge();
  }

  onTestRunEnd(): void {
    if (this.timeline) {
      for (const [project, bucket] of this.projects) {
        if (bucket.endedAt === null && bucket.completed > 0) {
          bucket.endedAt = this.lastModuleEndAt;
          this.emit(
            formatProjectCompleteLine(project, bucket.endedAt - bucket.startedAt, bucket.completed),
          );
        }
      }
    }
    this.reportCoverageMerge();
  }

  private reportCoverageMerge(): void {
    if (!this.timeline || this.coverageReported) return;
    this.coverageReported = true;
    const elapsed = this.now() - this.runStartedAt;
    this.emit(formatCoverageReportLine(elapsed));
  }
}

export default TsCheckLaneProgressReporter;
