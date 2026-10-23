/**
 * packs-root.ts -- single pack root resolver for pack-render and packs-slice (#5853).
 *
 * The compiled pack modules used to resolve their root from their own file
 * location (`import.meta.url`). When they run from an installed runtime
 * package, that location is the package, so a framework source checkout was
 * checked against the package's deposit-rewritten copies instead of its own
 * `content/`.
 *
 * Precedence: explicit `--project-root` -> `$DEFT_PROJECT_ROOT` -> ancestor walk
 * from cwd for `<dir>/content/packs/` -> module location (last resort only).
 * An explicit root that does not exist refuses closed. A root that carries
 * `content/packs/` is a framework source checkout and binds straight to its
 * `content/` (no content-package preference). Refs #5853, #5802, #1875.
 */

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_DIRNAME, contentRoot } from "../content-root.js";

export interface PacksRoot {
  /** Root holding repo-resident projections (meta/lessons.md). */
  readonly repoRoot: string;
  /** Root holding pack sources, schemas and document projections. */
  readonly contentRoot: string;
  /** True when bound to a framework source checkout's own content/. */
  readonly frameworkSource: boolean;
}

export interface ResolvePacksRootOptions {
  readonly projectRoot?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** `import.meta.url` of the calling module (last-resort fallback). */
  readonly moduleUrl: string;
}

/** Thrown when an explicit pack root (flag or env) does not exist. */
export class PacksRootError extends Error {}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasContentPacks(dir: string): boolean {
  return isDirectory(join(dir, CONTENT_DIRNAME, "packs"));
}

/** Repo root implied by a module living at `<root>/packages/core/{src,dist}/packs/`. */
export function moduleRepoRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..", "..");
}

/** Walk up from `start` to the nearest `<dir>/content/packs/` (portable root stop). */
export function findFrameworkSourceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (hasContentPacks(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Bind a chosen root: framework source -> its own content/; otherwise consumer contentRoot(). */
export function bindPacksRoot(root: string): PacksRoot {
  if (hasContentPacks(root)) {
    return { repoRoot: root, contentRoot: join(root, CONTENT_DIRNAME), frameworkSource: true };
  }
  return { repoRoot: root, contentRoot: contentRoot(root), frameworkSource: false };
}

/** Root used for module-level defaults: cwd walk-up, then module location. Never throws. */
export function defaultPacksRoot(moduleUrl: string, cwd: string = process.cwd()): PacksRoot {
  const found = findFrameworkSourceRoot(cwd);
  return bindPacksRoot(found ?? moduleRepoRoot(moduleUrl));
}

/** Full resolution for CLI entry points; explicit roots that fail to stat refuse closed. */
export function resolvePacksRoot(options: ResolvePacksRootOptions): PacksRoot {
  const env = options.env ?? process.env;
  const fromFlag = options.projectRoot ?? null;
  if (fromFlag !== null && fromFlag.length === 0) {
    throw new PacksRootError("--project-root requires a value (refusing package fallback)");
  }
  const fromEnv = env.DEFT_PROJECT_ROOT ?? "";
  const explicit = fromFlag !== null && fromFlag.length > 0 ? fromFlag : fromEnv;
  if (explicit.length > 0) {
    const source =
      fromFlag !== null && fromFlag.length > 0 ? "--project-root" : "DEFT_PROJECT_ROOT";
    const abs = resolve(explicit);
    if (!isDirectory(abs)) {
      throw new PacksRootError(`${source} ${abs} is not a directory (refusing package fallback)`);
    }
    return bindPacksRoot(abs);
  }
  return defaultPacksRoot(options.moduleUrl, options.cwd ?? process.cwd());
}
