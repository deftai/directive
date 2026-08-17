import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (projectRoot: string, args: readonly string[]) => GitRunResult;

function coerceGitBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

/** `-z` porcelain is byte-oriented; UTF-8 would turn invalid names into U+FFFD. */
function gitStdoutString(raw: Buffer, args: readonly string[]): string {
  if (args.includes("-z")) return raw.toString("latin1");
  const utf8 = raw.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(raw)) return utf8.trimEnd();
  return raw.toString("latin1").trimEnd();
}

export const defaultGitRunner: GitRunner = (projectRoot, args) => {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: gitStdoutString(coerceGitBytes(stdout), args), stderr: "" };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (e.code === "ENOENT") {
      return { code: 127, stdout: "", stderr: "git executable not found on PATH" };
    }
    return {
      code: typeof e.status === "number" ? e.status : 2,
      stdout: gitStdoutString(coerceGitBytes(e.stdout), args),
      stderr: coerceGitBytes(e.stderr).toString("utf8").trimEnd(),
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

/** True when `ancestor` is reachable from `descendant` (same commit counts). */
export function gitIsAncestor(
  projectRoot: string,
  ancestor: string,
  descendant: string,
  runGit: GitRunner = defaultGitRunner,
): boolean | null {
  if (ancestor === descendant) {
    return true;
  }
  const { code } = runGit(projectRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (code === 0) {
    return true;
  }
  if (code === 1) {
    return false;
  }
  return null;
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
