import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isFrameworkRepoRoot } from "../check/context.js";
import {
  type ExtraMarkdownFile,
  evaluateLiveProcedureTargets,
  extraDepositMarkdownFiles,
  formatLiveProcedureFailure,
} from "../deposit/live-procedure-targets.js";
import { NON_PRODUCT_DIRS } from "../fs/non-product-dirs.js";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
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
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function consumerDepositDir(cwd: string): string | null {
  for (const rel of [CANONICAL_INSTALL_ROOT, "deft"] as const) {
    const candidate = join(cwd, rel);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

export interface C3EvaluationRoot {
  readonly stagedRoot: string;
  readonly extraFiles: ExtraMarkdownFile[];
}

/**
 * Choose the C3 walk root. Probe framework source first, then an initialized
 * consumer deposit, then treat cwd as a flattened deposit. Do not use
 * contentRoot(cwd): that prefers the npm content package over the vendored
 * deposit (#4081).
 */
export function resolveC3EvaluationRoot(cwd: string): C3EvaluationRoot {
  if (isFrameworkRepoRoot(cwd)) {
    const underContent = join(cwd, "content");
    return {
      stagedRoot: isDirectory(underContent) ? underContent : cwd,
      extraFiles: extraDepositMarkdownFiles(cwd),
    };
  }
  const deposit = consumerDepositDir(cwd);
  if (deposit !== null) {
    return {
      stagedRoot: deposit,
      extraFiles: [],
    };
  }
  return {
    stagedRoot: cwd,
    extraFiles: [],
  };
}

function formatMissingC3Root(stagedRoot: string): string {
  return (
    "C3 live-procedure target validation failed: deposit root is missing or not a directory: " +
    stagedRoot
  );
}

export function evaluate(options: ValidateLinksOptions = {}): EvaluateResult {
  const cwd = resolve(options.cwd ?? ".");
  const strict =
    options.strict === true ||
    options.linkCheckStrict === true ||
    (options.argv ?? []).includes("--strict") ||
    process.env.LINK_CHECK_STRICT === "1";

  const c3Root = resolveC3EvaluationRoot(cwd);
  if (!isDirectory(c3Root.stagedRoot)) {
    return {
      code: 1,
      message: formatMissingC3Root(c3Root.stagedRoot),
      stream: "stdout",
    };
  }
  const c3 = evaluateLiveProcedureTargets({
    stagedRoot: c3Root.stagedRoot,
    extraFiles: c3Root.extraFiles,
  });
  if (c3.uniqueTargets.length > 0) {
    return {
      code: 1,
      message: formatLiveProcedureFailure(c3),
      stream: "stdout",
    };
  }

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
