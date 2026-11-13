import { readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared test-file walk for the cited-skip scan (#6071) and the
 * sanctioned-skip count baseline (#6072). Leaf module: node:fs/path only.
 *
 * Bounds (#6226):
 * - skip `node_modules`, `dist`, `.git`, and `.deft-scratch` by literal basename;
 * - do not descend into a subdirectory whose `.git` entry is a file
 *   (a linked worktree). The walk root itself is always walked, even when
 *   it is a linked worktree.
 *
 * Enumeration stays readdir-based (no `git ls-files`), so untracked on-disk
 * test files still participate.
 */

const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  ".deft-scratch",
]);

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/;

function isLinkedWorktreeDir(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    let st: Stats | undefined;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (isLinkedWorktreeDir(full)) continue;
      walk(full, out);
      continue;
    }
    if (TEST_FILE_RE.test(name)) {
      out.push(full);
    }
  }
}

/** Absolute paths of test files under `root`, honoring the #6226 bounds. */
export function walkTestFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  return out;
}
