/**
 * Session-start skippable nudge for coverageDebt + checkResume (#3189).
 *
 * Why / what + Strict / Hatch-aware / Later (+ Discuss / Back for #1470).
 * Later does not mark decided; re-nag next interactive mutation ritual.
 * Headless / CI / non-TTY fail-open (no block).
 */

import { isCoverageCheckResumeUndecided } from "../policy/coverage-check-resume-presets.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";
import { type HeadlessDetectionOptions, isHeadlessSession } from "../product-signal/headless.js";

/** Why block -- must appear in the nudge. */
export const COVERAGE_CHECK_RESUME_NUDGE_WHY =
  "Why: Long checks often fail late on small gates, or barely miss coverage. " +
  "The project can fail closed, warn, or hatch with a tracked debt issue on THIS repo. " +
  "Local machines may resume a suite that already passed at the same commit; " +
  "CI must not trust a laptop stamp.";

/** What block -- bundled presets, not five micro-toggles. */
export const COVERAGE_CHECK_RESUME_NUDGE_WHAT =
  "What we need: one bundled project decision (not USER.md personal prefs; not npm publish; " +
  "not turning off required CI):\n" +
  "  * Strict (recommended for most apps) -- coverageDebt.mode=off, checkResume.localStamp=off\n" +
  "  * Hatch-aware -- coverageDebt.mode=hatch (autoFile=false by default), localStamp=on for DX\n" +
  "  * Later -- skip this session; does NOT set status=decided; nag again next ritual\n" +
  "  * Discuss -- talk through the trade-offs\n" +
  "  * Back -- leave this prompt without choosing\n" +
  "Agent apply path (writes PROJECT-DEFINITION; production SoT API in @deftai/directive-core/policy):\n" +
  "  Strict -> applyStrictCoverageCheckResumePreset(projectRoot)\n" +
  "  Hatch-aware -> applyHatchAwareCoverageCheckResumePreset(projectRoot)\n" +
  "  Later -> applyLaterCoverageCheckResumeSkip() (no PD write)\n" +
  "  Dismiss-with-reason -> dismissCoverageCheckResume(projectRoot, reason)\n" +
  "Stop nag only after Strict / Hatch-aware (status=decided) or dismiss-with-reason " +
  `(visible via \`${policyColonInvocation("show", " --field=coverageDebt")}\` / doctor).`;

export const COVERAGE_CHECK_RESUME_NUDGE_BODY = `${COVERAGE_CHECK_RESUME_NUDGE_WHY}\n\n${COVERAGE_CHECK_RESUME_NUDGE_WHAT}`;

export interface CoverageCheckResumeNudgeEligibilityOptions extends HeadlessDetectionOptions {
  readonly projectRoot: string;
}

/**
 * True when an interactive mutation session-start ritual should surface the
 * coverage/check-resume decision nudge (#3189).
 */
export function isCoverageCheckResumeNudgeEligible(
  options: CoverageCheckResumeNudgeEligibilityOptions,
): boolean {
  if (isHeadlessSession(options)) {
    return false;
  }
  return isCoverageCheckResumeUndecided(options.projectRoot);
}

/** Format the full operator-facing nudge. */
export function formatCoverageCheckResumeNudge(): string {
  return `[deft policy] coverageDebt + checkResume undecided:\n${COVERAGE_CHECK_RESUME_NUDGE_BODY}\n`;
}

/**
 * Emit the nudge when eligible; headless / decided callers get an empty string.
 * Never blocks -- session-start always continues.
 */
export function maybeFormatCoverageCheckResumeNudge(
  options: CoverageCheckResumeNudgeEligibilityOptions,
): string {
  return isCoverageCheckResumeNudgeEligible(options) ? formatCoverageCheckResumeNudge() : "";
}
