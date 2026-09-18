/**
 * Shared single-path promote (proposed/ → pending/) with optional triage audit linkage (#1136).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bindPlanItemIdsToClauses } from "./acceptance-evidence.js";
import { append, canonicalLogPath, newDecisionId } from "./audit-log.js";
import { atomicWriteBrief, readBriefForMutation } from "./brief-io.js";
import { resolveProjectRoot } from "./project-context.js";
import { recordWipCapOverride, runTransition } from "./transition.js";
import { utcNowIso } from "./vbrief-json.js";
import { canonicalRelpath } from "./vbrief-ref.js";
import { checkWipCap, formatWipCapRefusal } from "./wip-cap-check.js";

export interface PromotePathOptions {
  readonly projectRoot?: string;
  /** WIP-cap override (--force). */
  readonly force?: boolean;
  readonly actor?: string;
  readonly now?: Date;
  /** Issue number that triggered this promote (from-issue / auto-promote). */
  readonly fromIssue?: number;
  /** Accept (or other) decision_id from candidates.jsonl, when known. */
  readonly cacheDecisionId?: string | null;
  /** Latest cache decision string at promote time (accept / defer / null). */
  readonly cacheStateAtPromote?: string | null;
  /** True when reciprocity gate was skipped via --force-no-cache. */
  readonly forceNoCache?: boolean;
  /** Write promote audit entry even without from-issue linkage (default: only when linkage present). */
  readonly alwaysAudit?: boolean;
  /**
   * When true, audit append failure is a hard error (from-issue / auto-promote
   * require from_issue + cache fields). Default false for plain path promote.
   */
  readonly requireAudit?: boolean;
}

export interface PromotePathResult {
  readonly ok: boolean;
  readonly message: string;
  readonly exitCode: number;
  readonly destPath?: string;
  readonly auditEntry?: Record<string, unknown> | null;
  readonly wipCapOverride?: boolean;
}

/**
 * Promote a single proposed-scope path to pending/, enforcing WIP and
 * optionally recording from_issue / cache_decision_id on the scope audit log.
 */
export function promotePath(filePath: string, options: PromotePathOptions = {}): PromotePathResult {
  const root = resolveProjectRoot(options.projectRoot);
  if (root === null) {
    return {
      ok: false,
      message:
        "Cannot determine project root. Pass --project-root PATH, set $DEFT_PROJECT_ROOT, or run from inside a directory tree that contains vbrief/ or .git/ (#535).",
      exitCode: 2,
    };
  }

  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { ok: false, message: `File not found: ${resolved}`, exitCode: 2 };
  }

  const capCheck = checkWipCap(root, options.force === true);
  if (!capCheck.allowed) {
    return {
      ok: false,
      message: formatWipCapRefusal(capCheck),
      exitCode: 1,
    };
  }

  const now = options.now ?? new Date();
  const result = runTransition("promote", resolved, now);
  if (!result.ok) {
    return { ok: false, message: result.message, exitCode: 1 };
  }

  const basename = resolved.split(/[/\\]/).pop() ?? "";
  // Destination after promote is sibling pending/ under the same lifecycle root.
  const lifecycleRoot = dirname(dirname(resolved));
  const destPath = join(lifecycleRoot, "pending", basename);

  let auditEntry: Record<string, unknown> | null = null;
  const shouldAudit =
    options.alwaysAudit === true ||
    options.fromIssue !== undefined ||
    options.forceNoCache === true ||
    options.cacheDecisionId !== undefined ||
    options.cacheStateAtPromote !== undefined;

  if (shouldAudit) {
    try {
      const entry: Record<string, unknown> = {
        decision_id: newDecisionId(),
        timestamp: utcNowIso(now),
        action: "promote",
        vbrief_path: canonicalRelpath(destPath, root),
        from_status: "proposed",
        to_status: "pending",
        actor: options.actor ?? "operator",
      };
      if (options.fromIssue !== undefined) {
        entry.from_issue = options.fromIssue;
      }
      if (options.cacheDecisionId !== undefined) {
        entry.cache_decision_id = options.cacheDecisionId;
      }
      if (options.cacheStateAtPromote !== undefined) {
        entry.cache_state_at_promote = options.cacheStateAtPromote;
      }
      if (options.forceNoCache === true) {
        entry.force_no_cache = true;
      }
      append(entry, canonicalLogPath(root));
      auditEntry = entry;
    } catch (err) {
      if (options.requireAudit === true) {
        return {
          ok: false,
          message:
            `Promoted ${basename} to pending/ but required scope audit failed: ${String(err)}. ` +
            `Artifact is in pending/; re-run promote will no-op once audit is writable.`,
          exitCode: 1,
          destPath,
          auditEntry: null,
          wipCapOverride: capCheck.forceOverride,
        };
      }
      /* best-effort audit for plain path promote */
    }
  }

  if (capCheck.forceOverride) {
    recordWipCapOverride(destPath, root, capCheck, now);
  }

  const bindWrite = bindClauseIdsOnPromotedBrief(destPath, root, lifecycleRoot);
  if (!bindWrite.ok) {
    return {
      ok: false,
      message: bindWrite.message,
      exitCode: 1,
      destPath,
      auditEntry,
      wipCapOverride: capCheck.forceOverride,
    };
  }

  return {
    ok: true,
    message: result.message,
    exitCode: 0,
    destPath,
    auditEntry,
    wipCapOverride: capCheck.forceOverride,
  };
}

function asPlanRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function bindClauseIdsOnPromotedBrief(
  destPath: string,
  projectRoot: string,
  lifecycleRoot: string,
): { readonly ok: boolean; readonly message: string } {
  if (!existsSync(destPath)) {
    return { ok: true, message: "" };
  }
  const loaded = readBriefForMutation(destPath);
  if (!loaded.ok) {
    return {
      ok: false,
      message: `Promoted to pending/ but clause-id bind failed: ${loaded.message}`,
    };
  }
  const plan = asPlanRecord(loaded.data.plan);
  if (plan === null) {
    return { ok: true, message: "" };
  }
  const bind = bindPlanItemIdsToClauses(plan);
  if (bind.boundIds.length === 0) {
    return { ok: true, message: "" };
  }
  const write = atomicWriteBrief(destPath, loaded.data, lifecycleRoot, { projectRoot });
  if (!write.ok) {
    return {
      ok: false,
      message: `Promoted to pending/ but clause-id bind write failed: ${write.message}`,
    };
  }
  return { ok: true, message: "" };
}
