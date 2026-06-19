import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  if (!basename.endsWith(".vbrief.json")) {
    return { ok: false, message: `Not a vBRIEF file (expected .vbrief.json): ${basename}` };
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

  const nowIso = utcNowIso(now);
  planObj.status = targetStatus;
  planObj.updated = nowIso;

  if (act === "complete") {
    const vbriefRoot = dirname(dirname(resolvedPath));
    const projectRoot = dirname(vbriefRoot);
    stampCompletionMetadata(planObj, projectRoot, nowIso);
  }

  writeFileSync(resolvedPath, formatVbriefJson(data), "utf8");

  if (targetFolder !== null) {
    const vbriefRoot = dirname(dirname(resolvedPath));
    const destDir = join(vbriefRoot, targetFolder);
    mkdirSync(destDir, { recursive: true });
    const destPath = join(destDir, basename);
    renameSync(resolvedPath, destPath);
    updateDecomposedParentBackReferences(data, resolvedPath, destPath, vbriefRoot);
    updateDecomposedChildBackReferences(data, resolvedPath, destPath, vbriefRoot);
    syncProjectDefinitionAfterScopeMove(data, resolvedPath, destPath, vbriefRoot, targetStatus);
    const actionLabel = MOVE_LABELS[act] ?? act.charAt(0).toUpperCase() + act.slice(1);
    return {
      ok: true,
      message: `${actionLabel} ${basename}: ${currentFolder}/ -> ${targetFolder}/ (status: ${targetStatus})`,
    };
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
