import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_STALE_MINUTES, REVIEW_MONITOR_FILENAME, SCHEMA_VERSION } from "./constants.js";
import type { PlatformPrimitive } from "./tier-detection.js";

export interface ReviewMonitorRecord {
  readonly pr: number;
  readonly repo: string | null;
  readonly head_sha: string | null;
  readonly platform_primitive: PlatformPrimitive;
  readonly monitor_agent_id: string;
  readonly started_at: string;
  readonly worktree_path: string;
  readonly parent_session_id: string | null;
  readonly ended_at: string | null;
}

export interface ReviewMonitorFile {
  readonly schema_version: number;
  readonly records: ReviewMonitorRecord[];
}

function resolveMainWorktreeRoot(startDir: string): string {
  let root = resolve(startDir);
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length > 0) {
      const commonDir = isAbsolute(out) ? out : resolve(startDir, out);
      root = dirname(commonDir);
    }
  } catch {
    // Not a git work tree -- fall back to startDir.
  }
  return root;
}

export function reviewMonitorPath(projectRoot: string): string {
  const root = resolveMainWorktreeRoot(projectRoot);
  return join(root, ".deft", REVIEW_MONITOR_FILENAME);
}

function atomicWriteJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text, undefined, "utf8");
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function emptyReviewMonitorFile(): ReviewMonitorFile {
  return { schema_version: SCHEMA_VERSION, records: [] };
}

export function readReviewMonitorFile(path: string): {
  data: ReviewMonitorFile | null;
  error: string | null;
} {
  if (!existsSync(path)) {
    return { data: emptyReviewMonitorFile(), error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (exc: unknown) {
    return { data: null, error: `${path}: invalid JSON (${String(exc)}).` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { data: null, error: `${path}: review-monitor file must be a JSON object.` };
  }
  const obj = parsed as Record<string, unknown>;
  const recordsRaw = obj.records;
  const records: ReviewMonitorRecord[] = [];
  if (Array.isArray(recordsRaw)) {
    for (const entry of recordsRaw) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const pr = e.pr;
      const monitorAgentId = e.monitor_agent_id;
      const platformPrimitive = e.platform_primitive;
      const startedAt = e.started_at;
      const worktreePath = e.worktree_path;
      if (
        typeof pr !== "number" ||
        !Number.isInteger(pr) ||
        pr <= 0 ||
        typeof monitorAgentId !== "string" ||
        monitorAgentId.trim().length === 0 ||
        typeof platformPrimitive !== "string" ||
        typeof startedAt !== "string" ||
        typeof worktreePath !== "string"
      ) {
        continue;
      }
      records.push({
        pr,
        repo: typeof e.repo === "string" ? e.repo : null,
        head_sha: typeof e.head_sha === "string" ? e.head_sha : null,
        platform_primitive: platformPrimitive as PlatformPrimitive,
        monitor_agent_id: monitorAgentId.trim(),
        started_at: startedAt,
        worktree_path: worktreePath,
        parent_session_id: typeof e.parent_session_id === "string" ? e.parent_session_id : null,
        ended_at: typeof e.ended_at === "string" ? e.ended_at : null,
      });
    }
  }
  return {
    data: {
      schema_version: typeof obj.schema_version === "number" ? obj.schema_version : SCHEMA_VERSION,
      records,
    },
    error: null,
  };
}

export function writeReviewMonitorFile(path: string, data: ReviewMonitorFile): void {
  atomicWriteJson(path, data);
}

export interface RegisterReviewMonitorInput {
  readonly pr: number;
  readonly repo?: string | null;
  readonly headSha?: string | null;
  readonly platformPrimitive: PlatformPrimitive;
  readonly monitorAgentId: string;
  readonly projectRoot: string;
  readonly parentSessionId?: string | null;
  readonly startedAt?: Date;
}

export function registerReviewMonitor(input: RegisterReviewMonitorInput): {
  path: string;
  record: ReviewMonitorRecord;
} {
  const path = reviewMonitorPath(input.projectRoot);
  const { data, error } = readReviewMonitorFile(path);
  if (data === null) {
    throw new Error(error ?? "could not read review-monitor file");
  }
  const startedAt = (input.startedAt ?? new Date()).toISOString();
  const record: ReviewMonitorRecord = {
    pr: input.pr,
    repo: input.repo ?? null,
    head_sha: input.headSha ?? null,
    platform_primitive: input.platformPrimitive,
    monitor_agent_id: input.monitorAgentId.trim(),
    started_at: startedAt,
    worktree_path: resolve(input.projectRoot),
    parent_session_id: input.parentSessionId ?? null,
    ended_at: null,
  };
  const active = data.records.filter((r) => r.ended_at === null && r.pr !== input.pr);
  writeReviewMonitorFile(path, {
    schema_version: SCHEMA_VERSION,
    records: [...active, record],
  });
  return { path, record };
}

export function parseIso8601Utc(value: string): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const trimmed = value.trim();
  let candidate = trimmed;
  if (trimmed.endsWith("Z")) {
    candidate = `${trimmed.slice(0, -1)}+00:00`;
  }
  if (!candidate.endsWith("+00:00")) {
    return null;
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function isRecordActive(
  record: ReviewMonitorRecord,
  options: { now?: Date; staleMinutes?: number; headSha?: string | null },
): boolean {
  if (record.ended_at !== null) {
    return false;
  }
  const started = parseIso8601Utc(record.started_at);
  if (started === null) {
    return false;
  }
  const now = options.now ?? new Date();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const ageMs = now.getTime() - started.getTime();
  if (ageMs > staleMinutes * 60 * 1000) {
    return false;
  }
  if (options.headSha !== undefined && options.headSha !== null && record.head_sha !== null) {
    return record.head_sha === options.headSha;
  }
  return true;
}

export function findActiveMonitorForPr(
  file: ReviewMonitorFile,
  pr: number,
  options: { now?: Date; staleMinutes?: number; headSha?: string | null },
): ReviewMonitorRecord | null {
  const matches = file.records.filter((r) => r.pr === pr && isRecordActive(r, options));
  if (matches.length === 0) {
    return null;
  }
  return matches.sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

export function defaultSubagentStatusDir(projectRoot: string): string {
  return join(resolve(projectRoot), ".deft-scratch", "subagent-status");
}
