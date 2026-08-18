import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { detectLifecycleFolder } from "../scope/decomposed-refs.js";
import {
  classifyStoredDeliveryDisposition,
  type DeliveryEvidenceInput,
  type NonDeliveryDisposition,
} from "../scope/delivery-evidence.js";
import { runTransition, type TransitionOptions } from "../scope/transition.js";
import { collectChildUris, collectPlanRefs, resolveVbriefRef } from "../scope/vbrief-ref.js";
import { MAX_FIXPOINT_PASSES, TERMINAL_FOLDERS } from "./constants.js";

/** Per-story or default delivery evidence for cohort completion (#3041). */
export interface CohortDeliveryContext {
  /** Evidence keyed by absolute story path (preferred). */
  readonly evidenceByPath?: ReadonlyMap<string, DeliveryEvidenceInput> | null;
  /** Shared evidence applied to every story when per-path map misses. */
  readonly defaultEvidence?: DeliveryEvidenceInput | null;
  readonly nonDeliveryDisposition?: NonDeliveryDisposition | null;
  readonly assumeEvidenceValidated?: boolean;
  readonly verifier?: string;
}

export interface TransitionRecord {
  kind: "story" | "epic";
  path: string;
  action: string;
  ok: boolean;
  detail: string;
}

export interface SweepResult {
  project_root: string;
  dry_run: boolean;
  stories: TransitionRecord[];
  parents: TransitionRecord[];
  errors: string[];
  ok: boolean;
}

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
  if (result.ok) {
    settled.add(resolve(join(vbriefDir, "completed", storyPath.split(/[/\\]/).pop() ?? "")));
  }
  return {
    kind: "story",
    path: relpath,
    action: result.ok ? "complete" : "failed",
    ok: result.ok,
    detail: result.message,
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
  if (completeResult.ok) {
    settled.add(resolve(join(vbriefDir, "completed", parentPath.split(/[/\\]/).pop() ?? "")));
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
  return {
    project_root: result.project_root,
    dry_run: result.dry_run,
    ok: result.ok,
    stories: result.stories,
    parents: result.parents,
    errors: result.errors,
  };
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
  lines.push("");
  if (result.ok) {
    const completed = [...result.stories, ...result.parents].filter((r) =>
      ["complete", "activate+complete"].includes(r.action),
    ).length;
    const verb = result.dry_run ? "would complete" : "completed";
    lines.push(`Result: SWEEP CLEAN -- ${verb} ${completed} vBRIEF(s).`);
  } else {
    const nFailed = [...result.stories, ...result.parents].filter((r) => !r.ok).length;
    lines.push(
      `Result: SWEEP INCOMPLETE -- ${nFailed} transition(s) failed and/or ${result.errors.length} resolution error(s). See above.`,
    );
  }
  return lines.join("\n");
}

export function completeCohort(args: {
  stories?: readonly string[];
  cohortGlobs?: readonly string[];
  projectRoot: string;
  dryRun?: boolean;
  emitJson?: boolean;
  /** Per-story delivery evidence; without it code-bearing stories fail closed (#3041). */
  delivery?: CohortDeliveryContext | null;
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

  const result = sweepCohortWithArgs({
    storyPaths: paths,
    projectRoot,
    dryRun: args.dryRun ?? false,
    delivery: args.delivery ?? null,
  });
  result.errors.push(...errors);

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
