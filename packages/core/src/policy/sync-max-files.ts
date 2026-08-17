/**
 * Typed plan.policy.syncMaxFiles (#3390 / #3377 Wave 2).
 *
 * One integer. Unset is 400. `--max-files` overrides one run and does not
 * write policy. Set 100 if SLizard is a required check. Do not probe
 * reviewer APIs and do not encode vendor limits as code constants.
 *
 * File-count warn uses the shared #3388 detector. Count is
 * `git diff --name-only origin/<dest>...origin/<source>`. No warn when
 * the detector says this is not a sync. The #3391 verb consumes
 * evaluateSyncMaxFilesWarn and the maxFiles one-run override.
 */

import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { type BranchSyncDetection, detectBranchSyncFromProject } from "./branch-sync.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_SYNC_MAX_FILES = "plan.policy.syncMaxFiles";
export const FIELD_SYNC_MAX_FILES_CLI_ALIAS = "syncMaxFiles";

/** Unset threshold. Not a vendor limit. */
export const DEFAULT_SYNC_MAX_FILES = 400;

/**
 * Operator docs for the threshold. Recommendation only — not a coded
 * Greptile or SLizard constant.
 */
export const SYNC_MAX_FILES_DOCS =
  "Unset is 400. Set plan.policy.syncMaxFiles to 100 if SLizard is a required check.";

export type SyncMaxFilesSource = "typed" | "default" | "default-on-error" | "flag";

/** Provenance printed in the warn: default vs policy vs one-run flag. */
export type SyncMaxFilesProvenance = "default" | "policy" | "flag";

export interface SyncMaxFilesResolved {
  readonly maxFiles: number;
  readonly source: SyncMaxFilesSource;
  readonly provenance: SyncMaxFilesProvenance;
  readonly error: string | null;
}

export type SyncMaxFilesWarnReason = "not-sync" | "within-limit" | "exceeds" | "diff-failed";

export interface SyncMaxFilesWarnResult {
  readonly warn: boolean;
  readonly reason: SyncMaxFilesWarnReason;
  readonly count: number | null;
  readonly threshold: number;
  readonly provenance: SyncMaxFilesProvenance;
  readonly dest: string;
  readonly source: string;
  readonly message: string;
}

function isValidMaxFiles(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0;
}

/** Parse `--max-files`. Invalid or absent values are ignored. */
export function parseMaxFilesFlag(raw: unknown): number | null {
  if (!isValidMaxFiles(raw)) return null;
  return raw;
}

/**
 * Resolve the file-count threshold.
 *
 * `--max-files` (maxFiles) wins for this call only and is never written.
 */
export function resolveSyncMaxFiles(
  projectRoot?: string | null,
  maxFiles?: number | null,
): SyncMaxFilesResolved {
  const flag = parseMaxFilesFlag(maxFiles);
  if (flag !== null) {
    return {
      maxFiles: flag,
      source: "flag",
      provenance: "flag",
      error: null,
    };
  }

  if (projectRoot !== undefined && projectRoot !== null && projectRoot.length > 0) {
    const [data, err] = loadProjectDefinition(projectRoot);
    if (data !== null) {
      const policyBlock = readPlanPolicy(data.plan);
      if (
        typeof policyBlock === "object" &&
        policyBlock !== null &&
        !Array.isArray(policyBlock) &&
        "syncMaxFiles" in policyBlock
      ) {
        const raw = (policyBlock as Record<string, unknown>).syncMaxFiles;
        if (isValidMaxFiles(raw)) {
          return {
            maxFiles: raw,
            source: "typed",
            provenance: "policy",
            error: null,
          };
        }
        return {
          maxFiles: DEFAULT_SYNC_MAX_FILES,
          source: "default-on-error",
          provenance: "default",
          error: `${FIELD_SYNC_MAX_FILES} must be a non-negative integer; got ${String(raw)}`,
        };
      }
    } else if (err !== null && err.length > 0) {
      return {
        maxFiles: DEFAULT_SYNC_MAX_FILES,
        source: "default",
        provenance: "default",
        error: err,
      };
    }
  }

  return {
    maxFiles: DEFAULT_SYNC_MAX_FILES,
    source: "default",
    provenance: "default",
    error: null,
  };
}

export interface SyncMaxFilesPolicyField {
  readonly name: typeof FIELD_SYNC_MAX_FILES;
  readonly current: number;
  readonly default: number;
  readonly source: string;
}

/** Inspector row for `task policy:show --field=syncMaxFiles`. */
export function inspectSyncMaxFiles(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): SyncMaxFilesPolicyField {
  const resolved = resolveSyncMaxFiles(projectRoot);
  return {
    name: FIELD_SYNC_MAX_FILES,
    current: resolved.maxFiles,
    default: DEFAULT_SYNC_MAX_FILES,
    source: resolved.source === "flag" ? "default" : resolved.source,
  };
}

/** Count files in `origin/<dest>...origin/<source>`. */
export function countSyncChangedFiles(options: {
  readonly dest: string;
  readonly source: string;
  readonly projectRoot: string;
  readonly runGit?: GitRunner;
}): { readonly count: number | null; readonly error: string | null } {
  const dest = options.dest.trim();
  const source = options.source.trim();
  if (dest.length === 0 || source.length === 0) {
    return { count: null, error: "empty dest or source" };
  }
  const runGit = options.runGit ?? defaultGitRunner;
  runGit(options.projectRoot, ["fetch", "--quiet", "origin", dest]);
  const ranged = `origin/${dest}...origin/${source}`;
  const diffed = runGit(options.projectRoot, ["diff", "--name-only", ranged]);
  if (diffed.code !== 0) {
    return { count: null, error: diffed.stderr || `git diff failed for ${ranged}` };
  }
  const files = diffed.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return { count: files.length, error: null };
}

export function formatSyncMaxFilesWarn(options: {
  readonly count: number;
  readonly threshold: number;
  readonly provenance: SyncMaxFilesProvenance;
  readonly dest: string;
  readonly source: string;
}): string {
  return (
    `file-count warn: ${options.count} files origin/${options.dest}...origin/${options.source} ` +
    `exceeds syncMaxFiles=${options.threshold} (${options.provenance})`
  );
}

export interface EvaluateSyncMaxFilesWarnInput {
  readonly projectRoot: string;
  readonly prBase: string;
  readonly headSha: string;
  /** `--max-files` one-run override. Does not write policy. */
  readonly maxFiles?: number | null;
  readonly runGit?: GitRunner;
  /** Optional precomputed detector result. */
  readonly sync?: BranchSyncDetection;
}

/**
 * Warn when a detected sync exceeds syncMaxFiles.
 *
 * No warn when the shared detector says this is not a sync.
 */
export function evaluateSyncMaxFilesWarn(
  input: EvaluateSyncMaxFilesWarnInput,
): SyncMaxFilesWarnResult {
  const runGit = input.runGit ?? defaultGitRunner;
  const sync =
    input.sync ??
    detectBranchSyncFromProject({
      projectRoot: input.projectRoot,
      prBase: input.prBase,
      headSha: input.headSha,
      runGit,
    });
  const resolved = resolveSyncMaxFiles(input.projectRoot, input.maxFiles);
  const empty: SyncMaxFilesWarnResult = {
    warn: false,
    reason: "not-sync",
    count: null,
    threshold: resolved.maxFiles,
    provenance: resolved.provenance,
    dest: sync.dest,
    source: sync.source,
    message: "",
  };
  if (!sync.isSync) {
    return empty;
  }

  const counted = countSyncChangedFiles({
    dest: sync.dest,
    source: sync.source,
    projectRoot: input.projectRoot,
    runGit,
  });
  if (counted.count === null) {
    return {
      ...empty,
      reason: "diff-failed",
      message: counted.error ?? "git diff failed",
    };
  }

  if (counted.count <= resolved.maxFiles) {
    return {
      warn: false,
      reason: "within-limit",
      count: counted.count,
      threshold: resolved.maxFiles,
      provenance: resolved.provenance,
      dest: sync.dest,
      source: sync.source,
      message: "",
    };
  }

  return {
    warn: true,
    reason: "exceeds",
    count: counted.count,
    threshold: resolved.maxFiles,
    provenance: resolved.provenance,
    dest: sync.dest,
    source: sync.source,
    message: formatSyncMaxFilesWarn({
      count: counted.count,
      threshold: resolved.maxFiles,
      provenance: resolved.provenance,
      dest: sync.dest,
      source: sync.source,
    }),
  };
}
