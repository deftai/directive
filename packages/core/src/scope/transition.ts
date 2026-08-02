import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { InstrumentedVbriefCrud, persistCrudMetrics } from "../eval/crud-telemetry.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { append, canonicalLogPath, newDecisionId } from "./audit-log.js";
import { atomicWriteBrief, formatBriefJson, readBriefForMutation } from "./brief-io.js";
import { stampCompletionMetadata } from "./capacity-stamp.js";
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
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { syncSpecificationAfterScopeMove } from "./specification-sync.js";
import { utcNowIso } from "./vbrief-json.js";
import type { WipCapCheck } from "./wip-cap-check.js";

export interface TransitionResult {
  readonly ok: boolean;
  readonly message: string;
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

/**
 * Refresh the document envelope `updated` stamp to match `plan.updated`.
 * Stamps whichever of xBRIEFInfo (v0.8) / vBRIEFInfo (v0.6) is present — never creates one (#2862 / #2346).
 */
function stampEnvelopeUpdated(data: Record<string, unknown>, nowIso: string): void {
  for (const key of ["xBRIEFInfo", "vBRIEFInfo"] as const) {
    const env = data[key];
    if (typeof env === "object" && env !== null && !Array.isArray(env)) {
      (env as Record<string, unknown>).updated = nowIso;
    }
  }
}

export function runTransition(
  action: string,
  filePath: string,
  now: Date = new Date(),
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
  if (!allowedSources.includes(currentFolder as (typeof allowedSources)[number])) {
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

  if (targetFolder !== null && targetFolder === currentFolder) {
    return {
      ok: true,
      message: `No-op: ${basename} is already in ${currentFolder}/ (status: ${currentStatus})`,
    };
  }

  const vbriefRoot = dirname(dirname(resolvedPath));
  const projectRoot = dirname(vbriefRoot);

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

  const nowIso = utcNowIso(now);
  planObj.status = targetStatus;
  planObj.updated = nowIso;
  // Keep the envelope clock aligned with plan.updated on every mutating transition (#2862).
  stampEnvelopeUpdated(data, nowIso);

  // Reconcile the completing brief's own plan.items (mirrors #1527 / #2566 registry sync) (#2862).
  if (OWN_ITEMS_RECONCILE_ACTIONS.has(act)) {
    advanceNonTerminalOwnItems(planObj.items, targetStatus);
  }

  if (act === "complete") {
    stampCompletionMetadata(planObj, projectRoot, nowIso);
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
      };
    }
    syncSpecificationAfterScopeMove(data, resolvedPath, destPath, vbriefRoot, targetStatus);
    return {
      ok: true,
      message: `${actionLabel} ${basename}: ${currentFolder}/ -> ${targetFolder}/ (status: ${targetStatus})`,
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
  return {
    ok: true,
    message: `${actionLabel} ${basename}: stays in ${currentFolder}/ (status: ${targetStatus})`,
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
