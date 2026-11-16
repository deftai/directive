/**
 * Merge-commit excuse for the prospective scope-cover check (#6379 item 6).
 *
 * When `MERGE_HEAD` is present at `git commit`, a staged product path outside
 * the story's `file_scope` is excused only when its staged entry (mode and
 * blob, or deletion) is identical to that path's entry in a `MERGE_HEAD`
 * commit that is an ancestor of the fetched delivery ref. Every other staged
 * path is checked as before. When `MERGE_HEAD` or the delivery ref cannot be
 * read, no path is excused. This module never widens `file_scope`: it only
 * names staged paths that arrive unchanged from the default branch.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import type { StagedIndexEntry } from "./planning-publication.js";

export interface MergeCommitExcuseInput {
  readonly projectRoot: string;
  /** Project-relative POSIX paths the scope check would refuse. */
  readonly paths: readonly string[];
  /** Raw staged index entries of the same index (absent: nothing is excused). */
  readonly stagedEntries: readonly StagedIndexEntry[] | undefined;
  /** The fence's delivery ref (for example `origin/master`); must be remote-tracking. */
  readonly deliveryRef: string | null | undefined;
  readonly runGit?: GitRunner;
}

export interface MergeCommitExcuseResult {
  readonly excused: readonly string[];
  readonly remaining: readonly string[];
}

/** SHA-1 (40 hex) or SHA-256 (64 hex) object ids. */
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function normalizeRel(path: string): string {
  return path.replace(/\r/g, "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isDeletion(entry: StagedIndexEntry): boolean {
  return entry.kind === "D" || (/^0+$/.test(entry.mode) && /^0+$/.test(entry.blob));
}

/** `MERGE_HEAD` commit ids of this checkout, or null when there is no merge. */
function readMergeHeads(projectRoot: string, runGit: GitRunner): string[] | null {
  const located = runGit(projectRoot, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  const rel = located.stdout.trim();
  if (located.code !== 0 || rel.length === 0) return null;
  const abs = resolve(projectRoot, rel);
  if (!existsSync(abs)) return null;
  try {
    const heads = readFileSync(abs, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => SHA_RE.test(line));
    return heads.length > 0 ? heads : null;
  } catch {
    return null;
  }
}

/** True only for a ref that resolves to a remote-tracking ref (a fetched ref). */
function isFetchedRef(projectRoot: string, ref: string, runGit: GitRunner): boolean {
  const full = runGit(projectRoot, ["rev-parse", "--symbolic-full-name", ref]);
  return full.code === 0 && full.stdout.trim().startsWith("refs/remotes/");
}

/**
 * `path -> "<mode> <oid>"` for the wanted paths in one commit's tree. One
 * recursive listing per commit, filtered here, so no pathspec reaches git.
 */
function treeEntries(
  projectRoot: string,
  commit: string,
  paths: readonly string[],
  runGit: GitRunner,
): Map<string, string> | null {
  const wanted = new Set(paths);
  const listed = runGit(projectRoot, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (listed.code !== 0) return null;
  const out = new Map<string, string>();
  for (const record of listed.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    // The git runner decodes `-z` output as latin1; staged paths are UTF-8.
    const path = Buffer.from(record.slice(tab + 1), "latin1").toString("utf8");
    if (!wanted.has(path)) continue;
    const [mode, , oid] = record.slice(0, tab).split(" ");
    if (mode === undefined || oid === undefined) continue;
    out.set(path, `${mode} ${oid}`);
  }
  return out;
}

/**
 * Split `paths` into those excused as unchanged arrivals from an authoritative
 * `MERGE_HEAD` commit and those that stay under the scope check.
 */
export function excuseMergeArrivals(input: MergeCommitExcuseInput): MergeCommitExcuseResult {
  const none: MergeCommitExcuseResult = { excused: [], remaining: [...input.paths] };
  const deliveryRef = input.deliveryRef?.trim() ?? "";
  if (input.paths.length === 0 || input.stagedEntries === undefined || deliveryRef.length === 0) {
    return none;
  }
  const runGit = input.runGit ?? defaultGitRunner;
  const root = input.projectRoot;
  try {
    const heads = readMergeHeads(root, runGit);
    if (heads === null || !isFetchedRef(root, deliveryRef, runGit)) return none;
    const authoritative = heads.filter(
      (sha) => runGit(root, ["merge-base", "--is-ancestor", sha, deliveryRef]).code === 0,
    );
    if (authoritative.length === 0) return none;

    const staged = new Map<string, StagedIndexEntry>();
    for (const entry of input.stagedEntries) staged.set(normalizeRel(entry.path), entry);

    const excused = new Set<string>();
    for (const head of authoritative) {
      const pending = input.paths.filter((path) => !excused.has(path) && staged.has(path));
      if (pending.length === 0) break;
      const tree = treeEntries(root, head, pending, runGit);
      if (tree === null) continue;
      for (const path of pending) {
        const entry = staged.get(path);
        if (entry === undefined) continue;
        const theirs = tree.get(path);
        const same = isDeletion(entry)
          ? theirs === undefined
          : theirs === `${entry.mode} ${entry.blob}`;
        if (same) excused.add(path);
      }
    }
    return {
      excused: input.paths.filter((path) => excused.has(path)),
      remaining: input.paths.filter((path) => !excused.has(path)),
    };
  } catch {
    return none;
  }
}
