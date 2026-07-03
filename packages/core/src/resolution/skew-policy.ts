/**
 * Three-band engine-vs-pin skew policy for the resolution spine (#2264, #2199).
 *
 * Content is always forward-migrated (`update`) before any gate runs; this
 * policy governs whether a globally-reachable engine that differs from the pin
 * may be used, and how loudly:
 *
 * - `engine == pin`                        -> proceed silently (trace only).
 * - `engine > pin` within the skew window  -> proceed, emit a loud delta, `update` first.
 * - `engine > pin` beyond the window       -> fail closed non-interactively (require
 *                                              `--accept-engine-jump`; prompt when interactive).
 *                                              `DEFT_ACCEPT_ENGINE_SKEW=1` is the CI escape.
 * - `engine < pin`                         -> reject the global, fall through the ladder.
 */

import { compareSemver, parseSemver } from "./pin.js";

/** Default skew window pre-1.0, measured in minor versions. */
export const DEFAULT_ENGINE_SKEW_WINDOW = 3;

/** Environment variable that acts as the CI / non-interactive escape hatch. */
export const ACCEPT_ENGINE_SKEW_ENV = "DEFT_ACCEPT_ENGINE_SKEW";

export type SkewBand = "match" | "within-window" | "beyond-window" | "engine-behind" | "unknown";

export type SkewDecision =
  | "proceed-silent"
  | "proceed-loud-update"
  | "prompt"
  | "fail-closed"
  | "reject-global";

export interface SkewOptions {
  /** Skew window (minor versions pre-1.0; ignored post-1.0 where "same major" applies). */
  readonly engineSkewWindow?: number | null;
  /** The `--accept-engine-jump` flag was supplied. */
  readonly acceptEngineJump?: boolean;
  /** Whether the session is interactive (a human can answer a prompt). */
  readonly interactive?: boolean;
  /** Environment map for the `DEFT_ACCEPT_ENGINE_SKEW` escape hatch. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface SkewResult {
  readonly band: SkewBand;
  readonly decision: SkewDecision;
  /** Loud delta / fail-closed message, or null when silent. */
  readonly message: string | null;
  /** The recommended flow must run `update` before proceeding. */
  readonly requiresUpdateFirst: boolean;
  /** An escape hatch (flag or env) was used to permit a beyond-window jump. */
  readonly escapeHatchUsed: boolean;
}

function resolveWindow(opts: SkewOptions): number {
  const raw = opts.engineSkewWindow;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return DEFAULT_ENGINE_SKEW_WINDOW;
}

function escapeHatchActive(opts: SkewOptions): boolean {
  if (opts.acceptEngineJump === true) return true;
  const env = opts.env ?? process.env;
  return env[ACCEPT_ENGINE_SKEW_ENV] === "1";
}

/**
 * Classify the `engine > pin` skew band. Pre-1.0 (pin major 0) the window is
 * measured in minors; post-1.0 the window collapses to "same major".
 */
function classifyAheadBand(
  engine: readonly [number, number, number],
  pin: readonly [number, number, number],
  window: number,
): "within-window" | "beyond-window" {
  const [engineMajor, engineMinor] = engine;
  const [pinMajor, pinMinor] = pin;
  if (pinMajor === 0) {
    if (engineMajor > 0) return "beyond-window";
    return engineMinor - pinMinor <= window ? "within-window" : "beyond-window";
  }
  return engineMajor === pinMajor ? "within-window" : "beyond-window";
}

/**
 * Evaluate the three-band skew policy for a reachable engine against the pin.
 * Unparseable versions fail closed (a version we cannot order is not safe to run).
 */
export function evaluateSkew(
  engineVersion: string | null,
  pinVersion: string | null,
  opts: SkewOptions = {},
): SkewResult {
  const engine = parseSemver(engineVersion);
  const pin = parseSemver(pinVersion);
  if (engine === null || pin === null) {
    return {
      band: "unknown",
      decision: "fail-closed",
      message: `cannot order engine (${engineVersion ?? "unknown"}) against pin (${pinVersion ?? "unknown"}); refusing to run an unorderable engine`,
      requiresUpdateFirst: false,
      escapeHatchUsed: false,
    };
  }

  const cmp = compareSemver(engineVersion, pinVersion);
  if (cmp === 0) {
    return {
      band: "match",
      decision: "proceed-silent",
      message: null,
      requiresUpdateFirst: false,
      escapeHatchUsed: false,
    };
  }

  if (cmp === -1) {
    return {
      band: "engine-behind",
      decision: "reject-global",
      message: `engine ${engineVersion} is behind pin ${pinVersion}; rejecting global engine and falling through the ladder`,
      requiresUpdateFirst: false,
      escapeHatchUsed: false,
    };
  }

  // engine > pin
  const window = resolveWindow(opts);
  const band = classifyAheadBand(engine, pin, window);
  if (band === "within-window") {
    return {
      band,
      decision: "proceed-loud-update",
      message: `engine ${engineVersion} is ahead of pin ${pinVersion} within the skew window; proceeding after content update`,
      requiresUpdateFirst: true,
      escapeHatchUsed: false,
    };
  }

  // beyond-window
  if (escapeHatchActive(opts)) {
    return {
      band,
      decision: "proceed-loud-update",
      message: `engine ${engineVersion} is a large jump ahead of pin ${pinVersion}; accepted via escape hatch (--accept-engine-jump / ${ACCEPT_ENGINE_SKEW_ENV}=1)`,
      requiresUpdateFirst: true,
      escapeHatchUsed: true,
    };
  }
  if (opts.interactive === true) {
    return {
      band,
      decision: "prompt",
      message: `engine ${engineVersion} is a large jump ahead of pin ${pinVersion}; prompt the operator to confirm (or pass --accept-engine-jump)`,
      requiresUpdateFirst: true,
      escapeHatchUsed: false,
    };
  }
  return {
    band,
    decision: "fail-closed",
    message: `engine ${engineVersion} is a large jump ahead of pin ${pinVersion}; failing closed. Re-run with --accept-engine-jump or ${ACCEPT_ENGINE_SKEW_ENV}=1`,
    requiresUpdateFirst: false,
    escapeHatchUsed: false,
  };
}
