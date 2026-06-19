import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function loadPlan(path: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
    if (typeof data !== "object" || data === null) {
      return null;
    }
    const plan = (data as Record<string, unknown>).plan;
    return typeof plan === "object" && plan !== null ? (plan as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract issue numbers from a plan's x-vbrief/github-issue references. */
export function issueNumbersFromPlan(plan: Record<string, unknown>): ReadonlySet<number> {
  const out = new Set<number>();
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return out;
  }
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null) {
      continue;
    }
    const typed = ref as Record<string, unknown>;
    if (typed.type !== "x-vbrief/github-issue") {
      continue;
    }
    const uri = typed.uri;
    if (typeof uri !== "string") {
      continue;
    }
    const tail = uri.replace(/\/+$/, "").split("/").pop() ?? "";
    if (/^\d+$/.test(tail)) {
      out.add(Number.parseInt(tail, 10));
    }
  }
  return out;
}

/** Return plan.metadata.rank as an int, or null when absent/invalid. */
export function scopeMetadataRank(plan: unknown): number | null {
  if (typeof plan !== "object" || plan === null) {
    return null;
  }
  const metadata = (plan as Record<string, unknown>).metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const rank = (metadata as Record<string, unknown>).rank;
  if (typeof rank === "boolean") {
    return null;
  }
  if (typeof rank === "number" && Number.isInteger(rank)) {
    return rank;
  }
  if (typeof rank === "string") {
    const trimmed = rank.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }
  return null;
}

function dependsOnIds(plan: Record<string, unknown>): readonly string[] {
  const metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return [];
  }
  const swarm = (metadata as Record<string, unknown>).swarm;
  if (typeof swarm !== "object" || swarm === null) {
    return [];
  }
  const raw = (swarm as Record<string, unknown>).depends_on;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
    .map((dep) => dep.trim());
}

function completedPlanIds(projectRoot: string): ReadonlySet<string> {
  const out = new Set<string>();
  const base = join(resolve(projectRoot), "vbrief", "completed");
  if (!existsSync(base)) {
    return out;
  }
  for (const name of readdirSync(base).filter((entry) => entry.endsWith(".vbrief.json"))) {
    const plan = loadPlan(join(base, name));
    if (plan === null) {
      continue;
    }
    const pid = plan.id;
    if (typeof pid === "string" && pid.trim().length > 0) {
      out.add(pid.trim());
    }
  }
  return out;
}

/** Return true when a scope is blocked (#1286). */
export function scopeIsBlocked(plan: unknown, completedIds: ReadonlySet<string>): boolean {
  if (typeof plan !== "object" || plan === null) {
    return false;
  }
  const typed = plan as Record<string, unknown>;
  if (typed.status === "blocked") {
    return true;
  }
  const deps = dependsOnIds(typed);
  return deps.length > 0 && deps.some((dep) => !completedIds.has(dep));
}

function walkScopeFolders(
  projectRoot: string,
  folders: readonly string[],
  visitor: (plan: Record<string, unknown>, filename: string) => void,
): void {
  const base = join(resolve(projectRoot), "vbrief");
  for (const folder of folders) {
    const folderDir = join(base, folder);
    if (!existsSync(folderDir)) {
      continue;
    }
    for (const name of readdirSync(folderDir)
      .filter((entry) => entry.endsWith(".vbrief.json"))
      .sort()) {
      const plan = loadPlan(join(folderDir, name));
      if (plan !== null) {
        visitor(plan, name);
      }
    }
  }
}

/** Issue numbers referenced by any vbrief/active/*.vbrief.json. */
export function activeReferencedIssueNumbers(projectRoot: string): ReadonlySet<number> {
  const out = new Set<number>();
  walkScopeFolders(projectRoot, ["active"], (plan) => {
    for (const n of issueNumbersFromPlan(plan)) {
      out.add(n);
    }
  });
  return out;
}

/** Map referenced issue numbers to plan.metadata.rank. */
export function rankByIssueNumber(
  projectRoot: string,
  folders: readonly string[] = ["pending", "active"],
): ReadonlyMap<number, number> {
  const out = new Map<number, number>();
  walkScopeFolders(projectRoot, folders, (plan) => {
    const rank = scopeMetadataRank(plan);
    if (rank === null) {
      return;
    }
    for (const n of issueNumbersFromPlan(plan)) {
      if (!out.has(n)) {
        out.set(n, rank);
      }
    }
  });
  return out;
}

/** Map referenced issue numbers to blocked state (#1286). */
export function blockedByIssueNumber(
  projectRoot: string,
  folders: readonly string[] = ["pending", "active"],
): ReadonlySet<number> {
  const out = new Set<number>();
  const completedIds = completedPlanIds(projectRoot);
  walkScopeFolders(projectRoot, folders, (plan) => {
    if (!scopeIsBlocked(plan, completedIds)) {
      return;
    }
    for (const n of issueNumbersFromPlan(plan)) {
      out.add(n);
    }
  });
  return out;
}
