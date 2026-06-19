import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ENV_PROJECT_REPO, ENV_PROJECT_ROOT, PROJECT_ROOT_SENTINELS } from "./constants.js";

function isProjectRoot(candidate: string): boolean {
  return PROJECT_ROOT_SENTINELS.some((sentinel) => existsSync(resolve(candidate, sentinel)));
}

/** Resolve the consumer project root using the documented precedence. */
export function resolveProjectRoot(cliProjectRoot?: string | null, start?: string): string | null {
  if (cliProjectRoot !== undefined && cliProjectRoot !== null && cliProjectRoot.length > 0) {
    const candidate = resolve(cliProjectRoot);
    return existsSync(candidate) ? candidate : null;
  }

  const envRoot = process.env[ENV_PROJECT_ROOT]?.trim() ?? "";
  if (envRoot.length > 0) {
    const candidate = resolve(envRoot);
    return existsSync(candidate) ? candidate : null;
  }

  const cwd = resolve(start ?? process.cwd());
  let current = cwd;
  while (true) {
    if (isProjectRoot(current)) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/** Accept OWNER/NAME or a full GitHub URL, return OWNER/NAME. */
export function normaliseRepoSlug(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const urlMatch = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\s|$)/);
  if (urlMatch?.[1] && urlMatch[2]) {
    return `${urlMatch[1]}/${urlMatch[2]}`;
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function detectRepoFromGit(projectRoot: string | null): string | null {
  try {
    const stdout = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot ?? undefined,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normaliseRepoSlug(stdout.trim());
  } catch {
    return null;
  }
}

/** Resolve the consumer GitHub repo (OWNER/NAME). */
export function resolveProjectRepo(
  cliRepo: string | null | undefined,
  projectRoot: string | null,
): string | null {
  if (cliRepo !== undefined && cliRepo !== null && cliRepo.length > 0) {
    return normaliseRepoSlug(cliRepo);
  }
  const envRepo = process.env[ENV_PROJECT_REPO]?.trim() ?? "";
  if (envRepo.length > 0) {
    return normaliseRepoSlug(envRepo);
  }
  return detectRepoFromGit(projectRoot);
}

export interface RootRepoResult {
  readonly projectRoot: string;
  readonly repo: string | null;
  readonly exitCode: number;
}

export function resolveRootAndRepo(
  cliProjectRoot: string | null | undefined,
  cliRepo: string | null | undefined,
  requireRepo: boolean,
): RootRepoResult {
  const projectRoot = resolveProjectRoot(cliProjectRoot ?? undefined);
  if (projectRoot === null) {
    return { projectRoot: ".", repo: null, exitCode: 2 };
  }
  if (!requireRepo) {
    return { projectRoot, repo: null, exitCode: 0 };
  }
  const repo = resolveProjectRepo(cliRepo ?? undefined, projectRoot);
  if (repo === null) {
    return { projectRoot, repo: null, exitCode: 2 };
  }
  return { projectRoot, repo, exitCode: 0 };
}

export function formatMissingRootError(): string {
  return (
    "error: cannot determine project root. Pass --project-root PATH, " +
    "set $DEFT_PROJECT_ROOT, or run from inside a directory tree that " +
    "contains vbrief/ or .git/ (#535)."
  );
}

export function formatMissingRepoError(): string {
  return (
    "error: cannot determine repo slug. Pass --repo OWNER/NAME, " +
    "set $DEFT_PROJECT_REPO, or run inside a git checkout with an " +
    "origin remote."
  );
}
