/**
 * Declared wall-clock wait budget for pr:watch / dual-stop (#3984 / #3153).
 *
 * Envelope selection SLA fires the wall-clock row only when a budget is
 * declared (CLI flag, env, or explicit option). The 30m default is a poll
 * cap, not a declared envelope budget — observed elapsed alone does not
 * re-cut the envelope on this number.
 */

import { DEFAULT_MAX_WAIT_MINUTES } from "./constants.js";

/** Env name for a parent-/envelope-declared pr:watch cap (#3984). */
export const ENV_PR_WATCH_MAX_WAIT_MINUTES = "DEFT_PR_WATCH_MAX_WAIT_MINUTES";

export type DeclaredWaitBudgetSource = "cli" | "env" | "default";

export type DeclaredWaitBudgetOk = {
  readonly ok: true;
  readonly minutes: number;
  readonly source: DeclaredWaitBudgetSource;
  /** True only for cli/env — #3153 wall-clock row input. */
  readonly declared: boolean;
};

export type DeclaredWaitBudgetErr = {
  readonly ok: false;
  readonly reason: string;
  readonly source: "cli" | "env";
};

export type DeclaredWaitBudgetResult = DeclaredWaitBudgetOk | DeclaredWaitBudgetErr;

export type ResolveDeclaredWaitBudgetInput = {
  /** Explicit CLI / API minutes when the caller set --max-wait-minutes. */
  readonly cliMinutes?: number | null;
  /** Environ map; defaults to process.env. */
  readonly env?: NodeJS.Dict<string>;
  /** Fallback when neither cli nor env declares a budget. */
  readonly defaultMinutes?: number;
};

/**
 * Resolve pr:watch max-wait: CLI > env > default.
 * Invalid env returns ok:false (no throw) so callers can surface CONFIG.
 */
export function resolveDeclaredWaitBudget(
  input: ResolveDeclaredWaitBudgetInput = {},
): DeclaredWaitBudgetResult {
  const defaultMinutes = input.defaultMinutes ?? DEFAULT_MAX_WAIT_MINUTES;
  if (input.cliMinutes !== undefined && input.cliMinutes !== null) {
    const seconds = input.cliMinutes * 60;
    // Reject values finite as minutes but non-finite as seconds (e.g. 1e308).
    if (!Number.isFinite(input.cliMinutes) || input.cliMinutes < 0 || !Number.isFinite(seconds)) {
      return {
        ok: false,
        reason: `invalid --max-wait-minutes value: ${String(input.cliMinutes)}`,
        source: "cli",
      };
    }
    return {
      ok: true,
      minutes: input.cliMinutes,
      source: "cli",
      declared: true,
    };
  }

  const env = input.env ?? process.env;
  const raw = env[ENV_PR_WATCH_MAX_WAIT_MINUTES];
  if (raw !== undefined && String(raw).trim() !== "") {
    const parsed = Number(String(raw).trim());
    const seconds = parsed * 60;
    // Reject values finite as minutes but non-finite as seconds (e.g. 1e308).
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isFinite(seconds)) {
      return {
        ok: false,
        reason: `invalid ${ENV_PR_WATCH_MAX_WAIT_MINUTES} value: ${raw}`,
        source: "env",
      };
    }
    return {
      ok: true,
      minutes: parsed,
      source: "env",
      declared: true,
    };
  }

  return {
    ok: true,
    minutes: defaultMinutes,
    source: "default",
    declared: false,
  };
}

/** True when CLI or env declared a wall-clock budget (#3153 row gate). */
export function hasDeclaredWallClockBudget(input: ResolveDeclaredWaitBudgetInput = {}): boolean {
  const r = resolveDeclaredWaitBudget(input);
  return r.ok && r.declared;
}
