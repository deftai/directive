import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveTriageCachePath } from "../triage/cache-path.js";
import { pythonJsonStringify } from "./json.js";
import { withAppendLock } from "./lock.js";
import { validateRecord } from "./validate.js";

export interface WriteSliceOptions {
  readonly umbrellaUrl: string;
  readonly actor: string;
  readonly expectedCloseSignal?: string;
  readonly sliceId?: string;
  readonly slicedAt?: string;
  readonly notes?: string;
  readonly path?: string;
  readonly nowIso?: () => string;
  readonly newSliceId?: () => string;
}

export interface RecordModuleDeps {
  readonly readFile?: typeof readFileSync;
  readonly exists?: typeof existsSync;
  readonly mkdir?: typeof mkdirSync;
  readonly withLock?: typeof withAppendLock;
}

const defaultDeps: Required<RecordModuleDeps> = {
  readFile: readFileSync,
  exists: existsSync,
  mkdir: mkdirSync,
  withLock: withAppendLock,
};

/**
 * Containment root for slices.jsonl append (#3354 / #3288).
 * Prefer `projectRoot` when the log is nested under it so out-of-tree dests refuse.
 * Otherwise use the log parent (still refuses leaf symlink follow).
 */
export function containmentRootForSliceLog(logPath: string, projectRoot?: string): string {
  if (projectRoot !== undefined) {
    return resolve(projectRoot);
  }
  return resolve(dirname(logPath));
}

function resolvePath(path: string | undefined): string {
  return path !== undefined ? resolve(path) : resolveTriageCachePath(process.cwd(), "slices.jsonl");
}

export function newSliceId(): string {
  return randomUUID();
}

/** Return the current UTC time in canonical ISO-8601 form with Z suffix (no fractional seconds). */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseJsonlIds(
  logPath: string,
  deps: Required<RecordModuleDeps>,
  warn?: (message: string) => void,
): Set<string> {
  if (!deps.exists(logPath)) {
    return new Set();
  }
  const seen = new Set<string>();
  const raw = deps.readFile(logPath, "utf8");
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i]?.trim() ?? "";
    if (stripped.length === 0) {
      continue;
    }
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        const sid = (obj as Record<string, unknown>).slice_id;
        if (typeof sid === "string") {
          seen.add(sid);
        }
      }
    } catch (err) {
      warn?.(`slices.jsonl: skipping malformed JSON on line ${i + 1}: ${String(err)}`);
    }
  }
  return seen;
}

/** Validate + append record without acquiring the sidecar lock. */
export function writeSliceUnlocked(
  record: Record<string, unknown>,
  options: {
    path?: string;
    deps?: RecordModuleDeps;
    warn?: (message: string) => void;
    projectRoot?: string;
  } = {},
): string {
  const deps = { ...defaultDeps, ...options.deps };
  validateRecord(record);
  const logPath = resolvePath(options.path);
  deps.mkdir(dirname(logPath), { recursive: true });
  const resolvedId = String(record.slice_id);
  const existing = parseJsonlIds(logPath, deps, options.warn);
  if (existing.has(resolvedId)) {
    return resolvedId;
  }
  const line = `${pythonJsonStringify(record)}\n`;
  const root = containmentRootForSliceLog(logPath, options.projectRoot);
  deps.mkdir(root, { recursive: true });
  containedWrite({
    root,
    target: logPath,
    data: line,
    mode: "append",
  });
  return resolvedId;
}

/** Validate and atomically append a cohort record to slices.jsonl. */
export function writeSlice(
  umbrella: number,
  children: Iterable<Record<string, unknown>>,
  options: WriteSliceOptions,
  deps: RecordModuleDeps = {},
): string {
  const mergedDeps = { ...defaultDeps, ...deps };
  const resolvedId = options.sliceId ?? options.newSliceId?.() ?? newSliceId();
  const record: Record<string, unknown> = {
    slice_id: resolvedId,
    umbrella,
    umbrella_url: options.umbrellaUrl,
    sliced_at: options.slicedAt ?? options.nowIso?.() ?? nowIso(),
    actor: options.actor,
    children: [...children].map((child) => ({ ...child })),
    expected_close_signal: options.expectedCloseSignal ?? "all-children-merged",
  };
  if (options.notes !== undefined) {
    record.notes = options.notes;
  }
  const logPath = resolvePath(options.path);
  return mergedDeps.withLock(logPath, () =>
    writeSliceUnlocked(record, { path: logPath, deps: mergedDeps }),
  );
}

/** Return every well-formed slice record in insertion order. */
export function readAll(
  options: { path?: string; deps?: RecordModuleDeps; warn?: (message: string) => void } = {},
): Record<string, unknown>[] {
  const deps = { ...defaultDeps, ...options.deps };
  const logPath = resolvePath(options.path);
  if (!deps.exists(logPath)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  const raw = deps.readFile(logPath, "utf8");
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i]?.trim() ?? "";
    if (stripped.length === 0) {
      continue;
    }
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        options.warn?.(
          `slices.jsonl: skipping non-object entry on line ${i + 1} (got ${obj === null ? "null" : typeof obj})`,
        );
        continue;
      }
      out.push(obj as Record<string, unknown>);
    } catch (err) {
      options.warn?.(`slices.jsonl: skipping malformed JSON on line ${i + 1}: ${String(err)}`);
    }
  }
  return out;
}

export function findBySliceId(
  sliceId: string,
  options: { path?: string; deps?: RecordModuleDeps } = {},
): Record<string, unknown> | null {
  for (const record of readAll(options)) {
    if (record.slice_id === sliceId) {
      return record;
    }
  }
  return null;
}

export function findByUmbrella(
  umbrella: number,
  options: { path?: string; deps?: RecordModuleDeps } = {},
): Record<string, unknown>[] {
  return readAll(options).filter((record) => record.umbrella === umbrella);
}

export function slicesPath(projectRoot: string): string {
  return resolveTriageCachePath(projectRoot, "slices.jsonl");
}
