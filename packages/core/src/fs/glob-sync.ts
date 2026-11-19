/**
 * `fs.globSync` that also loads and runs on Node 20 (#5873, AC16).
 *
 * Node added `fs.globSync` in v22. A static named import
 * (`import { globSync } from "node:fs"`) fails at ESM link time on Node 20,
 * so the whole runtime crashes before any code runs. This module uses a
 * namespace import, which links on every Node version, and checks for the
 * function at call time.
 *
 * - Node 22+: calls `fs.globSync` unchanged (identical results).
 * - Node 20: {@link globSyncFallback}, a port of Node's own sync glob walk
 *   with the same `minimatch` options, so results match.
 *
 * Production code imports glob from here, never `globSync` from `node:fs`
 * (guard: `no-static-globsync.test.ts`).
 */
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { GLOBSTAR, Minimatch } from "minimatch";

export interface GlobSyncCompatOptions {
  readonly cwd?: string;
}

type NativeGlobSync = (pattern: string, options?: GlobSyncCompatOptions) => string[];

/** Node's `fs.globSync` when present (Node 22+), else `null`. */
function nativeGlobSync(): NativeGlobSync | null {
  const candidate = (fs as { globSync?: unknown }).globSync;
  return typeof candidate === "function" ? (candidate as NativeGlobSync) : null;
}

/**
 * Glob like `fs.globSync(pattern, options)`. On Node 22+ this is exactly
 * `fs.globSync`; on Node 20 it uses {@link globSyncFallback}.
 */
export function globSyncCompat(pattern: string, options?: GlobSyncCompatOptions): string[] {
  const native = nativeGlobSync();
  if (native !== null) {
    return options === undefined ? native(pattern) : native(pattern, options);
  }
  return globSyncFallback(pattern, options);
}

// ---------------------------------------------------------------------------
// Node 20 fallback: a port of the sync path of Node's lib/internal/fs/glob.js
// (v24.22.1; Node.js is MIT-licensed). Only the options Directive uses are
// kept: `cwd`. No `exclude`, no `withFileTypes`, symlinks not followed
// (Node's default). Keep the logic in step with Node's; the parity test
// compares the two on the CI Node version. Older 22/24 releases also step one
// level into a symlinked directory under `**`; 24.22+ and 26 do not, and this
// port follows the newer behaviour.
// ---------------------------------------------------------------------------

/**
 * A compiled path segment. minimatch 10 yields a `RegExp`; minimatch 11 yields
 * a `Matcher` object with the same `test(name)` call.
 */
interface SegmentMatcher {
  test(name: string): boolean;
}

type PatternPart = string | typeof GLOBSTAR | SegmentMatcher;

function isSegmentMatcher(part: PatternPart | undefined): part is SegmentMatcher {
  return typeof part === "object" && part !== null && typeof part.test === "function";
}

interface EntryLike {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const isWindows = process.platform === "win32";

/** The options Node's glob gives its bundled minimatch (`createMatcher`). */
function createMatcher(pattern: string): Minimatch {
  return new Minimatch(pattern, {
    nocase: isWindows || process.platform === "darwin",
    windowsPathsNoEscape: true,
    nonegate: true,
    nocomment: true,
    optimizationLevel: 2,
    platform: process.platform,
    nocaseMagicOnly: true,
  });
}

function lstatEntry(path: string, name: string): EntryLike | null {
  try {
    const st = fs.lstatSync(path);
    return { name, isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink() };
  } catch {
    return null;
  }
}

class GlobCache {
  readonly #seen = new Map<string, Set<string>>();
  readonly #stats = new Map<string, EntryLike | null>();
  readonly #dirs = new Map<string, readonly EntryLike[]>();

  statSync(path: string): EntryLike | null {
    if (this.#stats.has(path)) return this.#stats.get(path) ?? null;
    const val = lstatEntry(path, path.split(/[\\/]/).pop() ?? path);
    this.#stats.set(path, val);
    return val;
  }

  addToStatCache(path: string, val: EntryLike): void {
    this.#stats.set(path, val);
  }

  readdirSync(path: string): readonly EntryLike[] {
    const cached = this.#dirs.get(path);
    if (cached) return cached;
    let val: readonly EntryLike[];
    try {
      val = fs.readdirSync(path, { withFileTypes: true });
    } catch {
      val = [];
    }
    this.#dirs.set(path, val);
    return val;
  }

  /** Returns true when every index of `pattern` was already seen at `path`. */
  add(path: string, pattern: GlobPattern): boolean {
    let cache = this.#seen.get(path);
    if (!cache) {
      cache = new Set();
      this.#seen.set(path, cache);
    }
    const before = cache.size;
    for (const index of pattern.indexes) cache.add(pattern.cacheKey(index));
    return cache.size !== before + pattern.indexes.size;
  }

  seen(path: string, pattern: GlobPattern, index: number): boolean {
    return this.#seen.get(path)?.has(pattern.cacheKey(index)) ?? false;
  }
}

class GlobPattern {
  readonly #parts: readonly PatternPart[];
  readonly #globStrings: readonly string[];
  readonly indexes: Set<number>;
  readonly symlinks: Set<number>;
  readonly last: number;

  constructor(
    parts: readonly PatternPart[],
    globStrings: readonly string[],
    indexes: Set<number>,
    symlinks: Set<number>,
  ) {
    this.#parts = parts;
    this.#globStrings = globStrings;
    this.indexes = indexes;
    this.symlinks = symlinks;
    this.last = parts.length - 1;
  }

  isLast(isDirectory: boolean): boolean {
    return (
      this.indexes.has(this.last) ||
      (this.at(-1) === "" &&
        isDirectory &&
        this.indexes.has(this.last - 1) &&
        this.at(-2) === GLOBSTAR)
    );
  }

  isFirst(): boolean {
    return this.indexes.has(0);
  }

  get hasSeenSymlinks(): boolean {
    return [...this.indexes].some((i) => !this.symlinks.has(i));
  }

  at(index: number): PatternPart | undefined {
    return this.#parts.at(index);
  }

  child(indexes: Set<number>, symlinks: Set<number> = new Set()): GlobPattern {
    return new GlobPattern(this.#parts, this.#globStrings, indexes, symlinks);
  }

  test(index: number, name: string): boolean {
    if (index > this.#parts.length) return false;
    const part = this.#parts[index];
    if (part === GLOBSTAR) return true;
    if (typeof part === "string") return part === name;
    if (isSegmentMatcher(part)) return part.test(name);
    return false;
  }

  cacheKey(index: number): string {
    return this.#globStrings.slice(index).join("/");
  }
}

class FallbackGlob {
  readonly #root: string;
  readonly #cache = new GlobCache();
  readonly #results = new Set<string>();
  readonly #queue: { path: string; patterns: GlobPattern[] }[] = [];
  readonly #subpatterns = new Map<string, GlobPattern[]>();
  readonly #patterns: GlobPattern[];

  constructor(pattern: string, cwd: string | undefined) {
    this.#root = cwd ?? ".";
    const matcher = createMatcher(pattern);
    this.#patterns = matcher.set.map(
      (parts, i) =>
        new GlobPattern(
          parts as PatternPart[],
          matcher.globParts[i] ?? [],
          new Set([0]),
          new Set(),
        ),
    );
  }

  run(): string[] {
    this.#queue.push({ path: ".", patterns: this.#patterns });
    while (this.#queue.length > 0) {
      const item = this.#queue.pop();
      if (item === undefined) break;
      for (const pattern of item.patterns) this.#addSubpatterns(item.path, pattern);
      for (const [path, patterns] of this.#subpatterns) this.#queue.push({ path, patterns });
      this.#subpatterns.clear();
    }
    return [...this.#results];
  }

  #isDirectorySync(stat: EntryLike | null, pattern: GlobPattern): boolean {
    if (stat?.isDirectory()) return true;
    if (!stat?.isSymbolicLink()) return false;
    return pattern.hasSeenSymlinks;
  }

  #addSubpattern(path: string, pattern: GlobPattern): void {
    const list = this.#subpatterns.get(path);
    if (list) list.push(pattern);
    else this.#subpatterns.set(path, [pattern]);
  }

  #addSubpatterns(path: string, pattern: GlobPattern): void {
    if (this.#cache.add(path, pattern)) return;
    const fullpath = resolve(this.#root, path);
    const stat = this.#cache.statSync(fullpath);
    const last = pattern.last;
    const isDirectory = this.#isDirectorySync(stat, pattern);
    const isLast = pattern.isLast(isDirectory);
    const isFirst = pattern.isFirst();
    const first = pattern.at(0);

    if (isFirst && isWindows && typeof first === "string" && first.endsWith(":")) {
      this.#addSubpattern(`${first}\\`, pattern.child(new Set([1])));
      return;
    }
    if (isFirst && first === "") {
      this.#addSubpattern("/", pattern.child(new Set([1])));
      return;
    }
    if (isFirst && first === "..") {
      this.#addSubpattern("../", pattern.child(new Set([1])));
      return;
    }
    if (isFirst && first === ".") {
      this.#addSubpattern(".", pattern.child(new Set([1])));
      return;
    }

    const lastPart = pattern.at(-1);
    if (isLast && typeof lastPart === "string") {
      const found = this.#cache.statSync(join(fullpath, lastPart));
      if (found && (lastPart || isDirectory)) this.#results.add(join(path, lastPart));
      if (pattern.indexes.size === 1 && pattern.indexes.has(last)) return;
    } else if (
      isLast &&
      lastPart === GLOBSTAR &&
      (path !== "." || first === "." || (last === 0 && stat !== null))
    ) {
      this.#results.add(path);
    }

    if (!isDirectory) return;

    let children: readonly EntryLike[];
    const firstIndex = pattern.indexes.values().next().value;
    const firstPattern =
      pattern.indexes.size === 1 && firstIndex !== undefined ? pattern.at(firstIndex) : undefined;
    if (typeof firstPattern === "string") {
      const found = this.#cache.statSync(join(fullpath, firstPattern));
      if (!found) return;
      children = [
        {
          name: firstPattern,
          isDirectory: () => found.isDirectory(),
          isSymbolicLink: () => found.isSymbolicLink(),
        },
      ];
    } else {
      children = this.#cache.readdirSync(fullpath);
    }

    for (const entry of children) {
      const entryPath = join(path, entry.name);
      const entryFullpath = join(fullpath, entry.name);
      this.#cache.addToStatCache(entryFullpath, entry);
      const entryIsDirectory = entry.isDirectory();

      const subPatterns = new Set<number>();
      const nSymlinks = new Set<number>();
      for (const index of pattern.indexes) {
        const current = pattern.at(index);
        const nextIndex = index + 1;
        const next = pattern.at(nextIndex);
        const fromSymlink = pattern.symlinks.has(index);

        if (current === GLOBSTAR) {
          const isDot = entry.name[0] === ".";
          const nextMatches = pattern.test(nextIndex, entry.name);
          let nextNonGlobIndex = nextIndex;
          while (pattern.at(nextNonGlobIndex) === GLOBSTAR) nextNonGlobIndex++;
          const matchesDot = isDot && pattern.test(nextNonGlobIndex, entry.name);
          if (isDot && !matchesDot) continue;
          if (!fromSymlink && entryIsDirectory) {
            subPatterns.add(index);
          } else if (!fromSymlink && index === last) {
            this.#results.add(entryPath);
          }
          if (nextMatches && nextIndex === last && !isLast) {
            this.#results.add(entryPath);
          } else if (nextMatches && entryIsDirectory) {
            subPatterns.add(index + 2);
          }
          if ((nextMatches || first === ".") && entryIsDirectory && !fromSymlink) {
            subPatterns.add(nextIndex);
          }
          if (entry.isSymbolicLink()) nSymlinks.add(index);
          if (next === ".." && entryIsDirectory) {
            const parent = join(path, "..");
            if (nextIndex < last) {
              if (!this.#subpatterns.has(path) && !this.#cache.seen(path, pattern, nextIndex + 1)) {
                this.#subpatterns.set(path, [pattern.child(new Set([nextIndex + 1]))]);
              }
              if (
                !this.#subpatterns.has(parent) &&
                !this.#cache.seen(parent, pattern, nextIndex + 1)
              ) {
                this.#subpatterns.set(parent, [pattern.child(new Set([nextIndex + 1]))]);
              }
            } else {
              if (!this.#cache.seen(path, pattern, nextIndex)) {
                this.#cache.add(path, pattern.child(new Set([nextIndex])));
                this.#results.add(path);
              }
              if (
                !this.#cache.seen(path, pattern, nextIndex) ||
                !this.#cache.seen(parent, pattern, nextIndex)
              ) {
                this.#cache.add(parent, pattern.child(new Set([nextIndex])));
                this.#results.add(parent);
              }
            }
          }
        }
        if (typeof current === "string") {
          if (pattern.test(index, entry.name) && index !== last) {
            subPatterns.add(nextIndex);
          } else if (current === "." && pattern.test(nextIndex, entry.name)) {
            if (nextIndex === last) this.#results.add(entryPath);
            else subPatterns.add(nextIndex + 1);
          }
        }
        if (isSegmentMatcher(current) && pattern.test(index, entry.name)) {
          if (index === last) this.#results.add(entryPath);
          else if (entryIsDirectory) subPatterns.add(nextIndex);
        }
      }
      if (subPatterns.size > 0) {
        this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks));
      }
    }
  }
}

/**
 * Node 20 fallback, exported for the parity test. Same results, in the same
 * order, as Node 22+ `fs.globSync(pattern, { cwd })`.
 */
export function globSyncFallback(pattern: string, options?: GlobSyncCompatOptions): string[] {
  return new FallbackGlob(pattern, options?.cwd).run();
}
