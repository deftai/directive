import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  LIFECYCLE_BUCKETS,
  RENDERABLE_SPEC_STATUSES,
  SCOPE_SUMMARY_NARRATIVES,
  SPEC_RENDER_BANNER,
  SPECIFICATION_NARRATIVE_KEY_ORDER,
} from "./constants.js";
import { validateSpec } from "./spec-validate.js";

type JsonObject = Record<string, unknown>;
type ScopeTuple = readonly [string, JsonObject];

function readEdgeEndpoints(edge: unknown): [string, string] {
  if (typeof edge !== "object" || edge === null || Array.isArray(edge)) return ["", ""];
  const e = edge as JsonObject;
  const frm = String(e.from ?? e.source ?? "") || "";
  const to = String(e.to ?? e.target ?? "") || "";
  return [frm, to];
}

function loadScopeVbriefs(folder: string): ScopeTuple[] {
  if (!existsSync(folder)) return [];
  let entries: string[];
  try {
    entries = readdirSync(folder)
      .filter((n) => n.endsWith(".vbrief.json"))
      .sort();
  } catch {
    return [];
  }
  const out: ScopeTuple[] = [];
  for (const name of entries) {
    const path = join(folder, name);
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
      let stem = name;
      if (stem.endsWith(".vbrief.json")) stem = stem.slice(0, -".vbrief.json".length);
      out.push([stem, data]);
    } catch {
      /* skip malformed */
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
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) {
    return "";
  }
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
    if (cleaned.startsWith("- ") || cleaned.startsWith("* ")) {
      cleaned = cleaned.slice(2).trim();
    }
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

function aggregateScopeSection(vbriefDir: string): string[] {
  const buckets: Array<[string, string, ScopeTuple[]]> = [];
  for (const [folderName, heading] of LIFECYCLE_BUCKETS) {
    let scopes = loadScopeVbriefs(join(vbriefDir, folderName));
    if (folderName === "completed") {
      scopes = scopes.filter(([, vb]) => {
        const plan = vb.plan;
        return (
          typeof plan === "object" &&
          plan !== null &&
          !Array.isArray(plan) &&
          (plan as JsonObject).status === "completed"
        );
      });
    }
    if (scopes.length > 0) buckets.push([folderName, heading, scopes]);
  }
  if (buckets.length === 0) return [];

  const lines: string[] = ["## Implementation Plan\n"];
  for (const [, heading, scopes] of buckets) {
    const depMap = crossScopeDepMap(scopes);
    const ordered = topoSortScopes(scopes, depMap);
    lines.push(`### ${heading}\n`);
    for (const [stem, vbrief] of ordered) lines.push(...renderScopeBlock(stem, vbrief));
  }
  return lines;
}

export type RenderSpecResult = readonly [boolean, string];

export interface RenderSpecOptions {
  readonly includeScopes?: boolean;
}

/** Render specification JSON to markdown (mirrors ``scripts/spec_render.render_spec``). */
export function renderSpec(
  specPath: string,
  outPath: string,
  options: RenderSpecOptions = {},
): RenderSpecResult {
  const includeScopes = options.includeScopes ?? true;
  const [ok, msg] = validateSpec(specPath);
  if (!ok) return [false, msg];

  const spec = JSON.parse(readFileSync(specPath, "utf8")) as JsonObject;
  const plan = spec.plan;
  let status = "";
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    status = String((plan as JsonObject).status ?? "");
  } else {
    status = String(spec.status ?? "");
  }

  if (!RENDERABLE_SPEC_STATUSES.has(status)) {
    const renderable = [...RENDERABLE_SPEC_STATUSES].join(", ");
    return [
      false,
      `⚠ specification.vbrief.json status is '${status}' (expected one of ${renderable})\n` +
        "  Have the user review and set status to one of the renderable statuses before rendering.",
    ];
  }

  const lines: string[] = [SPEC_RENDER_BANNER];
  let title = "Specification";
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    title = String((plan as JsonObject).title ?? "Specification");
  } else if (plan) {
    title = String(plan);
  } else {
    title = String(spec.title ?? "Specification");
  }
  lines.push(`# ${title}\n`);

  let narratives: Record<string, unknown> = {};
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    const n = (plan as JsonObject).narratives;
    if (typeof n === "object" && n !== null && !Array.isArray(n))
      narratives = n as Record<string, unknown>;
  } else {
    const legacy = spec.overview ?? spec.description ?? "";
    if (legacy) narratives = { Overview: legacy };
  }

  const renderedKeys = new Set<string>();
  for (const key of SPECIFICATION_NARRATIVE_KEY_ORDER) {
    const val = narratives[key];
    if (val) {
      lines.push(`## ${key}\n`);
      lines.push(`${String(val)}\n`);
      renderedKeys.add(key);
    }
  }
  for (const key of Object.keys(narratives).sort()) {
    if (renderedKeys.has(key) || !narratives[key]) continue;
    lines.push(`## ${key}\n`);
    lines.push(`${String(narratives[key])}\n`);
  }

  const items =
    typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? ((plan as JsonObject).items ?? [])
      : (spec.tasks ?? []);
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const itemObj = item as JsonObject;
      const itemId = String(itemObj.id ?? "");
      const titleText = String(itemObj.title ?? "");
      const itemStatus = String(itemObj.status ?? "");
      lines.push(`## ${itemId}: ${titleText}  \`[${itemStatus}]\`\n`);

      let deps: unknown;
      const metadata = itemObj.metadata;
      if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
        deps = (metadata as JsonObject).dependencies;
      }
      if (!deps) deps = itemObj.dependencies;
      if (Array.isArray(deps) && deps.length > 0) {
        lines.push(`**Depends on**: ${deps.map(String).join(", ")}\n`);
      }

      const narrative = itemObj.narrative;
      if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
        for (const [key, val] of Object.entries(narrative as JsonObject)) {
          if (key === "Traces") lines.push(`**Traces**: ${String(val)}\n`);
          else if (key === "Acceptance") {
            for (const line of splitAcceptance(val)) lines.push(`- ${line}`);
            lines.push("");
          } else lines.push(`${String(val)}\n`);
        }
      } else if (Array.isArray(narrative)) {
        for (const entry of narrative) lines.push(`- ${String(entry)}`);
        lines.push("");
      } else if (narrative) {
        lines.push(`${String(narrative)}\n`);
      }
    }
  }

  if (includeScopes) {
    const vbriefDir = resolve(dirname(specPath));
    const scopeLines = aggregateScopeSection(vbriefDir);
    if (scopeLines.length > 0) lines.push(...scopeLines);
  }

  writeFileSync(outPath, lines.join("\n"), "utf8");
  return [true, `✓ Rendered to ${outPath}`];
}

export function parseIncludeScopesFlag(argv: readonly string[]): {
  includeScopes: boolean;
  remaining: string[];
} {
  let includeScopes = true;
  const remaining: string[] = [];
  for (const arg of argv) {
    if (arg === "--include-scopes") {
      includeScopes = true;
      continue;
    }
    if (arg.startsWith("--include-scopes=")) {
      const value = arg.split("=", 2)[1]?.toLowerCase() ?? "";
      includeScopes = value === "on" || value === "true" || value === "1" || value === "yes";
      continue;
    }
    remaining.push(arg);
  }
  return { includeScopes, remaining };
}

/** CLI entry (mirrors ``scripts/spec_render.main``). */
export function main(argv: readonly string[]): number {
  const { includeScopes, remaining } = parseIncludeScopesFlag(argv);
  if (remaining.length === 0) {
    process.stderr.write(
      "Usage: spec_render.py <spec_file> [out_file] [--include-scopes=on|off]\n",
    );
    return 2;
  }
  const specPath = remaining[0] ?? "";
  const outPath =
    remaining.length >= 2
      ? (remaining[1] ?? "")
      : join(resolve(dirname(specPath)), "..", "SPECIFICATION.md");
  const [ok, message] = renderSpec(specPath, outPath, { includeScopes });
  process.stdout.write(`${message}\n`);
  return ok ? 0 : 1;
}
