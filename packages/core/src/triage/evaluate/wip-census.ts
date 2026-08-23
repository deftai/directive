import { readPlanSequence } from "../../plan-sequence/store.js";
import type { WipCensus, WipHit } from "./types.js";
import { listXbriefHits } from "./xbrief-refs.js";

function hitsForIssues(
  hits: readonly { issue: number; path: string }[],
  issues: ReadonlySet<number>,
  kind: WipHit["kind"],
): WipHit[] {
  return hits
    .filter((hit) => issues.has(hit.issue))
    .map((hit) => ({ kind, path: hit.path, issue: hit.issue }));
}

/** Parent-owned. Evaluators must never receive this object. */
export function collectWipCensus(projectRoot: string, issues: readonly number[]): WipCensus {
  const wanted = new Set(issues);
  const activeHits = listXbriefHits(projectRoot, "active");
  const pendingHits = listXbriefHits(projectRoot, "pending");
  const planHits: WipHit[] = [];
  const sequence = readPlanSequence(projectRoot);
  if (sequence !== null) {
    for (const entry of sequence.entries) {
      const fromField = entry.issue;
      const fromId = Number.parseInt(entry.id.trim().replace(/^#/u, ""), 10);
      const asNumber = typeof fromField === "number" ? fromField : fromId;
      if (!Number.isFinite(asNumber) || !wanted.has(asNumber)) {
        continue;
      }
      planHits.push({
        kind: "plan-sequence",
        path: ".deft/plan-sequence.json",
        issue: asNumber,
      });
    }
  }
  return {
    active: hitsForIssues(activeHits, wanted, "active-xbrief"),
    pending: hitsForIssues(pendingHits, wanted, "pending-xbrief"),
    planSequence: planHits,
  };
}

export function wipHitsForIssue(census: WipCensus, issue: number): WipHit[] {
  return [...census.active, ...census.pending, ...census.planSequence].filter(
    (hit) => hit.issue === issue,
  );
}
