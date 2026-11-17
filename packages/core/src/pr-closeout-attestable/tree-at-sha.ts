/**
 * Read active/running briefs from a commit's tree, not the working tree (#6295 item 7).
 *
 * `verify:pr-closeout-attestable` evaluates the tree that merges: the PR head SHA
 * read from REST. Reading git objects means local HEAD, a linked worktree, and
 * uncommitted lifecycle edits no longer matter. The reader never fetches; a head
 * commit absent from the local object store is a config error with a named
 * recovery.
 */

import { hasArtifactSuffix } from "../layout/resolve.js";
import { runningPlanFromJsonText } from "../orphan-active/running-briefs.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";

/** Lifecycle layout directory read at the SHA (xbrief/ only; see resolveLifecycleLayout). */
export const TREE_LIFECYCLE_DIR = "xbrief" as const;

/** One running brief read from a commit tree. */
export interface TreeBrief {
  /** Repository-relative POSIX path, e.g. `xbrief/active/x.xbrief.json`. */
  readonly relPath: string;
  readonly plan: Record<string, unknown>;
}

export type TreeAtShaResult =
  | { readonly status: "ok"; readonly hasLayout: boolean; readonly briefs: readonly TreeBrief[] }
  | { readonly status: "missing-object"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

export type TreeAtShaReader = (projectRoot: string, sha: string) => TreeAtShaResult;

const SHA_RE = /^[0-9a-f]{7,64}$/i;

interface LsTreeEntry {
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

/** Parse `git ls-tree -z` output: `<mode> SP <type> SP <oid> TAB <path> NUL`. */
export function parseLsTreeZ(stdout: string): LsTreeEntry[] {
  const out: LsTreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta.length < 3) continue;
    out.push({ type: meta[1] as string, oid: meta[2] as string, path: record.slice(tab + 1) });
  }
  return out;
}

/** List running briefs under `xbrief/active/` in the tree of `sha`. */
export function readActiveRunningBriefsAtSha(
  projectRoot: string,
  sha: string,
  git: GitRunner = defaultGitRunner,
): TreeAtShaResult {
  const commit = sha.trim();
  if (!SHA_RE.test(commit)) {
    return { status: "error", message: `not a commit SHA: ${JSON.stringify(sha)}` };
  }
  const present = git(projectRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  if (present.code !== 0) {
    return {
      status: "missing-object",
      message: `commit ${commit} is not in the local object store at ${projectRoot}`,
    };
  }
  const layout = git(projectRoot, ["ls-tree", "-z", commit, "--", TREE_LIFECYCLE_DIR]);
  if (layout.code !== 0) {
    return {
      status: "error",
      message: `git ls-tree ${commit} ${TREE_LIFECYCLE_DIR} exited ${layout.code}: ${layout.stderr.trim()}`,
    };
  }
  const hasLayout = parseLsTreeZ(layout.stdout).some(
    (e) => e.type === "tree" && e.path === TREE_LIFECYCLE_DIR,
  );
  if (!hasLayout) {
    return { status: "ok", hasLayout: false, briefs: [] };
  }
  const activeDir = `${TREE_LIFECYCLE_DIR}/active/`;
  const listing = git(projectRoot, ["ls-tree", "-z", commit, "--", activeDir]);
  if (listing.code !== 0) {
    return {
      status: "error",
      message: `git ls-tree ${commit} ${activeDir} exited ${listing.code}: ${listing.stderr.trim()}`,
    };
  }
  const briefs: TreeBrief[] = [];
  for (const entry of parseLsTreeZ(listing.stdout)) {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (entry.type !== "blob" || !hasArtifactSuffix(name)) continue;
    const blob = git(projectRoot, ["cat-file", "blob", entry.oid]);
    if (blob.code !== 0) {
      return {
        status: "error",
        message: `git cat-file blob ${entry.oid} (${entry.path}) exited ${blob.code}: ${blob.stderr.trim()}`,
      };
    }
    const plan = runningPlanFromJsonText(blob.stdout);
    if (plan !== null) briefs.push({ relPath: entry.path, plan });
  }
  briefs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { status: "ok", hasLayout: true, briefs };
}
