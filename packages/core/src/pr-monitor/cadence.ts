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
