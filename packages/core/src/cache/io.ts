import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { pythonJsonLine } from "./json.js";

export interface AtomicWriteTextOptions {
  /**
   * Project / checkout root used as the containment boundary (#3042).
   * When set, refuses symlink parents and out-of-root targets before temp+rename.
   * Prefer always passing this for product sinks (brief stay-path, agents refresh, cache).
   * When omitted, falls back to parent-dir containment (legacy test / low-risk helpers).
   */
  readonly projectRoot?: string;
}

/**
 * Write text via tempfile + rename (mirrors Python `_atomic_write_text`).
 * #2951 Phase 2: temp payload write uses containedWrite.
 * #3042: when `projectRoot` is set, containment root is projectRoot (not dirname(path))
 * so force-added lifecycle / cache directory symlinks fail closed.
 */
export function atomicWriteText(
  path: string,
  text: string,
  options: AtomicWriteTextOptions = {},
): void {
  const targetAbs = resolve(path);
  const dir = dirname(targetAbs);
  const tmpBase = `${basename(targetAbs)}.${randomBytes(4).toString("hex")}.tmp`;
  const tmp = join(dir, tmpBase);

  if (options.projectRoot !== undefined) {
    // Contain against projectRoot (parent-as-root fix #3042 / authz writeJsonContained pattern).
    const root = resolve(options.projectRoot);
    assertWriteTargetSafe(root, targetAbs);
    try {
      containedWrite({
        root,
        target: tmp,
        data: text,
        mode: "create",
      });
      renameSync(tmp, targetAbs);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* v8 ignore next -- best-effort cleanup */
      }
      throw err;
    }
    return;
  }

  // Legacy: parent-dir containment when no projectRoot (unit helpers / transitional call sites).
  mkdirSync(dir, { recursive: true });
  try {
    containedWrite({
      root: resolve(dir),
      target: tmpBase,
      data: text,
      mode: "create",
    });
    renameSync(tmp, targetAbs);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* v8 ignore next -- best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Append one JSON audit record (mirrors `_append_audit`).
 * #2951 Phase 2: product write sink routes through containedWrite.
 * Create cacheRoot first — containedWrite requires the containment root to exist.
 */
export function appendAudit(record: Record<string, unknown>, cacheRoot: string): void {
  const root = resolve(cacheRoot);
  mkdirSync(root, { recursive: true });
  containedWrite({
    root,
    target: "quarantine-audit.jsonl",
    data: `${pythonJsonLine(record)}\n`,
    mode: "append",
  });
}

/** Touch mtime for LRU signal; failures swallowed. */
export function touchMtime(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    /* read-only cache still serves hits */
  }
}

/** Read file size in bytes. */
export function fileSize(path: string): number {
  return statSync(path).size;
}

/** Remove directory tree; missing path is fine. */
export function removeEntryDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Best-effort temp file cleanup helper for tests. */
export function mkTempName(dir: string, prefix: string): string {
  return join(dir, `${prefix}.${randomBytes(4).toString("hex")}.tmp`);
}

export { tmpdir };
