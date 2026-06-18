import { execFileSync } from "node:child_process";

/** Raised when `git` is not on PATH (caller maps to exit 2). */
export class GitNotFoundError extends Error {}

/** Raised when a `git` invocation exits non-zero (caller maps to exit 2). */
export class GitCommandError extends Error {}

function runGit(args: string[], projectRoot: string): string {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : String(e.message ?? err);
    throw new GitCommandError(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

function splitLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.trim().length > 0);
}

/** Return `git ls-files` output as a list of POSIX-form rel paths. */
export function gitTrackedFiles(projectRoot: string): string[] {
  return splitLines(runGit(["ls-files"], projectRoot));
}

/** Return `git diff --cached --name-only` output as POSIX-form rel paths. */
export function gitStagedFiles(projectRoot: string): string[] {
  return splitLines(runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], projectRoot));
}
