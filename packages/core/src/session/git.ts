import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (projectRoot: string, args: readonly string[]) => GitRunResult;

export const defaultGitRunner: GitRunner = (projectRoot, args) => {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout.trimEnd(), stderr: "" };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT") {
      return { code: 127, stdout: "", stderr: "git executable not found on PATH" };
    }
    return {
      code: typeof e.status === "number" ? e.status : 2,
      stdout: typeof e.stdout === "string" ? e.stdout.trimEnd() : "",
      stderr: typeof e.stderr === "string" ? e.stderr.trimEnd() : "",
    };
  }
};

export function gitHead(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): {
  head: string | null;
  error: string | null;
} {
  const { code, stdout, stderr } = runGit(projectRoot, ["rev-parse", "--verify", "HEAD"]);
  if (code !== 0 || !stdout) {
    return { head: null, error: stderr || "could not resolve git HEAD" };
  }
  return { head: stdout, error: null };
}

export function worktreePath(projectRoot: string, runGit: GitRunner = defaultGitRunner): string {
  const { code, stdout } = runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (code === 0 && stdout) {
    return resolve(stdout);
  }
  return resolve(projectRoot);
}

export function detectBranch(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  const sym = runGit(projectRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (sym.code === 0 && sym.stdout.trim()) {
    return sym.stdout.trim();
  }
  const rev = runGit(projectRoot, ["rev-parse", "--short", "HEAD"]);
  if (rev.code === 0 && rev.stdout.trim()) {
    return `detached:${rev.stdout.trim()}`;
  }
  return null;
}
