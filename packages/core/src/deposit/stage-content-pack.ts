/**
 * Stage the @deftai/directive-content pack the same way prepack does, then
 * rewrite relative markdown links onto the flattened deposit layout (#3937).
 *
 * Must not write into the source tree: destDir is the pack root (packages/content
 * during prepack, or an out-of-tree temp dir in tests).
 */

import {
  cpSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { rewriteMarkdownDepositLinks, sourceRelForPackRel } from "./rewrite-deposit-links.js";

const ENGINE_ENTRIES = [".githooks", "Taskfile.yml", "tasks"] as const;
const HARNESS_ENTRIES = ["main.md", "SKILL.md"] as const;

function keepCopy(src: string): boolean {
  return !src.includes("__pycache__") && !src.endsWith(".pyc") && !src.endsWith(".py");
}

function rewriteStagedMarkdown(destDir: string): number {
  let filesRewritten = 0;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const packRel = relative(destDir, full).replace(/\\/g, "/");
      const original = readFileSync(full, "utf8");
      const { content, rewriteCount } = rewriteMarkdownDepositLinks({
        content: original,
        sourceFileRel: sourceRelForPackRel(packRel),
        packFileRel: packRel,
      });
      if (rewriteCount > 0 && content !== original) {
        containedWrite({
          root: destDir,
          target: packRel,
          data: content,
          mode: "replace",
        });
        filesRewritten += 1;
      }
    }
  };
  walk(destDir);
  return filesRewritten;
}

/** Copy content/ + harness + engine entries, then rewrite markdown links. */
export function stageContentPack(options: {
  readonly repoRoot: string;
  readonly destDir: string;
}): {
  filesRewritten: number;
} {
  const { repoRoot, destDir } = options;
  mkdirSync(destDir, { recursive: true });
  const contentSrc = join(repoRoot, "content");
  for (const name of readdirSync(contentSrc)) {
    const from = join(contentSrc, name);
    const to = join(destDir, name);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, filter: (src) => keepCopy(src) });
  }
  for (const name of ENGINE_ENTRIES) {
    const from = join(repoRoot, name);
    if (!existsSync(from)) continue;
    const to = join(destDir, name);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, filter: (src) => keepCopy(src) });
  }
  for (const name of HARNESS_ENTRIES) {
    const from = join(repoRoot, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(destDir, name));
  }
  const filesRewritten = rewriteStagedMarkdown(destDir);
  return { filesRewritten };
}

/** prepack cwd is packages/content. */
export function runPrepackFromContentPackage(pkgDir: string): void {
  const repoRoot = join(pkgDir, "..", "..");
  stageContentPack({ repoRoot, destDir: pkgDir });
}
