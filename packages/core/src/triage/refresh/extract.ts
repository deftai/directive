import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ISSUE_URL_RE = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i;

export function iterActiveVbriefs(activeDir: string): string[] {
  if (!existsSync(activeDir)) return [];
  return readdirSync(activeDir)
    .filter((name) => name.endsWith(".vbrief.json"))
    .sort()
    .map((name) => join(activeDir, name));
}

export function extractIssueRefs(vbriefPath: string): Array<[string, number]> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(vbriefPath, "utf8"));
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const plan = (data as Record<string, unknown>).plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return [];
  const refs = (plan as Record<string, unknown>).references;
  if (!Array.isArray(refs)) return [];
  const out: Array<[string, number]> = [];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const rec = ref as Record<string, unknown>;
    if (rec.type !== "x-vbrief/github-issue") continue;
    const uri = String(rec.uri ?? "");
    const match = ISSUE_URL_RE.exec(uri);
    if (!match) continue;
    out.push([match[1] ?? "", Number(match[2])]);
  }
  return out;
}
