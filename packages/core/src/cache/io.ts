import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { pythonJsonLine } from "./json.js";

/**
 * Write text via tempfile + rename (mirrors Python `_atomic_write_text`).
 * #2951 Phase 2: temp payload write uses containedWrite under the parent dir.
 */
export function atomicWriteText(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpName = `${basename(path)}.${randomBytes(4).toString("hex")}.tmp`;
  const tmp = join(dir, tmpName);
  try {
    containedWrite({
      root: resolve(dir),
      target: tmpName,
      data: text,
      mode: "create",
    });
    renameSync(tmp, path);
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
