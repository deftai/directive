/**
 * Evidence-only lifecycle verb (#4840).
 *
 * Writes x-directive/evidence via stampNamespacedEvidence. No disposition argv.
 * --pr / --merge-commit stay off this field. No glob expander.
 */

import { dirname } from "node:path";
import {
  persistClauseKeyedPendingItems,
  stampMatchAnyFileEvidence,
} from "./acceptance-evidence.js";
import { atomicWriteBrief, readBriefForMutation } from "./brief-io.js";
import { resolveProjectRoot } from "./project-context.js";

export const STAMP_EVIDENCE_ACTION = "stamp-evidence" as const;
export const STAMP_EVIDENCE_VERB = "scope:stamp-evidence" as const;

export interface StampEvidenceOnBriefResult {
  readonly ok: boolean;
  readonly message: string;
  readonly stampedIds: readonly string[];
}

export function stampEvidenceOnBrief(
  filePath: string,
  options: { readonly projectRoot?: string; readonly recorded_at?: string } = {},
): StampEvidenceOnBriefResult {
  const read = readBriefForMutation(filePath);
  if (!read.ok) {
    return { ok: false, message: read.message, stampedIds: [] };
  }
  const data = read.data;
  const plan = data.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, message: `vBRIEF at ${filePath} lacks a plan object`, stampedIds: [] };
  }
  const planObj = plan as Record<string, unknown>;
  persistClauseKeyedPendingItems(planObj);
  const projectRoot =
    resolveProjectRoot(options.projectRoot, filePath) ?? dirname(dirname(dirname(filePath)));
  const stamped = stampMatchAnyFileEvidence(planObj, {
    recorded_by: STAMP_EVIDENCE_VERB,
    recorded_at: options.recorded_at,
    projectRoot,
  });
  const vbriefRoot = dirname(dirname(filePath));
  const write = atomicWriteBrief(filePath, data, vbriefRoot, { projectRoot });
  if (!write.ok) {
    return { ok: false, message: write.message, stampedIds: [] };
  }
  const skipped = stamped.skipped.map((row) => `clause.${row.clauseId}:${row.reason}`).join(", ");
  const stampedList = stamped.stampedIds.length > 0 ? stamped.stampedIds.join(",") : "(none)";
  const repairedList = stamped.repairedIds.length > 0 ? stamped.repairedIds.join(",") : "";
  return {
    ok: true,
    message:
      `${STAMP_EVIDENCE_VERB} stamped ${stamped.stampedIds.length} item(s) ` +
      `(ids=${stampedList}` +
      (repairedList.length > 0 ? `; repaired=${repairedList}` : "") +
      (skipped.length > 0 ? `; skipped ${skipped}` : "") +
      ")",
    stampedIds: stamped.stampedIds,
  };
}
