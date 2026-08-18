/**
 * Vitest reporter that emits coarse flushed progress for ts:check-lane (#3470).
 *
 * Wired from the lane via `--reporter` so vitest.config.ts stays unchanged.
 * Does not print test names and does not change pass/fail.
 */

import {
  formatProgressLine,
  nextProgressTick,
  type ProgressLineSink,
  writeFlushedLine,
} from "./progress.js";

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
  private readonly sink?: ProgressLineSink;

  constructor(sink?: unknown) {
    // Vitest constructs reporters with its options object; only tests pass a sink.
    this.sink = isLineSink(sink) ? sink : undefined;
  }

  onTestRunStart(specifications: ReadonlyArray<unknown> = []): void {
    this.total = specifications.length;
    this.completed = 0;
    this.lastEmittedPercent = 0;
  }

  onTestModuleEnd(): void {
    this.completed += 1;
    const tick = nextProgressTick(this.completed, this.total, this.lastEmittedPercent);
    if (tick === null) {
      return;
    }
    this.lastEmittedPercent = tick.percent;
    writeFlushedLine(formatProgressLine(tick), this.sink);
  }
}

export default TsCheckLaneProgressReporter;
