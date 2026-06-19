import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pythonJsonLine } from "./json.js";

/** Write text via tempfile + rename (mirrors Python `_atomic_write_text`). */
export function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `${path.split(/[/\\]/).pop() ?? "file"}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmp, text, { encoding: "utf8" });
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

/** Append one JSON audit record (mirrors `_append_audit`). */
export function appendAudit(record: Record<string, unknown>, cacheRoot: string): void {
  const path = join(cacheRoot, "quarantine-audit.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${pythonJsonLine(record)}\n`, { encoding: "utf8" });
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
