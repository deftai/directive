/**
 * Vitest reporter that emits coarse flushed progress for ts:check-lane (#3470).
 *
 * Wired from the lane via `--reporter` so vitest.config.ts stays unchanged.
 * Does not print test names and does not change pass/fail.
 */

import {
  formatLastFileLine,
  formatProgressLine,
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
}

function moduleFilePath(mod: unknown): string {
  if (typeof mod !== "object" || mod === null) return "";
  const rec = mod as Record<string, unknown>;
  if (typeof rec.moduleId === "string" && rec.moduleId.length > 0) return rec.moduleId;
  if (typeof rec.filepath === "string" && rec.filepath.length > 0) return rec.filepath;
  if (typeof rec.id === "string" && rec.id.length > 0) return rec.id;
  return "";
}

function isLineSink(value: unknown): value is ProgressLineSink {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProgressLineSink).write === "function"
  );
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

  constructor(sink?: unknown, clock: ProgressReporterClock = {}) {
    // Vitest constructs reporters with its options object; only tests pass a sink.
    this.sink = isLineSink(sink) ? sink : undefined;
    this.now = clock.now ?? Date.now;
    this.everyN = clock.everyN ?? PROGRESS_FILE_HEARTBEAT_EVERY;
    this.heartbeatMs = clock.heartbeatMs ?? PROGRESS_FILE_HEARTBEAT_MS;
  }

  onTestRunStart(specifications: ReadonlyArray<unknown> = []): void {
    this.total = specifications.length;
    this.completed = 0;
    this.lastEmittedPercent = 0;
    this.lastHeartbeatCompleted = 0;
    this.lastHeartbeatAtMs = this.now();
  }

  onTestModuleEnd(mod?: unknown): void {
    this.completed += 1;
    const lastFile = moduleFilePath(mod);
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
      writeFlushedLine(formatLastFileLine(heartbeat), this.sink);
    }
    const tick = nextProgressTick(this.completed, this.total, this.lastEmittedPercent);
    if (tick === null) {
      return;
    }
    this.lastEmittedPercent = tick.percent;
    writeFlushedLine(formatProgressLine(tick), this.sink);
  }
}

export default TsCheckLaneProgressReporter;
