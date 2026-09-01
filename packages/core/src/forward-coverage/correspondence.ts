/**
 * Source-to-test correspondence for verify:forward-coverage (#4009 / #1310).
 *
 * Path-relative candidates, not bare stems. Candidate locations come from
 * colocated files, a sibling `__tests__/` directory, and directory-shaped
 * roots on the existing test-boundary policy (#3145) -- this module does not
 * invent a second testRoots config.
 */

import { basename } from "node:path";
import type { TestBoundaryPolicy } from "../test-boundary/policy.js";

/** Source-file extensions in scope for v1. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".go", ".ts", ".tsx"]);

/** Return the final `.ext` (lowercased) of a path, or empty when none. */
function extOf(pathStr: string): string {
  const b = basename(pathStr);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(dot).toLowerCase() : "";
}

function posix(pathStr: string): string {
  return pathStr.replace(/\\/g, "/");
}

function joinPosix(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter((part) => part.length > 0)
    .join("/");
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/**
 * True when `relPath` is a test file (excluded from the needs-coverage set
 * AND counted as available coverage). Covers the co-located TS/TSX
 * `.test` / `.spec` convention, Go `*_test.go`, and Python `test_*.py` /
 * `*_test.py`.
 */
export function isTestFile(relPath: string): boolean {
  const b = basename(relPath).toLowerCase();
  if (
    b.endsWith(".test.ts") ||
    b.endsWith(".test.tsx") ||
    b.endsWith(".spec.ts") ||
    b.endsWith(".spec.tsx")
  ) {
    return true;
  }
  if (b.endsWith("_test.go")) {
    return true;
  }
  if (b.endsWith(".py") && (b.startsWith("test_") || b.endsWith("_test.py"))) {
    return true;
  }
  return false;
}

/** True when `relPath` is an in-scope, non-test, non-`.d.ts` source file. */
export function isSourceFile(relPath: string): boolean {
  const b = basename(relPath).toLowerCase();
  if (b.endsWith(".d.ts")) {
    return false;
  }
  if (!SOURCE_EXTENSIONS.has(extOf(b))) {
    return false;
  }
  return !isTestFile(relPath);
}

/**
 * Candidate test-file basenames for a source file, keyed on extension + stem.
 * Used to name the file at each searched path; matching is not by basename
 * alone (#4009).
 */
export function expectedTestBasenames(sourcePath: string): string[] {
  const b = basename(sourcePath);
  const ext = extOf(b);
  const stem = b.slice(0, b.length - ext.length);
  switch (ext) {
    case ".ts":
      return [`${stem}.test.ts`, `${stem}.spec.ts`];
    case ".tsx":
      return [`${stem}.test.tsx`, `${stem}.spec.tsx`, `${stem}.test.ts`, `${stem}.spec.ts`];
    case ".py":
      return [`test_${stem}.py`, `${stem}_test.py`];
    case ".go":
      return [`${stem}_test.go`];
    default:
      return [];
  }
}

/** Strip a trailing `/**` (or bare `**`) so a root glob becomes a prefix template. */
function rootPrefixTemplate(glob: string): string {
  const g = posix(glob);
  if (g.endsWith("/**")) {
    return g.slice(0, -3);
  }
  if (g.endsWith("**")) {
    return g.slice(0, -2).replace(/\/$/, "");
  }
  return g;
}

/** File-shaped roots (`*.test.ts`, `*_test.go`) are not placement directories. */
export function isDirectoryShapedRoot(glob: string): boolean {
  const g = posix(glob);
  if (/\*\.[A-Za-z0-9*]+/.test(g)) {
    return false;
  }
  if (/_test\.[A-Za-z0-9]+/.test(g) || /\.test\./.test(g) || /\.spec\./.test(g)) {
    return false;
  }
  return true;
}

export interface SourceRootStrip {
  /** Path after the matched source-root prefix, including the filename. */
  readonly remainder: string;
  /** Values captured by single-star segments in the source-root glob. */
  readonly captures: readonly string[];
  /** Path segments consumed from the source path (for longest-match). */
  readonly consumed: number;
}

/**
 * Match posixPath against a source-root glob such as src/** or packages star-src/**.
 * Returns the remainder after the prefix, plus `*` captures, or null.
 */
export function stripSourceRoot(posixPath: string, sourceRoot: string): SourceRootStrip | null {
  const pathParts = posix(posixPath)
    .split("/")
    .filter((part) => part.length > 0);
  const prefix = rootPrefixTemplate(sourceRoot);
  if (prefix.length === 0) {
    return { remainder: posix(posixPath), captures: [], consumed: 0 };
  }
  const globParts = prefix.split("/").filter((part) => part.length > 0);
  const captures: string[] = [];
  let i = 0;
  for (const g of globParts) {
    if (g === "**") {
      return null;
    }
    if (i >= pathParts.length) {
      return null;
    }
    if (g === "*") {
      captures.push(pathParts[i] ?? "");
      i += 1;
      continue;
    }
    if (pathParts[i] !== g) {
      return null;
    }
    i += 1;
  }
  const remainderParts = pathParts.slice(i);
  if (remainderParts.length === 0) {
    return null;
  }
  return {
    remainder: remainderParts.join("/"),
    captures,
    consumed: i,
  };
}

function longestSourceStrip(
  posixPath: string,
  sourceRoots: readonly string[],
): SourceRootStrip | null {
  let best: SourceRootStrip | null = null;
  for (const root of sourceRoots) {
    const stripped = stripSourceRoot(posixPath, root);
    if (stripped === null) {
      continue;
    }
    if (best === null || stripped.consumed > best.consumed) {
      best = stripped;
    }
  }
  return best;
}

function starCount(template: string): number {
  return template.split("/").filter((part) => part === "*").length;
}

/** Fill a packages star-test root from packages star-src captures. Null if star counts differ. */
export function fillRootTemplate(testRoot: string, captures: readonly string[]): string | null {
  const template = rootPrefixTemplate(testRoot);
  if (template.includes("**")) {
    return null;
  }
  if (starCount(template) !== captures.length) {
    return null;
  }
  const parts = template.split("/").filter((part) => part.length > 0);
  const out: string[] = [];
  let cap = 0;
  for (const g of parts) {
    if (g === "*") {
      const value = captures[cap];
      if (value === undefined || value.length === 0) {
        return null;
      }
      out.push(value);
      cap += 1;
      continue;
    }
    out.push(g);
  }
  return out.join("/");
}

function addNamed(out: Set<string>, directory: string, names: readonly string[]): void {
  for (const name of names) {
    out.add(directory.length === 0 ? name : joinPosix(directory, name));
  }
}

/**
 * Repo-relative candidate test paths for `sourcePath` under `policy`.
 *
 * Always includes colocated and sibling `__tests__/` names. Directory-shaped
 * `testRoots` receive the source-relative remainder when the source sits under
 * a `sourceRoots` glob (or the full path when it does not). Star captures on
 * the source root (packages star src) pair only with test roots that have the
 * same number of star segments (packages star test).
 */
export function expectedTestPaths(sourcePath: string, policy: TestBoundaryPolicy): string[] {
  const rel = posix(sourcePath);
  const names = expectedTestBasenames(rel);
  if (names.length === 0) {
    return [];
  }
  const sourceDir = dirOf(rel);
  const out = new Set<string>();
  addNamed(out, sourceDir, names);
  addNamed(out, joinPosix(sourceDir, "__tests__"), names);

  const stripped = longestSourceStrip(rel, policy.sourceRoots);
  const remainder = stripped?.remainder ?? rel;
  const remainderDir = dirOf(remainder);
  const captures = stripped?.captures ?? [];

  for (const testRoot of policy.testRoots) {
    if (!isDirectoryShapedRoot(testRoot)) {
      continue;
    }
    const template = rootPrefixTemplate(testRoot);
    if (template === "**/__tests__" || template.endsWith("**/__tests__")) {
      addNamed(out, joinPosix("__tests__", remainderDir), names);
      continue;
    }
    if (template.includes("**")) {
      continue;
    }
    const filled = fillRootTemplate(testRoot, captures);
    if (filled === null) {
      continue;
    }
    addNamed(out, joinPosix(filled, remainderDir), names);
  }

  return [...out].sort();
}
