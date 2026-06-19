import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pyRepr } from "./py-repr.js";
import type { Candidate } from "./types.js";

export const LIFECYCLE_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

export function asStrList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function loadJson(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown>): Record<string, unknown> {
  const plan = data.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : {};
}

function metadataOf(plan: Record<string, unknown>): Record<string, unknown> {
  const metadata = plan.metadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function swarmOf(metadata: Record<string, unknown>): Record<string, unknown> {
  const swarm = metadata.swarm;
  return typeof swarm === "object" && swarm !== null && !Array.isArray(swarm)
    ? (swarm as Record<string, unknown>)
    : {};
}

function storyId(path: string, plan: Record<string, unknown>): string {
  const value = plan.id;
  if (typeof value === "string" && value.trim()) return value.trim();
  const name = path.split(/[/\\]/).pop() ?? "";
  return name.endsWith(".vbrief.json") ? name.slice(0, -".vbrief.json".length) : name;
}

export function allScopeIds(projectRoot: string): Record<string, [string, string]> {
  const ids: Record<string, [string, string]> = {};
  const vbriefDir = join(resolve(projectRoot), "vbrief");
  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) continue;
    const files = readdirSync(folderPath)
      .filter((f) => f.endsWith(".vbrief.json"))
      .sort();
    for (const file of files) {
      const path = join(folderPath, file);
      const data = loadJson(path);
      if (!data) continue;
      const plan = planOf(data);
      const scopeId = storyId(path, plan);
      const status = String(plan.status ?? "");
      ids[scopeId] = [path, status];
      const stem = file.endsWith(".vbrief.json") ? file.slice(0, -".vbrief.json".length) : file;
      if (!ids[stem]) ids[stem] = [path, status];
    }
  }
  return ids;
}

export function candidateFromPath(path: string, _projectRoot: string): Candidate | null {
  const data = loadJson(path);
  if (!data) return null;
  const plan = planOf(data);
  const metadata = metadataOf(plan);
  const swarm = swarmOf(metadata);
  return {
    path,
    storyId: storyId(path, plan),
    status: String(plan.status ?? ""),
    swarm,
    blocked: [],
  };
}

export function candidateDepGraph(
  candidates: Candidate[],
  knownIds: Record<string, [string, string]>,
): Record<string, string[]> {
  const candidateIds = new Set(candidates.map((c) => c.storyId));
  const graph: Record<string, string[]> = {};
  for (const cand of candidates) {
    const deps: string[] = [];
    for (const dep of asStrList(cand.swarm.depends_on)) {
      if (candidateIds.has(dep)) {
        deps.push(dep);
        continue;
      }
      const known = knownIds[dep];
      if (!known) continue;
      const [, depStatus] = known;
      if (!["completed", "failed", "cancelled"].includes(depStatus)) {
        cand.blocked.push(`dependency ${pyRepr(dep)} is not completed or a candidate`);
      }
    }
    graph[cand.storyId] = deps;
  }
  return graph;
}

export function markCycles(candidates: Candidate[], graph: Record<string, string[]>): void {
  const byId = Object.fromEntries(candidates.map((c) => [c.storyId, c]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (storyId: string, path: string[]): void => {
    if (visited.has(storyId)) return;
    if (visiting.has(storyId)) {
      const start = path.indexOf(storyId);
      const cycle = [...path.slice(start >= 0 ? start : 0), storyId];
      const message = `dependency cycle: ${cycle.join(" -> ")}`;
      for (const node of cycle) {
        const cand = byId[node];
        if (cand && !cand.blocked.includes(message)) cand.blocked.push(message);
      }
      return;
    }
    visiting.add(storyId);
    for (const dep of graph[storyId] ?? []) visit(dep, [...path, storyId]);
    visiting.delete(storyId);
    visited.add(storyId);
  };

  for (const cand of candidates) visit(cand.storyId, []);
}
