/**
 * Origin-resident active brief probe (#4714 R2 lite).
 * swarm:launch / finalize require the selected active path on fetched delivery tip.
 */
import { assertSafeBranchName, trackingFetchArgv } from "../policy/delivery-branch.js";
import {
  evaluateMintLevelRecord,
  evaluateOnePrScopeProofGate,
} from "../policy/one-pr-scope-proof.js";
import { PROJECT_DEFINITION_REL_PATH } from "../policy/resolve.js";
import {
  type ApprovedScopeRecord,
  approvedScopeIntentRel,
  approvedScopeSafePlanId,
  extractPlanId,
} from "../scope-provenance/digest.js";
import type { runText } from "./subprocess.js";

export interface OriginActiveBriefResult {
  readonly present: boolean;
  readonly error: string | null;
}

/** True when `origin/<deliveryBranch>:<relPath>` exists as a blob. */
export function originActiveBriefPresent(
  projectRoot: string,
  deliveryBranch: string,
  relPath: string,
  runGit: typeof runText,
): OriginActiveBriefResult {
  const rel = relPath.replace(/\\/g, "/");
  // Prefer-A #5545: gate inside the probe so launch.ts stays out of file_scope.
  const safe = assertSafeBranchName(deliveryBranch, "deliveryBranch");
  if (!safe.ok) {
    return { present: false, error: safe.error };
  }
  const fetchArgv = trackingFetchArgv("origin", safe.branch);
  if (!fetchArgv.ok) {
    return { present: false, error: fetchArgv.error };
  }
  const fetch = runGit(["git", ...fetchArgv.argv], { cwd: projectRoot });
  if (fetch.returncode !== 0) {
    return {
      present: false,
      error:
        `git fetch origin ${safe.branch} failed: ` +
        `${fetch.stderr.trim() || fetch.stdout.trim()}`,
    };
  }
  const tip = `origin/${safe.branch}`;
  // Require a blob. `cat-file -e` also succeeds for trees, which would false-present
  // a directory path and then fail later on `git show` (#4714 SLizard P1).
  const probe = runGit(["git", "cat-file", "-t", `${tip}:${rel}`], { cwd: projectRoot });
  if (probe.returncode === 0 && probe.stdout.trim() === "blob") {
    return { present: true, error: null };
  }
  return {
    present: false,
    error:
      `protected delivery tip ${tip} is missing active brief ${rel}. ` +
      "Land a human-reviewed activation PR before swarm:launch / finalize (#4714 R2).",
  };
}

/** Result of the one-PR origin probe (#6361). `ref` is the dest base on admit. */
export interface OnePrOriginBriefResult {
  readonly present: boolean;
  readonly error: string | null;
  /** `origin/<baseBranch>` when admitted; the dest worktree is created from it. */
  readonly ref: string | null;
}

function showAtRef(
  projectRoot: string,
  ref: string,
  relPath: string,
  runGit: typeof runText,
): string | null {
  const shown = runGit(["git", "show", `${ref}:${relPath}`], { cwd: projectRoot });
  return shown.returncode === 0 ? shown.stdout : null;
}

function parseRecord(raw: string | null): ApprovedScopeRecord | null {
  if (raw === null) return null;
  try {
    const rec = JSON.parse(raw) as unknown;
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return null;
    const r = rec as Record<string, unknown>;
    if (typeof r.fileScopeDigest !== "string" || !Array.isArray(r.fileScope)) return null;
    return rec as ApprovedScopeRecord;
  } catch {
    return null;
  }
}

/**
 * One-PR launch probe (#6361). A brief absent from `origin/<deliveryBranch>` is
 * accepted when it is a blob on `origin/<baseBranch>` (the pushed one-PR
 * branch) and the same evaluators CI uses admit it at that tip against its
 * merge base with the delivery tip: the merge base sets the one-PR level
 * (`evaluateOnePrScopeProofGate`) and the record on the tip matches the tip's
 * brief exactly (`evaluateMintLevelRecord`). Nothing is copied: the caller
 * builds the dest worktree from the returned ref. Never throws.
 */
export function originOnePrBriefAdmitted(
  projectRoot: string,
  deliveryBranch: string,
  baseBranch: string,
  relPath: string,
  runGit: typeof runText,
): OnePrOriginBriefResult {
  const refuse = (error: string): OnePrOriginBriefResult => ({ present: false, error, ref: null });
  try {
    const rel = relPath.replace(/\\/g, "/");
    const safeDelivery = assertSafeBranchName(deliveryBranch, "deliveryBranch");
    if (!safeDelivery.ok) return refuse(safeDelivery.error);
    const safeBase = assertSafeBranchName(baseBranch, "baseBranch");
    if (!safeBase.ok) return refuse(safeBase.error);
    const fetchArgv = trackingFetchArgv("origin", safeBase.branch);
    if (!fetchArgv.ok) return refuse(fetchArgv.error);
    const fetch = runGit(["git", ...fetchArgv.argv], { cwd: projectRoot });
    if (fetch.returncode !== 0) {
      return refuse(
        `git fetch origin ${safeBase.branch} failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
      );
    }
    const tip = `origin/${safeBase.branch}`;
    const deliveryTip = `origin/${safeDelivery.branch}`;
    const kind = runGit(["git", "cat-file", "-t", `${tip}:${rel}`], { cwd: projectRoot });
    if (kind.returncode !== 0 || kind.stdout.trim() !== "blob") {
      return refuse(`${tip} has no active brief ${rel}`);
    }
    const mb = runGit(["git", "merge-base", deliveryTip, tip], { cwd: projectRoot });
    const mergeBase = mb.stdout.trim();
    if (mb.returncode !== 0 || mergeBase.length === 0) {
      return refuse(`git merge-base ${deliveryTip} ${tip} failed`);
    }
    const gate = evaluateOnePrScopeProofGate({
      baseRaw: showAtRef(projectRoot, mergeBase, PROJECT_DEFINITION_REL_PATH, runGit),
      headRaw: showAtRef(projectRoot, tip, PROJECT_DEFINITION_REL_PATH, runGit),
    });
    if (gate.kind === "off") {
      return refuse("the merge-base onePrScopeProof level is off");
    }
    if (gate.kind === "refuse") return refuse(gate.reason);
    const headRaw = showAtRef(projectRoot, tip, rel, runGit);
    if (headRaw === null) return refuse(`${tip}:${rel} unreadable`);
    let payload: unknown;
    try {
      payload = JSON.parse(headRaw) as unknown;
    } catch {
      return refuse(`${tip}:${rel} is not valid JSON`);
    }
    const planId = extractPlanId(payload);
    if (planId === null) return refuse("head brief has no plan.id");
    const recordRel = `.deft/approved-scope/${approvedScopeSafePlanId(planId)}.json`;
    const verdict = evaluateMintLevelRecord({
      record: parseRecord(showAtRef(projectRoot, tip, recordRel, runGit)),
      intentRaw: showAtRef(projectRoot, tip, approvedScopeIntentRel(planId), runGit),
      xbriefRelPath: rel,
      headPayload: payload,
      headRaw,
      extract: { projectRoot },
      decisionExists: (decisionRel) => {
        const probe = runGit(["git", "cat-file", "-t", `${tip}:${decisionRel}`], {
          cwd: projectRoot,
        });
        return probe.returncode === 0 && probe.stdout.trim() === "blob";
      },
    });
    if (verdict.kind !== "admit") return refuse(verdict.reason);
    return { present: true, error: null, ref: tip };
  } catch (err) {
    return refuse(`one-PR probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
