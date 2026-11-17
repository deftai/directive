import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot, stripArtifactSuffix } from "../layout/resolve.js";
import { applyAcceptanceDispositionGrants } from "../policy/acceptance-disposition-grant.js";
import {
  evaluateAcceptanceEvidenceGate,
  persistClauseKeyedPendingItems,
} from "../scope/acceptance-evidence.js";
import { detectLifecycleFolder } from "../scope/decomposed-refs.js";
import {
  classifyStoredDeliveryDisposition,
  type DeliveryEvidenceInput,
  type NonDeliveryDisposition,
} from "../scope/delivery-evidence.js";
import { runTransition, type TransitionOptions } from "../scope/transition.js";
import { collectChildUris, collectPlanRefs, resolveVbriefRef } from "../scope/vbrief-ref.js";
import { liveOccupant, releaseSwarmOccupancy } from "../session/occupancy.js";
import type { LockDeps } from "../slice/lock.js";
import { MAX_FIXPOINT_PASSES, TERMINAL_FOLDERS } from "./constants.js";
import {
  type LaunchOccupancyRecordFile,
  launchOccupancyClosedStoryIds,
  launchOccupancyRecordFullyClosed,
  markLaunchOccupancyStoriesClosed,
  readLaunchOccupancyRecordsStrict,
  removeLaunchOccupancyRecordFile,
} from "./launch.js";
import { withLaunchCloseoutLock } from "./launch-closeout-lock.js";
import {
  cleanupWorkerAuthAssignmentsForStories,
  findWorkerAuthAssignmentsForStories,
} from "./worker-auth-assignment.js";

/** Per-story or default delivery evidence for cohort completion (#3041 / #3675). */
export interface CohortDeliveryContext {
  /** Evidence keyed by absolute story path (preferred). */
  readonly evidenceByPath?: ReadonlyMap<string, DeliveryEvidenceInput> | null;
  /** Shared evidence applied to every story when per-path map misses. */
  readonly defaultEvidence?: DeliveryEvidenceInput | null;
  readonly nonDeliveryDisposition?: NonDeliveryDisposition | null;
  readonly assumeEvidenceValidated?: boolean;
  readonly verifier?: string;
  /** Forward Prefer-A identity-join seams into runTransition (#3675). */
  readonly runGh?: TransitionOptions["runGh"];
  readonly fetchPrPayload?: TransitionOptions["fetchPrPayload"];
  readonly fetchClosingIssueIds?: TransitionOptions["fetchClosingIssueIds"];
}

export interface TransitionRecord {
  kind: "story" | "epic";
  path: string;
  action: string;
  ok: boolean;
  detail: string;
  /** Destination of a brief this run moved to completed/ (#6422 item 11). */
  moved_to?: string;
}

export interface SweepResult {
  project_root: string;
  dry_run: boolean;
  stories: TransitionRecord[];
  parents: TransitionRecord[];
  errors: string[];
  ok: boolean;
  /** Informational close-out lines (#6422 items 5 to 8). */
  closeout_notes?: string[];
}

/** One brief moved to a terminal folder in this run (#6422 item 11). */
export interface LifecycleMove {
  readonly source: string;
  readonly destination: string;
}

/** Briefs this run moved to completed/, stories and epic parents (#6422 item 11). */
export function lifecycleMovesOf(result: SweepResult): LifecycleMove[] {
  if (result.dry_run) return [];
  return [...result.stories, ...result.parents]
    .filter((r) => r.ok && typeof r.moved_to === "string" && r.moved_to.length > 0)
    .map((r) => ({ source: r.path, destination: r.moved_to as string }));
}

/** The on-disk notice a failed run prints when it already moved briefs (#6422 item 11). */
export const LIFECYCLE_MOVE_ON_DISK_NOTICE =
  "The lifecycle move below is already on disk and was not rolled back; commit these moved briefs:";

function loadPlan(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const plan = (data as Record<string, unknown>).plan;
    return typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function storyIdFromPath(path: string): string {
  const plan = loadPlan(path);
  const id = plan !== null && typeof plan.id === "string" ? plan.id.trim() : "";
  if (id.length > 0) return id;
  const name = basename(path);
  return hasArtifactSuffix(name) ? stripArtifactSuffix(name) : name.replace(/\.[^.]+$/, "");
}

/**
 * Tracked active twins of cohort stories that already have a completed/
 * counterpart with the same basename (#4798 leftover-complete must-move).
 * Add-completed-only is not leftover-complete; clearing verify_commands is
 * cleanup, not a substitute for moving or removing the active landmine.
 */
function readPlanId(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { plan?: { id?: unknown } };
    const id = raw.plan?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
export function findTrackedActiveTwins(storyPaths: readonly string[], vbriefDir: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const storyPath of storyPaths) {
    const name = basename(storyPath);
    if (!hasArtifactSuffix(name)) {
      continue;
    }
    const activePath = resolve(join(vbriefDir, "active", name));
    const completedPath = resolve(join(vbriefDir, "completed", name));
    if (seen.has(activePath)) {
      continue;
    }
    if (!existsSync(activePath) || !existsSync(completedPath)) {
      continue;
    }
    const activeId = readPlanId(activePath);
    const completedId = readPlanId(completedPath);
    // Same basename is not enough: missing or mismatched plan.id is not a twin.
    if (!activeId || !completedId || activeId !== completedId) {
      continue;
    }
    seen.add(activePath);
    out.push(activePath);
  }
  return out;
}

function rel(path: string, projectRoot: string): string {
  try {
    return resolve(path)
      .slice(resolve(projectRoot).length + 1)
      .replace(/\\/g, "/");
  } catch {
    return resolve(path).replace(/\\/g, "/");
  }
}

function globResolve(pattern: string, projectRoot: string): string[] {
  const absPattern = isAbsolute(pattern) ? pattern : join(projectRoot, pattern);
  if (!absPattern.includes("*")) {
    return existsSync(absPattern) ? [resolve(absPattern)] : [];
  }
  // Use path module to split directory/glob parts — platform-safe on both POSIX and Windows.
  const dir = dirname(absPattern);
  const glob = basename(absPattern);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => hasArtifactSuffix(name) || glob === name)
    .map((name) => resolve(dir, name))
    .filter((p) => existsSync(p));
}

export function resolveCohortPaths(
  positional: readonly string[],
  cohortGlobs: readonly string[],
  projectRoot: string,
): { paths: string[]; errors: string[] } {
  const resolved: string[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];

  const add = (path: string): void => {
    const rp = resolve(path);
    if (seen.has(rp)) {
      return;
    }
    seen.add(rp);
    resolved.push(rp);
  };

  for (const raw of positional) {
    const candidate = isAbsolute(raw) ? raw : join(projectRoot, raw);
    if (!existsSync(candidate)) {
      errors.push(`path does not exist: ${raw}`);
      continue;
    }
    add(candidate);
  }

  for (const pattern of cohortGlobs) {
    const matched = globResolve(pattern, projectRoot).sort();
    if (matched.length === 0) {
      errors.push(`glob matched no files: ${JSON.stringify(pattern)}`);
      continue;
    }
    for (const p of matched) {
      if (existsSync(p)) {
        add(p);
      }
    }
  }

  return { paths: resolved, errors };
}

function childIsSettled(
  childResolved: string,
  settled: Set<string>,
  dryRun: boolean,
  _vbriefDir: string,
): boolean {
  if (dryRun) {
    return settled.has(childResolved);
  }
  const folder = detectLifecycleFolder(childResolved);
  return (
    existsSync(childResolved) &&
    folder !== null &&
    TERMINAL_FOLDERS.includes(folder as "completed" | "cancelled")
  );
}

function allChildrenSettled(
  parentPlan: Record<string, unknown>,
  vbriefDir: string,
  settled: Set<string>,
  dryRun: boolean,
): boolean {
  const childUris = collectChildUris(parentPlan);
  if (childUris.length === 0) {
    return false;
  }
  for (const uri of childUris) {
    const childPath = resolveVbriefRef(uri, vbriefDir);
    if (childPath === null) {
      return false;
    }
    if (!childIsSettled(resolve(childPath), settled, dryRun, vbriefDir)) {
      return false;
    }
  }
  return true;
}

function parentCandidatesFrom(plan: Record<string, unknown>, vbriefDir: string): string[] {
  const out: string[] = [];
  for (const planRef of collectPlanRefs(plan)) {
    const parent = resolveVbriefRef(planRef, vbriefDir);
    if (parent !== null && existsSync(parent)) {
      out.push(resolve(parent));
    }
  }
  return out;
}

/**
 * #3240 on a clone. Persist mutates items in place; the clone is not written.
 * Derivation stays on the pending folder (#4839).
 */
function dryRunAcceptanceEvidenceGate(path: string): { ok: true } | { ok: false; detail: string } {
  const plan = loadPlan(path);
  if (plan === null) {
    return { ok: false, detail: `cannot read plan for acceptance evidence gate: ${path}` };
  }
  const clone = structuredClone(plan);
  persistClauseKeyedPendingItems(clone);
  // path is …/xbrief/<lifecycle>/<file>; project root is two levels up.
  const projectRoot = dirname(dirname(dirname(resolve(path))));
  // #6318: grant-covered deferrals apply on the clone as they do in scope:complete.
  const now = new Date();
  const granted = applyAcceptanceDispositionGrants({
    projectRoot,
    plan: clone,
    now,
    recordedAt: now.toISOString(),
  });
  if (!granted.ok) {
    return { ok: false, detail: granted.reason };
  }
  const gate = evaluateAcceptanceEvidenceGate(clone, { projectRoot });
  if (!gate.ok) {
    return { ok: false, detail: gate.message };
  }
  return { ok: true };
}

function transitionOptionsFor(
  storyPath: string,
  delivery: CohortDeliveryContext | null | undefined,
): TransitionOptions {
  if (delivery === null || delivery === undefined) {
    return { verifier: "swarm:complete-cohort" };
  }
  const pathKey = resolve(storyPath);
  const evidence =
    delivery.evidenceByPath?.get(pathKey) ??
    delivery.evidenceByPath?.get(storyPath) ??
    delivery.defaultEvidence ??
    null;
  return {
    deliveryEvidence: evidence,
    nonDeliveryDisposition: delivery.nonDeliveryDisposition,
    assumeEvidenceValidated: delivery.assumeEvidenceValidated,
    verifier: delivery.verifier ?? "swarm:complete-cohort",
    runGh: delivery.runGh,
    fetchPrPayload: delivery.fetchPrPayload,
    fetchClosingIssueIds: delivery.fetchClosingIssueIds,
  };
}

interface CompleteStoryArgs {
  readonly storyPath: string;
  readonly vbriefDir: string;
  readonly projectRoot: string;
  readonly settled: Set<string>;
  readonly dryRun: boolean;
  readonly delivery: CohortDeliveryContext | null;
}

function completeStory(args: CompleteStoryArgs): TransitionRecord {
  const { storyPath, vbriefDir, projectRoot, settled, dryRun, delivery } = args;
  const folder = detectLifecycleFolder(storyPath);
  const relpath = rel(storyPath, projectRoot);

  if (folder !== null && TERMINAL_FOLDERS.includes(folder as "completed" | "cancelled")) {
    settled.add(resolve(storyPath));
    const plan = loadPlan(storyPath);
    const disposition =
      folder === "completed" && plan !== null ? classifyStoredDeliveryDisposition(plan) : "unknown";
    return {
      kind: "story",
      path: relpath,
      action: "noop",
      ok: true,
      detail:
        folder === "completed"
          ? `already in ${folder}/ (deliveryDisposition=${disposition})`
          : `already in ${folder}/`,
    };
  }
  if (folder !== "active") {
    return {
      kind: "story",
      path: relpath,
      action: "skip",
      ok: true,
      detail: `not in active/ (in ${folder ?? "unknown"}/); cohort completion only sweeps active stories`,
    };
  }

  if (dryRun) {
    const gate = dryRunAcceptanceEvidenceGate(storyPath);
    if (!gate.ok) {
      return {
        kind: "story",
        path: relpath,
        action: "failed",
        ok: false,
        detail: gate.detail,
      };
    }
    settled.add(resolve(storyPath));
    return {
      kind: "story",
      path: relpath,
      action: "complete",
      ok: true,
      detail: "would complete active/ -> completed/",
    };
  }

  const result = runTransition(
    "complete",
    storyPath,
    new Date(),
    transitionOptionsFor(storyPath, delivery),
  );
  const destination = join(vbriefDir, "completed", storyPath.split(/[/\\]/).pop() ?? "");
  if (result.ok) {
    settled.add(resolve(destination));
  }
  return {
    kind: "story",
    path: relpath,
    action: result.ok ? "complete" : "failed",
    ok: result.ok,
    detail: result.message,
    ...(result.ok ? { moved_to: rel(destination, projectRoot) } : {}),
  };
}

interface CompleteParentArgs {
  readonly parentPath: string;
  readonly vbriefDir: string;
  readonly projectRoot: string;
  readonly settled: Set<string>;
  readonly dryRun: boolean;
  readonly delivery: CohortDeliveryContext | null;
}

function completeParent(args: CompleteParentArgs): TransitionRecord {
  const { parentPath, vbriefDir, projectRoot, settled, dryRun, delivery } = args;
  const folder = detectLifecycleFolder(parentPath);
  const relpath = rel(parentPath, projectRoot);

  if (folder !== null && TERMINAL_FOLDERS.includes(folder as "completed" | "cancelled")) {
    settled.add(resolve(parentPath));
    return {
      kind: "epic",
      path: relpath,
      action: "noop",
      ok: true,
      detail: `already in ${folder}/`,
    };
  }
  if (folder === "proposed") {
    return {
      kind: "epic",
      path: relpath,
      action: "skip",
      ok: true,
      detail: "parent in proposed/; promote it before the sweep can complete it",
    };
  }
  if (folder !== "pending" && folder !== "active") {
    return {
      kind: "epic",
      path: relpath,
      action: "skip",
      ok: true,
      detail: `unexpected folder ${folder ?? "unknown"}/`,
    };
  }

  if (dryRun) {
    if (folder === "active") {
      const gate = dryRunAcceptanceEvidenceGate(parentPath);
      if (!gate.ok) {
        return {
          kind: "epic",
          path: relpath,
          action: "failed",
          ok: false,
          detail: gate.detail,
        };
      }
    }
    settled.add(resolve(parentPath));
    const action = folder === "pending" ? "activate+complete" : "complete";
    return {
      kind: "epic",
      path: relpath,
      action,
      ok: true,
      detail: `would complete ${folder}/ -> completed/`,
    };
  }

  let current = parentPath;
  let action = "complete";
  let activateNotice = "";
  if (folder === "pending") {
    action = "activate+complete";
    const activateResult = runTransition("activate", current);
    if (!activateResult.ok) {
      return {
        kind: "epic",
        path: relpath,
        action: "failed",
        ok: false,
        detail: `activate failed: ${activateResult.message}`,
      };
    }
    activateNotice = activateResult.message.trim();
    current = join(vbriefDir, "active", parentPath.split(/[/\\]/).pop() ?? "");
  }

  const completeResult = runTransition(
    "complete",
    current,
    new Date(),
    transitionOptionsFor(current, delivery),
  );
  const destination = join(vbriefDir, "completed", parentPath.split(/[/\\]/).pop() ?? "");
  if (completeResult.ok) {
    settled.add(resolve(destination));
  }
  const detail =
    activateNotice.length > 0
      ? `${activateNotice}\n${completeResult.message}`
      : completeResult.message;
  return {
    kind: "epic",
    path: relpath,
    action: completeResult.ok ? action : "failed",
    ok: completeResult.ok,
    detail,
    ...(completeResult.ok ? { moved_to: rel(destination, projectRoot) } : {}),
  };
}

export interface SweepCohortArgs {
  readonly storyPaths: readonly string[];
  readonly projectRoot: string;
  readonly dryRun: boolean;
  readonly delivery?: CohortDeliveryContext | null;
}

export function sweepCohort(
  storyPaths: readonly string[],
  projectRoot: string,
  dryRun: boolean,
  delivery?: CohortDeliveryContext | null,
): SweepResult {
  return sweepCohortWithArgs({ storyPaths, projectRoot, dryRun, delivery: delivery ?? null });
}

function sweepCohortWithArgs(args: SweepCohortArgs): SweepResult {
  const { storyPaths, projectRoot, dryRun } = args;
  const delivery = args.delivery ?? null;
  let vbriefDir: string;
  try {
    vbriefDir = resolveLifecycleRoot(projectRoot);
  } catch {
    return {
      project_root: resolve(projectRoot),
      dry_run: dryRun,
      stories: [],
      parents: [],
      errors: [],
      ok: true,
    };
  }
  const result: SweepResult = {
    project_root: resolve(projectRoot),
    dry_run: dryRun,
    stories: [],
    parents: [],
    errors: [],
    ok: true,
  };

  const settled = new Set<string>();
  for (const term of TERMINAL_FOLDERS) {
    const termDir = join(vbriefDir, term);
    if (existsSync(termDir)) {
      for (const name of readdirSync(termDir)) {
        if (hasArtifactSuffix(name)) {
          settled.add(resolve(join(termDir, name)));
        }
      }
    }
  }

  const parentCandidates: string[] = [];
  const parentSeen = new Set<string>();
  for (const storyPath of storyPaths) {
    const plan = loadPlan(storyPath);
    if (plan !== null) {
      for (const parent of parentCandidatesFrom(plan, vbriefDir)) {
        if (!parentSeen.has(parent)) {
          parentSeen.add(parent);
          parentCandidates.push(parent);
        }
      }
    }
    result.stories.push(
      completeStory({
        storyPath,
        vbriefDir,
        projectRoot,
        settled,
        dryRun,
        delivery,
      }),
    );
  }

  const attempted = new Set(storyPaths.map((path) => resolve(path)));
  for (const twin of findTrackedActiveTwins(storyPaths, vbriefDir)) {
    const resolvedTwin = resolve(twin);
    if (attempted.has(resolvedTwin)) {
      continue;
    }
    attempted.add(resolvedTwin);
    result.stories.push(
      completeStory({
        storyPath: twin,
        vbriefDir,
        projectRoot,
        settled,
        dryRun,
        delivery,
      }),
    );
  }

  const finalized = new Set<string>();
  let passes = 0;
  while (passes < MAX_FIXPOINT_PASSES) {
    passes += 1;
    let progressed = false;
    for (const candidate of [...parentCandidates]) {
      if (finalized.has(candidate)) {
        continue;
      }
      const parentPlan = loadPlan(candidate);
      if (parentPlan === null) {
        finalized.add(candidate);
        continue;
      }
      if (!allChildrenSettled(parentPlan, vbriefDir, settled, dryRun)) {
        continue;
      }
      const record = completeParent({
        parentPath: candidate,
        vbriefDir,
        projectRoot,
        settled,
        dryRun,
        delivery,
      });
      result.parents.push(record);
      finalized.add(candidate);
      progressed = true;
      if (record.ok && (record.action === "complete" || record.action === "activate+complete")) {
        for (const grandparent of parentCandidatesFrom(parentPlan, vbriefDir)) {
          if (!parentSeen.has(grandparent) && !finalized.has(grandparent)) {
            parentSeen.add(grandparent);
            parentCandidates.push(grandparent);
          }
        }
      }
    }
    if (!progressed) {
      break;
    }
  }

  result.ok =
    result.errors.length === 0 && [...result.stories, ...result.parents].every((r) => r.ok);
  return result;
}

export function sweepResultToDict(result: SweepResult): Record<string, unknown> {
  const dict: Record<string, unknown> = {
    project_root: result.project_root,
    dry_run: result.dry_run,
    ok: result.ok,
    stories: result.stories,
    parents: result.parents,
    errors: result.errors,
  };
  if ((result.closeout_notes ?? []).length > 0) {
    dict.closeout_notes = result.closeout_notes;
  }
  const moves = lifecycleMovesOf(result);
  if (!result.ok && moves.length > 0) {
    // #6422 item 11: a failure after the sweep moved briefs says so.
    dict.lifecycle_moves_on_disk = moves;
    dict.lifecycle_move_notice = LIFECYCLE_MOVE_ON_DISK_NOTICE;
  }
  return dict;
}

/** One output line: a value with an embedded newline cannot start a new line. */
function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

/** Text lines naming each brief moved on disk by a failed run (#6422 item 11). */
export function lifecycleMoveOnDiskLines(result: SweepResult): string[] {
  const moves = lifecycleMovesOf(result);
  if (result.ok || moves.length === 0) return [];
  return [
    LIFECYCLE_MOVE_ON_DISK_NOTICE,
    ...moves.map((m) => `  - ${oneLine(m.source)} -> ${oneLine(m.destination)}`),
  ];
}

export function renderSweepText(result: SweepResult): string {
  const mode = result.dry_run ? "DRY-RUN" : "sweep";
  const nStory = result.stories.length;
  const nEpic = result.parents.length;
  const lines: string[] = [
    `Swarm cohort completion ${mode} (${nStory} stor${nStory === 1 ? "y" : "ies"}, ${nEpic} epic parent${nEpic === 1 ? "" : "s"})`,
    `  Project root: ${result.project_root}`,
  ];
  if (result.errors.length > 0) {
    lines.push("  Resolution errors:");
    for (const err of result.errors) {
      lines.push(`    - ${err}`);
    }
  }
  if (result.stories.length > 0) {
    lines.push("  Stories:");
    for (const r of result.stories) {
      lines.push(`    [${r.ok ? "ok" : "FAILED"}] ${r.action.padEnd(16)} ${r.path} -- ${r.detail}`);
    }
  }
  if (result.parents.length > 0) {
    lines.push("  Epic parents:");
    for (const r of result.parents) {
      lines.push(`    [${r.ok ? "ok" : "FAILED"}] ${r.action.padEnd(16)} ${r.path} -- ${r.detail}`);
    }
  }
  const notes = result.closeout_notes ?? [];
  if (notes.length > 0) {
    lines.push("  Close-out:");
    for (const note of notes) {
      lines.push(`    - ${oneLine(note)}`);
    }
  }
  const onDisk = lifecycleMoveOnDiskLines(result);
  if (onDisk.length > 0) {
    lines.push(`  ${onDisk[0]}`);
    for (const line of onDisk.slice(1)) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("");
  if (result.ok) {
    const completed = [...result.stories, ...result.parents].filter((r) =>
      ["complete", "activate+complete"].includes(r.action),
    ).length;
    const verb = result.dry_run ? "would complete" : "completed";
    lines.push(`Result: SWEEP CLEAN -- ${verb} ${completed} vBRIEF(s).`);
  } else if ([...result.stories, ...result.parents].every((r) => r.ok)) {
    lines.push(
      "Result: CLOSE-OUT FAILED after a clean sweep -- the lifecycle sweep succeeded; see the errors above.",
    );
  } else {
    const nFailed = [...result.stories, ...result.parents].filter((r) => !r.ok).length;
    lines.push(
      `Result: SWEEP INCOMPLETE -- ${nFailed} transition(s) failed and/or ${result.errors.length} resolution error(s). See above.`,
    );
  }
  return lines.join("\n");
}

/**
 * #6422 item 1: the stories this run moved to a terminal folder or found
 * already in completed/ or cancelled/. A story the sweep skipped for any other
 * reason is not closed.
 */
function closedSetOf(
  result: SweepResult,
  paths: readonly string[],
  storyIdByPath: ReadonlyMap<string, string>,
  projectRoot: string,
): string[] {
  const closed = new Set<string>();
  result.stories.forEach((record, index) => {
    if (!record.ok || (record.action !== "complete" && record.action !== "noop")) return;
    const requested = paths[index];
    const id =
      requested !== undefined
        ? storyIdByPath.get(resolve(requested))
        : record.moved_to !== undefined
          ? storyIdFromPath(join(projectRoot, record.moved_to))
          : undefined;
    if (id !== undefined && id.length > 0) closed.add(id);
  });
  return [...closed].sort();
}

interface CloseoutOutcome {
  readonly ok: boolean;
  readonly errors: string[];
  readonly notes: string[];
}

interface CloseOutStoriesArgs {
  readonly projectRoot: string;
  readonly closedStoryIds: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly allocationPlanId: string | null;
  readonly release: typeof releaseSwarmOccupancy;
}

const NOTHING_CHANGED = "Close-out removed nothing and released nothing.";

function listedBy(entry: LaunchOccupancyRecordFile, storyId: string): boolean {
  return entry.record.story_ids.some((id) => id.trim() === storyId);
}

/**
 * The records a closed story belongs to (#6422 item 4). A story a later launch
 * listed again after an earlier record closed it belongs to the record where it
 * is still open; only a story open in several records stays ambiguous.
 */
function owningRecords(
  records: readonly LaunchOccupancyRecordFile[],
  storyId: string,
): LaunchOccupancyRecordFile[] {
  const listing = records.filter((entry) => listedBy(entry, storyId));
  if (listing.length <= 1) return listing;
  const open = listing.filter(
    (entry) => !launchOccupancyClosedStoryIds(entry.record).includes(storyId),
  );
  return open.length > 0 ? open : listing;
}

/**
 * Per-story close-out under the launch/close-out lock (#6422 items 3 to 8).
 * Close-out acts on the closed set only, keeps each record's roster, and
 * releases the launcher lease only after every story of every record of that
 * session is closed.
 */
function closeOutStories(args: CloseOutStoriesArgs): CloseoutOutcome {
  const { projectRoot, closedStoryIds, env } = args;
  const notes: string[] = [];
  const refuse = (message: string): CloseoutOutcome => ({
    ok: false,
    errors: [`${message} ${NOTHING_CHANGED}`],
    notes,
  });

  // Item 3: strict read; never retract here.
  const read = readLaunchOccupancyRecordsStrict(projectRoot);
  if (!read.ok) {
    return refuse(
      `swarm close-out cannot read launch-occupancy record ${read.file}: ${read.detail}.`,
    );
  }
  const records = read.records;
  const liveSession = liveOccupant(projectRoot)?.sessionId ?? null;
  const fullyClosedBefore = new Set(
    records.filter((entry) => launchOccupancyRecordFullyClosed(entry.record)).map((e) => e.file),
  );

  // Item 4: group the closed set by the record that lists each story.
  const unlisted: string[] = [];
  const storiesByFile = new Map<string, string[]>();
  for (const storyId of closedStoryIds) {
    const listing = owningRecords(records, storyId);
    if (listing.length === 0) {
      unlisted.push(storyId);
      continue;
    }
    for (const entry of listing) {
      storiesByFile.set(entry.file, [...(storiesByFile.get(entry.file) ?? []), storyId]);
    }
  }
  if (storiesByFile.size > 1) {
    const named = [...storiesByFile.entries()]
      .map(([file, stories]) => `${file}: ${stories.join(", ")}`)
      .join("; ");
    return refuse(
      `swarm close-out refuses a run that mixes stories of more than one launch record (${named}). ` +
        "Close each record's stories in its own run.",
    );
  }

  // Item 5: stories that no record lists are not a failure.
  if (unlisted.length > 0) {
    const found = findWorkerAuthAssignmentsForStories({ projectRoot, storyIds: unlisted });
    for (const assignment of found) {
      notes.push(
        `story ${assignment.story_id}: no launch record here lists it; its worker assignment ` +
          `record (dispatch_id ${assignment.dispatch_id}) was left in place.`,
      );
    }
    const reported = new Set(found.map((a) => a.story_id));
    const quiet = unlisted.filter((id) => !reported.has(id));
    if (quiet.length > 0) {
      notes.push(`no launch record lists ${quiet.join(", ")}; nothing to close out for it.`);
    }
  }

  // Item 6: stories of one record.
  let releaseSession: string | null = null;
  const [groupFile, groupStories] = [...storiesByFile.entries()][0] ?? [null, []];
  const group = records.find((entry) => entry.file === groupFile) ?? null;
  if (group !== null) {
    const record = group.record;
    const session = record.occupancy_session_id;
    const wantedPlan = args.allocationPlanId?.trim() ?? "";
    if (wantedPlan.length > 0 && record.allocation_plan_id !== wantedPlan) {
      return refuse(
        `swarm close-out launch record ${group.file} belongs to allocation plan ` +
          `${record.allocation_plan_id ?? "(none)"}, not ${wantedPlan}.`,
      );
    }
    if (liveSession === session) {
      const envSession = env.DEFT_SESSION_ID?.trim() ?? "";
      if (envSession.length > 0 && envSession !== session) {
        return refuse(
          `swarm close-out ambient owner ${envSession} conflicts with cohort owner ${session}; ` +
            "refusing to release a later session's live lease.",
        );
      }
      const cleaned = cleanupWorkerAuthAssignmentsForStories({
        projectRoot,
        dispatchId: session,
        storyIds: groupStories,
      });
      if (!cleaned.ok) {
        return { ok: false, errors: [cleaned.detail], notes };
      }
      try {
        markLaunchOccupancyStoriesClosed(projectRoot, group, groupStories);
      } catch (exc: unknown) {
        return {
          ok: false,
          errors: [
            `swarm close-out removed ${String(cleaned.removed)} worker assignment record(s) but ` +
              `could not mark ${groupStories.join(", ")} closed in ${group.file}: ${String(exc)}. ` +
              "Run the command again.",
          ],
          notes,
        };
      }
      notes.push(
        `closed ${groupStories.join(", ")} in launch record ${group.file} (session ${session}); ` +
          `removed ${String(cleaned.removed)} worker assignment record(s).`,
      );
      releaseSession = session;
    } else if (!fullyClosedBefore.has(group.file)) {
      if (liveSession !== null) {
        return refuse(
          `swarm close-out occupancy record belongs to a different cohort: launch record ` +
            `${group.file} names session ${session}, but the live lease is held by ${liveSession}. ` +
            "The occupant may release (`occupancy:release` / `session:end`). Isolate in another " +
            "worktree rather than taking a live lease.",
        );
      }
      notes.push(
        `launch record ${group.file} names session ${session}, which holds no live lease; ` +
          "no worker assignment was removed and no story was marked closed.",
      );
    }
  }

  // Item 7: lease last.
  const removedFiles = new Set<string>();
  if (releaseSession !== null) {
    const reread = readLaunchOccupancyRecordsStrict(projectRoot);
    if (!reread.ok) {
      return {
        ok: false,
        errors: [`swarm close-out cannot re-read launch record ${reread.file}: ${reread.detail}.`],
        notes,
      };
    }
    const sessionRecords = reread.records.filter(
      (entry) => entry.record.occupancy_session_id === releaseSession,
    );
    const open = sessionRecords.flatMap((entry) => {
      const closed = new Set(launchOccupancyClosedStoryIds(entry.record));
      return entry.record.story_ids.filter((id) => !closed.has(id.trim()));
    });
    if (open.length > 0) {
      notes.push(
        `launcher lease of session ${releaseSession} kept: open launched stories remain ` +
          `(${open.join(", ")}).`,
      );
    } else {
      // Launcher occupancy only. Child owner leases release on the
      // orchestration terminal transition (#3999), not here.
      const released = args.release(projectRoot, { env, sessionId: releaseSession });
      if (released.code !== 0) {
        return {
          ok: false,
          errors: [
            `${released.message} The launch records stay; run the command again to release the lease.`,
          ],
          notes,
        };
      }
      notes.push(`released the launcher lease of session ${releaseSession}.`);
      for (const entry of sessionRecords) {
        try {
          removeLaunchOccupancyRecordFile(projectRoot, entry.file);
          removedFiles.add(entry.file);
          notes.push(`removed launch record ${entry.file}.`);
        } catch (exc: unknown) {
          return {
            ok: false,
            errors: [
              `swarm close-out released the lease but could not remove launch record ` +
                `${entry.file}: ${String(exc)}. Run the command again to remove it.`,
            ],
            notes,
          };
        }
      }
    }
  }

  // Item 8: finish a run that released the lease and stopped.
  for (const entry of records) {
    if (!fullyClosedBefore.has(entry.file) || removedFiles.has(entry.file)) continue;
    if (entry.record.occupancy_session_id === liveSession) continue;
    try {
      if (removeLaunchOccupancyRecordFile(projectRoot, entry.file)) {
        notes.push(
          `removed fully closed launch record ${entry.file}; its session holds no lease here, ` +
            "so no lease was released.",
        );
      }
    } catch (exc: unknown) {
      return {
        ok: false,
        errors: [`swarm close-out could not remove launch record ${entry.file}: ${String(exc)}.`],
        notes,
      };
    }
  }
  return { ok: true, errors: [], notes };
}

export function completeCohort(args: {
  stories?: readonly string[];
  cohortGlobs?: readonly string[];
  projectRoot: string;
  dryRun?: boolean;
  emitJson?: boolean;
  /** Per-story delivery evidence; without it code-bearing stories fail closed (#3041). */
  delivery?: CohortDeliveryContext | null;
  /** Optional launch allocation plan id so close-out reads this cohort's occupancy slot. */
  allocationPlanId?: string | null;
  /** Test seam and explicit ambient-owner source for close-out corroboration. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: wait/clock deps of the launch/close-out lock (#6422). */
  lockDeps?: LockDeps;
  /** Test seam: launcher lease release (defaults to releaseSwarmOccupancy). */
  releaseSwarmOccupancyFn?: typeof releaseSwarmOccupancy;
}): { exitCode: number; stdout: string; stderr: string; sweep: SweepResult | null } {
  const projectRoot = resolve(args.projectRoot);
  if (!existsSync(projectRoot)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Error: project root does not exist: ${projectRoot}\n`,
      sweep: null,
    };
  }
  if (!existsSync(resolveLifecycleRoot(projectRoot))) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Error: no vbrief/ directory under project root: ${projectRoot}\n`,
      sweep: null,
    };
  }

  const { paths, errors } = resolveCohortPaths(
    args.stories ?? [],
    args.cohortGlobs ?? [],
    projectRoot,
  );
  if (paths.length === 0) {
    const msg =
      "Error: empty cohort. Pass one or more story vBRIEF paths as positional arguments and/or --cohort <glob>.";
    const empty: SweepResult = {
      project_root: projectRoot,
      dry_run: args.dryRun ?? false,
      stories: [],
      parents: [],
      errors: errors.length > 0 ? errors : [msg],
      ok: false,
    };
    if (args.emitJson) {
      return {
        exitCode: 2,
        stdout: `${JSON.stringify(sweepResultToDict(empty), null, 2)}\n`,
        stderr: "",
        sweep: empty,
      };
    }
    let stderr = `${msg}\n`;
    for (const err of errors) {
      stderr += `  - ${err}\n`;
    }
    return { exitCode: 2, stdout: "", stderr, sweep: empty };
  }

  // Story ids are read before the sweep moves the briefs (#6422).
  const storyIdByPath = new Map(paths.map((path) => [resolve(path), storyIdFromPath(path)]));
  const result = sweepCohortWithArgs({
    storyPaths: paths,
    projectRoot,
    dryRun: args.dryRun ?? false,
    delivery: args.delivery ?? null,
  });
  result.errors.push(...errors);

  if (result.ok && args.dryRun !== true) {
    const env = args.env ?? process.env;
    const closedStoryIds = closedSetOf(result, paths, storyIdByPath, projectRoot);
    // The sweep runs outside the lock; close-out runs inside it (#6422 item 2).
    const locked = withLaunchCloseoutLock(
      projectRoot,
      () =>
        closeOutStories({
          projectRoot,
          closedStoryIds,
          env,
          allocationPlanId: args.allocationPlanId ?? null,
          release: args.releaseSwarmOccupancyFn ?? releaseSwarmOccupancy,
        }),
      args.lockDeps ?? {},
    );
    const outcome: CloseoutOutcome = locked.ok
      ? locked.value
      : { ok: false, errors: [locked.detail], notes: [] };
    if (outcome.notes.length > 0) {
      result.closeout_notes = outcome.notes;
    }
    if (!outcome.ok) {
      result.ok = false;
      result.errors.push(...outcome.errors);
    }
  }

  if (args.emitJson) {
    return {
      exitCode: result.ok ? 0 : 1,
      stdout: `${JSON.stringify(sweepResultToDict(result), null, 2)}\n`,
      stderr: "",
      sweep: result,
    };
  }
  return {
    exitCode: result.ok ? 0 : 1,
    stdout: `${renderSweepText(result)}\n`,
    stderr: "",
    sweep: result,
  };
}
