import { findLastReviewedCommitSha } from "../text/redos-safe.js";
import {
  CONFIDENCE_RE,
  GREPTILE_ERRORED_SENTINEL,
  INFORMAL_CLEAN_SIGNAL_RE,
  P0_BADGE,
  P1_BADGE,
  SECTION_RE,
} from "./constants.js";
import type { GreptileVerdict } from "./types.js";

export function emptyVerdict(): GreptileVerdict {
  return {
    found: false,
    errored: false,
    lastReviewedSha: null,
    confidence: null,
    p0Count: 0,
    p1Count: 0,
    p2Count: 0,
    informalClean: false,
    rawBodyExcerpt: "",
  };
}

export function isInformalCleanMissingCanonicalFields(
  verdict: GreptileVerdict,
  body: string,
): boolean {
  if (!verdict.found || verdict.errored) {
    return false;
  }
  if (verdict.lastReviewedSha !== null || verdict.confidence !== null) {
    return false;
  }
  if (verdict.p0Count > 0 || verdict.p1Count > 0) {
    return false;
  }
  return INFORMAL_CLEAN_SIGNAL_RE.test(body);
}

function countSubstring(body: string, needle: string): number {
  let count = 0;
  let idx = 0;
  let found = body.indexOf(needle, idx);
  while (found !== -1) {
    count += 1;
    idx = found + needle.length;
    found = body.indexOf(needle, idx);
  }
  return count;
}

/** Parse a Greptile rolling-summary comment body into a structured verdict. */
export function parseGreptileBody(body: string): GreptileVerdict {
  if (!body?.trim()) {
    return emptyVerdict();
  }

  const errored = body.trim().startsWith(GREPTILE_ERRORED_SENTINEL);

  const lastReviewedSha = findLastReviewedCommitSha(body);

  const confMatch = CONFIDENCE_RE.exec(body);
  const confidence = confMatch?.groups?.score !== undefined ? Number(confMatch.groups.score) : null;

  let p0Count = countSubstring(body, P0_BADGE);
  let p1Count = countSubstring(body, P1_BADGE);
  let p2Count = countSubstring(body, '<img alt="P2"');

  const hasDetailsFormat = body.includes("<details>");
  if (!hasDetailsFormat && p0Count === 0 && p1Count === 0) {
    for (const match of body.matchAll(SECTION_RE)) {
      const sev = (match.groups?.sev ?? "").toUpperCase();
      const count = Number(match.groups?.count ?? 0);
      if (sev === "P0") {
        p0Count = count;
      } else if (sev === "P1") {
        p1Count = count;
      } else if (sev === "P2" && p2Count === 0) {
        p2Count = count;
      }
    }
  }

  const verdict: GreptileVerdict = {
    found: true,
    errored,
    lastReviewedSha,
    confidence,
    p0Count,
    p1Count,
    p2Count,
    informalClean: false,
    rawBodyExcerpt: body.slice(0, 200),
  };

  if (isInformalCleanMissingCanonicalFields(verdict, body)) {
    return { ...verdict, informalClean: true };
  }
  return verdict;
}
