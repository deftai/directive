import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { append, canonicalLogPath, newDecisionId, readAll } from "./audit-log.js";
import { REVERSIBLE_ACTIONS, TERMINAL_ACTIONS } from "./constants.js";
import { formatVbriefJson, utcNowIso } from "./vbrief-json.js";

export interface UndoResult {
  readonly ok: boolean;
  readonly message: string;
  readonly auditEntry: Record<string, unknown> | null;
}

function vbriefRoot(projectRoot: string): string {
  return join(resolve(projectRoot), "vbrief");
}

function absForEntryPath(projectRoot: string, vbriefPath: string): string {
  return resolve(projectRoot, vbriefPath);
}

export function isAlreadyUndone(
  decisionId: string,
  logEntries: Record<string, unknown>[],
): boolean {
  for (const entry of logEntries) {
    if (entry.action !== "undo") {
      continue;
    }
    const meta = entry.undo_meta;
    if (
      typeof meta === "object" &&
      meta !== null &&
      !Array.isArray(meta) &&
      (meta as Record<string, unknown>).original_decision_id === decisionId
    ) {
      return true;
    }
  }
  return false;
}

export function findByDecisionId(
  decisionId: string,
  logEntries: Record<string, unknown>[],
): Record<string, unknown> | null {
  for (const entry of logEntries) {
    if (entry.decision_id === decisionId) {
      return entry;
    }
  }
  return null;
}

export function findByBatchId(
  batchId: string,
  logEntries: Record<string, unknown>[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const entry of logEntries) {
    const meta = entry.demote_meta;
    let bid: unknown;
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      bid = (meta as Record<string, unknown>).batch_id;
    }
    if (bid === undefined) {
      bid = entry.batch_id;
    }
    if (bid === batchId) {
      out.push(entry);
    }
  }
  return out;
}

interface InversePlan {
  srcRelpath: string;
  destFolder: string;
  newStatus: string;
  fromStatus: string;
  toStatus: string;
}

function inversePlan(
  entry: Record<string, unknown>,
  logEntries: Record<string, unknown>[],
): InversePlan | null {
  const action = entry.action;
  if (action === "demote") {
    return {
      srcRelpath: String(entry.vbrief_path ?? ""),
      destFolder: "pending",
      newStatus: "pending",
      fromStatus: "proposed",
      toStatus: "pending",
    };
  }
  if (action === "cancel") {
    const meta = entry.cancel_meta;
    let cancelledFrom: unknown;
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      cancelledFrom = (meta as Record<string, unknown>).cancelled_from;
    }
    if (cancelledFrom === undefined || cancelledFrom === null || cancelledFrom === "") {
      cancelledFrom = entry.cancelled_from;
    }
    if (cancelledFrom === undefined || cancelledFrom === null || cancelledFrom === "") {
      cancelledFrom = entry.from_status;
    }
    if (typeof cancelledFrom !== "string" || cancelledFrom.length === 0) {
      return null;
    }
    const folderMap: Record<string, string> = {
      running: "active",
      blocked: "active",
      completed: "completed",
      failed: "completed",
      cancelled: "cancelled",
      proposed: "proposed",
      pending: "pending",
      active: "active",
    };
    const destFolder = folderMap[cancelledFrom] ?? cancelledFrom;
    const statusMap: Record<string, string> = {
      proposed: "proposed",
      pending: "pending",
      active: "running",
      completed: "completed",
      cancelled: "cancelled",
    };
    const newStatus = statusMap[destFolder] ?? destFolder;
    return {
      srcRelpath: String(entry.vbrief_path ?? ""),
      destFolder,
      newStatus,
      fromStatus: "cancelled",
      toStatus: newStatus,
    };
  }
  if (action === "restore") {
    return {
      srcRelpath: String(entry.vbrief_path ?? ""),
      destFolder: "cancelled",
      newStatus: "cancelled",
      fromStatus: "proposed",
      toStatus: "cancelled",
    };
  }
  if (action === "undo") {
    const meta = entry.undo_meta;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      return null;
    }
    const originalId = (meta as Record<string, unknown>).original_decision_id;
    if (typeof originalId !== "string") {
      return null;
    }
    const original = findByDecisionId(originalId, logEntries);
    if (original === null) {
      return null;
    }
    const originalAction = original.action;
    if (originalAction === "demote") {
      return {
        srcRelpath: String(entry.vbrief_path ?? ""),
        destFolder: "proposed",
        newStatus: "proposed",
        fromStatus: "pending",
        toStatus: "proposed",
      };
    }
    if (originalAction === "cancel") {
      return {
        srcRelpath: String(entry.vbrief_path ?? ""),
        destFolder: "cancelled",
        newStatus: "cancelled",
        fromStatus: String(entry.to_status ?? "proposed"),
        toStatus: "cancelled",
      };
    }
    if (originalAction === "restore") {
      return {
        srcRelpath: String(entry.vbrief_path ?? ""),
        destFolder: "proposed",
        newStatus: "proposed",
        fromStatus: "cancelled",
        toStatus: "proposed",
      };
    }
    return null;
  }
  return null;
}

function moveAndFlip(
  srcFile: string,
  destFolder: string,
  newStatus: string,
  timestamp: string,
): [boolean, string, string | null] {
  if (!existsSync(srcFile)) {
    return [false, `File not found: ${srcFile}`, null];
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(srcFile, "utf8")) as Record<string, unknown>;
  } catch (err: unknown) {
    return [false, `Invalid JSON in ${srcFile}: ${String(err)}`, null];
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [false, `Missing or invalid 'plan' object in ${srcFile}`, null];
  }
  const planObj = plan as Record<string, unknown>;
  planObj.status = newStatus;
  planObj.updated = timestamp;
  writeFileSync(srcFile, formatVbriefJson(data), "utf8");
  mkdirSync(destFolder, { recursive: true });
  const destPath = join(destFolder, basename(srcFile));
  renameSync(srcFile, destPath);
  return [true, "ok", destPath];
}

function buildUndoEntry(options: {
  entry: Record<string, unknown>;
  timestamp: string;
  actor: string;
  fromStatus: string;
  toStatus: string;
  newRelpath: string;
  undoBatchId?: string;
}): Record<string, unknown> {
  const undoMeta: Record<string, unknown> = {
    original_decision_id: options.entry.decision_id,
    original_action: options.entry.action ?? "",
  };
  if (options.undoBatchId !== undefined) {
    undoMeta.undo_batch_id = options.undoBatchId;
  }
  return {
    decision_id: newDecisionId(),
    timestamp: options.timestamp,
    action: "undo",
    vbrief_path: options.newRelpath,
    from_status: options.fromStatus,
    to_status: options.toStatus,
    actor: options.actor,
    undo_meta: undoMeta,
  };
}

export function undoOne(
  entry: Record<string, unknown>,
  projectRoot: string,
  options: {
    actor?: string;
    now?: Date;
    logPath?: string;
    dryRun?: boolean;
    undoBatchId?: string;
    logEntries?: Record<string, unknown>[];
  } = {},
): UndoResult {
  const action = String(entry.action ?? "");
  const decisionId = String(entry.decision_id ?? "");
  const actor = options.actor ?? "operator";
  const now = options.now ?? new Date();
  const logPath = options.logPath ?? canonicalLogPath(projectRoot);
  let logEntries = options.logEntries ?? readAll(logPath);

  if (TERMINAL_ACTIONS.has(action)) {
    return {
      ok: false,
      message:
        `Refusing to undo terminal action '${action}' (decision_id=${decisionId}). ` +
        "Use git revert or hand-edit.",
      auditEntry: null,
    };
  }
  if (!REVERSIBLE_ACTIONS.has(action)) {
    return {
      ok: false,
      message: `Refusing to undo unknown action '${action}' (decision_id=${decisionId}).`,
      auditEntry: null,
    };
  }
  if (isAlreadyUndone(decisionId, logEntries)) {
    return {
      ok: true,
      message: `No-op: entry ${decisionId} is already undone (idempotent re-run).`,
      auditEntry: null,
    };
  }

  const plan = inversePlan(entry, logEntries);
  if (plan === null) {
    return {
      ok: false,
      message:
        `Cannot derive inverse transition for entry ${decisionId} (action='${action}'). ` +
        "Missing required metadata.",
      auditEntry: null,
    };
  }

  const srcPath = absForEntryPath(projectRoot, plan.srcRelpath);
  const destFolderPath = join(vbriefRoot(projectRoot), plan.destFolder);
  const timestamp = utcNowIso(now);

  if (options.dryRun === true) {
    let srcDisplay: string;
    try {
      srcDisplay = relative(resolve(projectRoot), srcPath).replace(/\\/g, "/");
    } catch {
      srcDisplay = srcPath;
    }
    const msg =
      `DRY-RUN: would undo ${action} (decision_id=${decisionId}) -- ` +
      `${srcDisplay} -> vbrief/${plan.destFolder}/ (status: ${plan.newStatus})`;
    const preview = buildUndoEntry({
      entry,
      timestamp,
      actor,
      fromStatus: plan.fromStatus,
      toStatus: plan.toStatus,
      newRelpath: `vbrief/${plan.destFolder}/${basename(srcPath)}`,
      undoBatchId: options.undoBatchId,
    });
    return { ok: true, message: msg, auditEntry: preview };
  }

  const [ok, fsMsg, destPath] = moveAndFlip(srcPath, destFolderPath, plan.newStatus, timestamp);
  if (!ok || destPath === null) {
    return { ok: false, message: fsMsg, auditEntry: null };
  }

  let destRelpath: string;
  try {
    destRelpath = relative(resolve(projectRoot), destPath).replace(/\\/g, "/");
  } catch {
    destRelpath = destPath.replace(/\\/g, "/");
  }

  const undoEntry = buildUndoEntry({
    entry,
    timestamp,
    actor,
    fromStatus: plan.fromStatus,
    toStatus: plan.toStatus,
    newRelpath: destRelpath,
    undoBatchId: options.undoBatchId,
  });
  append(undoEntry, logPath);
  logEntries = readAll(logPath);

  return {
    ok: true,
    message:
      `Undid ${action} (decision_id=${decisionId}): ${basename(destPath)} -> ` +
      `vbrief/${plan.destFolder}/ (status: ${plan.newStatus})`,
    auditEntry: undoEntry,
  };
}

export function undoBatch(
  batchId: string,
  projectRoot: string,
  options: { actor?: string; now?: Date; logPath?: string; dryRun?: boolean } = {},
): [number, Record<string, unknown>[], string[], string[]] {
  const logPath = options.logPath ?? canonicalLogPath(projectRoot);
  let logEntries = readAll(logPath);
  const members = findByBatchId(batchId, logEntries);
  if (members.length === 0) {
    return [0, [], [`No audit entries found for batch_id=${batchId}.`], []];
  }

  const undoBatchId = options.dryRun === true ? `DRY-RUN-${newDecisionId()}` : newDecisionId();
  const auditEntries: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  const previews: string[] = [];
  let undone = 0;

  members.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  for (const member of members) {
    const result = undoOne(member, projectRoot, {
      ...options,
      undoBatchId,
      logEntries,
    });
    if (result.ok) {
      if (result.auditEntry !== null) {
        auditEntries.push(result.auditEntry);
        if (options.dryRun === true) {
          previews.push(result.message);
        } else {
          logEntries = readAll(logPath);
        }
        undone += 1;
      } else {
        skipped.push(result.message);
      }
    } else {
      skipped.push(result.message);
    }
  }
  return [undone, auditEntries, skipped, previews];
}

export { REVERSIBLE_ACTIONS, TERMINAL_ACTIONS };
