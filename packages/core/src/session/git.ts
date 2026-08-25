import { execFileSync, spawnSync } from "node:child_process";
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

/**
 * Ceiling for one `git cat-file --batch` payload. The directive terminal
 * corpus is ~8 MiB today; this leaves headroom without reintroducing
 * per-blob `git show` on a truncated read.
 */
export const GIT_CAT_FILE_BATCH_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Parse `git cat-file --batch` stdout for `paths.length` objects, in the
 * same order the names were written to stdin. Returns null if the stream
 * is truncated or a header is malformed so callers can fall back.
 */
export function parseGitCatFileBatch(
  stdout: Buffer,
  paths: readonly string[],
): Map<string, string | null> | null {
  const out = new Map<string, string | null>();
  let offset = 0;
  for (const path of paths) {
    const nl = stdout.indexOf(0x0a, offset);
    if (nl < 0) {
      return null;
    }
    const header = stdout.subarray(offset, nl).toString("utf8");
    offset = nl + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      out.set(path, null);
      continue;
    }
    const match = /^[0-9a-fA-F]+ \S+ (\d+)$/.exec(header);
    if (match === null) {
      return null;
    }
    const size = Number(match[1]);
    if (!Number.isInteger(size) || size < 0 || offset + size > stdout.length) {
      return null;
    }
    const content = stdout.subarray(offset, offset + size);
    offset += size;
    if (offset < stdout.length && stdout[offset] === 0x0a) {
      offset += 1;
    } else if (offset !== stdout.length) {
      return null;
    }
    out.set(path, content.toString("utf8"));
  }
  return out;
}

function showBlobViaRunner(
  projectRoot: string,
  tip: string,
  path: string,
  runGit: GitRunner,
): string | null {
  const result = runGit(projectRoot, ["show", `${tip}:${path}`]);
  if (result.code !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * Read many `tip:path` blobs in one `git cat-file --batch` process.
 * Falls back to per-path `git show` only when the batch stream cannot be
 * parsed, so verdicts stay content-authoritative.
 */
export function showBlobsBatch(
  projectRoot: string,
  tip: string,
  paths: readonly string[],
  runGit: GitRunner = defaultGitRunner,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) {
    return out;
  }

  const input = Buffer.from(`${paths.map((path) => `${tip}:${path}`).join("\n")}\n`, "utf8");
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: projectRoot,
    input,
    maxBuffer: GIT_CAT_FILE_BATCH_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error === undefined && result.status === 0 && result.stdout !== undefined) {
    const parsed = parseGitCatFileBatch(coerceGitBytes(result.stdout), paths);
    if (parsed !== null) {
      return parsed;
    }
  }

  for (const path of paths) {
    out.set(path, showBlobViaRunner(projectRoot, tip, path, runGit));
  }
  return out;
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
