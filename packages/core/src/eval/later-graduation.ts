/**
 * #3286 Later graduation trigger from a #3282 run summary (#3320).
 *
 * Named surface: eval:report prints graduate / do-not-graduate / unevaluable.
 * A graduation or decline MUST cite an emitted share. Counts without a
 * denominator are unevaluable — never invent a ratio.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  computeRitualGateShare,
  parseRunSummaryJsonl,
  type RitualGateShare,
} from "../run-summary/share.js";
import { DEFAULT_RUN_SUMMARY_BASENAME, ENV_RUN_SUMMARY_PATH } from "../run-summary/types.js";

/** #3286 Later trigger: graduate when ritual+gate share is at least this fraction. */
export const LATER_GRADUATION_SHARE_THRESHOLD = 0.25;

export type LaterGraduationVerdict = "graduate" | "do-not-graduate" | "unevaluable";

export interface LaterGraduationTrigger {
  readonly evaluable: boolean;
  readonly verdict: LaterGraduationVerdict;
  readonly summary: string;
  readonly ritualGateCount: number;
  readonly totalToolTurns: number | null;
  readonly share: number | null;
  readonly threshold: number;
}

export interface EvaluateLaterGraduationOptions {
  readonly projectRoot: string;
  readonly runSummaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly threshold?: number;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function laterGraduationFromShare(
  share: RitualGateShare,
  threshold: number = LATER_GRADUATION_SHARE_THRESHOLD,
): LaterGraduationTrigger {
  if (!share.evaluable || share.share === null || share.totalToolTurns === null) {
    return {
      evaluable: false,
      verdict: "unevaluable",
      summary: "trigger unevaluable (no tool/turn denominator on run summary)",
      ritualGateCount: share.ritualGateCount,
      totalToolTurns: share.totalToolTurns,
      share: null,
      threshold,
    };
  }
  const graduate = share.share >= threshold;
  const verdict: LaterGraduationVerdict = graduate ? "graduate" : "do-not-graduate";
  return {
    evaluable: true,
    verdict,
    summary: `ritual+gate share ${formatPercent(share.share)} (${share.ritualGateCount}/${share.totalToolTurns}) — ${verdict} (threshold ${formatPercent(threshold)})`,
    ritualGateCount: share.ritualGateCount,
    totalToolTurns: share.totalToolTurns,
    share: share.share,
    threshold,
  };
}

/**
 * Resolve a readable run-summary path. Unset env + missing default file → null
 * (fail-open / unevaluable). stdout dest (`-`) is not a file.
 */
export function resolveRunSummaryReadPath(
  projectRoot: string,
  options: { readonly runSummaryPath?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string | null {
  if (options.runSummaryPath !== undefined && options.runSummaryPath.trim().length > 0) {
    return resolve(options.runSummaryPath.trim());
  }
  const env = options.env ?? process.env;
  const raw = env[ENV_RUN_SUMMARY_PATH];
  if (raw !== undefined && raw.trim() === "-") {
    return null;
  }
  if (raw !== undefined && raw.trim().length > 0) {
    const trimmed = raw.trim();
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
  }
  const fallback = resolve(projectRoot, DEFAULT_RUN_SUMMARY_BASENAME);
  return existsSync(fallback) ? fallback : null;
}

function readSummaryText(path: string): string | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Evaluate #3286 Later from the run-summary file (or unevaluable). */
export function evaluateLaterGraduationTrigger(
  options: EvaluateLaterGraduationOptions,
): LaterGraduationTrigger {
  const threshold = options.threshold ?? LATER_GRADUATION_SHARE_THRESHOLD;
  const path = resolveRunSummaryReadPath(options.projectRoot, {
    runSummaryPath: options.runSummaryPath,
    env: options.env,
  });
  if (path === null) {
    return laterGraduationFromShare(
      { evaluable: false, ritualGateCount: 0, totalToolTurns: null, share: null },
      threshold,
    );
  }
  const text = readSummaryText(path);
  if (text === null) {
    return laterGraduationFromShare(
      { evaluable: false, ritualGateCount: 0, totalToolTurns: null, share: null },
      threshold,
    );
  }
  return laterGraduationFromShare(computeRitualGateShare(parseRunSummaryJsonl(text)), threshold);
}

export function formatLaterGraduationLine(trigger: LaterGraduationTrigger): string {
  return `#3286 Later: ${trigger.summary}`;
}
