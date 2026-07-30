import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { pythonJsonPretty } from "./json.js";
import type { JsonObject } from "./types.js";
import { ProjectDefinitionIOError } from "./types.js";

const mutationThreadLock = { held: false };

/**
 * Absolute path to the PROJECT-DEFINITION artifact. Layout-aware (#2302):
 * resolves `xbrief/PROJECT-DEFINITION.xbrief.json` on a migrated tree, else the
 * legacy `vbrief/PROJECT-DEFINITION.vbrief.json`, so loader not-found messages
 * name the path that actually applies to the project's layout.
 */
export function projectDefinitionPath(projectRoot: string): string {
  return resolveProjectDefinitionPath(resolve(projectRoot));
}

function defaultSleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

export interface MutationLockDeps {
  readonly sleepMs?: (ms: number) => void;
  readonly now?: () => number;
}

/** Serialise PROJECT-DEFINITION read-modify-write critical sections. */
export function projectDefinitionMutationLock<T>(
  projectRoot: string,
  fn: () => T,
  deps: MutationLockDeps = {},
): T {
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const now = deps.now ?? Date.now;
  // Derive the sidecar lock path from the layout-aware resolved PROJECT-DEFINITION
  // path (xbrief/ when migrated, else vbrief/) so the lock lives next to the real
  // artifact and every mutator sharing a project root contends on the same lock,
  // instead of the constant vbrief/ path which would strand a stray lock (#1260).
  const path = resolveProjectDefinitionPath(resolve(projectRoot));
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  if (mutationThreadLock.held) {
    throw new Error("project definition mutation lock is not reentrant");
  }
  mutationThreadLock.held = true;
  let fd: number | undefined;
  try {
    const deadline = now() + 30_000;
    while (true) {
      try {
        fd = openSync(lockPath, "a+");
        const existing = readFileSync(lockPath);
        if (existing.length === 0) {
          writeSync(fd, Buffer.from("\0"));
        }
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EBUSY") {
          throw err;
        }
        if (now() > deadline) {
          throw err;
        }
        sleepMs(20);
      }
    }
    return fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    mutationThreadLock.held = false;
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort */
    }
  }
}

/** Read PROJECT-DEFINITION.vbrief.json and return ``(data, path)``. */
export function loadProjectDefinitionForMutation(projectRoot: string): [JsonObject, string] {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION not found at ${path}; run task triage:welcome / ` +
        "task triage:bootstrap to scaffold one first.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProjectDefinitionIOError(`Could not read PROJECT-DEFINITION at ${path}: ${msg}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProjectDefinitionIOError(`PROJECT-DEFINITION at ${path} is not valid JSON: ${msg}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION at ${path} top-level value is not a JSON object`,
    );
  }
  return [structuredClone(data) as JsonObject, path];
}

/** Atomically write ``data`` to ``path`` as pretty-printed JSON. */
export function atomicWriteProjectDefinition(path: string, data: JsonObject): void {
  // #2980 wave C: product write sink routes through containedWrite (temp under parent).
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload = pythonJsonPretty(data).replace(/\n$/, "");
  const body = payload.endsWith("\n") ? payload : `${payload}\n`;
  const tmpName = `${basename(path)}.${randomBytes(4).toString("hex")}.tmp`;
  const tmp = join(dir, tmpName);
  try {
    containedWrite({
      root: resolve(dir),
      target: tmpName,
      data: body,
      mode: "create",
    });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
