import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractIssueRef } from "./parse-uri.js";

export function scanLifecycleRefs(folder: string): Array<[string | null, number, string]> {
  const results: Array<[string | null, number, string]> = [];
  if (!existsSync(folder)) return results;
  const files = readdirSync(folder)
    .filter((name) => name.endsWith(".vbrief.json"))
    .sort();
  for (const name of files) {
    const path = join(folder, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const [repo, number] = extractIssueRef(data as Record<string, unknown>);
    if (number === null) continue;
    results.push([repo, number, path]);
  }
  return results;
}

export function existingAuditRefs(auditPath: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(auditPath)) return seen;
  let text: string;
  try {
    text = readFileSync(auditPath, "utf8");
  } catch {
    return seen;
  }
  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (!stripped) continue;
    try {
      const entry = JSON.parse(stripped) as unknown;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      const repo = rec.repo;
      const number = rec.issue_number;
      if (typeof repo === "string" && typeof number === "number" && Number.isInteger(number)) {
        seen.add(`${repo}:${number}`);
      }
    } catch {}
  }
  return seen;
}

export function auditKey(repo: string, issueNumber: number): string {
  return `${repo}:${issueNumber}`;
}
