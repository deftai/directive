/**
 * in-progress flip clock (#4298). First in-envelope thread evidence is
 * panel-deposit or role: critic, not spawn intent.
 */

import { isPanelDepositBody, type ThreadComment } from "./completed-arc-record.js";
import type { DesignCritiqueCatalogChip } from "./exclusive-chip.js";

const CRITIC_ROLE_RE = /(?:^|\n)\s*role:\s*critic\b/i;

export function hasInProgressFlipEvidence(comments: readonly ThreadComment[]): boolean {
  return comments.some(
    (comment) => CRITIC_ROLE_RE.test(comment.body) || isPanelDepositBody(comment.body),
  );
}

/** Not-started vs live. Bind terminal ingest-ready is a different remaining-set. */
export function resolveInFlightCatalogChip(
  comments: readonly ThreadComment[],
): DesignCritiqueCatalogChip {
  return hasInProgressFlipEvidence(comments)
    ? "design-critique:in-progress"
    : "design-critique:mechanism-shaped";
}
