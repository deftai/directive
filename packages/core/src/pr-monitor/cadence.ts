import { DEFAULT_CADENCE } from "./constants.js";

/** Expand cadence tuple into per-poll interval seconds. */
export function cadenceIntervals(
  cadence: ReadonlyArray<readonly [number, number]> = DEFAULT_CADENCE,
): number[] {
  const intervals: number[] = [];
  for (const [interval, repeats] of cadence) {
    for (let i = 0; i < repeats; i += 1) {
      intervals.push(interval);
    }
  }
  return intervals;
}

/**
 * Seconds to sleep after poll `pollIndex` (1-based). Repeats the final cadence
 * tier once the configured repeats are exhausted so the monitor can run until
 * the cap instead of stopping after a fixed poll budget (#2581).
 */
export function cadenceIntervalAfterPoll(
  pollIndex: number,
  cadence: ReadonlyArray<readonly [number, number]> = DEFAULT_CADENCE,
): number {
  const intervals = cadenceIntervals(cadence);
  if (intervals.length === 0) {
    return 60;
  }
  const idx = Math.min(Math.max(pollIndex, 1) - 1, intervals.length - 1);
  return intervals[idx] ?? intervals[intervals.length - 1] ?? 60;
}
