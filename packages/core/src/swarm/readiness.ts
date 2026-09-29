import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import {
  ARTIFACT_SUFFIXES,
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  LIFECYCLE_DIR_NAMES,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
  resolveLifecycleLayout,
  resolveLifecycleRoot,
  stripArtifactSuffix,
} from "../layout/resolve.js";
import { SERIALIZE_N_PRS } from "../one-pr-unit/types.js";
import {
  acceptanceTextsFromItems,
  asStrList,
  deprecatedSubitemsIssues,
  itemHasTraces,
  itemsHaveAcceptance,
  missingRequiredSwarmFields,
  type SwarmFieldMode,
  storyQualityIssues,
} from "../vbrief-validation/story-quality.js";
import { LIFECYCLE_FOLDERS, READY } from "./constants.js";

/** Remediation when swarm block is missing/incomplete (#3718). */
export const SWARM_BLOCK_REMEDIATION_HINT =
  "Swarm block missing or incomplete. xbrief:preflight exit 0 is lifecycle-ready, not swarm-ready. " +
  "Scaffold operator-named paths and explicit draft fields only: " +
  "swarm:readiness --scaffold <xbrief-path> --file-scope <path> [--file-scope ...] " +
  "--verify-command <cmd> --size <small|medium|large> --file-scope-confidence <high|medium|low> " +
  "--readiness ready --parallel-safe true|false " +
  "(do not invent file_scope or verify_commands from issue text; #4988). " +
  "Documented N=1 / solo headless launch relaxes ceremony fields expected_outputs, conflict_group, and model_tier (#3718). " +
  "Interactive solo-worker discoverability stays on #3669.";

export interface ReadinessReportOptions {
  readonly soloHeadless?: boolean;
}

export interface ScaffoldSwarmDraftInput {
  readonly projectRoot: string;
  readonly vbriefPath: string;
  readonly fileScope: readonly string[];
  readonly verifyCommands: readonly string[];
  readonly expectedOutputs?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly conflictGroup?: string;
  readonly size: string;
  readonly fileScopeConfidence: string;
  readonly modelTier?: string;
  readonly readiness: string;
  readonly parallelSafe: boolean;
}

export type ScaffoldSwarmDraftResult =
  | { ok: true; path: string; writtenKeys: string[] }
  | { ok: false; error: string };

export interface Candidate {
  path: string;
  relpath: string;
  data: Record<string, unknown>;
  plan: Record<string, unknown>;
  story_id: string;
  title: string;
  status: string;
  folder: string;
  kind: string;
  swarm: Record<string, unknown>;
  missing: string[];
  blocked: string[];
  decomposition_needed: boolean;
}

function loadJson(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function projectRel(projectRoot: string, path: string): string {
  try {
    return resolve(path)
      .slice(resolve(projectRoot).length + 1)
      .replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function expandPaths(projectRoot: string, patterns: readonly string[]): string[] {
  // Use the canonical xbrief layout; re-throw only if a legacy vbrief/-only tree is detected (#2112).
  let layout: ReturnType<typeof resolveLifecycleLayout>;
  try {
    layout = resolveLifecycleLayout(projectRoot);
  } catch (err) {
    const xbriefDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
    if (existsSync(xbriefDir)) {
      // xbrief/ dir exists but has no artifacts yet -- treat as valid (empty) layout.
      layout = {
        root: xbriefDir,
        artifactDir: MIGRATED_ARTIFACT_DIR,
        artifactSuffix: MIGRATED_ARTIFACT_SUFFIX,
        infoRootKey: MIGRATED_INFO_ROOT_KEY,
        migrated: true,
      };
    } else if (existsSync(join(projectRoot, LEGACY_ARTIFACT_DIR))) {
      throw err; // Legacy-only project: operator must run deft migrate:xbrief.
    } else {
      // Neither exists -- return empty list.
      return [];
    }
  }
  const usePatterns =
    patterns.length > 0 ? patterns : [`${layout.artifactDir}/active/*${layout.artifactSuffix}`];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const pattern of usePatterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
      const folder = pattern.includes("/") ? dirnamePattern(projectRoot, pattern) : projectRoot;
      const globPart = pattern.includes("/")
        ? pattern.slice(pattern.lastIndexOf("/") + 1)
        : pattern;
      const firstSeg = pattern.split("/")[0] ?? "";
      const secondSeg = pattern.split("/")[1] ?? "";
      const lifecyclePattern = (LIFECYCLE_DIR_NAMES as readonly string[]).includes(firstSeg);
      if (lifecyclePattern && existsSync(join(projectRoot, firstSeg, secondSeg))) {
        const activeDir = join(projectRoot, firstSeg, secondSeg);
        for (const name of readdirSync(activeDir)) {
          if (matchGlob(name, globPart)) {
            addPath(join(activeDir, name), seen, out);
          }
        }
      } else {
        const targetDir = pattern.includes("/")
          ? join(projectRoot, pattern.slice(0, pattern.lastIndexOf("/")))
          : projectRoot;
        if (existsSync(targetDir)) {
          for (const name of readdirSync(targetDir)) {
            if (matchGlob(name, globPart)) {
              addPath(join(targetDir, name), seen, out);
            }
          }
        }
      }
      void folder;
    } else {
      const candidate = resolve(pattern.startsWith("/") ? pattern : join(projectRoot, pattern));
      addPath(candidate, seen, out);
    }
  }
  return out.sort();
}

function dirnamePattern(projectRoot: string, pattern: string): string {
  const idx = pattern.lastIndexOf("/");
  return idx >= 0 ? join(projectRoot, pattern.slice(0, idx)) : projectRoot;
}

function matchGlob(name: string, glob: string): boolean {
  // Layout-aware (#2109 part 1): an artifact-suffix glob matches either suffix,
  // so a mixed/either lifecycle tree resolves the same way.
  if (ARTIFACT_SUFFIXES.some((suffix) => glob === `*${suffix}`)) {
    return hasArtifactSuffix(name);
  }
  if (glob.startsWith("*.")) {
    return name.endsWith(glob.slice(1));
  }
  return name === glob;
}

function addPath(path: string, seen: Set<string>, out: string[]): void {
  const resolved = resolve(path);
  if (seen.has(resolved) || !existsSync(resolved)) {
    return;
  }
  seen.add(resolved);
  out.push(resolved);
}

function folderFor(path: string): string {
  const parent = basename(resolve(path, ".."));
  return (LIFECYCLE_FOLDERS as readonly string[]).includes(parent) ? parent : "";
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

function hasChildPlanRefs(plan: Record<string, unknown>): boolean {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return false;
  }
  return refs.some(
    (ref) =>
      typeof ref === "object" &&
      ref !== null &&
      !Array.isArray(ref) &&
      referenceTypeMatches(String((ref as Record<string, unknown>).type ?? ""), "plan"),
  );
}

function looksLikePhase(path: string, plan: Record<string, unknown>): boolean {
  const title = String(plan.title ?? "");
  const planId = String(plan.id ?? "");
  const narratives = plan.narratives;
  let hasAcceptanceNarrative = false;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const acc = (narratives as Record<string, unknown>).Acceptance;
    hasAcceptanceNarrative = typeof acc === "string" && acc.trim().length > 0;
  }
  const hasItems = Array.isArray(plan.items) && plan.items.length > 0;
  const stem = basename(path);
  return (
    stem.includes("-ip") ||
    title.toLowerCase().startsWith("ip-") ||
    planId.toLowerCase().startsWith("ip-") ||
    (!hasItems && hasAcceptanceNarrative)
  );
}

function kindOf(path: string, plan: Record<string, unknown>): string {
  const metadata = metadataOf(plan);
  const explicit = metadata.kind;
  if (explicit === "story" || explicit === "epic" || explicit === "phase") {
    return String(explicit);
  }
  if (hasChildPlanRefs(plan)) {
    return "epic";
  }
  if (looksLikePhase(path, plan)) {
    return "phase";
  }
  return "story";
}

function storyId(path: string, plan: Record<string, unknown>): string {
  const value = plan.id;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  const name = basename(path);
  return hasArtifactSuffix(name) ? stripArtifactSuffix(name) : name.replace(/\.[^.]+$/, "");
}

function hasTraces(plan: Record<string, unknown>, swarm: Record<string, unknown>): boolean {
  const narratives = plan.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const traces = (narratives as Record<string, unknown>).Traces;
    if (typeof traces === "string" && traces.trim().length > 0) {
      return true;
    }
  }
  const items = plan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        itemHasTraces(item as Record<string, unknown>)
      ) {
        return true;
      }
    }
  }
  const refs = plan.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (
        typeof ref === "object" &&
        ref !== null &&
        !Array.isArray(ref) &&
        referenceTypeMatches(String((ref as Record<string, unknown>).type ?? ""), "spec-section")
      ) {
        return true;
      }
    }
  }
  return asStrList(swarm.missing_traces_justification).length > 0;
}

function planNarrative(plan: Record<string, unknown>, key: string): string {
  const narratives = plan.narratives;
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) {
    return "";
  }
  const value = (narratives as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function acceptanceCountJustification(
  plan: Record<string, unknown>,
  swarm: Record<string, unknown>,
): string {
  const value = swarm.acceptance_criteria_justification;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return planNarrative(plan, "AcceptanceJustification");
}

function allScopeIds(projectRoot: string): Map<string, [string, string]> {
  const ids = new Map<string, [string, string]>();
  let vbriefDir: string;
  try {
    vbriefDir = resolveLifecycleRoot(projectRoot);
  } catch {
    return ids; // No xbrief/ layout; no scope IDs.
  }
  for (const folder of LIFECYCLE_FOLDERS) {
    const dir = join(vbriefDir, folder);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir).sort()) {
      if (!hasArtifactSuffix(name)) {
        continue;
      }
      const path = join(dir, name);
      const data = loadJson(path);
      if (data === null) {
        continue;
      }
      const plan = planOf(data);
      const sid = storyId(path, plan);
      ids.set(sid, [path, String(plan.status ?? "")]);
      const stem = stripArtifactSuffix(name);
      if (!ids.has(stem)) {
        ids.set(stem, [path, String(plan.status ?? "")]);
      }
    }
  }
  return ids;
}

function candidateFromPath(path: string, projectRoot: string): Candidate | null {
  const data = loadJson(path);
  if (data === null) {
    return null;
  }
  const plan = planOf(data);
  const metadata = metadataOf(plan);
  const swarm = swarmOf(metadata);
  return {
    path,
    relpath: projectRel(projectRoot, path),
    data,
    plan,
    story_id: storyId(path, plan),
    title: String(plan.title ?? basename(path)),
    status: String(plan.status ?? ""),
    folder: folderFor(path),
    kind: kindOf(path, plan),
    swarm,
    missing: [],
    blocked: [],
    decomposition_needed: false,
  };
}

function validateCandidate(
  candidate: Candidate,
  knownIds: Map<string, [string, string]>,
  fieldMode: SwarmFieldMode = "concurrent",
): void {
  if (candidate.kind === "epic" || candidate.kind === "phase") {
    candidate.decomposition_needed = true;
    return;
  }
  if (candidate.kind !== "story" || metadataOf(candidate.plan).kind !== "story") {
    candidate.missing.push("plan.metadata.kind=story");
  }
  if (typeof candidate.plan.id !== "string" || candidate.plan.id.trim().length === 0) {
    candidate.missing.push("plan.id");
  }
  if (typeof candidate.plan.title !== "string" || candidate.plan.title.trim().length === 0) {
    candidate.missing.push("plan.title");
  }
  const description = planNarrative(candidate.plan, "Description");
  const implementationPlan = planNarrative(candidate.plan, "ImplementationPlan");
  const userStory = planNarrative(candidate.plan, "UserStory");
  if (description.length === 0) {
    candidate.missing.push("plan.narratives.Description");
  }
  if (implementationPlan.length === 0) {
    candidate.missing.push("plan.narratives.ImplementationPlan");
  }
  if (userStory.length === 0) {
    candidate.missing.push("plan.narratives.UserStory");
  }
  if (candidate.folder === "active" && candidate.status !== "running") {
    candidate.blocked.push("active candidate plan.status must be running");
  }
  if (candidate.status === "running" && candidate.folder !== "active") {
    candidate.blocked.push("plan.status=running is only valid in vbrief/active/");
  }
  if (candidate.status === "blocked") {
    candidate.blocked.push("plan.status=blocked");
  }

  const items = candidate.plan.items;
  if (!Array.isArray(items) || items.length === 0) {
    candidate.missing.push("plan.items");
  } else {
    if (!itemsHaveAcceptance(items as Record<string, unknown>[])) {
      candidate.missing.push("plan.items[].narrative.Acceptance");
    }
    candidate.blocked.push(...deprecatedSubitemsIssues(items as Record<string, unknown>[]));
  }

  if (candidate.swarm.readiness !== READY) {
    candidate.missing.push("plan.metadata.swarm.readiness=ready for concurrent allocation");
  }
  const parallelSafe = candidate.swarm.parallel_safe;
  if (parallelSafe !== true && parallelSafe !== false) {
    candidate.missing.push("plan.metadata.swarm.parallel_safe");
  }
  candidate.missing.push(...missingRequiredSwarmFields(candidate.swarm, fieldMode));
  if (!hasTraces(candidate.plan, candidate.swarm)) {
    candidate.missing.push("Traces or missing_traces_justification");
  }
  candidate.blocked.push(
    ...storyQualityIssues({
      title: candidate.title,
      description,
      implementationPlan,
      userStory,
      acceptanceTexts: acceptanceTextsFromItems(items as Record<string, unknown>[] | undefined),
      acceptanceCountJustification: acceptanceCountJustification(candidate.plan, candidate.swarm),
      swarm: candidate.swarm,
      concurrentReady: candidate.swarm.readiness === READY,
    }),
  );
  if (candidate.swarm.size === "large" && candidate.swarm.parallel_safe === true) {
    candidate.blocked.push("size=large cannot be parallel_safe=true");
  }

  for (const dep of asStrList(candidate.swarm.depends_on)) {
    if (!knownIds.has(dep)) {
      candidate.blocked.push(`dependency ${JSON.stringify(dep)} does not resolve`);
    }
  }
}

function candidateDepGraph(
  candidates: Candidate[],
  knownIds: Map<string, [string, string]>,
): Map<string, string[]> {
  const candidateIds = new Set(candidates.map((c) => c.story_id));
  const graph = new Map<string, string[]>();
  for (const candidate of candidates) {
    const deps: string[] = [];
    for (const dep of asStrList(candidate.swarm.depends_on)) {
      if (candidateIds.has(dep)) {
        deps.push(dep);
        continue;
      }
      const known = knownIds.get(dep);
      if (known === undefined) {
        continue;
      }
      const depStatus = known[1];
      if (!["completed", "failed", "cancelled"].includes(depStatus)) {
        candidate.blocked.push(`dependency ${JSON.stringify(dep)} is not completed or a candidate`);
      }
    }
    graph.set(candidate.story_id, deps);
  }
  return graph;
}

function markCycles(candidates: Candidate[], graph: Map<string, string[]>): void {
  const byId = new Map(candidates.map((c) => [c.story_id, c]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (storyId: string, path: string[]): void => {
    if (visited.has(storyId)) {
      return;
    }
    if (visiting.has(storyId)) {
      const start = path.indexOf(storyId);
      const cycle = [...path.slice(start >= 0 ? start : 0), storyId];
      const message = `dependency cycle: ${cycle.join(" -> ")}`;
      for (const node of cycle) {
        const cand = byId.get(node);
        if (cand !== undefined && !cand.blocked.includes(message)) {
          cand.blocked.push(message);
        }
      }
      return;
    }
    visiting.add(storyId);
    for (const dep of graph.get(storyId) ?? []) {
      visit(dep, [...path, storyId]);
    }
    visiting.delete(storyId);
    visited.add(storyId);
  };

  for (const candidate of candidates) {
    visit(candidate.story_id, []);
  }
}

function propagateBlockedDependencies(candidates: Candidate[], graph: Map<string, string[]>): void {
  const byId = new Map(candidates.map((c) => [c.story_id, c]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (candidate.kind !== "story") {
        continue;
      }
      for (const dep of graph.get(candidate.story_id) ?? []) {
        const depCandidate = byId.get(dep);
        if (depCandidate === undefined) {
          continue;
        }
        if (
          depCandidate.missing.length === 0 &&
          depCandidate.blocked.length === 0 &&
          !depCandidate.decomposition_needed
        ) {
          continue;
        }
        const message = `dependency ${JSON.stringify(dep)} is blocked`;
        if (!candidate.blocked.includes(message)) {
          candidate.blocked.push(message);
          changed = true;
        }
      }
    }
  }
}

function readyStories(candidates: Candidate[]): Candidate[] {
  return candidates.filter(
    (c) =>
      c.kind === "story" &&
      c.missing.length === 0 &&
      c.blocked.length === 0 &&
      !c.decomposition_needed,
  );
}

function dependencyWaves(candidates: Candidate[], graph: Map<string, string[]>): string[][] {
  const readyIds = new Set(readyStories(candidates).map((c) => c.story_id));
  const remaining = new Set(readyIds);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((storyId) => (graph.get(storyId) ?? []).every((dep) => !remaining.has(dep)))
      .sort();
    if (wave.length === 0) {
      waves.push([...remaining].sort());
      break;
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
    }
  }
  return waves;
}

function transitiveDeps(storyId: string, graph: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [...(graph.get(storyId) ?? [])];
  while (stack.length > 0) {
    const dep = stack.pop();
    if (dep === undefined || out.has(dep)) {
      continue;
    }
    out.add(dep);
    stack.push(...(graph.get(dep) ?? []));
  }
  return out;
}

function fileOverlaps(
  candidates: Candidate[],
  graph: Map<string, string[]>,
): Map<string, string[]> {
  const fileToIds = new Map<string, string[]>();
  for (const candidate of readyStories(candidates)) {
    for (const filePath of asStrList(candidate.swarm.file_scope)) {
      const list = fileToIds.get(filePath) ?? [];
      list.push(candidate.story_id);
      fileToIds.set(filePath, list);
    }
  }

  const overlaps = new Map<string, string[]>();
  for (const [filePath, ids] of fileToIds) {
    const unsafePairs = new Set<string>();
    for (let index = 0; index < ids.length; index += 1) {
      const left = ids[index] ?? "";
      for (let j = index + 1; j < ids.length; j += 1) {
        const right = ids[j] ?? "";
        const leftDeps = transitiveDeps(left, graph);
        const rightDeps = transitiveDeps(right, graph);
        if (rightDeps.has(left) || leftDeps.has(right)) {
          continue;
        }
        unsafePairs.add(left);
        unsafePairs.add(right);
      }
    }
    if (unsafePairs.size > 0) {
      overlaps.set(filePath, [...unsafePairs].sort());
    }
  }
  return overlaps;
}

function conflictGroups(candidates: Candidate[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    const group = candidate.swarm.conflict_group;
    if (typeof group === "string" && group.trim().length > 0) {
      const list = groups.get(group) ?? [];
      list.push(candidate.story_id);
      groups.set(group, list);
    }
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function renderReport(
  candidates: Candidate[],
  graph: Map<string, string[]>,
  overlaps: Map<string, string[]>,
): string {
  const ready = readyStories(candidates);
  const blocked = candidates.filter(
    (c) => c.kind === "story" && (c.missing.length > 0 || c.blocked.length > 0),
  );
  const needsDecomposition = candidates.filter((c) => c.decomposition_needed);
  const lines: string[] = ["Swarm readiness report", ""];

  lines.push("Ready stories:");
  if (ready.length > 0) {
    for (const c of ready) {
      lines.push(`- ${c.story_id}: ${c.title} (${c.relpath})`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Blocked stories:");
  if (blocked.length > 0) {
    for (const c of blocked) {
      const reasons = [...c.missing, ...c.blocked];
      lines.push(`- ${c.story_id}: ${c.title} -- ${reasons.join("; ")}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Decomposition-needed epics/phases:");
  if (needsDecomposition.length > 0) {
    for (const c of needsDecomposition) {
      lines.push(`- ${c.story_id}: kind=${c.kind} (${c.relpath})`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Dependency waves:");
  const waves = dependencyWaves(candidates, graph);
  if (waves.length > 0) {
    waves.forEach((wave, index) => {
      lines.push(`- wave ${index + 1}: ${wave.join(", ")}`);
    });
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Conflict groups:");
  const groups = conflictGroups(candidates);
  if (groups.size > 0) {
    for (const [group, ids] of groups) {
      lines.push(`- ${group}: ${[...ids].sort().join(", ")}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("File overlap matrix:");
  if (overlaps.size > 0) {
    for (const [filePath, ids] of [...overlaps.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${filePath}: ${ids.join(", ")}`);
    }
    lines.push("Overlap is not one-PR-unit consent; serialize N PRs, one origin per PR.");
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Missing fields:");
  let missingAny = false;
  for (const c of candidates) {
    if (c.missing.length > 0) {
      missingAny = true;
      lines.push(`- ${c.story_id}: ${c.missing.join(", ")}`);
    }
  }
  if (!missingAny) {
    lines.push("- none");
  }
  return lines.join("\n");
}

function needsSwarmBlockRemediation(candidates: readonly Candidate[]): boolean {
  for (const c of candidates) {
    for (const item of c.missing) {
      if (
        item.startsWith("plan.metadata.swarm.") ||
        item.includes("readiness=ready") ||
        item === "plan.metadata.swarm.parallel_safe"
      ) {
        return true;
      }
    }
  }
  return false;
}

export function readinessReport(
  projectRoot: string,
  paths: readonly string[],
  options: ReadinessReportOptions = {},
): { exitCode: number; report: string } {
  const fieldMode: SwarmFieldMode =
    options.soloHeadless === true ? "solo-headless" : "concurrent";
  const candidates = paths
    .map((p) => candidateFromPath(p, projectRoot))
    .filter((c): c is Candidate => c !== null);
  if (candidates.length === 0) {
    return { exitCode: 1, report: "Swarm readiness report\n\nNo candidate vBRIEFs found." };
  }
  const knownIds = allScopeIds(projectRoot);
  for (const c of candidates) {
    knownIds.set(c.story_id, [c.path, c.status]);
  }
  for (const c of candidates) {
    validateCandidate(c, knownIds, fieldMode);
  }
  const graph = candidateDepGraph(candidates, knownIds);
  markCycles(candidates, graph);
  propagateBlockedDependencies(candidates, graph);
  const overlaps = fileOverlaps(candidates, graph);
  let report = renderReport(candidates, graph, overlaps);
  if (fieldMode === "solo-headless") {
    report = `${report}\n\nField mode: solo-headless (N=1 ceremony fields relaxed: expected_outputs, conflict_group, model_tier).`;
  }
  const failed =
    candidates.some(
      (c) => c.missing.length > 0 || c.blocked.length > 0 || c.decomposition_needed,
    ) || overlaps.size > 0;
  if (failed && needsSwarmBlockRemediation(candidates)) {
    report = `${report}\n\n${SWARM_BLOCK_REMEDIATION_HINT}`;
  }
  const withSerialize =
    failed && !report.includes("serialize N PRs")
      ? `${report}\n\n${SERIALIZE_N_PRS}`
      : report;
  return { exitCode: failed ? 1 : 0, report: withSerialize };
}

/**
 * Write plan.metadata.swarm from operator-named paths and explicit draft fields only (#3718).
 * Refuses empty file_scope / verify_commands. Does not read issue body text.
 */
export function scaffoldSwarmDraft(input: ScaffoldSwarmDraftInput): ScaffoldSwarmDraftResult {
  const fileScope = input.fileScope.map((p) => p.trim()).filter((p) => p.length > 0);
  const verifyCommands = input.verifyCommands.map((c) => c.trim()).filter((c) => c.length > 0);
  if (fileScope.length === 0) {
    return {
      ok: false,
      error:
        "scaffold requires operator-named --file-scope paths; refuse inventing fence authority from issue text (#4988 / #3718)",
    };
  }
  if (verifyCommands.length === 0) {
    return {
      ok: false,
      error:
        "scaffold requires explicit --verify-command values; refuse promoting issue-body commands (#4988 / #3718)",
    };
  }
  const size = input.size.trim();
  const confidence = input.fileScopeConfidence.trim();
  const readiness = input.readiness.trim();
  if (!size || !confidence || !readiness) {
    return {
      ok: false,
      error: "scaffold requires explicit --size, --file-scope-confidence, and --readiness",
    };
  }
  const absPath = resolve(input.projectRoot, input.vbriefPath);
  const data = loadJson(absPath);
  if (data === null) {
    return { ok: false, error: `scaffold could not read xBRIEF JSON at ${input.vbriefPath}` };
  }
  const plan = planOf(data);
  const metadata =
    typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
      ? ({ ...(plan.metadata as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const existingSwarm =
    typeof metadata.swarm === "object" &&
    metadata.swarm !== null &&
    !Array.isArray(metadata.swarm)
      ? ({ ...(metadata.swarm as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const swarm: Record<string, unknown> = {
    ...existingSwarm,
    readiness,
    parallel_safe: input.parallelSafe,
    file_scope: fileScope,
    verify_commands: verifyCommands,
    depends_on: input.dependsOn !== undefined ? [...input.dependsOn] : [],
    size,
    file_scope_confidence: confidence,
  };
  const writtenKeys = [
    "readiness",
    "parallel_safe",
    "file_scope",
    "verify_commands",
    "depends_on",
    "size",
    "file_scope_confidence",
  ];
  if (input.expectedOutputs !== undefined) {
    swarm.expected_outputs = [...input.expectedOutputs];
    writtenKeys.push("expected_outputs");
  }
  if (input.conflictGroup !== undefined && input.conflictGroup.trim()) {
    swarm.conflict_group = input.conflictGroup.trim();
    writtenKeys.push("conflict_group");
  }
  if (input.modelTier !== undefined && input.modelTier.trim()) {
    swarm.model_tier = input.modelTier.trim();
    writtenKeys.push("model_tier");
  }
  metadata.swarm = swarm;
  plan.metadata = metadata;
  data.plan = plan;
  try {
    writeFileSync(absPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `scaffold write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, path: absPath, writtenKeys };
}

export function expandReadinessPaths(projectRoot: string, patterns: readonly string[]): string[] {
  return expandPaths(projectRoot, patterns);
}

export { readyStories, renderReport as renderReadinessReport };
