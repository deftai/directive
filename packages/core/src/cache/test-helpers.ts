import type { Clock } from "./time.js";

/** Fixed clock for deterministic TTL tests. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  setNow(dt: Date): void {
    this.current = dt;
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
