import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import {
  MIGRATOR_METADATA_KEY,
  ROADMAP_BANNER,
  ROADMAP_COMPLETED_CAP,
  ROADMAP_EMPTY_FORWARD_MARKER,
} from "./constants.js";
import { phaseSortKey } from "./text-utils.js";

type JsonObject = Record<string, unknown>;

function scopeMetadataRank(plan: JsonObject): number | null {
  const metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const rank = (metadata as JsonObject).rank;
  if (typeof rank === "boolean") return null;
  if (typeof rank === "number" && Number.isInteger(rank)) return rank;
  if (typeof rank === "string") {
    const trimmed = rank.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(parsed) && String(parsed) === trimmed) return parsed;
  }
  return null;
}

function scopeRankSortKey(vbrief: JsonObject): [number, number] {
  const plan = (vbrief.plan ?? {}) as JsonObject;
  const rank = scopeMetadataRank(plan);
  if (rank === null) return [1, 0];
  return [0, rank];
}

function loadVbriefs(folder: string): JsonObject[] {
  if (!existsSync(folder)) return [];
  let files: string[];
  try {
    files = readdirSync(folder)
      .filter((n) => hasArtifactSuffix(n))
      .sort();
  } catch {
    return [];
  }
  const vbriefs: JsonObject[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(folder, f), "utf8")) as JsonObject;
      data._source_file = f;
      vbriefs.push(data);
    } catch {
      /* skip */
    }
  }
  vbriefs.sort((a, b) => {
    const [ba, ra] = scopeRankSortKey(a);
    const [bb, rb] = scopeRankSortKey(b);
    return ba - bb || ra - rb;
  });
  return vbriefs;
}

function extractIssueRefs(references: unknown): string[] {
  if (!Array.isArray(references)) return [];
  const issues: string[] = [];
  for (const ref of references) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const r = ref as JsonObject;
    const refId = r.id;
    if (typeof refId === "string" && refId.startsWith("#")) {
      issues.push(refId);
      continue;
    }
    for (const key of ["uri", "url"] as const) {
      const url = r[key];
      if (typeof url === "string" && url.includes("/issues/")) {
        const num = url.replace(/\/+$/, "").split("/").pop() ?? "";
        if (/^\d+$/.test(num)) {
          issues.push(`#${num}`);
          break;
        }
      }
    }
  }
  return issues;
}

function readEdgeEndpoints(edge: unknown): [string, string] {
  if (typeof edge !== "object" || edge === null || Array.isArray(edge)) return ["", ""];
  const e = edge as JsonObject;
  const frm = String(e.from ?? e.source ?? "") || "";
  const to = String(e.to ?? e.target ?? "") || "";
  return [frm, to];
}

function buildEdgeMap(vbrief: JsonObject): Record<string, string[]> {
  const plan = (vbrief.plan ?? {}) as JsonObject;
  const edges = plan.edges;
  if (!Array.isArray(edges)) return {};
  const depMap: Record<string, string[]> = {};
  for (const edge of edges) {
    const [frm, to] = readEdgeEndpoints(edge);
    if (frm && to) {
      if (!depMap[to]) depMap[to] = [];
      depMap[to].push(frm);
    }
  }
  return depMap;
}

function topoSortItems(items: JsonObject[], depMap: Record<string, string[]>): JsonObject[] {
  if (items.length === 0) return [];
  const idToItem = new Map<string, JsonObject>();
  const itemIds: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as JsonObject;
    const id = String(item.id ?? `_anon_${i}`);
    idToItem.set(id, item);
    itemIds.push(id);
  }
  const depths: Record<string, number> = {};

  const depth = (itemId: string, visited: Set<string> | null = null): number => {
    if (itemId in depths) return depths[itemId] ?? 0;
    const vis = visited ?? new Set<string>();
    if (vis.has(itemId)) return 0;
    vis.add(itemId);
    const deps = depMap[itemId] ?? [];
    const inScope = deps.filter((d) => idToItem.has(d));
    if (inScope.length === 0) {
      depths[itemId] = 0;
      return 0;
    }
    const result = Math.max(...inScope.map((d) => depth(d, vis))) + 1;
    depths[itemId] = result;
    return result;
  };

  for (const iid of itemIds) depth(iid);
  const sortedIds = [...itemIds].sort(
    (a, b) => (depths[a] ?? 0) - (depths[b] ?? 0) || itemIds.indexOf(a) - itemIds.indexOf(b),
  );
  return sortedIds.map((id) => idToItem.get(id) as JsonObject);
}

function renderItem(item: JsonObject, depMap: Record<string, string[]>, indent = 0): string[] {
  const lines: string[] = [];
  const itemId = String(item.id ?? "");
  const title = String(item.title ?? "Untitled");
  const status = String(item.status ?? "");
  const prefix = `${"  ".repeat(indent)}- `;
  const parts: string[] = [];
  if (itemId) parts.push(`**${itemId}**`);
  parts.push(title);
  if (status) parts.push(`\`[${status}]\``);
  const deps = depMap[itemId] ?? [];
  if (deps.length > 0) parts.push(`(depends on: ${[...deps].sort().join(", ")})`);
  lines.push(`${prefix}${parts.join(" -- ")}`);

  const subItems = item.subItems;
  if (Array.isArray(subItems) && subItems.length > 0) {
    const subs = subItems.filter(
      (s): s is JsonObject => typeof s === "object" && s !== null && !Array.isArray(s),
    );
    const sortedSubs = topoSortItems(subs, depMap);
    for (const sub of sortedSubs) lines.push(...renderItem(sub, depMap, indent + 1));
  }
  return lines;
}

function migratorMetadata(plan: JsonObject): JsonObject {
  const metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
  const bucket = (metadata as JsonObject)[MIGRATOR_METADATA_KEY];
  if (typeof bucket === "object" && bucket !== null && !Array.isArray(bucket)) {
    return bucket as JsonObject;
  }
  return {};
}

function migratorField(plan: JsonObject, key: string): string {
  const bucket = migratorMetadata(plan);
  const value = bucket[key];
  if (typeof value === "string" && value) return value;
  const narratives = plan.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const fallback = (narratives as JsonObject)[key];
    if (typeof fallback === "string") return fallback;
  }
  return "";
}

function sortedPhaseNames(phaseNames: string[]): string[] {
  return [...phaseNames].sort((a, b) => {
    const [a0, a1, a2] = phaseSortKey(a);
    const [b0, b1, b2] = phaseSortKey(b);
    return a0 - b0 || a1 - b1 || a2.localeCompare(b2);
  });
}

function groupByPhase(
  vbriefs: JsonObject[],
): [Record<string, JsonObject[]>, Record<string, string>] {
  const insertionGroups: Record<string, JsonObject[]> = {};
  const phaseDescriptions: Record<string, string> = {};
  for (const vb of vbriefs) {
    const plan = (vb.plan ?? {}) as JsonObject;
    const phase = migratorField(plan, "Phase") || "Ungrouped";
    if (!insertionGroups[phase]) insertionGroups[phase] = [];
    insertionGroups[phase].push(vb);
    if (!(phase in phaseDescriptions)) {
      const pd = migratorField(plan, "PhaseDescription");
      if (pd) phaseDescriptions[phase] = pd;
    }
  }
  const phaseGroups: Record<string, JsonObject[]> = {};
  for (const name of sortedPhaseNames(Object.keys(insertionGroups))) {
    phaseGroups[name] = insertionGroups[name] ?? [];
  }
  return [phaseGroups, phaseDescriptions];
}

function groupByTier(vbriefs: JsonObject[]): Record<string, JsonObject[]> {
  const tierGroups: Record<string, JsonObject[]> = {};
  for (const vb of vbriefs) {
    const plan = (vb.plan ?? {}) as JsonObject;
    const tier = migratorField(plan, "Tier");
    if (!tierGroups[tier]) tierGroups[tier] = [];
    tierGroups[tier].push(vb);
  }
  return tierGroups;
}

function renderScopeItem(vbriefData: JsonObject): string[] {
  const plan = (vbriefData.plan ?? {}) as JsonObject;
  const title = String(plan.title ?? "Untitled");
  const status = String(plan.status ?? "");
  const references = plan.references;
  const issueRefs = extractIssueRefs(references);
  const parts: string[] = [];
  if (issueRefs.length > 0) parts.push(`**${issueRefs[0]}**`);
  parts.push(title);
  if (status && status !== "pending") parts.push(`\`[${status}]\``);
  return [`- ${parts.join(" -- ")}`];
}

function resolveCompletedDir(pendingDir: string, completedDir?: string): string {
  return completedDir ?? join(dirname(pendingDir), "completed");
}

function lifecycleSibling(pendingDir: string, bucket: string): string {
  return join(dirname(pendingDir), bucket);
}

function hasLifecycleArtifacts(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((n) => hasArtifactSuffix(n));
  } catch {
    return false;
  }
}

/**
 * Prefer completion-time stamps over creation-dated filenames so the cap
 * keeps recently completed scopes (#2653 Greptile P1).
 * Order: plan.metadata.completedAt → plan.updated → envelope updated → _source_file.
 */
function completedRecencyKey(vbrief: JsonObject): string {
  const plan = (vbrief.plan ?? {}) as JsonObject;
  const metadata = plan.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const completedAt = (metadata as JsonObject).completedAt;
    if (typeof completedAt === "string" && completedAt.trim()) return completedAt.trim();
  }
  if (typeof plan.updated === "string" && plan.updated.trim()) return plan.updated.trim();
  for (const envelopeKey of ["xBRIEFInfo", "vBRIEFInfo"] as const) {
    const env = vbrief[envelopeKey];
    if (typeof env === "object" && env !== null && !Array.isArray(env)) {
      const updated = (env as JsonObject).updated;
      if (typeof updated === "string" && updated.trim()) return updated.trim();
    }
  }
  return String(vbrief._source_file ?? "");
}

/** Newest-first by completion recency, then cap. */
function takeCompletedCap(
  vbriefs: JsonObject[],
  cap: number = ROADMAP_COMPLETED_CAP,
): { shown: JsonObject[]; total: number; omitted: number } {
  const sorted = [...vbriefs].sort((a, b) => {
    const kb = completedRecencyKey(b);
    const ka = completedRecencyKey(a);
    const byKey = kb.localeCompare(ka);
    if (byKey !== 0) return byKey;
    return String(b._source_file ?? "").localeCompare(String(a._source_file ?? ""));
  });
  if (sorted.length <= cap) {
    return { shown: sorted, total: sorted.length, omitted: 0 };
  }
  return {
    shown: sorted.slice(0, cap),
    total: sorted.length,
    omitted: sorted.length - cap,
  };
}

/** Flat list of scope bullets (proposed / active / completed). */
function renderScopeList(vbriefs: JsonObject[]): string[] {
  const lines: string[] = [];
  for (const vb of vbriefs) lines.push(...renderScopeItem(vb));
  if (vbriefs.length > 0) lines.push("");
  return lines;
}

/**
 * Pending-only body: preserve phase-grouped and hierarchical heading models
 * so existing ROADMAP consumers keep stable ## structure when pending is the
 * sole forward source.
 */
function renderPendingBody(vbriefs: JsonObject[]): string[] {
  const lines: string[] = [];
  const hasPhaseNarratives = vbriefs.some((vb) => {
    const plan = (vb.plan ?? {}) as JsonObject;
    return Boolean(migratorField(plan, "Phase"));
  });

  if (hasPhaseNarratives) {
    const [phaseGroups, phaseDescs] = groupByPhase(vbriefs);
    for (const phaseName of Object.keys(phaseGroups)) {
      const phaseVbriefs = phaseGroups[phaseName] ?? [];
      lines.push(`## ${phaseName}\n`);
      const desc = phaseDescs[phaseName] ?? "";
      if (desc) lines.push(`${desc}\n`);

      const tierGroups = groupByTier(phaseVbriefs);
      const hasTiers = Object.keys(tierGroups).some((t) => t.length > 0);

      if (hasTiers) {
        const untiered = tierGroups[""] ?? [];
        const namedTiers = { ...tierGroups };
        delete namedTiers[""];
        for (const tierName of Object.keys(namedTiers)) {
          lines.push(`### ${tierName}\n`);
          for (const vb of namedTiers[tierName] ?? []) lines.push(...renderScopeItem(vb));
          lines.push("");
        }
        if (untiered.length > 0) {
          for (const vb of untiered) lines.push(...renderScopeItem(vb));
          lines.push("");
        }
      } else {
        for (const vb of phaseVbriefs) lines.push(...renderScopeItem(vb));
        lines.push("");
      }
    }
    return lines;
  }

  for (const vbrief of vbriefs) {
    const plan = (vbrief.plan ?? {}) as JsonObject;
    const planTitle = String(plan.title ?? "Untitled");
    const issueRefs = extractIssueRefs(plan.references);
    const titleParts = [`## ${planTitle}`];
    if (issueRefs.length > 0) titleParts.push(`(${issueRefs.join(", ")})`);
    lines.push(`${titleParts.join(" ")}\n`);

    const narratives = plan.narratives;
    if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
      const overview = (narratives as JsonObject).Overview;
      if (typeof overview === "string" && overview) lines.push(`${overview}\n`);
    }

    const depMap = buildEdgeMap(vbrief);
    const phases = Array.isArray(plan.items)
      ? plan.items.filter(
          (p): p is JsonObject => typeof p === "object" && p !== null && !Array.isArray(p),
        )
      : [];
    const sortedPhases = topoSortItems(phases, depMap);

    for (const phase of sortedPhases) {
      const phaseId = String(phase.id ?? "");
      const phaseTitle = String(phase.title ?? "Untitled Phase");
      const phaseStatus = String(phase.status ?? "");
      let heading = phaseId ? `### ${phaseId}: ${phaseTitle}` : `### ${phaseTitle}`;
      if (phaseStatus) heading += ` \`[${phaseStatus}]\``;
      lines.push(`${heading}\n`);

      const narrative = phase.narrative;
      if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
        for (const [key, val] of Object.entries(narrative as JsonObject)) {
          if (key !== "Traces" && key !== "Acceptance") lines.push(`${String(val)}\n`);
        }
      }

      const subItems = phase.subItems;
      if (Array.isArray(subItems) && subItems.length > 0) {
        const subs = subItems.filter(
          (s): s is JsonObject => typeof s === "object" && s !== null && !Array.isArray(s),
        );
        const sortedSubs = topoSortItems(subs, depMap);
        for (const item of sortedSubs) lines.push(...renderItem(item, depMap));
        lines.push("");
      }
    }
    lines.push("---\n");
  }
  return lines;
}

/** Single render-to-buffer entry used by both write and --check (mirrors ``scripts/roadmap_render.generate_roadmap_content``). */
export function renderRoadmapToBuffer(pendingDir: string, completedDir?: string): string {
  const pendingVbriefs = loadVbriefs(pendingDir);
  const activeVbriefs = loadVbriefs(lifecycleSibling(pendingDir, "active"));
  const proposedVbriefs = loadVbriefs(lifecycleSibling(pendingDir, "proposed"));
  const resolvedCompleted = resolveCompletedDir(pendingDir, completedDir);
  const completedVbriefs = loadVbriefs(resolvedCompleted);

  const lines: string[] = [ROADMAP_BANNER, "# Roadmap\n"];

  const hasForward =
    pendingVbriefs.length > 0 || activeVbriefs.length > 0 || proposedVbriefs.length > 0;
  const hasAny = hasForward || completedVbriefs.length > 0;

  if (!hasAny) {
    lines.push("No pending work items.\n");
    return `${lines.join("\n")}\n`;
  }

  // D2.2: never emit Completed-only without an explicit empty-forward marker.
  if (!hasForward && completedVbriefs.length > 0) {
    lines.push("## Forward plan\n");
    lines.push(ROADMAP_EMPTY_FORWARD_MARKER);
  }

  if (pendingVbriefs.length > 0) {
    lines.push(...renderPendingBody(pendingVbriefs));
  }

  if (activeVbriefs.length > 0) {
    lines.push("## Active\n");
    lines.push(...renderScopeList(activeVbriefs));
  }

  if (proposedVbriefs.length > 0) {
    lines.push("## Proposed\n");
    lines.push(
      "_Scopes not yet promoted to pending. Orientation only — not a substitute for `task triage:queue`._\n",
    );
    lines.push(...renderScopeList(proposedVbriefs));
  }

  if (completedVbriefs.length > 0) {
    const { shown, total, omitted } = takeCompletedCap(completedVbriefs);
    lines.push("## Completed\n");
    if (omitted > 0) {
      lines.push(
        `_Showing ${shown.length} of ${total} completed scopes (newest first). ` +
          `Full history: lifecycle \`completed/\` (or \`task report\` when available)._\n`,
      );
    }
    for (const vb of shown) lines.push(...renderScopeItem(vb));
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/** @deprecated Prefer ``renderRoadmapToBuffer`` — kept for existing imports and parity harnesses. */
export function generateRoadmapContent(pendingDir: string, completedDir?: string): string {
  return renderRoadmapToBuffer(pendingDir, completedDir);
}

export type RenderRoadmapResult = readonly [boolean, string];

export type RenderRoadmapOptions = {
  completedDir?: string;
  projectRoot?: string;
};

export function renderRoadmap(
  pendingDir: string,
  outPath: string,
  completedDirOrOptions?: string | RenderRoadmapOptions,
): RenderRoadmapResult {
  let completedDir: string | undefined;
  let projectRoot: string | undefined;
  if (typeof completedDirOrOptions === "string") {
    completedDir = completedDirOrOptions;
  } else if (completedDirOrOptions !== undefined) {
    completedDir = completedDirOrOptions.completedDir;
    projectRoot = completedDirOrOptions.projectRoot;
  }
  try {
    const content = renderRoadmapToBuffer(pendingDir, completedDir);
    // Trust boundary is the project root — never dirname(outPath), which follows a
    // diverted parent symlink and would make containment pass outside the checkout.
    const projectDir =
      projectRoot !== undefined ? resolve(projectRoot) : resolve(pendingDir, "..", "..");
    assertWriteTargetSafe(projectDir, resolve(outPath));
    writeFileSync(outPath, content, "utf8");
    return [true, `✓ Rendered ROADMAP.md to ${outPath}`];
  } catch (exc) {
    return [false, `✗ Failed to write ${outPath}: ${String(exc)}`];
  }
}

export function checkDrift(
  pendingDir: string,
  roadmapPath: string,
  completedDir?: string,
): RenderRoadmapResult {
  const expected = renderRoadmapToBuffer(pendingDir, completedDir);
  if (!existsSync(roadmapPath)) {
    const hasPending = hasLifecycleArtifacts(pendingDir);
    const hasActive = hasLifecycleArtifacts(lifecycleSibling(pendingDir, "active"));
    const hasProposed = hasLifecycleArtifacts(lifecycleSibling(pendingDir, "proposed"));
    const inferredCompleted = resolveCompletedDir(pendingDir, completedDir);
    const hasCompleted = hasLifecycleArtifacts(inferredCompleted);
    if (!hasPending && !hasActive && !hasProposed && !hasCompleted) {
      return [true, "✓ No ROADMAP.md needed (no lifecycle scope vBRIEFs)"];
    }
    return [false, "✗ ROADMAP.md does not exist but vBRIEFs found"];
  }
  const actual = readFileSync(roadmapPath, "utf8");
  if (actual === expected) return [true, "✓ ROADMAP.md is up to date"];
  return [
    false,
    "✗ ROADMAP.md has drifted from lifecycle scope vBRIEFs -- run: task roadmap:render",
  ];
}

/** CLI entry (mirrors ``scripts/roadmap_render.main``). */
export function main(argv: readonly string[]): number {
  let projectRoot: string | undefined;
  let check = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--project-root") {
      projectRoot = argv[i + 1] as string | undefined;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--check") {
      check = true;
    } else {
      positional.push(arg);
    }
  }

  let pendingDir: string;
  let outPath: string;
  if (projectRoot !== undefined) {
    const lifecycleRoot = resolveLifecycleRoot(resolve(projectRoot));
    pendingDir = join(lifecycleRoot, "pending");
    outPath = positional[0] ?? join(resolve(projectRoot), "ROADMAP.md");
  } else {
    pendingDir = positional[0] ?? join(process.cwd(), "vbrief", "pending");
    outPath = positional[1] ?? join(process.cwd(), "ROADMAP.md");
  }

  if (check) {
    const [ok, msg] = checkDrift(pendingDir, outPath);
    process.stdout.write(`${msg}\n`);
    return ok ? 0 : 1;
  }
  // When --project-root is set, use it; otherwise renderRoadmap derives from pendingDir
  // (…/xbrief|vbrief/pending → project root). Never use dirname(outPath).
  const [ok, msg] = renderRoadmap(pendingDir, outPath, {
    projectRoot: projectRoot !== undefined ? resolve(projectRoot) : undefined,
  });
  process.stdout.write(`${msg}\n`);
  return ok ? 0 : 1;
}
