/**
 * Completed basenames the check walk may skip for D7 (#4844).
 *
 * A name already at the base ref, and not an add or rename destination
 * in the change set, does not fail the gate. Discovery failure does not
 * exempt: callers keep the hard filename error. This is not a completed/
 * skip and not a warning.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { hasArtifactSuffix } from "../layout/resolve.js";

const COMPLETED_FILE_RE = /^(?:xbrief|vbrief)\/completed\/[^/]+$/;

interface GitResult {
  readonly status: number;
  readonly stdout: string;
}

function gitEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(projectRoot));
  return env;
}

function git(args: readonly string[], projectRoot: string): GitResult | null {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(projectRoot),
  });
  if (result.error !== undefined || result.status === null) {
    return null;
  }
  return { status: result.status, stdout: result.stdout ?? "" };
}

function normalizeRepoRelPath(raw: string): string {
  let text = raw.replace(/\r$/, "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Default-branch ref. `HEAD` is not a landed base (#4844). */
function resolveBaseRef(projectRoot: string): string | null {
  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  const explicit = [
    process.env.DEFT_BASE_REF,
    githubBase !== undefined && githubBase.length > 0 ? `origin/${githubBase}` : undefined,
    githubBase,
  ];
  const candidates: string[] = [];
  for (const value of explicit) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === "HEAD") continue;
    candidates.push(trimmed);
  }
  candidates.push("origin/master", "origin/main", "master", "main");
  for (const candidate of candidates) {
    const verified = git(["rev-parse", "--verify", "-q", candidate], projectRoot);
    if (verified !== null && verified.status === 0) {
      return candidate;
    }
  }
  return null;
}

function collectAddOrRenameDests(stdout: string, into: Set<string>): void {
  for (const line of stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("A")) {
      const path = parts[1];
      if (path !== undefined) into.add(normalizeRepoRelPath(path));
    } else if (status.startsWith("R") || status.startsWith("C")) {
      const dest = parts[2] ?? parts[1];
      if (dest !== undefined) into.add(normalizeRepoRelPath(dest));
    }
  }
}

function changeSetAddOrRenameDests(projectRoot: string, baseRef: string): Set<string> | null {
  const dests = new Set<string>();
  const range = baseRef.includes("...") ? baseRef : `${baseRef}...HEAD`;
  const committed = git(["diff", "-M", "--name-status", "--diff-filter=AR", range], projectRoot);
  if (committed === null || committed.status !== 0) return null;
  collectAddOrRenameDests(committed.stdout, dests);
  const vsHead = git(["diff", "-M", "--name-status", "--diff-filter=AR", "HEAD"], projectRoot);
  if (vsHead === null || vsHead.status !== 0) return null;
  collectAddOrRenameDests(vsHead.stdout, dests);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (untracked === null || untracked.status !== 0) return null;
  for (const line of untracked.stdout.split("\n")) {
    const path = normalizeRepoRelPath(line);
    if (path.length > 0) dests.add(path);
  }
  return dests;
}

function isCompletedArtifact(relPath: string): boolean {
  if (!COMPLETED_FILE_RE.test(relPath)) return false;
  const slash = relPath.lastIndexOf("/");
  const name = slash === -1 ? relPath : relPath.slice(slash + 1);
  return hasArtifactSuffix(name);
}

/**
 * Repo-relative completed paths whose basename already landed and that
 * the change set did not add or rename. Null when git cannot prove it.
 */
export function landedUnchangedCompletedPaths(projectRoot: string): ReadonlySet<string> | null {
  const root = resolve(projectRoot);
  const inside = git(["rev-parse", "--is-inside-work-tree"], root);
  if (inside === null || inside.status !== 0 || inside.stdout.trim() !== "true") {
    return null;
  }
  const baseRef = resolveBaseRef(root);
  if (baseRef === null) return null;
  const tree = git(
    ["ls-tree", "-r", "--name-only", baseRef, "--", "xbrief/completed", "vbrief/completed"],
    root,
  );
  if (tree === null || tree.status !== 0) return null;
  const landed = new Set<string>();
  for (const line of tree.stdout.split("\n")) {
    const relPath = normalizeRepoRelPath(line);
    if (isCompletedArtifact(relPath)) landed.add(relPath);
  }
  const changed = changeSetAddOrRenameDests(root, baseRef);
  if (changed === null) return null;
  for (const dest of changed) landed.delete(dest);
  return landed;
}
