import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_SOURCE } from "./types.js";

/** Walk `<cacheRoot>/github-issue/<owner>/<repo>/<N>/raw.json`. */
export function iterCacheIssues(cacheRoot: string): Array<Record<string, unknown>> {
  const base = join(cacheRoot, CACHE_SOURCE);
  if (!existsSync(base)) return [];
  const out: Array<Record<string, unknown>> = [];
  const owners = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const owner of owners) {
    const ownerDir = join(base, owner);
    const repos = readdirSync(ownerDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const repo of repos) {
      const repoDir = join(ownerDir, repo);
      const issues = readdirSync(repoDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => Number(a) - Number(b));
      for (const issueNum of issues) {
        const rawPath = join(repoDir, issueNum, "raw.json");
        if (!existsSync(rawPath)) continue;
        try {
          const data = JSON.parse(readFileSync(rawPath, "utf8")) as unknown;
          if (typeof data === "object" && data !== null && !Array.isArray(data)) {
            out.push(data as Record<string, unknown>);
          }
        } catch {}
      }
    }
  }
  return out;
}

export function extractLabels(issue: Record<string, unknown>): Set<string> {
  const raw = issue.labels;
  const names = new Set<string>();
  if (!Array.isArray(raw)) return names;
  for (const item of raw) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string" && name) names.add(name);
    } else if (typeof item === "string" && item) {
      names.add(item);
    }
  }
  return names;
}

export function extractMilestone(issue: Record<string, unknown>): string {
  const raw = issue.milestone;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const title = rec.title;
    if (typeof title === "string" && title) return title;
    const alt = rec.name;
    if (typeof alt === "string" && alt) return alt;
  } else if (typeof raw === "string" && raw) {
    return raw;
  }
  return "";
}

export function extractAuthor(issue: Record<string, unknown>): string {
  const user = issue.user;
  if (typeof user === "object" && user !== null && !Array.isArray(user)) {
    const login = (user as Record<string, unknown>).login;
    if (typeof login === "string" && login) return login;
  }
  const author = issue.author;
  if (typeof author === "object" && author !== null && !Array.isArray(author)) {
    const login = (author as Record<string, unknown>).login;
    if (typeof login === "string" && login) return login;
  }
  if (typeof author === "string" && author) return author;
  return "";
}

export function isOpen(issue: Record<string, unknown>): boolean {
  return issue.state === undefined || issue.state === "open";
}

export function issueRepoKey(issue: Record<string, unknown>): string {
  for (const key of ["repository_url", "html_url"] as const) {
    const value = issue[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}
