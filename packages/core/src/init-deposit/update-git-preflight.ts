/**
 * Three-state Git preflight for `directive update` (#4158).
 *
 * Read-only: never maps missing git / non-repo / safe.directory / locked
 * index / parse failure to clean. Dirty escape does not waive unreadable.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectOpenClaw } from "../doctor/openclaw-skills.js";
import type { MutationSummary } from "../fs/mutation-ledger.js";

/** Porcelain argv: no index lock, NUL records, all untracked. */
export const UPDATE_GIT_PREFLIGHT_ARGV = [
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
] as const;

export const UPDATE_GIT_REV_PARSE_ARGV = [
  "--no-optional-locks",
  "rev-parse",
  "--is-inside-work-tree",
] as const;

export type UpdateGitKind = "no-repository" | "clean" | "dirty" | "unreadable";

export type UpdateGitErrorCode = "dirty_tree" | "unreadable_repo";

export interface UpdateGitPreflight {
  readonly kind: UpdateGitKind;
  readonly dirty_tree: boolean;
  readonly dirty_files: readonly string[];
  readonly stderr: string;
}

export interface GitExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
}

export type GitExecFn = (args: readonly string[], options: { cwd: string }) => GitExecResult;

export interface ProbeUpdateGitOptions {
  readonly execGit?: GitExecFn;
  readonly gitDirExists?: (projectDir: string) => boolean;
}

export function defaultGitExec(args: readonly string[], options: { cwd: string }): GitExecResult {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout ?? "", stderr: "" };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT") {
      return { status: 127, stdout: "", stderr: e.stderr ?? "", errorCode: "ENOENT" };
    }
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? ""),
    };
  }
}

function defaultGitDirExists(projectDir: string): boolean {
  let dir = resolve(projectDir);
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Parse `git status --porcelain=v1 -z` records.
 * Rename/copy: `XY orig\0dest\0`. Throws on malformed input.
 */
export function parsePorcelainV1Nul(stdout: string): string[] {
  if (stdout.length === 0) return [];
  const parts = stdout.split("\0");
  const files: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i];
    i += 1;
    if (rec === undefined || rec.length === 0) continue;
    if (rec.length < 4 || rec[2] !== " ") {
      throw new Error("porcelain-parse-failure");
    }
    const xy = rec.slice(0, 2);
    files.push(rec.slice(3));
    if (xy.includes("R") || xy.includes("C")) {
      const dest = parts[i];
      i += 1;
      if (dest === undefined || dest.length === 0) {
        throw new Error("porcelain-parse-failure");
      }
      files.push(dest);
    }
  }
  return uniquePaths(files);
}

function notAGitRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

export function probeUpdateGit(
  projectDir: string,
  options: ProbeUpdateGitOptions = {},
): UpdateGitPreflight {
  const execGit = options.execGit ?? defaultGitExec;
  const gitDirExists = options.gitDirExists ?? defaultGitDirExists;
  const cwd = { cwd: projectDir };

  const rev = execGit([...UPDATE_GIT_REV_PARSE_ARGV], cwd);
  if (rev.errorCode === "ENOENT") {
    if (gitDirExists(projectDir)) {
      return {
        kind: "unreadable",
        dirty_tree: false,
        dirty_files: [],
        stderr: rev.stderr.length > 0 ? rev.stderr : "git binary not found",
      };
    }
    return { kind: "no-repository", dirty_tree: false, dirty_files: [], stderr: rev.stderr };
  }

  const inside = rev.status === 0 && rev.stdout.trim() === "true";
  if (!inside) {
    const repoMarker = gitDirExists(projectDir);
    if (!repoMarker && (notAGitRepository(rev.stderr) || rev.status === 0)) {
      return { kind: "no-repository", dirty_tree: false, dirty_files: [], stderr: rev.stderr };
    }
    return {
      kind: "unreadable",
      dirty_tree: false,
      dirty_files: [],
      stderr: rev.stderr,
    };
  }

  const status = execGit([...UPDATE_GIT_PREFLIGHT_ARGV], cwd);
  if (status.errorCode === "ENOENT" || status.status !== 0) {
    return {
      kind: "unreadable",
      dirty_tree: false,
      dirty_files: [],
      stderr: status.stderr.length > 0 ? status.stderr : "git status failed",
    };
  }

  try {
    const dirty_files = parsePorcelainV1Nul(status.stdout);
    if (dirty_files.length === 0) {
      return { kind: "clean", dirty_tree: false, dirty_files: [], stderr: status.stderr };
    }
    return { kind: "dirty", dirty_tree: true, dirty_files, stderr: status.stderr };
  } catch {
    return {
      kind: "unreadable",
      dirty_tree: false,
      dirty_files: [],
      stderr: status.stderr.length > 0 ? status.stderr : "porcelain-parse-failure",
    };
  }
}

export function destPlanIsEmpty(summary: MutationSummary): boolean {
  return summary.mutations.length === 0;
}

export function outOfRootWriterMightFire(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectOpenClaw(env).detected;
}

export function gitPreflightRequired(destEmpty: boolean, outOfRootWriter: boolean): boolean {
  return !destEmpty || outOfRootWriter;
}

export const DIRTY_TREE_REFUSAL_MESSAGE =
  "directive update: working tree is dirty; refuse before writes. " +
  "Use --allow-dirty-no-stage to apply without automatic git add.";

export const UNREADABLE_REPO_REFUSAL_MESSAGE =
  "directive update: Git state is unreadable (repository present); refuse before writes. " +
  "--allow-dirty-no-stage does not waive this.";

export interface UpdateGitGateDecision {
  readonly action: "proceed" | "refuse";
  readonly error_code?: UpdateGitErrorCode;
  readonly message?: string;
  readonly preflight: UpdateGitPreflight;
}

export function decideUpdateGitGate(input: {
  readonly preflight: UpdateGitPreflight;
  readonly required: boolean;
  readonly allowDirtyNoStage: boolean;
}): UpdateGitGateDecision {
  const { preflight, required, allowDirtyNoStage } = input;
  if (!required) {
    return { action: "proceed", preflight };
  }
  if (preflight.kind === "no-repository" || preflight.kind === "clean") {
    return { action: "proceed", preflight };
  }
  if (preflight.kind === "unreadable") {
    return {
      action: "refuse",
      error_code: "unreadable_repo",
      message: UNREADABLE_REPO_REFUSAL_MESSAGE,
      preflight,
    };
  }
  if (allowDirtyNoStage) {
    return { action: "proceed", preflight };
  }
  return {
    action: "refuse",
    error_code: "dirty_tree",
    message: DIRTY_TREE_REFUSAL_MESSAGE,
    preflight,
  };
}

export class UnknownUpdateFlagError extends Error {
  readonly flag: string;

  constructor(flag: string) {
    const notThisEscape =
      flag === "--allow-dirty" ||
      flag === "--force" ||
      flag === "/allow-dirty" ||
      flag === "/force";
    super(
      notThisEscape
        ? `${flag} is not the dirty-update escape; use --allow-dirty-no-stage`
        : `unknown flag: ${flag}`,
    );
    this.name = "UnknownUpdateFlagError";
    this.flag = flag;
  }
}

const UPDATE_FLAGS_TAKING_VALUE = new Set(["--repo-root", "/repo-root"]);

const KNOWN_UPDATE_FLAGS = new Set([
  "--json",
  "/json",
  "--yes",
  "--non-interactive",
  "/yes",
  "/non-interactive",
  "--repo-root",
  "/repo-root",
  "--upgrade",
  "/upgrade",
  "--dry-run",
  "/dry-run",
  "--plan",
  "/plan",
  "--allow-dirty-no-stage",
  "/allow-dirty-no-stage",
  "-h",
  "--help",
  "/help",
  "/h",
]);

export function assertKnownUpdateFlags(args: readonly string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (UPDATE_FLAGS_TAKING_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-") && !arg.startsWith("/")) continue;
    if (!KNOWN_UPDATE_FLAGS.has(arg)) {
      throw new UnknownUpdateFlagError(arg);
    }
  }
}
