/**
 * Context note for verified clause rows (#6374 item 4).
 *
 * For a brief in a non-terminal lifecycle folder that is committed at its
 * current path, a `verified` row whose bound file is identical in the working
 * tree to its content at the parent of the commit that added the brief at that
 * path gets a note in its detail. The note is context only: it never changes a
 * row outcome, the first line, the resolution label or the exit code. Whether
 * such evidence should still count as verified is #6408, not this module.
 *
 * A brief that is not committed at its current path, a brief in a terminal
 * folder and a checkout outside git get no note and no extra line.
 */
import { relative, resolve } from "node:path";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import type { ClauseWalkReport, ClauseWalkResult } from "./clauses.js";

export const ENTRY_BASELINE_NOTE =
  "file unchanged since the commit before this brief entered this folder";

const LIFECYCLE_ROOTS = new Set(["xbrief", "vbrief"]);
const NON_TERMINAL_FOLDERS = new Set(["proposed", "pending", "active"]);

/** Project-relative POSIX path, or null when the path is outside the project. */
function projectRelative(projectRoot: string, path: string): string | null {
  const rel = relative(resolve(projectRoot), resolve(projectRoot, path)).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) {
    return null;
  }
  return rel;
}

/**
 * The parent of the commit that added the brief at its current path, or null
 * when no note applies (terminal folder, not committed at this path, root
 * commit, outside git).
 */
export function resolveEntryBaselineCommit(
  projectRoot: string,
  xbriefPath: string,
  git: GitRunner = defaultGitRunner,
): string | null {
  const rel = projectRelative(projectRoot, xbriefPath);
  if (rel === null) {
    return null;
  }
  const parts = rel.split("/");
  if (
    parts.length !== 3 ||
    !LIFECYCLE_ROOTS.has(parts[0] ?? "") ||
    !NON_TERMINAL_FOLDERS.has(parts[1] ?? "")
  ) {
    return null;
  }
  // Committed at its current path: HEAD holds a blob there. `./` makes the
  // tree path relative to projectRoot, which may sit below the repository root.
  if (git(projectRoot, ["cat-file", "-e", `HEAD:./${rel}`]).code !== 0) {
    return null;
  }
  // A lifecycle move is a rename; --no-renames reports it as an add at the new path.
  const added = git(projectRoot, [
    "log",
    "--no-renames",
    "--diff-filter=A",
    "--format=%H",
    "-n",
    "1",
    "--",
    rel,
  ]);
  const sha = added.code === 0 ? added.stdout.trim().split(/\r?\n/)[0]?.trim() : "";
  if (sha === undefined || !/^[0-9a-f]{7,64}$/.test(sha)) {
    return null;
  }
  const parent = git(projectRoot, ["rev-parse", "--verify", "--quiet", `${sha}^`]);
  const parentSha = parent.code === 0 ? parent.stdout.trim() : "";
  return /^[0-9a-f]{7,64}$/.test(parentSha) ? parentSha : null;
}

/** True when the working-tree file has the same blob id as at `commit`. */
function unchangedSince(projectRoot: string, rel: string, commit: string, git: GitRunner): boolean {
  const before = git(projectRoot, ["rev-parse", "--verify", "--quiet", `${commit}:./${rel}`]);
  if (before.code !== 0) {
    return false;
  }
  const now = git(projectRoot, ["hash-object", "--", rel]);
  if (now.code !== 0) {
    return false;
  }
  const a = before.stdout.trim();
  const b = now.stdout.trim();
  return a.length > 0 && a === b;
}

/**
 * Add the context note to each qualifying `verified` row. Returns the report
 * unchanged when no note applies; outcomes and counts never change.
 */
export function annotateUnchangedSinceEntry(
  report: Omit<ClauseWalkReport, "message"> & { readonly message?: string },
  input: {
    readonly projectRoot: string;
    readonly xbriefPath: string | null | undefined;
    readonly git?: GitRunner;
  },
): Omit<ClauseWalkReport, "message"> & { readonly message?: string } {
  if (report.verified.length === 0) {
    return report;
  }
  const xbriefPath = input.xbriefPath?.trim() ?? "";
  if (xbriefPath.length === 0) {
    return report;
  }
  const git = input.git ?? defaultGitRunner;
  const baseline = resolveEntryBaselineCommit(input.projectRoot, xbriefPath, git);
  if (baseline === null) {
    return report;
  }
  let changed = false;
  const clauses: ClauseWalkResult[] = report.clauses.map((row) => {
    if (row.outcome !== "verified" || row.artifact_path === null) {
      return row;
    }
    const rel = projectRelative(input.projectRoot, row.artifact_path);
    if (rel === null || !unchangedSince(input.projectRoot, rel, baseline, git)) {
      return row;
    }
    changed = true;
    return { ...row, detail: `${row.detail}; ${ENTRY_BASELINE_NOTE}` };
  });
  if (!changed) {
    return report;
  }
  return {
    ...report,
    clauses,
    failed: clauses.filter((row) => row.outcome === "failed"),
    unverifiable: clauses.filter((row) => row.outcome === "unverifiable"),
    verified: clauses.filter((row) => row.outcome === "verified"),
  };
}
