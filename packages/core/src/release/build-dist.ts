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
 * framework content (#2953); no tracked path lives under any core entry, so the
 * shared core removes only untracked operator state from the archive.
 *
 * Callers may still widen this per run via `extraExcludes` / `--exclude-extra`.
 */
export const DEFAULT_EXCLUDES = new Set([...NON_PRODUCT_DIRS, "htmlcov", ".coverage", "coverage"]);

export const DEFAULT_EXCLUDED_PATH_PREFIXES = [
  "history/archive",
  "vbrief/completed",
  "vbrief/cancelled",
] as const;

export const ARCHIVE_ROOT = "deft";
export const CONTENT_PREFIX = "content/";

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
  onProgress: (p: BuildProgress) => void;
} {
  // Backward-compatible: 4th arg may be a bare extra-excludes array (pre-#2953).
  if (isExtraExcludesList(options)) {
    return { extraExcludes: options, onProgress: () => {} };
  }
  return {
    extraExcludes: options.extraExcludes ?? [],
    onProgress: options.onProgress ?? (() => {}),
  };
}

export async function buildArchive(
  root: string,
  version: string,
  fmt: "tar" | "zip",
  options: readonly string[] | BuildArchiveOptions = {},
): Promise<string> {
  const { extraExcludes, onProgress } = resolveBuildOptions(options);
  const excludes = new Set([...DEFAULT_EXCLUDES, ...extraExcludes]);
  const output = outputPath(root, version, fmt);
  mkdirSync(dirname(output), { recursive: true });
  if (existsSync(output)) {
    unlinkSync(output);
  }
  onProgress({ stage: "scan", detail: "enumerating source files" });
  const entries = iterSourceFiles(root, excludes);
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
