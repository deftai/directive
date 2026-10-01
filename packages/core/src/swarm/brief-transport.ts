/**
 * Bounded retained-brief transport into the isolated lifecycle checkout (#4714 R5).
 * Materialize only when exact bytes match a reachable reviewed product/evidence blob.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import type { runText } from "./subprocess.js";

export const SOURCE_RECOVERY_REMEDIATION =
  "leftover-complete/source-recovery: no reviewed merged/reachable evidence-bearing active brief " +
  "for this issue/story/path. Land an activation + product/evidence PR that carries the brief, " +
  "or recover the reviewed bytes before swarm:finalize-cohort (#4714 R5).";

export interface ReviewedBriefLookup {
  readonly bytes: string | null;
  readonly source: string | null;
  readonly error: string | null;
}

/**
 * History tip for reviewed-blob recovery. Must be the validated delivery branch
 * (origin/<deliveryBranch>), never remote default HEAD alone (#4714 Greptile P1).
 */
export function deliveryHistoryRef(deliveryBranch: string | null | undefined): string | null {
  if (typeof deliveryBranch !== "string") {
    return null;
  }
  const branch = deliveryBranch.trim();
  if (branch.length === 0) {
    return null;
  }
  return `origin/${branch}`;
}

/** Read brief bytes from a commit-ish path (merge SHA or delivery-branch history). */
export function readReviewedBriefBlob(
  projectRoot: string,
  relPath: string,
  commitIsh: string | null | undefined,
  runGit: typeof runText,
  deliveryBranch: string | null | undefined,
): ReviewedBriefLookup {
  const rel = relPath.replace(/\\/g, "/");
  if (typeof commitIsh === "string" && commitIsh.trim().length > 0) {
    const tip = commitIsh.trim();
    const shown = runGit(["git", "show", `${tip}:${rel}`], { cwd: projectRoot });
    if (shown.returncode === 0 && shown.stdout.length > 0) {
      return { bytes: shown.stdout, source: `${tip}:${rel}`, error: null };
    }
  }
  const historyRef = deliveryHistoryRef(deliveryBranch);
  if (historyRef === null) {
    return {
      bytes: null,
      source: null,
      error: `no validated delivery branch for reviewed-blob recovery of ${rel}`,
    };
  }
  // Walk delivery-branch history for a readable blob. Prefer non-deletion touches;
  // a merge that deleted the active brief must not become the recovery tip (#4714 R5).
  const log = runGit(
    ["git", "log", "-20", "--format=%H", "--diff-filter=ACMR", historyRef, "--", rel],
    { cwd: projectRoot },
  );
  let shas: string[] =
    log.returncode === 0
      ? log.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
  if (shas.length === 0) {
    // Fallback without diff-filter: walk recent delivery tips and skip unreadable (deleted) tips.
    const anyLog = runGit(["git", "log", "-20", "--format=%H", historyRef, "--", rel], {
      cwd: projectRoot,
    });
    if (anyLog.returncode === 0) {
      shas = anyLog.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  }
  for (const sha of shas) {
    const shown = runGit(["git", "show", `${sha}:${rel}`], { cwd: projectRoot });
    if (shown.returncode === 0 && shown.stdout.length > 0) {
      return { bytes: shown.stdout, source: `${sha}:${rel}`, error: null };
    }
  }
  return {
    bytes: null,
    source: null,
    error: `no reachable reviewed blob for ${rel}`,
  };
}

export interface MaterializeBriefArgs {
  readonly checkoutRoot: string;
  readonly projectRoot: string;
  readonly relPath: string;
  readonly retainedRoots: readonly string[];
  readonly reviewedCommitIsh: string | null | undefined;
  /** Validated plan/policy delivery branch (not remote default HEAD). */
  readonly deliveryBranch: string | null | undefined;
  readonly runGit: typeof runText;
}

export type MaterializeBriefResult =
  | { ok: true; path: string; source: string }
  | { ok: false; error: string };

function conflictAt(checkoutRoot: string, relPath: string): string | null {
  const active = resolve(checkoutRoot, relPath);
  if (existsSync(active)) {
    return `active conflict at ${relPath}`;
  }
  const completedRel = relPath.replace("/active/", "/completed/");
  const cancelledRel = relPath.replace("/active/", "/cancelled/");
  if (existsSync(resolve(checkoutRoot, completedRel))) {
    return `terminal conflict at ${completedRel}`;
  }
  if (existsSync(resolve(checkoutRoot, cancelledRel))) {
    return `terminal conflict at ${cancelledRel}`;
  }
  return null;
}

/**
 * Copy one retained brief into the lifecycle checkout when bytes match a reviewed blob.
 * Never copies a whole xbrief/ tree or completes in the worker dest.
 */
export function materializeRetainedBrief(args: MaterializeBriefArgs): MaterializeBriefResult {
  const rel = args.relPath.replace(/\\/g, "/");
  const conflict = conflictAt(args.checkoutRoot, rel);
  if (conflict !== null) {
    return { ok: false, error: conflict };
  }

  const reviewed = readReviewedBriefBlob(
    args.projectRoot,
    rel,
    args.reviewedCommitIsh,
    args.runGit,
    args.deliveryBranch,
  );
  if (reviewed.bytes === null) {
    return {
      ok: false,
      error: `${SOURCE_RECOVERY_REMEDIATION} (${reviewed.error ?? "missing reviewed blob"})`,
    };
  }

  // Prefer an exact reviewed-byte match across retained roots. Do not stop at
  // the first readable stale candidate (#4714 Greptile: first retained masks).
  let retainedBytes: string | null = null;
  let retainedFrom: string | null = null;
  let firstReadable: { bytes: string; from: string } | null = null;
  for (const root of args.retainedRoots) {
    const candidate = resolve(root, rel);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const bytes = readFileSync(candidate, "utf8");
      if (firstReadable === null) {
        firstReadable = { bytes, from: candidate };
      }
      if (bytes === reviewed.bytes) {
        retainedBytes = bytes;
        retainedFrom = candidate;
        break;
      }
    } catch {}
  }
  if (retainedBytes === null || retainedFrom === null) {
    if (firstReadable === null) {
      return {
        ok: false,
        error: `${SOURCE_RECOVERY_REMEDIATION} (no retained dest bytes for ${rel})`,
      };
    }
    retainedBytes = firstReadable.bytes;
    retainedFrom = firstReadable.from;
  }

  // Prefer-A transport admission is exact reviewed bytes only. Immutable
  // projection equality is not a substitute for full-byte match (#4714 R5 /
  // SLizard dead-branch class).
  if (retainedBytes !== reviewed.bytes) {
    return {
      ok: false,
      error:
        `${SOURCE_RECOVERY_REMEDIATION} (retained bytes do not exactly match reviewed ` +
        `blob ${reviewed.source ?? rel})`,
    };
  }

  const dest = join(args.checkoutRoot, ...rel.split("/"));
  try {
    containedWrite({
      root: args.checkoutRoot,
      target: rel,
      data: retainedBytes,
      mode: "replace",
    });
  } catch (err) {
    if (err instanceof ContainedWriteError) {
      return {
        ok: false,
        error: `contained write failed (${err.code}): ${err.message}`,
      };
    }
    return {
      ok: false,
      error: `contained write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    path: dest,
    source: `retained:${retainedFrom}==${reviewed.source ?? "reviewed"}`,
  };
}
