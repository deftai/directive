import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { InstrumentedVbriefCrud, persistCrudMetrics } from "../eval/crud-telemetry.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { append, canonicalLogPath, newDecisionId } from "./audit-log.js";
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
import { formatVbriefJson, utcNowIso } from "./vbrief-json.js";
import type { WipCapCheck } from "./wip-cap-check.js";

export interface TransitionResult {
  readonly ok: boolean;
  readonly message: string;
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

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(resolvedPath, "utf8")) as Record<string, unknown>;
  } catch (err: unknown) {
    return { ok: false, message: `Invalid JSON in ${resolvedPath}: ${String(err)}` };
  }

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

  if (act === "complete") {
    stampCompletionMetadata(planObj, projectRoot, nowIso);
  }

  const formatted = formatVbriefJson(data);
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
    const writeResult = crud.update(destPath, formatted, { trustedWrite: true });
    if (!writeResult.ok) {
      return { ok: false, message: writeResult.error ?? `CRUD update failed for ${destPath}` };
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
    syncProjectDefinitionAfterScopeMove(data, resolvedPath, destPath, vbriefRoot, targetStatus);
    syncSpecificationAfterScopeMove(data, resolvedPath, destPath, vbriefRoot, targetStatus);
    const actionLabel = MOVE_LABELS[act] ?? act.charAt(0).toUpperCase() + act.slice(1);
    return {
      ok: true,
      message: `${actionLabel} ${basename}: ${currentFolder}/ -> ${targetFolder}/ (status: ${targetStatus})`,
    };
  }

  const writeResult = crud.update(resolvedPath, formatted, { trustedWrite: true });
  if (!writeResult.ok) {
    return { ok: false, message: writeResult.error ?? `CRUD update failed for ${resolvedPath}` };
  }
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
