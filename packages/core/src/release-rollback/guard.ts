import {
  DEFAULT_BOT_THRESHOLD,
  DOUBLE_READ_SLEEP_SECONDS,
  FIVE_MINUTES_SECONDS,
  THIRTY_MINUTES_SECONDS,
} from "./constants.js";
import { ghReleaseViewJson } from "./gh.js";
import type { GhReleasePayload, RollbackSeams } from "./types.js";

export function sumDownloads(payload: GhReleasePayload): number {
  const assets = payload.assets ?? [];
  let total = 0;
  for (const asset of assets) {
    const count = asset.downloadCount;
    const parsed = Number(count);
    if (!Number.isNaN(parsed)) {
      total += parsed;
    }
  }
  return total;
}

export function releaseAgeSeconds(payload: GhReleasePayload, now: Date = new Date()): number {
  const createdAt = payload.createdAt ?? payload.publishedAt;
  if (!createdAt) {
    return 0;
  }
  try {
    let normalized = createdAt;
    if (normalized.endsWith("Z")) {
      normalized = `${normalized.slice(0, -1)}+00:00`;
    }
    const dt = new Date(normalized);
    if (Number.isNaN(dt.getTime())) {
      return 0;
    }
    const deltaMs = now.getTime() - dt.getTime();
    return Math.max(0, Math.floor(deltaMs / 1000));
  } catch {
    return 0;
  }
}

export function computeThreshold(
  ageSeconds: number,
  options: {
    allowLowDownloads: number;
    allowDataLoss: boolean;
    forceStrict0: boolean;
  },
): [number | null, string] {
  const { allowLowDownloads, allowDataLoss, forceStrict0 } = options;
  if (forceStrict0) {
    return [0, "--force-strict-0 override (require exactly 0 downloads)"];
  }
  if (allowDataLoss) {
    return [2 ** 31 - 1, "--allow-data-loss override (accept any count)"];
  }
  if (ageSeconds < FIVE_MINUTES_SECONDS) {
    return [0, "release age < 5 min; threshold=0 (rollback safe)"];
  }
  if (ageSeconds < THIRTY_MINUTES_SECONDS) {
    const threshold = Math.max(allowLowDownloads, DEFAULT_BOT_THRESHOLD);
    return [
      threshold,
      `release age 5-30 min; threshold=${threshold} ` +
        `(filters bot fetches; --allow-low-downloads=${allowLowDownloads})`,
    ];
  }
  return [
    null,
    "release age > 30 min; downloads likely consumer-driven. " +
      "Pass --allow-data-loss to acknowledge consumer impact, OR " +
      "abandon rollback in favour of a hot-fix release with a " +
      "withdrawal note in the next CHANGELOG entry.",
  ];
}

export function doubleReadDownloads(
  version: string,
  repo: string,
  options: { sleepSeconds?: number } = {},
  seams: RollbackSeams = {},
): [boolean, number, number, string] {
  const sleepSeconds = options.sleepSeconds ?? DOUBLE_READ_SLEEP_SECONDS;

  const [ok1, payload1, reason1] = ghReleaseViewJson(version, repo, seams);
  if (!ok1 || payload1 === null) {
    return [false, 0, 0, `first read failed: ${reason1}`];
  }
  const firstCount = sumDownloads(payload1);

  if (sleepSeconds > 0) {
    const sleepFn =
      seams.sleep ??
      ((seconds: number) => {
        const start = Date.now();
        while (Date.now() - start < seconds * 1000) {
          // busy-wait fallback
        }
      });
    sleepFn(sleepSeconds);
  }

  const [ok2, payload2, reason2] = ghReleaseViewJson(version, repo, seams);
  if (!ok2 || payload2 === null) {
    return [false, firstCount, 0, `second read failed: ${reason2}`];
  }
  const secondCount = sumDownloads(payload2);

  if (secondCount > firstCount) {
    return [
      false,
      firstCount,
      secondCount,
      `download_count grew between reads (${firstCount} -> ` +
        `${secondCount}); a real consumer downloaded the asset during ` +
        "the rollback window. Re-run with the new count visible.",
    ];
  }
  return [true, firstCount, secondCount, ""];
}
