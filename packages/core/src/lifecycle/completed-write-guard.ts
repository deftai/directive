/**
 * Refuse newly added completed/ blobs that bypass runTransition (#3679).
 *
 * Historical corpus is advisory (doctor). New work in the change set is hard
 * (verify:completed-write-guard). Does not read completionProvenance and does
 * not change verify:completed-tracked.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import {
  hasArtifactSuffix,
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
} from "../layout/resolve.js";
import { hasTransitionWrite, LEFTOVER_LAND_PR_REMEDIATION } from "../scope/lifecycle-write.js";
import { resolveDefaultBaseRef, unquoteGitPath } from "../scope-provenance/evaluate.js";

export type CompletedWriteGuardCode = 0 | 1 | 2;

export interface CompletedWriteGuardFinding {
  readonly relPath: string;
  readonly detail: string;
}

export interface CompletedWriteGuardResult {
  readonly code: CompletedWriteGuardCode;
  readonly message: string;
  readonly findings: readonly CompletedWriteGuardFinding[];
}

export interface CompletedWriteGuardOptions {
  readonly baseRef?: string;
  /** Inject added repo-relative POSIX paths (skips git). */
  readonly addedFiles?: readonly string[];
  /** Inject payloads: relPath -> raw JSON. */
  readonly payloads?: ReadonlyMap<string, string>;
}

const COMPLETED_REL_RE = /^(?:xbrief|vbrief)\/completed\/[^/]+$/;

function normalizeRepoRelPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isCompletedArtifactRel(relPath: string): boolean {
  const n = normalizeRepoRelPath(relPath);
  if (!COMPLETED_REL_RE.test(n)) {
    return false;
  }
  const base = n.split("/").pop() ?? "";
  return hasArtifactSuffix(base);
}

function parsePlan(raw: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    const plan = (data as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return null;
    }
    return plan as Record<string, unknown>;
  } catch {
    return null;
  }
}

function gitEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(projectRoot));
  return env;
}

function git(args: string[], projectRoot: string): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(projectRoot),
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    throw new GitCommandError(`git ${args.join(" ")} failed: ${String(e.message)}`);
  }
  if (result.signal !== null && result.signal !== undefined) {
    throw new GitCommandError(`git ${args.join(" ")} killed by signal ${String(result.signal)}`);
  }
  const status = result.status ?? 1;
  const stderr = String(result.stderr ?? "").trim();
  if (status !== 0 && stderr.length > 0) {
    return { status, stdout: `${result.stdout ?? ""}\n${stderr}` };
  }
  return { status, stdout: result.stdout ?? "" };
}

function addedPathsFromNameStatus(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (t.length === 0) {
      continue;
    }
    const parts = t.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("A")) {
      const path = parts[1];
      if (path !== undefined) {
        out.push(unquoteGitPath(path));
      }
    } else if (status.startsWith("R")) {
      const dest = parts[2] ?? parts[1];
      if (dest !== undefined) {
        out.push(unquoteGitPath(dest));
      }
    }
  }
  return out;
}

function discoverAddedFiles(projectRoot: string, baseRef: string): string[] {
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (inside.status !== 0) {
    throw new GitCommandError("not a git working tree");
  }
  let resolved = baseRef;
  if (baseRef === "HEAD" || baseRef === "") {
    const upgraded = resolveDefaultBaseRef(projectRoot);
    if (upgraded === null) {
      throw new GitCommandError(
        "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF)",
      );
    }
    resolved = upgraded;
  }
  const hasBase = git(["rev-parse", "--verify", "-q", resolved], projectRoot).status === 0;
  if (!hasBase) {
    throw new GitCommandError(`base ref '${resolved}' not found; pass --base-ref`);
  }
  const out = new Set<string>();
  const range = resolved.includes("...") ? resolved : `${resolved}...HEAD`;
  const committed = git(["diff", "--name-status", "--diff-filter=AR", range], projectRoot);
  if (committed.status === 0) {
    for (const p of addedPathsFromNameStatus(committed.stdout)) {
      out.add(normalizeRepoRelPath(p));
    }
  }
  const vsHead = git(["diff", "--name-status", "--diff-filter=AR", "HEAD"], projectRoot);
  if (vsHead.status === 0) {
    for (const p of addedPathsFromNameStatus(vsHead.stdout)) {
      out.add(normalizeRepoRelPath(p));
    }
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (untracked.status === 0) {
    for (const line of untracked.stdout.split("\n")) {
      const p = normalizeRepoRelPath(unquoteGitPath(line));
      if (p.length > 0) {
        out.add(p);
      }
    }
  }
  return [...out];
}

type PayloadRead =
  | { readonly kind: "ok"; readonly raw: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly detail: string };

function readPayload(
  projectRoot: string,
  relPath: string,
  payloads: ReadonlyMap<string, string> | undefined,
): PayloadRead {
  const n = normalizeRepoRelPath(relPath);
  const injected = payloads?.get(n);
  if (injected !== undefined) {
    return { kind: "ok", raw: injected };
  }
  const abs = join(projectRoot, n);
  let st: Stats;
  try {
    st = lstatSync(abs);
  } catch {
    return { kind: "missing" };
  }
  if (st.isSymbolicLink()) {
    return {
      kind: "unsafe",
      detail: `${n}: completed/ add is a symlink; refuse without following`,
    };
  }
  if (!st.isFile()) {
    return {
      kind: "unsafe",
      detail: `${n}: completed/ add is not a regular file; refuse without reading`,
    };
  }
  try {
    return { kind: "ok", raw: readFileSync(abs, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Hard check: newly added completed/ artifacts must show runTransition evidence.
 */
export function evaluateCompletedWriteGuard(
  projectRoot: string,
  options: CompletedWriteGuardOptions = {},
): CompletedWriteGuardResult {
  const root = resolve(projectRoot);
  let added: readonly string[];
  try {
    if (options.addedFiles !== undefined) {
      added = options.addedFiles.map(normalizeRepoRelPath);
    } else {
      const inside = git(["rev-parse", "--is-inside-work-tree"], root);
      if (inside.status !== 0 || inside.stdout.trim() !== "true") {
        return {
          code: 0,
          findings: [],
          message: "verify_completed_write_guard: skipped -- not a git working tree.",
        };
      }
      let baseRef = options.baseRef ?? "";
      if (baseRef.length === 0 || baseRef === "HEAD") {
        const resolved = resolveDefaultBaseRef(root);
        if (resolved === null) {
          return {
            code: 2,
            findings: [],
            message:
              "verify_completed_write_guard: no merge-base ref found " +
              "(origin/master|main, DEFT_BASE_REF, or GITHUB_BASE_REF). " +
              "Pass --base-ref. Unguarded completed/ adds cannot be skipped.",
          };
        }
        baseRef = resolved;
      }
      added = discoverAddedFiles(root, baseRef);
    }
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return {
        code: 2,
        findings: [],
        message:
          "verify_completed_write_guard: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      };
    }
    if (err instanceof GitCommandError) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("not a git repository") ||
        msg.includes("outside repository") ||
        msg.includes("not a git working tree")
      ) {
        return {
          code: 0,
          findings: [],
          message: `verify_completed_write_guard: skipped -- not a git working tree (${err.message}).`,
        };
      }
      return {
        code: 2,
        findings: [],
        message: `verify_completed_write_guard: git failed -- ${err.message}`,
      };
    }
    throw err;
  }

  const findings: CompletedWriteGuardFinding[] = [];
  for (const rel of added) {
    if (!isCompletedArtifactRel(rel)) {
      continue;
    }
    const payload = readPayload(root, rel, options.payloads);
    if (payload.kind === "missing") {
      findings.push({
        relPath: rel,
        detail: `${rel}: added under completed/ but unreadable`,
      });
      continue;
    }
    if (payload.kind === "unsafe") {
      findings.push({
        relPath: rel,
        detail: payload.detail,
      });
      continue;
    }
    const plan = parsePlan(payload.raw);
    if (plan === null) {
      findings.push({
        relPath: rel,
        detail: `${rel}: added under completed/ with unreadable plan`,
      });
      continue;
    }
    if (!hasTransitionWrite(plan)) {
      findings.push({
        relPath: rel,
        detail: `${rel}: added under completed/ without a runTransition write`,
      });
    }
  }

  if (findings.length === 0) {
    return {
      code: 0,
      findings: [],
      message: "verify_completed_write_guard: clean -- no unguarded completed/ adds",
    };
  }

  return {
    code: 1,
    findings,
    message:
      `verify_completed_write_guard: ${findings.length} unguarded completed/ add(s) (#3679).\n` +
      findings.map((f) => `  - ${f.detail}`).join("\n") +
      `\n${LEFTOVER_LAND_PR_REMEDIATION}`,
  };
}

export interface CompletedWriteCorpusResult {
  readonly findings: readonly CompletedWriteGuardFinding[];
  readonly scanned: number;
}

function listCompletedArtifactRels(projectRoot: string): string[] {
  const out: string[] = [];
  for (const dirName of [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR]) {
    const completedDir = join(projectRoot, dirName, "completed");
    if (!existsSync(completedDir)) {
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(completedDir).filter((n) => hasArtifactSuffix(n));
    } catch {
      continue;
    }
    for (const name of names) {
      out.push(`${dirName}/completed/${name}`);
    }
  }
  return out.sort();
}

/**
 * Corpus scan for doctor: artifacts without transition evidence.
 * Caller marks these advisory so historical pre-stamp files do not red doctor.
 */
export function scanCompletedWriteCorpus(projectRoot: string): CompletedWriteCorpusResult {
  const findings: CompletedWriteGuardFinding[] = [];
  const rels = listCompletedArtifactRels(projectRoot);
  for (const rel of rels) {
    const payload = readPayload(resolve(projectRoot), rel, undefined);
    if (payload.kind !== "ok") {
      continue;
    }
    const plan = parsePlan(payload.raw);
    if (plan === null) {
      continue;
    }
    if (!hasTransitionWrite(plan)) {
      findings.push({
        relPath: rel,
        detail: `${rel}: completed/ artifact has no runTransition write (historical advisory)`,
      });
    }
  }
  return { findings, scanned: rels.length };
}
