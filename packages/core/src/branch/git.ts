import { execFileSync } from "node:child_process";

/** Raised when ``git`` is not on PATH (#777 Greptile P2 fix). */
export class GitNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitNotFoundError";
  }
}

export interface BranchState {
  readonly branch: string;
  readonly detached: boolean;
}

/**
 * Return current branch via `git symbolic-ref --quiet --short HEAD`.
 * Maps to detached HEAD when symbolic-ref fails; raises GitNotFoundError when
 * the git executable is missing.
 */
export function currentBranch(projectRoot: string): BranchState {
  try {
    const stdout = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const branch = stdout.trim();
    if (branch.length > 0) {
      return { branch, detached: false };
    }
    return { branch: "", detached: true };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: string | Buffer };
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("git executable not found on PATH");
    }
    if (typeof e.status === "number" && e.status === 127) {
      const stderr = typeof e.stderr === "string" ? e.stderr : String(e.stderr ?? "");
      if (stderr.includes("git executable not found")) {
        throw new GitNotFoundError(stderr.trim() || "git executable not found on PATH");
      }
    }
    // Detached HEAD (symbolic-ref exits non-zero) -- never blocked.
    return { branch: "", detached: true };
  }
}
