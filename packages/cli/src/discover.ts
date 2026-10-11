/**
 * Git-aware project discovery (AC3.7 / INIT-05 / INIT-06).
 * No dependency on runtime/core — uses child_process only.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type DiscoverErrorKind =
  | "git_error"
  | "refused_root"
  | "refused_home"
  | "root_not_git_toplevel"
  | "missing_root";

export interface DiscoverOk {
  readonly ok: true;
  readonly root: string;
  /** True when discovery moved up from the invocation directory. */
  readonly movedUp: boolean;
  readonly viaGit: boolean;
}

export interface DiscoverErr {
  readonly ok: false;
  readonly kind: DiscoverErrorKind;
  readonly message: string;
}

export type DiscoverResult = DiscoverOk | DiscoverErr;

/** Resolve path, following symlinks when the target exists (AC3.8 / AC14.43). */
function realpathOrResolve(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isFilesystemRoot(path: string): boolean {
  const resolved = realpathOrResolve(path);
  // Unix `/` or Windows `C:\`
  let rootReal: string;
  try {
    rootReal = realpathSync("/");
  } catch {
    rootReal = resolve("/");
  }
  if (resolved === rootReal || resolved === resolve("/")) return true;
  return /^[A-Za-z]:[\\/]?$/.test(resolved);
}

function isUserHome(path: string): boolean {
  try {
    return realpathOrResolve(path) === realpathOrResolve(homedir());
  } catch {
    return false;
  }
}

function runGitShowToplevel(cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: process.env,
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

export interface DiscoverOptions {
  readonly cwd?: string;
  /** Explicit --root override. */
  readonly rootFlag?: string | null;
  /** When true, allow filesystem root / home (deliberate). Default false. */
  readonly allowRootOrHome?: boolean;
}

/**
 * Discover the project root for launcher bookends and passthrough.
 */
export function discoverProject(options: DiscoverOptions = {}): DiscoverResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  // Lexical resolve for existence; realpath for refuse + git identity (AC3.8).
  const rootFlagLexical = options.rootFlag ? resolve(options.rootFlag) : null;

  if (rootFlagLexical !== null) {
    if (!existsSync(rootFlagLexical) || !statSync(rootFlagLexical).isDirectory()) {
      return {
        ok: false,
        kind: "missing_root",
        message: `--root ${rootFlagLexical} is not an existing directory.`,
      };
    }
    const rootFlag = realpathOrResolve(rootFlagLexical);
    // Refuse home/root on the real destination before accepting (symlink bypass).
    if (!options.allowRootOrHome) {
      if (isFilesystemRoot(rootFlag)) {
        return {
          ok: false,
          kind: "refused_root",
          message: "Refusing filesystem root as install destination. Pass a project path deliberately.",
        };
      }
      if (isUserHome(rootFlag)) {
        return {
          ok: false,
          kind: "refused_home",
          message: "Refusing home directory as install destination. Pass a project path deliberately.",
        };
      }
    }
    const git = runGitShowToplevel(rootFlagLexical);
    if (git.code === 0 && git.stdout.length > 0) {
      const toplevel = realpathOrResolve(git.stdout);
      if (toplevel !== rootFlag) {
        return {
          ok: false,
          kind: "root_not_git_toplevel",
          message: `--root must be the Git working-tree root (${toplevel}); got ${rootFlagLexical}.`,
        };
      }
    }
    return {
      ok: true,
      root: rootFlag,
      movedUp: rootFlag !== realpathOrResolve(cwd) && rootFlagLexical !== cwd,
      viaGit: git.code === 0,
    };
  }

  const git = runGitShowToplevel(cwd);
  if (git.code === 0 && git.stdout.length > 0) {
    const root = resolve(git.stdout);
    if (!options.allowRootOrHome) {
      if (isFilesystemRoot(root) || isUserHome(root)) {
        return {
          ok: false,
          kind: isFilesystemRoot(root) ? "refused_root" : "refused_home",
          message: `Refusing ${isFilesystemRoot(root) ? "filesystem root" : "home directory"} as project root.`,
        };
      }
    }
    return {
      ok: true,
      root,
      movedUp: root !== cwd,
      viaGit: true,
    };
  }

  // Distinguish "not a repository" (128) from other Git errors (AC3.7).
  if (git.code !== 0 && git.code !== 128 && git.stderr.length > 0) {
    // Git binary missing often yields status null/1 with ENOENT — treat as no-git path.
    const missingGit =
      (git.stderr.includes("ENOENT") || git.code === 127) &&
      !existsSync(resolve(cwd, ".git"));
    if (!missingGit && git.code !== 128) {
      // Only hard-fail when git ran but errored unexpectedly inside a likely repo.
      if (existsSync(resolve(cwd, ".git"))) {
        return {
          ok: false,
          kind: "git_error",
          message: `Git error during discovery: ${git.stderr}`,
        };
      }
    }
  }

  // No Git / not a repo: use cwd after checking enclosing package.json workspace lightly.
  let root = cwd;
  let probe = cwd;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(probe, "package.json"))) {
      root = probe;
      break;
    }
    const parent = resolve(probe, "..");
    if (parent === probe) break;
    probe = parent;
  }

  if (!options.allowRootOrHome) {
    if (isFilesystemRoot(root)) {
      return {
        ok: false,
        kind: "refused_root",
        message: "Refusing filesystem root as project root.",
      };
    }
    if (isUserHome(root)) {
      return {
        ok: false,
        kind: "refused_home",
        message: "Refusing home directory as project root.",
      };
    }
  }

  return {
    ok: true,
    root,
    movedUp: root !== cwd,
    viaGit: false,
  };
}

/** Parse --root <path> from argv; returns remaining argv without the flag. */
export function takeRootFlag(argv: readonly string[]): {
  root: string | null;
  rest: string[];
} {
  const rest: string[] = [];
  let root: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--root") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        root = "";
        continue;
      }
      root = isAbsolute(next) ? next : resolve(next);
      i++;
      continue;
    }
    if (a.startsWith("--root=")) {
      root = a.slice("--root=".length);
      continue;
    }
    rest.push(a);
  }
  return { root, rest };
}
