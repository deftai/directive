import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_AUDIT_LOG_REL_PATH } from "./constants.js";
import type { AuditEntry } from "./types.js";

/** Resolve audit log path; mirrors candidates_log._resolve_path (framework root). */
export function resolveAuditLogPath(
  options: { readonly auditLogPath?: string | null; readonly frameworkRoot?: string | null } = {},
): string {
  if (options.auditLogPath !== null && options.auditLogPath !== undefined) {
    return resolve(options.auditLogPath);
  }
  const envRoot = process.env.DEFT_ROOT?.trim() ?? "";
  const root =
    options.frameworkRoot !== null && options.frameworkRoot !== undefined
      ? resolve(options.frameworkRoot)
      : envRoot.length > 0
        ? resolve(envRoot)
        : process.cwd();
  return join(root, DEFAULT_AUDIT_LOG_REL_PATH);
}

/** Read audit log entries, optionally filtered by repo. */
export function readAuditEntries(
  repo: string | null,
  options: {
    readonly frameworkRoot?: string | null;
    readonly auditLogPath?: string | null;
  } = {},
): readonly AuditEntry[] {
  const logPath = resolveAuditLogPath(options);
  if (!existsSync(logPath)) {
    return [];
  }
  const out: AuditEntry[] = [];
  const raw = readFileSync(logPath, { encoding: "utf8" });
  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    if (stripped.length === 0) {
      continue;
    }
    try {
      const obj: unknown = JSON.parse(stripped);
      if (typeof obj !== "object" || obj === null) {
        continue;
      }
      const entry = obj as AuditEntry;
      if (repo !== null && entry.repo !== repo) {
        continue;
      }
      out.push(entry);
    } catch {
      // skip malformed audit rows
    }
  }
  return out;
}
