import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasArtifactSuffix, stripArtifactSuffix } from "../layout/resolve.js";
import { PROPOSED_DISCLAIMER_LINES, PROPOSED_STATUS_FILTER } from "../spec-authority/constants.js";
import { SCOPE_SUMMARY_NARRATIVES } from "./constants.js";

type JsonObject = Record<string, unknown>;
type ScopeTuple = readonly [string, JsonObject];

export interface ScopeOutlookOptions {
  readonly includeProposed?: boolean;
  readonly proposedLimit?: number;
  /**
   * When false, omit the completed lifecycle bucket (#1566 compact render).
   * Default true so callers that opt into full aggregation keep prior behavior.
   */
  readonly includeCompleted?: boolean;
}

function readEdgeEndpoints(edge: unknown): [string, string] {
  if (typeof edge !== "object" || edge === null || Array.isArray(edge)) return ["", ""];
  const e = edge as JsonObject;
  return [String(e.from ?? e.source ?? "") || "", String(e.to ?? e.target ?? "") || ""];
}

function loadScopeVbriefs(folder: string): ScopeTuple[] {
  if (!existsSync(folder)) return [];
  let entries: string[];
  try {
    entries = readdirSync(folder)
      .filter((n) => hasArtifactSuffix(n))
      .sort();
  } catch {
    return [];
  }
  const out: ScopeTuple[] = [];
  for (const name of entries) {
    try {
      const data = JSON.parse(readFileSync(join(folder, name), "utf8")) as JsonObject;
      const stem = stripArtifactSuffix(name);
      out.push([stem, data]);
    } catch {
      /* skip */
    }
  }
  return out;
}

function scopeId(stem: string, vbrief: JsonObject): string {
  const plan = vbrief.plan;
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    const planId = (plan as JsonObject).id;
    if (typeof planId === "string" && planId) return planId;
  }
  return stem;
}

function crossScopeDepMap(scopes: ScopeTuple[]): Record<string, string[]> {
  const scopeIds = new Set(scopes.map(([stem, vb]) => scopeId(stem, vb)));
  const depMap: Record<string, string[]> = {};
  for (const [, vbrief] of scopes) {
    const plan = vbrief.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) continue;
    const edges = (plan as JsonObject).edges;
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      const [frm, to] = readEdgeEndpoints(edge);
      if (frm && to && scopeIds.has(frm) && scopeIds.has(to)) {
        if (!depMap[to]) depMap[to] = [];
        depMap[to].push(frm);
      }
    }
  }
  return depMap;
}

function topoSortScopes(scopes: ScopeTuple[], depMap: Record<string, string[]>): ScopeTuple[] {
  if (scopes.length === 0) return [];
  const idByIndex = scopes.map(([stem, vb]) => scopeId(stem, vb));
  const idToIndex = new Map(idByIndex.map((sid, i) => [sid, i]));
  const depths: Record<string, number> = {};

  const depth = (sid: string, visited: Set<string> | null = null): number => {
    if (sid in depths) return depths[sid] ?? 0;
    const vis = visited ?? new Set<string>();
    if (vis.has(sid)) return 0;
    vis.add(sid);
    const deps = (depMap[sid] ?? []).filter((d) => idToIndex.has(d));
    if (deps.length === 0) {
      depths[sid] = 0;
      return 0;
    }
    const result = Math.max(...deps.map((d) => depth(d, vis))) + 1;
    depths[sid] = result;
    return result;
  };

  for (const sid of idByIndex) depth(sid);
  const orderedIndices = [...idByIndex.keys()].sort(
    (a, b) => (depths[idByIndex[a] ?? ""] ?? 0) - (depths[idByIndex[b] ?? ""] ?? 0) || a - b,
  );
  return orderedIndices.map((i) => scopes[i] as ScopeTuple);
}

function scopeSummaryNarrative(plan: JsonObject): string {
  const narratives = plan.narratives;
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) return "";
  const narr = narratives as Record<string, unknown>;
  for (const key of SCOPE_SUMMARY_NARRATIVES) {
    const val = narr[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  for (const val of Object.values(narr)) {
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function splitAcceptance(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((s) => s.length > 0);
  }
  if (typeof value !== "string") return [];
  const parts: string[] = [];
  for (const line of value.split("\n")) {
    let cleaned = line.trim();
    if (!cleaned) continue;
    if (cleaned.startsWith("- ") || cleaned.startsWith("* ")) cleaned = cleaned.slice(2).trim();
    if (cleaned) parts.push(cleaned);
  }
  return parts;
}

function itemAcceptance(item: JsonObject): string[] {
  const narrative = item.narrative;
  if (typeof narrative !== "object" || narrative === null || Array.isArray(narrative)) return [];
  return splitAcceptance((narrative as JsonObject).Acceptance);
}

function renderScopeBlock(stem: string, vbrief: JsonObject): string[] {
  const plan = vbrief.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return [];
  const planObj = plan as JsonObject;
  const title = String(planObj.title ?? stem);
  const status = String(planObj.status ?? "");
  let heading = `### ${stem}: ${title}`;
  if (status) heading += `  \`[${status}]\``;
  const lines: string[] = [`${heading}\n`];

  const summary = scopeSummaryNarrative(planObj);
  if (summary) lines.push(`${summary}\n`);

  const narratives = planObj.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const scopeAcceptance = splitAcceptance((narratives as JsonObject).Acceptance);
    if (scopeAcceptance.length > 0) {
      lines.push("**Scope Acceptance**:\n");
      for (const criterion of scopeAcceptance) lines.push(`- ${criterion}`);
      lines.push("");
    }
  }

  const items = planObj.items;
  if (Array.isArray(items) && items.length > 0) {
    lines.push("**Acceptance**:\n");
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const itemObj = item as JsonObject;
      const itemTitle = String(itemObj.title ?? "Untitled");
      const itemStatus = String(itemObj.status ?? "");
      let bullet = `- ${itemTitle}`;
      if (itemStatus) bullet += ` \`[${itemStatus}]\``;
      lines.push(bullet);
      for (const criterion of itemAcceptance(itemObj)) {
        if (criterion !== itemTitle) lines.push(`  - Acceptance: ${criterion}`);
      }
    }
    lines.push("");
  }
  return lines;
}

type BucketDef = readonly [folder: string, heading: string, filter?: (vb: JsonObject) => boolean];

const COMMITTED_BUCKETS: BucketDef[] = [
  ["pending", "Accepted backlog (pending)"],
  ["active", "Active"],
  [
    "completed",
    "Completed",
    (vb) => {
      const plan = vb.plan;
      return (
        typeof plan === "object" &&
        plan !== null &&
        !Array.isArray(plan) &&
        (plan as JsonObject).status === "completed"
      );
    },
  ],
];

function filterProposed(vb: JsonObject): boolean {
  const plan = vb.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return true;
  const status = String((plan as JsonObject).status ?? "proposed").toLowerCase();
  return PROPOSED_STATUS_FILTER.has(status);
}

/** Build Scope outlook section per #2013 Wave 0 §4. */
export function buildScopeOutlookSection(
  vbriefDir: string,
  options: ScopeOutlookOptions = {},
): string[] {
  const includeProposed = options.includeProposed ?? false;
  const proposedLimit = options.proposedLimit ?? 0;
  const includeCompleted = options.includeCompleted ?? true;

  const buckets: Array<[string, string, ScopeTuple[]]> = [];

  if (includeProposed) {
    let proposed = loadScopeVbriefs(join(vbriefDir, "proposed")).filter(([, vb]) =>
      filterProposed(vb),
    );
    if (proposedLimit > 0 && proposed.length > proposedLimit) {
      const omitted = proposed.length - proposedLimit;
      proposed = proposed.slice(0, proposedLimit);
      buckets.push([
        "proposed",
        `Not yet accepted (proposed) — showing ${proposedLimit} of ${proposedLimit + omitted}`,
        proposed,
      ]);
    } else if (proposed.length > 0) {
      buckets.push(["proposed", "Not yet accepted (proposed)", proposed]);
    }
  }

  for (const [folder, heading, filter] of COMMITTED_BUCKETS) {
    if (folder === "completed" && !includeCompleted) continue;
    let scopes = loadScopeVbriefs(join(vbriefDir, folder));
    if (filter) scopes = scopes.filter(([, vb]) => filter(vb));
    if (scopes.length > 0) buckets.push([folder, heading, scopes]);
  }

  if (buckets.length === 0) return [];

  const lines: string[] = ["## Scope outlook\n"];
  for (const [folder, heading, scopes] of buckets) {
    const depMap = crossScopeDepMap(scopes);
    const ordered = topoSortScopes(scopes, depMap);
    lines.push(`### ${heading}\n`);
    if (folder === "proposed") {
      for (const line of PROPOSED_DISCLAIMER_LINES) lines.push(line, "");
    }
    for (const [stem, vbrief] of ordered) lines.push(...renderScopeBlock(stem, vbrief));
  }
  return lines;
}

/** Legacy wrapper: stakeholder export (no proposed). */
export function aggregateScopeSection(vbriefDir: string): string[] {
  return buildScopeOutlookSection(vbriefDir, { includeProposed: false });
}
