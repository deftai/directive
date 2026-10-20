/**
 * Engine-vs-pin reconciliation helpers (AC12.6).
 *
 * No skew windows and no retired engine-jump escape hatches.
 * Mismatches map to AC9.7 recovery or deliberate `directive upgrade`.
 */

import { compareSemver, parseSemver, semverGte } from "./pin.js";

export type EnginePinBand = "match" | "engine-ahead" | "engine-behind" | "unknown";

export type EnginePinDecision =
  | "proceed-silent"
  | "proceed-loud-update"
  | "fail-closed"
  | "reject-global";

export interface EnginePinResult {
  readonly band: EnginePinBand;
  readonly decision: EnginePinDecision;
  readonly message: string | null;
  readonly requiresUpdateFirst: boolean;
}

/** True when deposited content is already at or ahead of the running engine. */
export function contentMatchesEngine(
  contentVersion: string | null,
  engineVersion: string | null,
): boolean {
  if (contentVersion === null || engineVersion === null) return false;
  return semverGte(contentVersion, engineVersion);
}

/**
 * Compare a reachable engine against the committed pin.
 * Unparseable versions fail closed.
 */
export function evaluateEnginePin(
  engineVersion: string | null,
  pinVersion: string | null,
): EnginePinResult {
  const engine = parseSemver(engineVersion);
  const pin = parseSemver(pinVersion);
  if (engine === null || pin === null) {
    return {
      band: "unknown",
      decision: "fail-closed",
      message: `cannot order engine (${engineVersion ?? "unknown"}) against pin (${pinVersion ?? "unknown"}); refusing to run an unorderable engine`,
      requiresUpdateFirst: false,
    };
  }

  const cmp = compareSemver(engineVersion, pinVersion);
  if (cmp === 0) {
    return {
      band: "match",
      decision: "proceed-silent",
      message: null,
      requiresUpdateFirst: false,
    };
  }

  if (cmp === -1) {
    return {
      band: "engine-behind",
      decision: "reject-global",
      message: `engine ${engineVersion} is behind pin ${pinVersion}`,
      requiresUpdateFirst: false,
    };
  }

  return {
    band: "engine-ahead",
    decision: "proceed-loud-update",
    message: `engine ${engineVersion} is ahead of pin ${pinVersion}`,
    requiresUpdateFirst: true,
  };
}
