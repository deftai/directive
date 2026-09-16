/**
 * Named demand predicate for observable-scope mint (#4588).
 *
 * Fail-closed site is verify merge-base. Preflight is not that site and
 * does not cover setup-created briefs. Parking is not the when.
 * Does not change the oracle or invent a mint path.
 */

import { isMarkupPath } from "./extract.js";

export const OBSERVABLE_MINT_FAIL_CLOSED_SITE = "verify-merge-base" as const;
export const OBSERVABLE_MINT_OPEN_PREDECESSOR = "#4383";
export const OBSERVABLE_MINT_PARKING_IS_WHEN = false;
export const OBSERVABLE_MINT_WHEN_HINT =
  'Fail-closed when is verify merge-base after plan["x-directive/observableChange"] is authored and before the UI-change PR (#4588). Parking is not this when (predecessor #4383).';

export type VerifyObservableMintDemandReason =
  | "demand-policy-and-matched-markup"
  | "na-no-policy"
  | "warn-unset-policy-ui"
  | "na-unmatched"
  | "na-no-markup";

export interface VerifyObservableMintDemand {
  readonly site: "verify";
  readonly failClosed: true;
  readonly demand: boolean;
  readonly reason: VerifyObservableMintDemandReason;
}

export type PreflightObservableMintDemandReason =
  | "intended-placement-markup"
  | "no-markup-in-intended-placement";

export interface PreflightObservableMintDemand {
  readonly site: "preflight";
  readonly failClosed: false;
  readonly demand: boolean;
  readonly reason: PreflightObservableMintDemandReason;
}

/**
 * Verify demand: merge-base surfaces policy AND a matched .html/.jsx/.tsx
 * change. Greenfield without that policy is N/A (or inferred-defaults-warn),
 * not an ask.
 */
export function classifyVerifyObservableMintDemand(input: {
  readonly policyPresent: boolean;
  readonly uiChanged: boolean;
  readonly matchedCount: number;
  readonly matchedMarkupCount: number;
}): VerifyObservableMintDemand {
  if (!input.policyPresent) {
    if (input.uiChanged) {
      return {
        site: "verify",
        failClosed: true,
        demand: false,
        reason: "warn-unset-policy-ui",
      };
    }
    return { site: "verify", failClosed: true, demand: false, reason: "na-no-policy" };
  }
  if (input.matchedCount === 0) {
    return { site: "verify", failClosed: true, demand: false, reason: "na-unmatched" };
  }
  if (input.matchedMarkupCount === 0) {
    return { site: "verify", failClosed: true, demand: false, reason: "na-no-markup" };
  }
  return {
    site: "verify",
    failClosed: true,
    demand: true,
    reason: "demand-policy-and-matched-markup",
  };
}

/**
 * Preflight demand: markup in intended_placement.files. Missing or empty
 * placement (setup-created briefs) is not this site. Authority stays
 * working-tree existsSync; do not tighten that into the fail-closed when.
 */
export function classifyPreflightObservableMintDemand(
  files: readonly string[],
): PreflightObservableMintDemand {
  const demand = files.some((f) => isMarkupPath(f));
  return {
    site: "preflight",
    failClosed: false,
    demand,
    reason: demand ? "intended-placement-markup" : "no-markup-in-intended-placement",
  };
}
