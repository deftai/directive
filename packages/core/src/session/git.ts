import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

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
      // `git show <tip>:<path>` streams whole blobs; SPECIFICATION.md alone is
      // past Node's 1 MB default (#3903).
      maxBuffer: SUBPROCESS_MAX_BUFFER,
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

/**
 * One `git rev-parse` that answers the three ref reads the mutation gates
 * otherwise make separately. Output is one line per requested value, in
 * argument order: full HEAD, worktree root, branch name.
 */
const DISPATCH_GIT_CONTEXT_ARGS = [
  "rev-parse",
  "HEAD",
  "--show-toplevel",
  "--abbrev-ref",
  "HEAD",
] as const;

/** The individual reads `DISPATCH_GIT_CONTEXT_ARGS` can answer without a spawn. */
const COALESCED_GIT_ARGS: readonly (readonly string[])[] = [
  ["rev-parse", "--verify", "HEAD"],
  ["rev-parse", "--show-toplevel"],
  ["symbolic-ref", "--short", "HEAD"],
];

/**
 * Ref and identity reads whose answer cannot change inside one dispatch.
 * Deliberately excludes content reads (no repeat callers, unbounded memory)
 * and anything that touches the object store or a remote.
 */
const CACHEABLE_GIT_VERBS: ReadonlySet<string> = new Set([
  "rev-parse",
  "symbolic-ref",
  "merge-base",
  "rev-list",
]);

function isCoalescedGitArgs(args: readonly string[]): boolean {
  return COALESCED_GIT_ARGS.some(
    (candidate) => candidate.length === args.length && candidate.every((arg, i) => arg === args[i]),
  );
}

/**
 * Serve a dispatch's repeated ref reads from one `git` child (#3736).
 *
 * The host mutation gate resolved HEAD, the worktree root, and the branch with
 * a separate spawn each, twice over; on a loaded Windows box a spawn measured a
 * 2.2s p50, so every concurrent agent's hook slowed every other agent's hook.
 * The probe is lazy on purpose: it only fires for a read it can actually
 * answer, so a caller that never asks for context never pays for it.
 */
export function memoizeGitRunner(runGit: GitRunner = defaultGitRunner): GitRunner {
  const cache = new Map<string, GitRunResult>();
  const probed = new Set<string>();
  const keyFor = (root: string, args: readonly string[]) => JSON.stringify([root, args]);

  const probeContext = (projectRoot: string, root: string): void => {
    probed.add(root);
    const context = runGit(projectRoot, DISPATCH_GIT_CONTEXT_ARGS);
    if (context.code !== 0) return;
    const [head, worktree, branch, ...extra] = context.stdout.split(/\r?\n/);
    if (!head || !worktree || !branch || extra.length > 0) return;
    const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: "" });
    cache.set(keyFor(root, ["rev-parse", "--verify", "HEAD"]), ok(head));
    cache.set(keyFor(root, ["rev-parse", "--show-toplevel"]), ok(worktree));
    // `--abbrev-ref` prints the literal "HEAD" on a detached head, where
    // `symbolic-ref` exits non-zero — which is what callers branch on.
    cache.set(
      keyFor(root, ["symbolic-ref", "--short", "HEAD"]),
      branch === "HEAD" ? { code: 1, stdout: "", stderr: "" } : ok(branch),
    );
  };

  return (projectRoot, args) => {
    const root = resolve(projectRoot);
    const key = keyFor(root, args);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    if (!probed.has(root) && isCoalescedGitArgs(args)) {
      probeContext(projectRoot, root);
      const coalesced = cache.get(key);
      if (coalesced !== undefined) return coalesced;
    }

    const result = runGit(projectRoot, args);
    const verb = args[0];
    if (verb !== undefined && CACHEABLE_GIT_VERBS.has(verb)) {
      cache.set(key, result);
    }
    return result;
  };
}

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

/**
 * Walk from `targetPath` to the nearest existing directory. A write that
 * creates a missing nested file is the common case; git cannot use a
 * nonexistent cwd.
 */
export function existingAncestorDir(targetPath: string): string | null {
  let current = resolve(targetPath);
  for (;;) {
    if (existsSync(current)) {
      try {
        if (statSync(current).isDirectory()) return current;
      } catch {
        // Fall through to dirname when the path is not stat-able.
      }
      const parent = dirname(current);
      return parent === current ? null : parent;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Failure-expressing sibling of {@link worktreePath}. Returns null instead of
 * falling back to `startDir` so a missing git tree is distinguishable from
 * success (#3794).
 */
export function worktreePathOrNull(
  startDir: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  const { code, stdout } = runGit(startDir, ["rev-parse", "--show-toplevel"]);
  const trimmed = stdout.trim();
  if (code !== 0 || trimmed.length === 0) return null;
  return resolve(trimmed);
}

/** Absolute `--git-common-dir` for `projectRoot`, or null on failure. */
export function gitCommonDir(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  const { code, stdout } = runGit(projectRoot, ["rev-parse", "--git-common-dir"]);
  const trimmed = stdout.trim();
  if (code !== 0 || trimmed.length === 0) return null;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
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
