import { INFORMAL_CLEAN_DIAGNOSTIC } from "./constants.js";
import type { GreptileVerdict } from "./types.js";

/** Return failure messages (empty list == merge-ready). */
export function evaluateGates(
  _prNumber: number,
  headSha: string | null,
  verdict: GreptileVerdict,
): string[] {
  const failures: string[] = [];

  if (!verdict.found) {
    failures.push(
      "No Greptile rolling-summary comment found on the PR. " +
        "Either Greptile has not posted yet, or the bot login filter is wrong. " +
        "Wait for the review to land before merging (see #796 late-bot-review re-check).",
    );
    return failures;
  }

  if (verdict.errored) {
    failures.push(
      "Greptile review is in the ERRORED state on the current HEAD (#526). " +
        "Retry via @greptileai or escalate per " +
        "skills/deft-directive-swarm/SKILL.md Phase 6 Step 1.",
    );
  }

  if (verdict.informalClean) {
    failures.push(INFORMAL_CLEAN_DIAGNOSTIC);
    return failures;
  }

  if (verdict.lastReviewedSha === null) {
    failures.push(
      "Could not parse `Last reviewed commit:` from Greptile body. " +
        "The comment may be malformed or Greptile may still be writing it -- re-fetch.",
    );
  } else if (
    headSha &&
    !(headSha.startsWith(verdict.lastReviewedSha) || verdict.lastReviewedSha.startsWith(headSha))
  ) {
    failures.push(
      `Greptile last reviewed ${verdict.lastReviewedSha} but PR HEAD is ${headSha}. ` +
        "Review is stale -- wait for Greptile to re-review the latest commit.",
    );
  }

  if (verdict.confidence === null) {
    failures.push(
      "Could not parse `Confidence Score: X/5` from Greptile body. " +
        "Confidence is a required exit-condition input per " +
        "skills/deft-directive-review-cycle/SKILL.md Phase 2 Step 6.",
    );
  } else if (verdict.confidence <= 3) {
    failures.push(
      `Greptile confidence is ${verdict.confidence}/5; exit condition requires > 3. ` +
        "Address remaining findings or push clarifying changes.",
    );
  }

  if (verdict.p0Count > 0 || verdict.p1Count > 0) {
    failures.push(
      `Greptile reports ${verdict.p0Count} P0 and ${verdict.p1Count} P1 findings ` +
        "on the current HEAD. All P0 / P1 findings MUST be addressed before merge " +
        "(P2 findings are non-blocking).",
    );
  }

  return failures;
}

export function isMergeReady(failures: readonly string[]): boolean {
  return failures.length === 0;
}
