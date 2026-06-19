import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { countVbriefWip, resolveWipCap } from "../policy/wip.js";
import { runTransition } from "../scope/transition.js";
import {
  allScopeIds,
  asStrList,
  candidateDepGraph,
  candidateFromPath,
  markCycles,
} from "./swarm-deps.js";
import type { ReconcileGraphOutcome } from "./types.js";

export const RESOLVED_FOLDERS = ["completed", "cancelled"] as const;
const CYCLE_MARKER = "dependency cycle:";

function resolveWipState(projectRoot: string): [number, number] {
  const capResult = resolveWipCap(projectRoot);
  const cap = capResult.cap;
  const count = countVbriefWip(projectRoot);
  return [cap, count];
}

export function depResolved(dep: string, knownIds: Record<string, [string, string]>): boolean {
  const known = knownIds[dep];
  if (!known) return false;
  const [path] = known;
  const folder = path.split(/[/\\]/).slice(-2, -1)[0] ?? "";
  return (RESOLVED_FOLDERS as readonly string[]).includes(folder);
}

function unresolvedDeps(
  candidate: { swarm: Record<string, unknown> },
  knownIds: Record<string, [string, string]>,
): string[] {
  return asStrList(candidate.swarm.depends_on).filter((dep) => !depResolved(dep, knownIds));
}

function candidateInCycle(candidate: { blocked: string[] }): boolean {
  return candidate.blocked.some((r) => r.startsWith(CYCLE_MARKER));
}

export interface ReconcileGraphOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export function reconcileGraph(
  projectRoot: string,
  options: ReconcileGraphOptions = {},
): [number, ReconcileGraphOutcome] {
  const root = resolve(projectRoot);
  const proposedDir = join(root, "vbrief", "proposed");
  if (!existsSync(proposedDir)) {
    return [
      2,
      {
        promoted: [],
        deferredWip: [],
        waiting: [],
        cycles: [],
        errors: [],
        cap: 0,
        count: 0,
        dryRun: options.dryRun ?? false,
        forced: options.force ?? false,
      },
    ];
  }

  const candidatePaths = readdirSync(proposedDir)
    .filter((f) => f.endsWith(".vbrief.json"))
    .sort()
    .map((f) => join(proposedDir, f));

  const candidates = candidatePaths
    .map((p) => candidateFromPath(p, root))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const knownIds = allScopeIds(root);
  for (const cand of candidates) {
    if (!knownIds[cand.storyId]) knownIds[cand.storyId] = [cand.path, cand.status];
  }

  const graph = candidateDepGraph(candidates, knownIds);
  markCycles(candidates, graph);

  const [cap, count] = resolveWipState(root);
  const outcome: ReconcileGraphOutcome = {
    promoted: [],
    deferredWip: [],
    waiting: [],
    cycles: [],
    errors: [],
    cap,
    count,
    dryRun: options.dryRun ?? false,
    forced: options.force ?? false,
  };

  const eligible: typeof candidates = [];
  for (const cand of [...candidates].sort((a, b) => a.storyId.localeCompare(b.storyId))) {
    if (candidateInCycle(cand)) {
      const cycleReason = cand.blocked.find((r) => r.startsWith(CYCLE_MARKER)) ?? "";
      outcome.cycles.push(`${cand.storyId}: ${cycleReason}`);
      continue;
    }
    const deps = asStrList(cand.swarm.depends_on);
    if (deps.length === 0) continue;
    const unresolved = unresolvedDeps(cand, knownIds);
    if (unresolved.length > 0) {
      outcome.waiting.push({ story_id: cand.storyId, unresolved });
      continue;
    }
    eligible.push(cand);
  }

  let runningCount = count;
  for (const cand of eligible) {
    if (runningCount >= cap && !options.force) {
      outcome.deferredWip.push(cand.storyId);
      continue;
    }
    if (options.dryRun) {
      outcome.promoted.push(cand.storyId);
      runningCount += 1;
      continue;
    }
    const result = runTransition("promote", cand.path);
    if (!result.ok) {
      outcome.errors.push({ story_id: cand.storyId, message: result.message });
      continue;
    }
    outcome.promoted.push(cand.storyId);
    runningCount += 1;
  }

  return [outcome.cycles.length > 0 ? 1 : 0, { ...outcome, count: runningCount }];
}

export function renderGraphReport(outcome: ReconcileGraphOutcome): string {
  const lines: string[] = ["vBRIEF reconcile graph", ""];
  const suffix = outcome.dryRun ? " (dry-run)" : "";

  lines.push(`Promoted${suffix}:`);
  if (outcome.promoted.length > 0) {
    for (const id of outcome.promoted) lines.push(`- ${id}`);
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push(`Deferred (WIP cap ${outcome.count}/${outcome.cap}):`);
  if (outcome.deferredWip.length > 0) {
    for (const id of outcome.deferredWip) lines.push(`- ${id}`);
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Waiting (deps unresolved):");
  if (outcome.waiting.length > 0) {
    for (const w of outcome.waiting) {
      lines.push(`- ${w.story_id}: needs ${w.unresolved.join(", ")}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Cycles:");
  if (outcome.cycles.length > 0) {
    for (const entry of outcome.cycles) lines.push(`- ${entry}`);
  } else {
    lines.push("- none");
  }

  if (outcome.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const err of outcome.errors) lines.push(`- ${err.story_id}: ${err.message}`);
  }

  return lines.join("\n");
}

export function graphOutcomeToJson(outcome: ReconcileGraphOutcome): Record<string, unknown> {
  return {
    promoted: [...outcome.promoted],
    deferred_wip: [...outcome.deferredWip],
    waiting: outcome.waiting.map((w) => ({ story_id: w.story_id, unresolved: w.unresolved })),
    cycles: [...outcome.cycles],
    errors: outcome.errors.map((e) => ({ story_id: e.story_id, message: e.message })),
    cap: outcome.cap,
    count: outcome.count,
    dry_run: outcome.dryRun,
    forced: outcome.forced,
  };
}
