/**
 * Shared single-path promote (proposed/ → pending/) with optional triage audit linkage (#1136).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { append, canonicalLogPath, newDecisionId } from "./audit-log.js";
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
    } catch {
      /* best-effort audit; promote already succeeded */
    }
  }

  if (capCheck.forceOverride) {
    recordWipCapOverride(destPath, root, capCheck, now);
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
