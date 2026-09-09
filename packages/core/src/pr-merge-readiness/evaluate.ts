import {
  resolveFindingsChannel,
  resolveShaCurrency,
} from "../content-contracts/skills/greptile-detector.js";
import {
  DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE,
  formatMinConfidenceRequirement,
  meetsMinGreptileConfidence,
} from "../policy/min-greptile-confidence.js";
import { INFORMAL_CLEAN_DIAGNOSTIC } from "./constants.js";
import type { InlineGreptileFindings } from "./greptile-inline.js";
import type { GreptileVerdict } from "./types.js";

export interface EvaluateGatesOptions {
  /**
   * Minimum Greptile confidence (1–5) that satisfies CLEAN (#3095).
   * Defaults to the consumer bar (4 == legacy confidence > 3).
   */
  readonly minConfidence?: number;
  /** Already-fetched Greptile Review check-run is terminal on current HEAD (#4289). */
  readonly greptileReviewTerminalOnHead?: boolean;
  /** Parsed check-run N comments added; null if missing (#4289). */
  readonly commentsAdded?: number | null;
}

/** Return failure messages (empty list == merge-ready). */
export function evaluateGates(
  _prNumber: number,
  headSha: string | null,
  verdict: GreptileVerdict,
  inline: InlineGreptileFindings | null = null,
  options: EvaluateGatesOptions = {},
): string[] {
  const failures: string[] = [];
  const minConfidence = options.minConfidence ?? DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE;

  if (!verdict.found) {
    failures.push(
      "No Greptile rolling-summary comment found on the PR. " +
        "Either Greptile has not posted yet, or the bot login filter is wrong. " +
        "Wait for the review to land before merging (see #796 late-bot-review re-check).",
    );
    return failures;
  }

  if (!verdict.excludedAuthor) {
    if (verdict.errored) {
      failures.push(
        "Greptile review is in the ERRORED state on the current HEAD (#526). " +
          "Retry via @greptileai or escalate per " +
          "skills/deft-directive-swarm/SKILL.md Phase 6 Step 1.",
      );
    }

    if (verdict.informalClean) {
      failures.push(INFORMAL_CLEAN_DIAGNOSTIC);
      return appendInlineFailures(failures, inline);
    }

    const sha = resolveShaCurrency({
      bodySha: verdict.lastReviewedSha,
      headSha: headSha ?? "",
      thinHtmlSummary: verdict.thinHtmlSummary,
      greptileReviewTerminalOnHead: options.greptileReviewTerminalOnHead === true,
    });
    if (sha.source === "none") {
      failures.push(
        "Could not parse `Last reviewed commit:` from Greptile body. " +
          "The comment may be malformed or Greptile may still be writing it -- re-fetch.",
      );
    } else if (
      headSha &&
      sha.sha !== null &&
      !(headSha.startsWith(sha.sha) || sha.sha.startsWith(headSha))
    ) {
      failures.push(
        `Greptile last reviewed ${sha.sha} but PR HEAD is ${headSha}. ` +
          "Review is stale -- wait for Greptile to re-review the latest commit.",
      );
    }

    if (verdict.confidence === null) {
      failures.push(
        "Could not parse `Confidence Score: X/5` from Greptile body. " +
          "Confidence is a required exit-condition input per " +
          "skills/deft-directive-review-cycle/SKILL.md Phase 2 Step 6.",
      );
    } else if (!meetsMinGreptileConfidence(verdict.confidence, minConfidence)) {
      failures.push(
        `Greptile confidence is ${verdict.confidence}/5; exit condition requires ${formatMinConfidenceRequirement(minConfidence)}. ` +
          "Address remaining findings or push clarifying changes. " +
          "Inspect the floor via `task policy:show --field=minGreptileConfidence` (#3095).",
      );
    }

    // #3225: advisory should-not-merge prose blocks regardless of formal review
    // state / Ready-to-merge mechanical box. Composes with minGreptileConfidence
    // (#3095): sub-threshold conf already fails above; this catches high-conf
    // prose blocks and conf-only paths that still name should-not-merge.
    if (verdict.shouldNotMerge) {
      failures.push(
        "Reviewer bot comment prose records a should-not-merge / not-safe-to-merge " +
          "advisory verdict (no formal Changes-Requested required). " +
          "Mechanical Ready-to-merge / green checks are necessary, never sufficient (#3225). " +
          "Address residual risk or wait for a clean advisory re-review before merge.",
      );
    }

    if (verdict.thinHtmlSummary) {
      const rest =
        inline !== null && inline.error === null
          ? { p0Count: inline.p0Count, p1Count: inline.p1Count }
          : null;
      const channel = resolveFindingsChannel({
        thinHtmlSummary: true,
        bodyDetect: {
          p0_count: verdict.p0Count,
          p1_count: verdict.p1Count,
          has_blocking: verdict.p0Count + verdict.p1Count > 0 || verdict.shouldNotMerge,
        },
        commentsAdded: options.commentsAdded ?? null,
        restPullComments: rest,
      });
      if (!channel.present) {
        failures.push(
          "Thin HTML greptile_summary has no findings channel (#4289). " +
            "Do not CLEAN on parsed confidence plus a terminal Greptile Review check-run " +
            "plus vacuous detect() zeros. Fetch REST pulls comments and/or parse check-run " +
            "comments-added text.",
        );
      } else if (channel.hasBlocking) {
        if (channel.p0Count + channel.p1Count > 0) {
          failures.push(
            `Greptile findings channel reports ${channel.p0Count} P0 and ${channel.p1Count} P1 ` +
              "on the current HEAD (REST pull comments and/or check-run comments-added). " +
              "All P0 / P1 findings MUST be addressed before merge (P2 findings are non-blocking).",
          );
        } else {
          failures.push(
            "Thin HTML findings channel is dirty via check-run comments-added " +
              "(REST/GraphQL counts unavailable). Do not treat this as 0 P0 / 0 P1 (#4289).",
          );
        }
      }
      return appendInlineFailures(failures, inline, true, channel.present);
    } else if (verdict.p0Count > 0 || verdict.p1Count > 0) {
      failures.push(
        `Greptile reports ${verdict.p0Count} P0 and ${verdict.p1Count} P1 findings ` +
          "on the current HEAD. All P0 / P1 findings MUST be addressed before merge " +
          "(P2 findings are non-blocking).",
      );
    }
  }

  return appendInlineFailures(failures, inline);
}

function appendInlineFailures(
  failures: string[],
  inline: InlineGreptileFindings | null,
  skipInlineCounts = false,
  skipErrorWhenChannelPresent = false,
): string[] {
  if (inline === null) {
    return failures;
  }
  if (inline.error !== null) {
    if (!skipErrorWhenChannelPresent) {
      failures.push(
        "Could not verify Greptile inline review comments on the current HEAD (#2620). " +
          `Root cause: ${inline.error}`,
      );
    }
  } else if (!skipInlineCounts && (inline.p0Count > 0 || inline.p1Count > 0)) {
    failures.push(
      `Greptile has ${inline.p0Count} unresolved inline P0 and ${inline.p1Count} unresolved inline P1 ` +
        `review comment(s) on the current HEAD across ${inline.unresolvedThreadCount} open thread(s). ` +
        "Resolve or address all blocking inline threads before merge -- rolling-summary badge counts alone " +
        "are insufficient (#2620).",
    );
  }
  return failures;
}

export function isMergeReady(failures: readonly string[]): boolean {
  return failures.length === 0;
}
