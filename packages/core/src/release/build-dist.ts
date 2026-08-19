import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { NON_PRODUCT_DIRS } from "../fs/non-product-dirs.js";
import { runGit } from "./git.js";

type ArchiverInstance = {
  pipe: (dest: ReturnType<typeof createWriteStream>) => void;
  file: (path: string, opts: { name: string }) => void;
  finalize: () => void | Promise<void>;
  on: (event: "error", handler: (err: Error) => void) => void;
};

// archiver v8 dropped the v7 `archiver(format, options)` factory in favour of
// per-format classes (`new ZipArchive(opts)` / `new TarArchive(opts)`). Require
// the CJS module via createRequire so the built ESM dist resolves it correctly.
type ArchiverModule = {
  ZipArchive: new (options?: object) => ArchiverInstance;
  TarArchive: new (options?: object) => ArchiverInstance;
};

const { ZipArchive, TarArchive } = createRequire(import.meta.url)("archiver") as ArchiverModule;

/**
 * Shared "not product source" core (#3487) plus the coverage artifacts only the
 * release archive names. Scratch and agent worktrees are never shippable
 * framework content (#2953). The archive set is git-tracked files (#3490); this
 * denylist is defence in depth, including for a tracked path under a core name.
 *
 * Callers may still widen this per run via `extraExcludes` / `--exclude-extra`.
 */
export const DEFAULT_EXCLUDES = new Set([...NON_PRODUCT_DIRS, "htmlcov", ".coverage", "coverage"]);

export const DEFAULT_EXCLUDED_PATH_PREFIXES = [
  "history/archive",
  "vbrief/completed",
  "vbrief/cancelled",
] as const;

/**
 * Generated outputs that may be packed even when untracked. Empty by default:
 * the release archive is a source distribution, so extra outputs must be named
 * explicitly (#3490).
 */
export const DEFAULT_GENERATED_ALLOWLIST: readonly string[] = [];

export const ARCHIVE_ROOT = "deft";
export const CONTENT_PREFIX = "content/";

/** Raised when the resolved archive set contains an untracked surprise (#3490). */
export class UntrackedArchiveEntryError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    const listed = paths.join(", ");
    super(
      `build-dist: refusing to pack untracked files not on the generated-output allowlist: ${listed}`,
    );
    this.name = "UntrackedArchiveEntryError";
    this.paths = paths;
  }
}

const VENDORED_TS_TEST_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/i;

function flattenContentPrefix(relPosix: string): string {
  if (relPosix === "content") return relPosix;
  if (relPosix.startsWith(CONTENT_PREFIX)) {
    return relPosix.slice(CONTENT_PREFIX.length);
  }
  return relPosix;
}

function matchesExcludedPrefix(relPosix: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => relPosix === prefix || relPosix.startsWith(`${prefix}/`));
}

function isVendoredTsTest(relPosix: string): boolean {
  if (relPosix !== "packages" && !relPosix.startsWith("packages/")) {
    return false;
  }
  const basename = relPosix.split("/").pop() ?? "";
  return VENDORED_TS_TEST_RE.test(basename);
}

function pathHasExcludedComponent(relPosix: string, excludes: ReadonlySet<string>): boolean {
  return relPosix.split("/").some((part) => excludes.has(part));
}

function shouldSkipRel(
  relPosix: string,
  excludes: ReadonlySet<string>,
  excludedPrefixes: readonly string[],
): boolean {
  return (
    pathHasExcludedComponent(relPosix, excludes) ||
    matchesExcludedPrefix(relPosix, excludedPrefixes) ||
    isVendoredTsTest(relPosix)
  );
}

export type ArchiveSourceEntry = { absPath: string; archiveRel: string };

/**
 * Return `git ls-files -z` paths in POSIX form. Fail closed when git cannot
 * enumerate tracked files -- a walk would pack host-local untracked state (#3490).
 */
export function listGitTrackedFiles(root: string): string[] {
  // Pin to root/.git so a nested --root cannot walk up and pack a parent repo.
  const result = runGit(root, ["--git-dir=.git", "--work-tree=.", "ls-files", "-z"]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "unknown error";
    throw new Error(`git ls-files failed in ${root}: ${detail}`);
  }
  return result.stdout
    .split("\0")
    .map((line) => line.replace(/\r?\n/g, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * Fail closed when any resolved archive path is untracked and not on the
 * generated-output allowlist (#3490).
 */
export function assertArchiveEntriesTrackedOrGenerated(
  root: string,
  rels: readonly string[],
  generatedAllowlist: readonly string[] = DEFAULT_GENERATED_ALLOWLIST,
): void {
  const tracked = new Set(listGitTrackedFiles(root));
  const allowed = new Set(generatedAllowlist);
  const surprise = rels.filter((rel) => !tracked.has(rel) && !allowed.has(rel));
  if (surprise.length > 0) {
    throw new UntrackedArchiveEntryError(surprise);
  }
}

export type ResolveArchiveEntriesOptions = {
  readonly extraExcludes?: readonly string[];
  readonly excludedPrefixes?: readonly string[];
  readonly generatedAllowlist?: readonly string[];
};

function toArchiveEntry(root: string, relPosix: string): ArchiveSourceEntry | null {
  const absPath = join(root, ...relPosix.split("/"));
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { absPath, archiveRel: flattenContentPrefix(relPosix) };
}

/**
 * Derive the archive file set from git-tracked paths plus an explicit
 * generated-output allowlist. The basename denylist remains defence in depth.
 */
export function resolveArchiveEntries(
  root: string,
  options: ResolveArchiveEntriesOptions = {},
): ArchiveSourceEntry[] {
  const excludes = new Set([...DEFAULT_EXCLUDES, ...(options.extraExcludes ?? [])]);
  const excludedPrefixes = options.excludedPrefixes ?? DEFAULT_EXCLUDED_PATH_PREFIXES;
  const generatedAllowlist = options.generatedAllowlist ?? DEFAULT_GENERATED_ALLOWLIST;
  const tracked = listGitTrackedFiles(root);
  const entries: ArchiveSourceEntry[] = [];
  const sourceRels: string[] = [];
  const seen = new Set<string>();
  for (const relPosix of tracked) {
    if (shouldSkipRel(relPosix, excludes, excludedPrefixes)) continue;
    const entry = toArchiveEntry(root, relPosix);
    if (entry === null) continue;
    entries.push(entry);
    sourceRels.push(relPosix);
    seen.add(relPosix);
  }
  for (const relPosix of generatedAllowlist) {
    if (seen.has(relPosix)) continue;
    const entry = toArchiveEntry(root, relPosix);
    if (entry === null) continue;
    entries.push(entry);
    sourceRels.push(relPosix);
    seen.add(relPosix);
  }
  assertArchiveEntriesTrackedOrGenerated(root, sourceRels, generatedAllowlist);
  entries.sort((a, b) => a.archiveRel.localeCompare(b.archiveRel));
  return entries;
}

export function iterSourceFiles(
  root: string,
  excludes: ReadonlySet<string> = DEFAULT_EXCLUDES,
  excludedPrefixes: readonly string[] = DEFAULT_EXCLUDED_PATH_PREFIXES,
): Array<{ absPath: string; archiveRel: string }> {
  const entries: Array<{ absPath: string; archiveRel: string }> = [];

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (excludes.has(name)) continue;
      const absPath = join(dir, name);
      let relPosix: string;
      try {
        relPosix = relative(root, absPath).split("\\").join("/");
      } catch {
        continue;
      }
      if (matchesExcludedPrefix(relPosix, excludedPrefixes)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(absPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(absPath);
        continue;
      }
      if (!st.isFile()) continue;
      if (isVendoredTsTest(relPosix)) continue;
      entries.push({ absPath, archiveRel: flattenContentPrefix(relPosix) });
    }
  };

  walk(root);
  entries.sort((a, b) => a.archiveRel.localeCompare(b.archiveRel));
  return entries;
}

export function selectFormat(arg: string | null | undefined): "tar" | "zip" {
  if (arg) return arg.toLowerCase() === "zip" ? "zip" : "tar";
  return platform().startsWith("win") ? "zip" : "tar";
}

export function outputPath(root: string, version: string, fmt: "tar" | "zip"): string {
  const suffix = fmt === "zip" ? "zip" : "tar.gz";
  return join(root, "dist", `deft-${version}.${suffix}`);
}

export type BuildProgress = {
  readonly stage: string;
  readonly detail?: string;
  readonly current?: number;
  readonly total?: number;
};

export type BuildArchiveOptions = {
  readonly extraExcludes?: readonly string[];
  /** Untracked generated outputs that may be packed (#3490). */
  readonly generatedAllowlist?: readonly string[];
  /** Progress sink; default silent so unit tests stay quiet (#2953). */
  readonly onProgress?: (p: BuildProgress) => void;
};

/**
 * Emit human-readable stage progress for long release packaging runs (#2953).
 * Writes to stderr so stdout stays the archive path for pipeline capture.
 */
export function emitBuildProgress(
  progress: BuildProgress,
  stream: { write: (chunk: string) => unknown } = process.stderr,
): void {
  const { stage, detail, current, total } = progress;
  let line = `build-dist: ${stage}`;
  if (typeof current === "number" && typeof total === "number" && total > 0) {
    const pct = Math.min(100, Math.floor((current / total) * 100));
    line += ` ${current}/${total} (${pct}%)`;
  }
  if (detail) line += ` - ${detail}`;
  stream.write(`${line}\n`);
}

function isExtraExcludesList(
  options: readonly string[] | BuildArchiveOptions,
): options is readonly string[] {
  return Array.isArray(options);
}

function resolveBuildOptions(options: readonly string[] | BuildArchiveOptions = {}): {
  extraExcludes: readonly string[];
  generatedAllowlist: readonly string[];
  onProgress: (p: BuildProgress) => void;
} {
  // Backward-compatible: 4th arg may be a bare extra-excludes array (pre-#2953).
  if (isExtraExcludesList(options)) {
    return {
      extraExcludes: options,
      generatedAllowlist: DEFAULT_GENERATED_ALLOWLIST,
      onProgress: () => {},
    };
  }
  return {
    extraExcludes: options.extraExcludes ?? [],
    generatedAllowlist: options.generatedAllowlist ?? DEFAULT_GENERATED_ALLOWLIST,
    onProgress: options.onProgress ?? (() => {}),
  };
}

export async function buildArchive(
  root: string,
  version: string,
  fmt: "tar" | "zip",
  options: readonly string[] | BuildArchiveOptions = {},
): Promise<string> {
  const { extraExcludes, generatedAllowlist, onProgress } = resolveBuildOptions(options);
  const output = outputPath(root, version, fmt);
  mkdirSync(dirname(output), { recursive: true });
  if (existsSync(output)) {
    unlinkSync(output);
  }
  onProgress({ stage: "scan", detail: "enumerating tracked source files" });
  const entries = resolveArchiveEntries(root, { extraExcludes, generatedAllowlist });
  const total = entries.length;
  onProgress({ stage: "scan", detail: `found ${total} files`, current: total, total });

  await new Promise<void>((resolvePromise, reject) => {
    const out = createWriteStream(output);
    const archive =
      fmt === "zip"
        ? new ZipArchive({ zlib: { level: 9 } })
        : new TarArchive({ gzip: true, gzipOptions: { level: 9 } });
    out.on("close", () => resolvePromise());
    out.on("error", (err: Error) => reject(err));
    archive.on("error", (err: Error) => reject(err));
    archive.pipe(out);
    onProgress({ stage: "pack", detail: `format=${fmt}`, current: 0, total });
    // Progress ticks every ~5% (or every 250 files) so long packs do not look hung.
    const tickEvery = Math.max(1, Math.min(250, Math.ceil(total / 20)));
    let i = 0;
    for (const { absPath, archiveRel } of entries) {
      archive.file(absPath, { name: `${ARCHIVE_ROOT}/${archiveRel}` });
      i += 1;
      if (i === total || i % tickEvery === 0) {
        onProgress({ stage: "pack", current: i, total });
      }
    }
    onProgress({ stage: "finalize", detail: output });
    void archive.finalize();
  });

  onProgress({ stage: "done", detail: output, current: total, total });
  return output;
}

export function parseExtraExcludes(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  let version: string | null = null;
  let fmtArg: string | null = null;
  let root: string | null = null;
  let extra = "";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--version") version = args[++i] as string;
    else if (arg === "--format") fmtArg = args[++i] as string;
    else if (arg === "--root") root = args[++i] as string;
    else if (arg === "--exclude-extra") extra = args[++i] as string;
    else if (arg === "-h" || arg === "--help") {
      process.stderr.write(
        "usage: build-dist --version X.Y.Z [--format tar|zip] [--root PATH] [--exclude-extra a,b]\n",
      );
      return 2;
    }
  }

  if (!version) {
    process.stderr.write("error: --version is required\n");
    return 2;
  }
  const projectRoot = resolve(root ?? process.cwd());
  if (!existsSync(projectRoot)) {
    process.stderr.write(`error: root not found: ${projectRoot}\n`);
    return 2;
  }
  const fmt = selectFormat(fmtArg);
  try {
    const out = await buildArchive(projectRoot, version, fmt, {
      extraExcludes: parseExtraExcludes(extra),
      onProgress: emitBuildProgress,
    });
    const printable = relative(projectRoot, out) || out;
    process.stdout.write(`Created ${printable}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${String(err)}\n`);
    return 1;
  }
}
