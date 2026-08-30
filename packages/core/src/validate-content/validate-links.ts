import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { NON_PRODUCT_DIRS } from "../fs/non-product-dirs.js";
import { extractLinkTargets, shouldSkipLinkTarget } from "./link-parser.js";
import type { EvaluateResult } from "./types.js";

/**
 * Shared "not product source" core (#3487) plus the two directories only the
 * link walk skips: generated planning projections and `specs/`.
 *
 * Walking agent worktrees during release Step 5 / `task check` is pure
 * wall-clock waste (#2953, #1656, #3481).
 */
export const EXCLUDE_DIRS = new Set([...NON_PRODUCT_DIRS, ".planning", "specs"]);

export interface BrokenLink {
  readonly file: string;
  readonly line: number;
  readonly target: string;
}

export interface ValidateLinksOptions {
  readonly cwd?: string;
  readonly strict?: boolean;
  readonly linkCheckStrict?: boolean;
  readonly argv?: readonly string[];
}

function shouldSkipPath(parts: string[]): boolean {
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  return parts.includes("history") && parts.includes("archive");
}

function collectMarkdownFiles(root: string): string[] {
  const out: string[] = [];

  const walk = (dir: string, parts: string[]): void => {
    if (shouldSkipPath(parts)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const nextParts = [...parts, entry.name];
      if (shouldSkipPath(nextParts)) continue;
      if (entry.isDirectory()) {
        walk(full, nextParts);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };

  walk(root, []);
  return out.sort();
}

/** Collect broken internal markdown links under cwd. Used by packed-fixture tests (#3937). */
export function collectBrokenLinks(cwd: string): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const root = resolve(cwd);
  for (const md of collectMarkdownFiles(root)) {
    let text: string;
    try {
      text = readFileSync(md, "utf8");
    } catch {
      continue;
    }
    const rel = md.startsWith(root + sep) ? relative(root, md) : md;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const target of extractLinkTargets(line)) {
        if (
          target.startsWith("http://") ||
          target.startsWith("https://") ||
          target.startsWith("mailto:") ||
          target.startsWith("#")
        ) {
          continue;
        }
        if (shouldSkipLinkTarget(target)) continue;
        const clean = target.split("#")[0]?.split("?")[0] ?? "";
        if (!clean) continue;
        const resolved = resolve(join(md, ".."), clean);
        if (!existsSync(resolved)) {
          broken.push({ file: rel, line: i + 1, target });
        }
      }
    }
  }
  return broken;
}

/**
 * Validate internal markdown links. Faithful to `scripts/validate-links.py`.
 */
export function evaluate(options: ValidateLinksOptions = {}): EvaluateResult {
  const cwd = resolve(options.cwd ?? ".");
  const strict =
    options.strict === true ||
    options.linkCheckStrict === true ||
    (options.argv ?? []).includes("--strict") ||
    process.env.LINK_CHECK_STRICT === "1";

  const broken = collectBrokenLinks(cwd);
  if (broken.length === 0) {
    return {
      code: 0,
      message: "All internal markdown links valid",
      stream: "stdout",
    };
  }

  const mode = strict ? "errors" : "warnings";
  const lines = [`Found ${broken.length} broken internal link(s) (${mode}):`];
  for (const item of broken.slice(0, 50)) {
    lines.push(`  ${item.file}:${item.line} -> ${item.target}`);
  }
  if (broken.length > 50) {
    lines.push(`  ... and ${broken.length - 50} more`);
  }
  return {
    code: strict ? 1 : 0,
    message: lines.join("\n"),
    stream: "stdout",
  };
}
