import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  SESSION_COMPLETED_AC_REMEDIATION,
  writeSessionCompletedMarker,
} from "../check/session-completed-ac.js";
import { InstrumentedVbriefCrud, persistCrudMetrics } from "../eval/crud-telemetry.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import {
  applyClauseDerivationToPlan,
  maybeEmitAcceptanceStampFromChange,
} from "../intake/clause-derivation.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { stampExistingEnvelopes } from "../lifecycle/brief-envelope.js";
import { evaluateCompletedPlanConsistency } from "../lifecycle/completed-consistency.js";
import { evaluateLiteralAcceptanceFromPlan } from "../literal-acceptance/index.js";
import type { GitRunner } from "../session/git.js";
import { evaluateAcceptanceActivateGate } from "./acceptance-activate-gate.js";
import {
  type CriterionAcceptanceReport,
  evaluateAcceptanceEvidenceGate,
  evaluateScopeCompleteAcceptanceWalk,
  formatAcceptanceCompletionListing,
} from "./acceptance-evidence.js";
import { append, canonicalLogPath, newDecisionId } from "./audit-log.js";
import { atomicWriteBrief, formatBriefJson, readBriefForMutation } from "./brief-io.js";
import { stampCompletionMetadata } from "./capacity-stamp.js";
import {
  applyPromoteClauseFileScopeBind,
  shouldApplyPromoteClauseFileScopeBind,
} from "./clause-file-scope-bind.js";
import {
  LIFECYCLE_FOLDERS,
  MOVE_LABELS,
  type ScopeAction,
  STATUS_PRECONDITIONS,
  STAY_LABELS,
  TRANSITIONS,
} from "./constants.js";
import {
  detectLifecycleFolder,
  updateDecomposedChildBackReferences,
  updateDecomposedParentBackReferences,
} from "./decomposed-refs.js";
import {
  classifyStoredDeliveryDisposition,
  type DeliveryEvidenceInput,
  evaluateDeliveryGate,
  type NonDeliveryDisposition,
  resolveCompletionSessionId,
  stampDeliveryProvenance,
} from "./delivery-evidence.js";
import { evaluateEffortActivateGate } from "./effort-activate-gate.js";
import { stampLifecycleWrite } from "./lifecycle-write.js";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { syncSpecificationAfterScopeMove } from "./specification-sync.js";
import { utcNowIso } from "./vbrief-json.js";
import type { WipCapCheck } from "./wip-cap-check.js";

export interface TransitionResult {
  readonly ok: boolean;
  readonly message: string;
  /** Per-criterion acceptance reports when complete ran the #3240 gate. */
  readonly acceptanceReports?: readonly CriterionAcceptanceReport[];
}

/** Optional completion evidence / disposition for the delivery gate (#3041). */
export interface TransitionOptions {
  readonly deliveryEvidence?: DeliveryEvidenceInput | null;
  readonly nonDeliveryDisposition?: NonDeliveryDisposition | null;
  readonly runGit?: GitRunner;
  readonly verifier?: string;
  readonly assumeEvidenceValidated?: boolean;
  /**
   * Test-only escape hatch: skip the #3240 per-item acceptance evidence gate.
   * Production callers MUST leave this false/undefined.
   */
  readonly skipAcceptanceEvidenceGate?: boolean;
}

/** Item statuses that still represent unfinished work and should advance on terminal transitions (#2862). */
const NON_TERMINAL_ITEM_STATUSES = new Set(["pending", "proposed", "running"]);

/** Terminal lifecycle actions that reconcile the brief's own plan.items (#2862). */
const OWN_ITEMS_RECONCILE_ACTIONS = new Set<ScopeAction>(["complete", "fail", "cancel"]);

/**
 * Advance non-terminal plan.items / subItems to the terminal target status.
 * Leaves cancelled / failed / completed / other non-pending-proposed-running items alone (#2862).
 */
function advanceNonTerminalOwnItems(items: unknown, targetStatus: string): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const status = String(obj.status ?? "");
    if (NON_TERMINAL_ITEM_STATUSES.has(status)) {
      obj.status = targetStatus;
    }
    advanceNonTerminalOwnItems(obj.subItems, targetStatus);
    advanceNonTerminalOwnItems(obj.items, targetStatus);
  }
}

export function runTransition(
  action: string,
  filePath: string,
  now: Date = new Date(),
  options: TransitionOptions = {},
): TransitionResult {
  if (!(action in TRANSITIONS)) {
    const valid = Object.keys(TRANSITIONS).sort().join(", ");
    return { ok: false, message: `Unknown action '${action}'. Valid actions: ${valid}` };
  }
  const act = action as ScopeAction;
  const resolvedPath = resolve(filePath);

  if (!existsSync(resolvedPath)) {
    return { ok: false, message: `File not found: ${resolvedPath}` };
  }
  const basename = resolvedPath.split(/[/\\]/).pop() ?? "";
  if (!hasArtifactSuffix(basename)) {
    return {
      ok: false,
      message: `Not a vBRIEF file (expected .vbrief.json or .xbrief.json): ${basename}`,
    };
  }

  const currentFolder = detectLifecycleFolder(resolvedPath);
  if (currentFolder === null) {
    return {
      ok: false,
      message: `File is not inside a lifecycle folder (${LIFECYCLE_FOLDERS.join(", ")}): ${resolvedPath}`,
    };
  }

  const { allowedSources, targetFolder, targetStatus } = TRANSITIONS[act];
  const restampCompleted = act === "complete" && currentFolder === "completed";
  if (
    !restampCompleted &&
    !allowedSources.includes(currentFolder as (typeof allowedSources)[number])
  ) {
    const allowedStr = allowedSources.map((s) => `${s}/`).join(", ");
    return {
      ok: false,
      message:
        `Invalid transition: '${act}' requires file in ${allowedStr}. ` +
        `File is in ${currentFolder}/.`,
    };
  }

  const readResult = readBriefForMutation(resolvedPath);
  if (!readResult.ok) {
    return { ok: false, message: readResult.message };
  }
  const data = readResult.data;

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return { ok: false, message: `Missing or invalid 'plan' object in ${resolvedPath}` };
  }
  const planObj = plan as Record<string, unknown>;
  const currentStatus = String(planObj.status ?? "");

  const requiredStatus = STATUS_PRECONDITIONS[act];
  if (requiredStatus !== undefined) {
    if (currentStatus === targetStatus) {
      return {
        ok: true,
        message: `No-op: ${basename} is already ${targetStatus} in ${currentFolder}/`,
      };
    }
    if (currentStatus !== requiredStatus) {
      return {
        ok: false,
        message:
          `Invalid transition: '${act}' requires status='${requiredStatus}', ` +
          `but ${basename} has status='${currentStatus}'.`,
      };
    }
  }

  const nowIso = utcNowIso(now);
  const vbriefRoot = dirname(dirname(resolvedPath));
  const projectRoot = dirname(vbriefRoot);

  // #3679: lift #3041 already-completed handling out of STATUS_PRECONDITIONS
  // so complete can stamp a brief already in completed/ without a folder trip.
  if (restampCompleted) {
    return restampCompletedBrief({
      resolvedPath,
      basename,
      data,
      planObj,
      projectRoot,
      vbriefRoot,
      now,
      nowIso,
      options,
    });
  }

  if (targetFolder !== null && targetFolder === currentFolder) {
    return {
      ok: true,
      message: `No-op: ${basename} is already in ${currentFolder}/ (status: ${currentStatus})`,
    };
  }

  if (targetFolder !== null) {
    const destDir = join(vbriefRoot, targetFolder);
    try {
      // #2447: refuse lifecycle moves when the destination folder escapes the checkout.
      // Run before mutating the source file so a refusal leaves lifecycle state intact.
      assertProjectionContained(projectRoot, destDir);
    } catch (err) {
      if (err instanceof ProjectionContainmentError) {
        return { ok: false, message: err.message };
      }
      throw err;
    }
  }

  // #3360: hand-authored briefs run #3323 clause derivation on activate/promote.
  // #3355: stamp is state-observed (before vs after), not derivation-notice-bound.
  const previousAcceptance = planObj.acceptance;
  let derivationNotice = "";
  if (act === "activate" || act === "promote") {
    const derivation = applyClauseDerivationToPlan(planObj, {
      projectRoot,
      emitStamp: false,
    });
    if (derivation.notice.length > 0) {
      derivationNotice = derivation.notice;
    }
    if (shouldApplyPromoteClauseFileScopeBind(planObj)) {
      const bind = applyPromoteClauseFileScopeBind(planObj);
      if (!bind.ok) {
        return { ok: false, message: bind.message };
      }
      if (bind.message.length > 0) {
        derivationNotice =
          derivationNotice.length > 0 ? `${derivationNotice}\n${bind.message}` : bind.message;
      }
    }
  }

  // #1581: fail closed before activating a scope that still has XL plan items.
  if (act === "activate") {
    const effortGate = evaluateEffortActivateGate(planObj);
    if (!effortGate.ok) {
      return { ok: false, message: effortGate.message };
    }
    const acceptanceGate = evaluateAcceptanceActivateGate(planObj);
    if (!acceptanceGate.ok) {
      return { ok: false, message: acceptanceGate.message };
    }
  }

  // #3041: fail closed before mutating a code-bearing complete without delivery evidence.
  if (act === "complete") {
    const gate = evaluateDeliveryGate({
      projectRoot,
      plan: planObj,
      nowIso,
      evidence: options.deliveryEvidence,
      nonDeliveryDisposition: options.nonDeliveryDisposition,
      runGit: options.runGit,
      verifier: options.verifier ?? "scope:complete",
      assumeEvidenceValidated: options.assumeEvidenceValidated,
    });
    if (!gate.ok) {
      return { ok: false, message: gate.message };
    }
    if (gate.provenance !== null) {
      const sessionId = resolveCompletionSessionId(projectRoot);
      stampDeliveryProvenance(
        planObj,
        sessionId !== null
          ? { ...gate.provenance, completedSessionId: sessionId }
          : gate.provenance,
      );
    }
    stampLifecycleWrite(planObj, "complete", nowIso);
  }

  // #3240: per-criterion typed evidence or human-origin disposition before auto-advance.
  let acceptanceReports: readonly CriterionAcceptanceReport[] | undefined;
  let acceptanceListing = "";
  if (act === "complete" && options.skipAcceptanceEvidenceGate !== true) {
    const acceptanceGate = evaluateAcceptanceEvidenceGate(planObj);
    acceptanceReports = acceptanceGate.reports;
    if (!acceptanceGate.ok) {
      return {
        ok: false,
        message: acceptanceGate.message,
        acceptanceReports: acceptanceGate.reports,
      };
    }
    acceptanceListing = formatAcceptanceCompletionListing(acceptanceGate.reports);

    // #3267: run agent-authored literal AC before complete; re-scan narratives so
    // narrative-only stated commands fail closed (promote required) rather than skip.
    const literalGate = evaluateLiteralAcceptanceFromPlan(planObj, {
      projectRoot,
      captureFromNarratives: true,
    });
    if (!literalGate.ok) {
      return {
        ok: false,
        message:
          `Literal acceptance-command gate failed before scope:complete (#3267).\n` +
          literalGate.message,
        acceptanceReports: acceptanceGate.reports,
      };
    }
    if (literalGate.commands.length > 0 || literalGate.message.length > 0) {
      acceptanceListing =
        acceptanceListing.length > 0
          ? `${acceptanceListing}\n${literalGate.message}`
          : literalGate.message;
    }

    // #3357: verify:ac walk is a hard precondition. Disposition does not skip it.
    const acWalk = evaluateScopeCompleteAcceptanceWalk(planObj, { projectRoot });
    if (!acWalk.ok) {
      return {
        ok: false,
        message: acWalk.message,
        acceptanceReports: acceptanceGate.reports,
      };
    }
    if (acWalk.message.length > 0) {
      acceptanceListing =
        acceptanceListing.length > 0 ? `${acceptanceListing}\n${acWalk.message}` : acWalk.message;
    }
  }

  planObj.status = targetStatus;
  planObj.updated = nowIso;
  // Keep the envelope clock aligned with plan.updated on every mutating transition (#2862).
  // Stamps whichever envelope is present, never creates one (#3933 / #2346).
  stampExistingEnvelopes(data, nowIso);

  // Reconcile the completing brief's own plan.items (mirrors #1527 / #2566 registry sync) (#2862).
  // On complete, items only reach here when #3240 evidence/disposition gate passed.
  if (OWN_ITEMS_RECONCILE_ACTIONS.has(act)) {
    advanceNonTerminalOwnItems(planObj.items, targetStatus);
  }

  if (act === "complete") {
    stampCompletionMetadata(planObj, projectRoot, nowIso, {
      completedSessionId: resolveCompletionSessionId(projectRoot),
    });
    // #3242 / epic #3237 Q4: after reconcile, completed lifecycle must match
    // plan.status=completed and terminal plan.items (compose with #3240).
    const consistency = evaluateCompletedPlanConsistency(planObj, {
      relPath: basename,
      requireStatus: "completed",
    });
    if (!consistency.ok) {
      return {
        ok: false,
        message: consistency.message,
        acceptanceReports,
      };
    }
  }

  if (act === "fail") {
    stampLifecycleWrite(planObj, "fail", nowIso);
  }
  if (act === "cancel") {
    stampLifecycleWrite(planObj, "cancel", nowIso);
  }

  const formatted = formatBriefJson(data);
  const crud = new InstrumentedVbriefCrud({ now: () => now });

  if (targetFolder !== null) {
    const destDir = join(vbriefRoot, targetFolder);
    mkdirSync(destDir, { recursive: true });
    const destPath = join(destDir, basename);
    if (existsSync(destPath)) {
      return { ok: false, message: `Target already exists: ${destPath}` };
    }

    // #2578: stamp terminal status at the destination path in the same write as
    // folder placement — never leave a non-terminal status under completed/.
    const writeResult = atomicWriteBrief(destPath, data, vbriefRoot, { projectRoot });
    if (!writeResult.ok) {
      return { ok: false, message: writeResult.message };
    }
    crud.recordTrustedUpdate(destPath, formatted);
    if (act === "complete") {
      const sessionId = resolveCompletionSessionId(projectRoot);
      if (sessionId !== null) {
        try {
          writeSessionCompletedMarker(projectRoot, {
            path: destPath,
            sessionId,
            completedAt: nowIso,
          });
        } catch {
          try {
            unlinkSync(destPath);
          } catch {
            /* dest rollback after marker failure */
          }
          return { ok: false, message: SESSION_COMPLETED_AC_REMEDIATION };
        }
      }
    }

    try {
      unlinkSync(resolvedPath);
    } catch (err: unknown) {
      try {
        unlinkSync(destPath);
      } catch {
        /* best-effort rollback */
      }
      return { ok: false, message: `Failed to remove source after move: ${String(err)}` };
    }

    try {
      persistCrudMetrics(projectRoot, crud.getMetrics());
    } catch {
      /* best-effort telemetry persistence */
    }

    updateDecomposedParentBackReferences(data, resolvedPath, destPath, vbriefRoot);
    updateDecomposedChildBackReferences(data, resolvedPath, destPath, vbriefRoot);
    const actionLabel = MOVE_LABELS[act] ?? act.charAt(0).toUpperCase() + act.slice(1);
    const pdSyncError = syncProjectDefinitionAfterScopeMove(
      data,
      resolvedPath,
      destPath,
      vbriefRoot,
      targetStatus,
    );
    if (pdSyncError !== null) {
      return {
        ok: false,
        message:
          `${actionLabel} ${basename}: brief moved to ${targetFolder}/ but ` +
          `PROJECT-DEFINITION sync failed: ${pdSyncError}`,
        acceptanceReports,
      };
    }
    syncSpecificationAfterScopeMove(data, resolvedPath, destPath, vbriefRoot, targetStatus);
    if (act === "activate" || act === "promote") {
      maybeEmitAcceptanceStampFromChange(projectRoot, previousAcceptance, planObj.acceptance);
    }
    const moveMsg =
      `${actionLabel} ${basename}: ${currentFolder}/ -> ${targetFolder}/ (status: ${targetStatus})` +
      (derivationNotice.length > 0 ? `\n${derivationNotice}` : "") +
      (acceptanceListing.length > 0 ? `\n${acceptanceListing}` : "");
    return {
      ok: true,
      message: moveMsg,
      acceptanceReports,
    };
  }

  const writeResult = atomicWriteBrief(resolvedPath, data, vbriefRoot, { projectRoot });
  if (!writeResult.ok) {
    return { ok: false, message: writeResult.message };
  }
  crud.recordTrustedUpdate(resolvedPath, formatted);
  try {
    persistCrudMetrics(projectRoot, crud.getMetrics());
  } catch {
    /* best-effort telemetry persistence */
  }

  const actionLabel = STAY_LABELS[act] ?? act.charAt(0).toUpperCase() + act.slice(1);
  if (act === "activate" || act === "promote") {
    maybeEmitAcceptanceStampFromChange(projectRoot, previousAcceptance, planObj.acceptance);
  }
  const stayMsg =
    `${actionLabel} ${basename}: stays in ${currentFolder}/ (status: ${targetStatus})` +
    (derivationNotice.length > 0 ? `\n${derivationNotice}` : "") +
    (acceptanceListing.length > 0 ? `\n${acceptanceListing}` : "");
  return {
    ok: true,
    message: stayMsg,
    acceptanceReports,
  };
}

interface RestampArgs {
  readonly resolvedPath: string;
  readonly basename: string;
  readonly data: Record<string, unknown>;
  readonly planObj: Record<string, unknown>;
  readonly projectRoot: string;
  readonly vbriefRoot: string;
  readonly now: Date;
  readonly nowIso: string;
  readonly options: TransitionOptions;
}

/**
 * Stamp a brief already in completed/ (#3679). Runs the #3041 delivery gate
 * and writes in place so recovery does not need a folder round-trip.
 * The #3041 deliveryDisposition suffix now actually executes for complete.
 */
function restampCompletedBrief(args: RestampArgs): TransitionResult {
  const { resolvedPath, basename, data, planObj, projectRoot, vbriefRoot, now, nowIso, options } =
    args;

  const gate = evaluateDeliveryGate({
    projectRoot,
    plan: planObj,
    nowIso,
    evidence: options.deliveryEvidence,
    nonDeliveryDisposition: options.nonDeliveryDisposition,
    runGit: options.runGit,
    verifier: options.verifier ?? "scope:complete",
    assumeEvidenceValidated: options.assumeEvidenceValidated,
  });
  if (!gate.ok) {
    return { ok: false, message: gate.message };
  }
  if (gate.provenance !== null) {
    const sessionId = resolveCompletionSessionId(projectRoot);
    stampDeliveryProvenance(
      planObj,
      sessionId !== null ? { ...gate.provenance, completedSessionId: sessionId } : gate.provenance,
    );
  }

  planObj.status = "completed";
  planObj.updated = nowIso;
  stampExistingEnvelopes(data, nowIso);
  stampCompletionMetadata(planObj, projectRoot, nowIso, {
    completedSessionId: resolveCompletionSessionId(projectRoot),
  });
  stampLifecycleWrite(planObj, "complete", nowIso);

  const writeResult = atomicWriteBrief(resolvedPath, data, vbriefRoot, { projectRoot });
  if (!writeResult.ok) {
    return { ok: false, message: writeResult.message };
  }

  const crud = new InstrumentedVbriefCrud({ now: () => now });
  crud.recordTrustedUpdate(resolvedPath, formatBriefJson(data));
  try {
    persistCrudMetrics(projectRoot, crud.getMetrics());
  } catch {
    /* best-effort telemetry persistence */
  }

  const sessionId = resolveCompletionSessionId(projectRoot);
  if (sessionId !== null) {
    try {
      writeSessionCompletedMarker(projectRoot, {
        path: resolvedPath,
        sessionId,
        completedAt: nowIso,
      });
    } catch {
      return { ok: false, message: SESSION_COMPLETED_AC_REMEDIATION };
    }
  }

  const disposition = classifyStoredDeliveryDisposition(planObj);
  return {
    ok: true,
    message:
      `Restamped ${basename} in completed/ (status: completed, ` +
      `deliveryDisposition=${disposition})`,
  };
}

export function recordWipCapOverride(
  filePath: string,
  projectRoot: string,
  check: WipCapCheck,
  now: Date = new Date(),
): void {
  try {
    const rel = resolve(filePath).startsWith(resolve(projectRoot))
      ? resolve(filePath)
          .slice(resolve(projectRoot).length + 1)
          .replace(/\\/g, "/")
      : resolve(filePath).replace(/\\/g, "/");
    const entry = {
      decision_id: newDecisionId(),
      timestamp: utcNowIso(now),
      action: "promote",
      vbrief_path: rel,
      from_status: "proposed",
      to_status: "pending",
      actor: "operator",
      wip_cap_override: {
        cap: check.cap,
        count_at_promote: check.count,
        source: check.source,
        reason: "--force",
      },
    };
    append(entry, canonicalLogPath(projectRoot));
  } catch {
    /* best-effort audit */
  }
}

export { detectLifecycleFolder };
