/**
 * Bounded retained-brief transport into the isolated lifecycle checkout (#4714 R5).
 * Materialize only when exact bytes match a reachable reviewed product/evidence blob.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectionsEqual } from "./immutable-projection.js";
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

/** Read brief bytes from a commit-ish path (merge SHA or origin tip history). */
export function readReviewedBriefBlob(
  projectRoot: string,
  relPath: string,
  commitIsh: string | null | undefined,
  runGit: typeof runText,
): ReviewedBriefLookup {
  const rel = relPath.replace(/\\/g, "/");
  if (typeof commitIsh === "string" && commitIsh.trim().length > 0) {
    const shown = runGit(["git", "show", `${commitIsh.trim()}:${rel}`], { cwd: projectRoot });
    if (shown.returncode === 0 && shown.stdout.length > 0) {
      return { bytes: shown.stdout, source: `${commitIsh.trim()}:${rel}`, error: null };
    }
  }
  // Fall back to tip history: last commit that touched the path on origin.
  const log = runGit(["git", "log", "-1", "--format=%H", `origin/HEAD`, "--", rel], {
    cwd: projectRoot,
  });
  if (log.returncode === 0 && log.stdout.trim().length > 0) {
    const sha = log.stdout.trim();
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
  );
  if (reviewed.bytes === null) {
    return {
      ok: false,
      error: `${SOURCE_RECOVERY_REMEDIATION} (${reviewed.error ?? "missing reviewed blob"})`,
    };
  }

  let retainedBytes: string | null = null;
  let retainedFrom: string | null = null;
  for (const root of args.retainedRoots) {
    const candidate = resolve(root, rel);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      retainedBytes = readFileSync(candidate, "utf8");
      retainedFrom = candidate;
      break;
    } catch {}
  }
  if (retainedBytes === null || retainedFrom === null) {
    return {
      ok: false,
      error: `${SOURCE_RECOVERY_REMEDIATION} (no retained dest bytes for ${rel})`,
    };
  }

  if (retainedBytes !== reviewed.bytes) {
    // Allow evidence-only divergence when immutable projection matches AND
    // retained is a strict superset path — Prefer-A still requires exact full
    // bytes including evidence for transport admission.
    try {
      const retainedJson = JSON.parse(retainedBytes) as unknown;
      const reviewedJson = JSON.parse(reviewed.bytes) as unknown;
      if (!projectionsEqual(retainedJson, reviewedJson) || retainedBytes !== reviewed.bytes) {
        return {
          ok: false,
          error:
            `${SOURCE_RECOVERY_REMEDIATION} (retained bytes do not exactly match reviewed ` +
            `blob ${reviewed.source ?? rel})`,
        };
      }
    } catch {
      return {
        ok: false,
        error: `${SOURCE_RECOVERY_REMEDIATION} (retained/reviewed brief JSON unreadable)`,
      };
    }
  }

  const dest = join(args.checkoutRoot, ...rel.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, retainedBytes, "utf8");
  return {
    ok: true,
    path: dest,
    source: `retained:${retainedFrom}==${reviewed.source ?? "reviewed"}`,
  };
}
