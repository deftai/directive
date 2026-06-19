import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stripTrailingPathSeparators } from "../text/redos-safe.js";
import { append, canonicalLogPath, latestForPath, newDecisionId } from "./audit-log.js";
import { resolveProjectRoot } from "./project-context.js";
import { formatVbriefJson, utcNowIso } from "./vbrief-json.js";
import { canonicalRelpath } from "./vbrief-ref.js";

export const DEFAULT_OLDER_THAN_DAYS = 45;
export const SOURCE_FOLDER = "pending";
export const TARGET_FOLDER = "proposed";
export const TARGET_STATUS = "proposed";

export interface DemoteResult {
  readonly ok: boolean;
  readonly message: string;
  readonly auditEntry: Record<string, unknown> | null;
}

function parsePlanUpdated(text: string | undefined): Date | null {
  if (text === undefined || text.length === 0) {
    return null;
  }
  let candidate = text;
  if (candidate.endsWith("Z")) {
    candidate = `${candidate.slice(0, -1)}+00:00`;
  }
  const dt = new Date(candidate);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function daysInPending(filePath: string, planUpdated: string | undefined, now: Date): number {
  const parsed = parsePlanUpdated(planUpdated);
  const stamp = parsed ?? new Date(statSync(filePath).mtimeMs);
  const deltaMs = now.getTime() - stamp.getTime();
  return Math.max(0, Math.floor(deltaMs / (24 * 60 * 60 * 1000)));
}

export function demoteOne(
  filePath: string,
  projectRoot: string,
  reason: string,
  options: {
    actor?: string;
    now?: Date;
    logPath?: string;
    batchId?: string;
  } = {},
): DemoteResult {
  const resolved = resolve(filePath);
  const actor = options.actor ?? "operator";
  const now = options.now ?? new Date();
  const logPath = options.logPath ?? canonicalLogPath(projectRoot);

  if (!existsSync(resolved)) {
    return { ok: false, message: `File not found: ${resolved}`, auditEntry: null };
  }
  const basename = resolved.split(/[/\\]/).pop() ?? "";
  if (!basename.endsWith(".vbrief.json")) {
    return {
      ok: false,
      message: `Not a vBRIEF file (expected .vbrief.json): ${basename}`,
      auditEntry: null,
    };
  }
  const parent = dirname(resolved).split(/[/\\]/).pop() ?? "";
  if (parent !== SOURCE_FOLDER) {
    return {
      ok: false,
      message: `Invalid transition: 'demote' requires file in ${SOURCE_FOLDER}/. File is in ${parent}/.`,
      auditEntry: null,
    };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  } catch (err: unknown) {
    return { ok: false, message: `Invalid JSON in ${resolved}: ${String(err)}`, auditEntry: null };
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      ok: false,
      message: `Missing or invalid 'plan' object in ${resolved}`,
      auditEntry: null,
    };
  }
  const planObj = plan as Record<string, unknown>;
  const planUpdatedBefore = planObj.updated;
  const days = daysInPending(
    resolved,
    typeof planUpdatedBefore === "string" ? planUpdatedBefore : undefined,
    now,
  );

  const canonicalPath = canonicalRelpath(resolved, projectRoot);
  const priorPromote = latestForPath(canonicalPath, "promote", logPath);
  const originalPromotionDecisionId =
    priorPromote !== null ? (priorPromote.decision_id as string | null) : null;

  const timestamp = utcNowIso(now);
  planObj.status = TARGET_STATUS;
  planObj.updated = timestamp;
  writeFileSync(resolved, formatVbriefJson(data), "utf8");

  const vbriefRoot = dirname(dirname(resolved));
  const targetDir = join(vbriefRoot, TARGET_FOLDER);
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, basename);
  renameSync(resolved, targetPath);

  const canonicalPathAfter = canonicalRelpath(targetPath, projectRoot);
  const demoteMeta: Record<string, unknown> = {
    was_promoted: parent === SOURCE_FOLDER,
    original_promotion_decision_id: originalPromotionDecisionId,
    days_in_pending: days,
    demote_reason: reason,
    demoted_from: parent,
  };
  if (options.batchId !== undefined) {
    demoteMeta.batch_id = options.batchId;
  }
  const entry: Record<string, unknown> = {
    decision_id: newDecisionId(),
    timestamp,
    action: "demote",
    vbrief_path: canonicalPathAfter,
    from_status: "pending",
    to_status: TARGET_STATUS,
    actor,
    demote_meta: demoteMeta,
  };
  append(entry, logPath);

  return {
    ok: true,
    message:
      `Demoted ${basename}: ${SOURCE_FOLDER}/ -> ${TARGET_FOLDER}/ ` +
      `(status: ${TARGET_STATUS}, days_in_pending: ${days})`,
    auditEntry: entry,
  };
}

export function batchDemote(
  projectRoot: string,
  olderThanDays: number,
  options: { actor?: string; now?: Date; logPath?: string } = {},
): [number, Record<string, unknown>[], string[]] {
  if (olderThanDays < 0) {
    throw new Error(`--older-than-days must be >= 0, got ${olderThanDays}`);
  }
  const now = options.now ?? new Date();
  const pendingDir = join(resolve(projectRoot), "vbrief", SOURCE_FOLDER);
  if (!existsSync(pendingDir)) {
    return [0, [], []];
  }
  const reason = `batch:older-than-days:${olderThanDays}`;
  let batchId: string | undefined;
  const auditEntries: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  let demoted = 0;

  const files = readdirSync(pendingDir)
    .filter((name) => name.endsWith(".vbrief.json"))
    .sort();

  for (const name of files) {
    const candidate = join(pendingDir, name);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
    } catch (err: unknown) {
      skipped.push(`${name}: read error: ${String(err)}`);
      continue;
    }
    const plan = data.plan;
    const planUpdated =
      typeof plan === "object" && plan !== null && !Array.isArray(plan)
        ? (plan as Record<string, unknown>).updated
        : undefined;
    const days = daysInPending(
      candidate,
      typeof planUpdated === "string" ? planUpdated : undefined,
      now,
    );
    if (days < olderThanDays) {
      skipped.push(`${name}: ${days} day(s) in pending (< ${olderThanDays})`);
      continue;
    }
    if (batchId === undefined) {
      batchId = newDecisionId();
    }
    const result = demoteOne(candidate, projectRoot, reason, {
      ...options,
      now,
      batchId,
    });
    if (result.ok && result.auditEntry !== null) {
      auditEntries.push(result.auditEntry);
      demoted += 1;
    } else {
      skipped.push(`${name}: ${result.message}`);
    }
  }
  return [demoted, auditEntries, skipped];
}

export function resolveFilePath(
  raw: string,
  cliProjectRoot?: string | null,
): [string | null, string | null] {
  const stripped = stripTrailingPathSeparators(raw.trim());
  if (stripped.length === 0) {
    return [
      null,
      "No vBRIEF file path provided. Usage: scope_lifecycle.py <action> <file> [--project-root PATH]",
    ];
  }
  if (isAbsolute(stripped)) {
    return [resolve(stripped), null];
  }
  const projectRoot = resolveProjectRoot(cliProjectRoot);
  if (projectRoot === null) {
    return [
      null,
      `Cannot resolve relative path '${stripped}': no project root detected. Pass --project-root PATH, set $DEFT_PROJECT_ROOT, or run from inside a directory tree that contains vbrief/ or .git/ (#535).`,
    ];
  }
  return [resolve(join(projectRoot, stripped)), null];
}

export function resolveDemoteFilePath(
  raw: string,
  cliProjectRoot?: string | null,
): [string | null, string | null] {
  const stripped = stripTrailingPathSeparators(raw.trim());
  if (stripped.length === 0) {
    return [
      null,
      "No vBRIEF file path provided. Usage: scope_demote.py <file> [--reason TEXT] [--project-root PATH]",
    ];
  }
  if (isAbsolute(stripped)) {
    return [resolve(stripped), null];
  }
  return resolveFilePath(raw, cliProjectRoot);
}

export function resolveProjectRootStrict(
  cliProjectRoot?: string | null,
): [string | null, string | null] {
  const projectRoot = resolveProjectRoot(cliProjectRoot);
  if (projectRoot === null) {
    return [
      null,
      "Cannot determine project root. Pass --project-root PATH, set $DEFT_PROJECT_ROOT, or run from inside a directory tree that contains vbrief/ or .git/ (#535).",
    ];
  }
  return [projectRoot, null];
}
