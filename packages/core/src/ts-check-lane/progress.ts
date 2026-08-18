/**
 * Coarse percent/count ticks for ts:check-lane (#3470).
 *
 * Band math is independent of vitest so tests can cover cadence and flush
 * without running the suite.
 */

import { writeSync } from "node:fs";

/** Relative to the repo root; wired onto `pnpm run test` from the lane. */
export const PROGRESS_REPORTER_RELATIVE_PATH =
  "packages/core/src/ts-check-lane/progress-reporter.ts";

/** One line every 20% of known files -- coarse enough for a log snapshot. */
export const PROGRESS_BAND_PERCENT = 20;

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
}

export function buildTestLaneCommand(
  reporterPath: string = PROGRESS_REPORTER_RELATIVE_PATH,
): readonly string[] {
  // Do not insert a standalone "--": pnpm forwards it to vitest, which then
  // treats later --reporter flags as file filters (#3470).
  return ["run", "test", "--reporter", reporterPath, "--reporter", "default"];
}
