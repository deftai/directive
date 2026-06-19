/** Injectable clock seam for TTL tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

export function utcIso(clock: Clock, dt?: Date): string {
  const date = dt ?? clock.now();
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseIso(stamp: string): Date {
  let text = stamp.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  return new Date(text);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
