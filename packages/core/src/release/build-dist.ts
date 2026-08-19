import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NON_PRODUCT_DIRS } from "../fs/non-product-dirs.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

type ArchiverInstance = {
  pipe: (dest: ReturnType<typeof createWriteStream>) => void;
  file: (path: string | Buffer, opts: { name: string }) => void;
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

export type ArchiveSourceEntry = { absPath: string | Buffer; archiveRel: string };

/** Original `ls-files -z` segment bytes plus the display/skip string. */
export type GitLsFilesPath = {
  readonly relPosix: string;
  readonly bytes: Buffer;
};

export type ArchiveFsLookup = {
  realpathSync: (
    path: string | Buffer,
    options?: { encoding?: BufferEncoding | "buffer" | null },
  ) => string | Buffer;
  lstatSync: (path: string | Buffer) => ReturnType<typeof lstatSync>;
};

const defaultArchiveFs: ArchiveFsLookup = {
  realpathSync: (path, options) => {
    if (options?.encoding === "buffer") {
      return realpathSync(path, { encoding: "buffer" });
    }
    return realpathSync(path);
  },
  lstatSync: (path) => lstatSync(path),
};

/** `-z` stdout is a NUL-separated byte stream; never UTF-8-decode it whole. */
export const GIT_LS_FILES_Z_ENCODING = null;

export type GitLsFilesZSpawn = (
  command: string,
  args: readonly string[],
  options: {
    encoding: null;
    timeout?: number;
    maxBuffer?: number;
    stdio?: readonly ["ignore", "pipe", "pipe"];
  },
) => {
  status: number | null;
  stdout?: Buffer | string | null;
  stderr?: Buffer | string | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
};

/** Decode one `ls-files -z` segment; keep non-UTF-8 bytes as latin1. */
export function decodeGitLsFilesPath(segment: Buffer): string {
  const utf8 = segment.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(segment)) return utf8;
  return segment.toString("latin1");
}

/** Split a raw `git ls-files -z` Buffer on 0x00, keeping original path bytes. */
export function splitGitLsFilesZRecords(stdout: Buffer): GitLsFilesPath[] {
  const paths: GitLsFilesPath[] = [];
  let start = 0;
  for (let i = 0; i < stdout.length; i += 1) {
    if (stdout[i] === 0) {
      if (i > start) {
        const bytes = Buffer.from(stdout.subarray(start, i));
        paths.push({ relPosix: decodeGitLsFilesPath(bytes), bytes });
      }
      start = i + 1;
    }
  }
  if (start < stdout.length) {
    const bytes = Buffer.from(stdout.subarray(start));
    paths.push({ relPosix: decodeGitLsFilesPath(bytes), bytes });
  }
  return paths;
}

/** Split a raw `git ls-files -z` Buffer on 0x00, then decode each path. */
export function splitGitLsFilesZ(stdout: Buffer): string[] {
  return splitGitLsFilesZRecords(stdout).map((p) => p.relPosix);
}

function spawnTextFromMaybeBuffer(value: Buffer | string | null | undefined): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function bufferFromSpawnStdout(value: Buffer | string | null | undefined): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

/**
 * Return `git ls-files -z` paths with original bytes. Fail closed when git
 * cannot enumerate tracked files -- a walk would pack host-local untracked
 * state (#3490).
 */
export function listGitTrackedPathRecords(
  root: string,
  spawn: GitLsFilesZSpawn = spawnSync,
): GitLsFilesPath[] {
  // Pin to root/.git so a nested --root cannot walk up and pack a parent repo.
  const result = spawn("git", ["-C", root, "--git-dir=.git", "--work-tree=.", "ls-files", "-z"], {
    encoding: GIT_LS_FILES_Z_ENCODING,
    timeout: 30_000,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error) {
    const detail =
      spawnTextFromMaybeBuffer(result.stderr).trim() ||
      spawnTextFromMaybeBuffer(result.stdout).trim() ||
      result.error?.message ||
      "unknown error";
    throw new Error(`git ls-files failed in ${root}: ${detail}`);
  }
  return splitGitLsFilesZRecords(bufferFromSpawnStdout(result.stdout));
}

/** Return `git ls-files -z` paths in POSIX form. */
export function listGitTrackedFiles(root: string, spawn: GitLsFilesZSpawn = spawnSync): string[] {
  return listGitTrackedPathRecords(root, spawn).map((p) => p.relPosix);
}

/**
 * Fail closed when any resolved archive path is untracked and not on the
 * generated-output allowlist (#3490).
 */
export function assertArchiveEntriesTrackedOrGenerated(
  root: string,
  rels: readonly string[],
  generatedAllowlist: readonly string[] = DEFAULT_GENERATED_ALLOWLIST,
  spawn: GitLsFilesZSpawn = spawnSync,
): void {
  const tracked = new Set(listGitTrackedFiles(root, spawn));
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
  readonly spawn?: GitLsFilesZSpawn;
  readonly fs?: ArchiveFsLookup;
};

function isInsideRoot(root: string, absPath: string): boolean {
  const rel = relative(resolve(root), absPath);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

type CanonicalArchiveRoot = { readonly text: string; readonly bytes: Buffer };

/** Canonicalize the supplied archive root once per resolve (#3490 review). */
function canonicalArchiveRoot(root: string, fs: ArchiveFsLookup): CanonicalArchiveRoot {
  try {
    const real = fs.realpathSync(root, { encoding: "buffer" });
    if (Buffer.isBuffer(real)) {
      return { text: real.toString("utf8"), bytes: real };
    }
    return { text: real, bytes: Buffer.from(real, "utf8") };
  } catch {
    throw new Error(`build-dist: cannot resolve archive root: ${root}`);
  }
}

/** Join canonical root bytes with original git path bytes; convert POSIX `/` to OS sep. */
export function joinRootAndRelBytes(rootBytes: Buffer, relBytes: Buffer): Buffer {
  const sepByte = sep.charCodeAt(0);
  const converted = Buffer.from(relBytes);
  if (sep !== "/") {
    for (let i = 0; i < converted.length; i += 1) {
      if (converted[i] === 0x2f) converted[i] = sepByte;
    }
  }
  if (converted.length === 0) return rootBytes;
  const rootEndsSep = rootBytes.length > 0 && rootBytes[rootBytes.length - 1] === sepByte;
  const relStartsSep = converted[0] === sepByte;
  if (rootEndsSep && relStartsSep) return Buffer.concat([rootBytes, converted.subarray(1)]);
  if (rootEndsSep || relStartsSep) return Buffer.concat([rootBytes, converted]);
  return Buffer.concat([rootBytes, Buffer.from([sepByte]), converted]);
}

/**
 * String path when the `-z` segment is valid UTF-8; otherwise a Buffer that
 * keeps the original filename bytes for fs lookup (#3490 residual).
 */
export function fsLookupPath(
  root: string,
  relPosix: string,
  bytes: Buffer,
  rootBytes?: Buffer,
): string | Buffer | null {
  const contained = containedAbsPath(root, relPosix);
  if (contained === null) return null;
  if (Buffer.from(relPosix, "utf8").equals(bytes)) return contained;
  return joinRootAndRelBytes(rootBytes ?? Buffer.from(resolve(root), "utf8"), bytes);
}

function isInsideResolved(
  canonicalRoot: string,
  canonicalBytes: Buffer,
  real: string | Buffer,
): boolean {
  if (typeof real === "string") return isInsideRoot(canonicalRoot, real);
  const sepByte = sep.charCodeAt(0);
  if (real.equals(canonicalBytes)) return true;
  const prefix =
    canonicalBytes.length > 0 && canonicalBytes[canonicalBytes.length - 1] === sepByte
      ? canonicalBytes
      : Buffer.concat([canonicalBytes, Buffer.from([sepByte])]);
  if (real.length < prefix.length) return false;
  if (real.subarray(0, prefix.length).equals(prefix)) return true;
  if (process.platform === "win32") {
    return (
      real.subarray(0, prefix.length).toString("utf8").toLowerCase() ===
      prefix.toString("utf8").toLowerCase()
    );
  }
  return false;
}

/** Resolve a POSIX rel path under root, or null if it escapes (#3490 review). */
export function containedAbsPath(root: string, relPosix: string): string | null {
  if (relPosix.includes("\0")) return null;
  // Git index paths are POSIX (`/` only). A literal `\` is a filename byte
  // (gitglossary "path"); splitting on `\` would pack `foo\bar` as nested
  // path segments and could escape the root. Node resolve still fail-closes
  // OS-separator `..\` via isInsideRoot.
  const parts = relPosix.split("/");
  if (parts.some((part) => part === "..")) return null;
  const absPath = resolve(root, ...parts.filter((part) => part.length > 0 && part !== "."));
  if (!isInsideRoot(root, absPath)) return null;
  return absPath;
}

function toArchiveEntry(
  root: string,
  canonicalRoot: CanonicalArchiveRoot,
  relPosix: string,
  bytes: Buffer,
  fs: ArchiveFsLookup,
): ArchiveSourceEntry | null {
  const lookup = fsLookupPath(root, relPosix, bytes, canonicalRoot.bytes);
  if (lookup === null) return null;
  let real: string | Buffer;
  try {
    // realpath resolves leaf and ancestor symlinks before the file-type check.
    // Buffer lookup keeps invalid filename bytes; a string would re-encode UTF-8.
    real = Buffer.isBuffer(lookup)
      ? fs.realpathSync(lookup, { encoding: "buffer" })
      : fs.realpathSync(lookup);
  } catch {
    return null;
  }
  // Compare against the canonical root so a symlink *to* the checkout is
  // inside, while a symlink *out of* the tree still throws.
  if (!isInsideResolved(canonicalRoot.text, canonicalRoot.bytes, real)) {
    throw new Error(`build-dist: path resolves outside the archive root: ${relPosix}`);
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = fs.lstatSync(real);
  } catch {
    return null;
  }
  if (st == null || !st.isFile()) return null;
  return { absPath: real, archiveRel: flattenContentPrefix(relPosix) };
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
  const spawn = options.spawn ?? spawnSync;
  const fs = options.fs ?? defaultArchiveFs;
  const canonicalRoot = canonicalArchiveRoot(root, fs);
  const tracked = listGitTrackedPathRecords(root, spawn);
  const entries: ArchiveSourceEntry[] = [];
  const sourceRels: string[] = [];
  const seen = new Set<string>();
  for (const { relPosix, bytes } of tracked) {
    if (shouldSkipRel(relPosix, excludes, excludedPrefixes)) continue;
    const entry = toArchiveEntry(root, canonicalRoot, relPosix, bytes, fs);
    if (entry === null) continue;
    entries.push(entry);
    sourceRels.push(relPosix);
    seen.add(relPosix);
  }
  for (const relPosix of generatedAllowlist) {
    if (seen.has(relPosix)) continue;
    if (containedAbsPath(root, relPosix) === null) {
      throw new Error(`build-dist: generated allowlist path escapes the archive root: ${relPosix}`);
    }
    const entry = toArchiveEntry(root, canonicalRoot, relPosix, Buffer.from(relPosix, "utf8"), fs);
    if (entry === null) continue;
    entries.push(entry);
    sourceRels.push(relPosix);
    seen.add(relPosix);
  }
  assertArchiveEntriesTrackedOrGenerated(root, sourceRels, generatedAllowlist, spawn);
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
