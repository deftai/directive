/**
 * Stage-2 provenance migration (#1941): stamp a canonical-vendored `.deft/core`
 * deposit as npm-managed so the npm channel + `directive update` own the payload.
 *
 * This is a THIN provenance verb (locked decision F): the on-disk shape is
 * UNCHANGED. It never normalizes legacy layouts (stage-1 frozen Go guarantees
 * canonical-vendored input), never moves/renames/trims `.deft/core` content, and
 * NEVER downloads a payload (#1933 never-first-start decree).
 *
 * Flow:
 *   1. Detect a canonical-vendored `.deft/core/VERSION` deposit (reuse the
 *      manifest locator in doctor/manifest.ts).
 *   2. Idempotency: if the manifest already carries the npm-managed handshake
 *      sentinel (`managed_by: 'npm'`), make zero changes (already-hybrid).
 *   3. Engine-resolve check: verify the global engine resolves via
 *      content-root.ts `resolveContentPackageRoot`. If absent, signpost the
 *      README and return needs-action -- NEVER install/download.
 *   4. Stamp the sentinel into the manifest. The timestamped backup is written
 *      outside `.deft/core` (user-cache `deft/backups`, else OS temp).
 *
 * Three-state result:
 *   - exitCode 0: migrated OR already-hybrid
 *   - exitCode 1: needs action (engine missing -> README signpost)
 *   - exitCode 2: config error (no canonical-vendored deposit / unreadable manifest)
 *
 * Refs #1941, #1912 (freeze prerequisite b), #1933 (never-first-start), #1670.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContentPackageRoot } from "../content-root.js";
import { locateManifest, parseInstallManifest } from "../doctor/manifest.js";
import {
  containedWrite,
  ContainedWriteError,
  ContainedWriteErrorCode,
} from "../fs/contained-write.js";
import { CANONICAL_INSTALL_ROOT } from "./scaffold.js";

/**
 * The npm-managed handshake sentinel. `directive migrate` adds this key/value to
 * the install manifest (`.deft/core/VERSION`) to mark the deposit as owned by the
 * npm content channel. `doctor` (parseInstallManifest reads every colon
 * key/value line) and future `directive update` recognize it; its presence is
 * also the idempotency signal that the deposit is already hybrid.
 */
export const NPM_MANAGED_SENTINEL_KEY = "managed_by";
export const NPM_MANAGED_SENTINEL_VALUE = "npm";

/** The npm package the README tells operators to install for the engine. */
export const ENGINE_PACKAGE_NAME = "@deftai/directive";

export type MigrateOutcome =
  | "migrated"
  | "already-hybrid"
  | "engine-missing"
  | "no-deposit"
  | "manifest-unreadable";

export interface MigrateResult {
  readonly outcome: MigrateOutcome;
  readonly exitCode: 0 | 1 | 2;
  readonly manifestPath: string | null;
  readonly backupPath: string | null;
  readonly sentinelKey: string;
  readonly message: string;
}

export interface MigrateSeams {
  /** Existence probe (default: node:fs existsSync). */
  isFile?: (path: string) => boolean;
  /** Text read returning null on failure (default: node:fs readFileSync, utf8). */
  readText?: (path: string) => string | null;
  /** Text write (default: containedWrite under projectRoot; #2980 wave A). */
  writeText?: (path: string, text: string) => void;
  /** ISO-8601 UTC timestamp source for the backup filename (default: Date.now). */
  nowIso?: () => string;
  /** Engine-resolve check; returns the resolved content package root or null. */
  resolveEngine?: () => string | null;
  /**
   * Out-of-tree directory for the VERSION backup (#4812). Default is the
   * user-cache `deft/backups` root. A root inside the project is refused.
   */
  backupRootDir?: () => string;
  /**
   * Backup bytes. Default is containedWrite rooted at the backup directory,
   * not the project. A project root refuses the cache and temp paths.
   * An EXISTS refusal from mode "create" is retried under another filename.
   */
  writeBackup?: (path: string, text: string) => void;
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function migrateModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Default engine-resolve check: walk up from this module's own install location
 * (a globally-installed engine has the `@deftai/directive-content` package as a
 * sibling in the same node_modules) and return the resolved content package
 * root, or null when the engine does not resolve.
 */
function defaultResolveEngine(): string | null {
  return resolveContentPackageRoot(migrateModuleDir());
}

/** Filesystem-safe rendering of an ISO-8601 timestamp for a backup suffix. */
function backupSuffix(nowIso: string): string {
  return nowIso.replace(/:/g, "-");
}

/** Stable per-project key so one shared backup directory cannot collide (#4812). */
function projectBackupKey(projectRoot: string): string {
  const abs = resolve(projectRoot);
  const canonical = process.platform === "win32" ? abs.toLowerCase() : abs;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** `VERSION.bak.<project-key>.<suffix>`. The key is not a path and not in-tree. */
export function migrateVersionBackupName(projectRoot: string, suffix: string): string {
  return `VERSION.bak.${projectBackupKey(projectRoot)}.${suffix}`;
}

function backupNameTaken(skip: ReadonlySet<string>, candidate: string): boolean {
  return existsSync(candidate) || skip.has(candidate) || skip.has(resolve(candidate));
}

function unusedBackupFile(dir: string, baseName: string, skip: ReadonlySet<string>): string {
  const first = join(dir, baseName);
  if (!backupNameTaken(skip, first)) return first;
  const pid = process.pid;
  for (let n = 1; n < 10000; n += 1) {
    const candidate = join(dir, `${baseName}.${pid}.${n}`);
    if (!backupNameTaken(skip, candidate)) return candidate;
  }
  const stamp = Date.now();
  for (let n = 0; n < 100; n += 1) {
    const candidate = join(dir, `${baseName}.${pid}.${stamp}.${n}`);
    if (!backupNameTaken(skip, candidate)) return candidate;
  }
  return join(dir, `${baseName}.${pid}.${stamp}.last`);
}

function userCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local) return local;
    const home = (env.USERPROFILE ?? env.HOME)?.trim();
    if (!home) return null;
    return join(home, "AppData", "Local");
  }
  if (platform === "darwin") {
    const home = env.HOME?.trim();
    if (!home) return null;
    return join(home, "Library", "Caches");
  }
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) return xdg;
  const home = env.HOME?.trim();
  if (!home) return null;
  return join(home, ".cache");
}

/** `<user-cache>/deft/backups`, else the OS temp dir (#1445 / #4812). */
export function defaultVersionBackupRootDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(userCacheDir(env, platform) ?? tmpdir(), "deft", "backups");
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Timestamped VERSION backup outside the project tree (#4812).
 * Prefers `backupRootDir` (user-cache `deft/backups`), then OS temp `deft-backups`,
 * then `deft-core-bak-*`. A root inside the project, including `.deft/backups/`, is skipped.
 */
export function resolveMigrateBackupFile(
  projectRoot: string,
  suffix: string,
  backupRootDir?: () => string,
  skip: ReadonlySet<string> = new Set(),
): string {
  const fileName = migrateVersionBackupName(projectRoot, suffix);
  const roots = [
    backupRootDir ?? (() => defaultVersionBackupRootDir()),
    () => join(tmpdir(), "deft-backups"),
  ];
  for (const rootFn of roots) {
    let dir = "";
    try {
      dir = rootFn();
      if (dir.trim().length === 0) continue;
      mkdirSync(dir, { recursive: true });
    } catch {
      continue;
    }
    const candidate = unusedBackupFile(dir, fileName, skip);
    if (pathIsInside(projectRoot, candidate)) continue;
    if (backupNameTaken(skip, candidate)) continue;
    return candidate;
  }
  const fallback = join(mkdtempSync(join(tmpdir(), "deft-core-bak-")), fileName);
  if (!backupNameTaken(skip, fallback) && !pathIsInside(projectRoot, fallback)) return fallback;
  return join(mkdtempSync(join(tmpdir(), "deft-core-bak-")), `${fileName}.${process.pid}.1`);
}

function writeBackupFile(path: string, text: string): void {
  const root = dirname(path);
  mkdirSync(root, { recursive: true });
  // Root is the backup directory, not the project. create refuses an overwrite.
  containedWrite({
    root,
    target: path,
    data: text,
    mode: "create",
  });
}

function isBackupCreateExists(err: unknown): boolean {
  return err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS;
}

/**
 * Same-second callers can both observe one free name. The loser of mode
 * "create" gets EXISTS; pick another name instead of aborting the stamp.
 * Any other failure is invoked again outside the catch so that refusal still
 * stops the migration.
 */
function writeMigrateBackup(
  projectRoot: string,
  suffix: string,
  text: string,
  backupRootDir: (() => string) | undefined,
  writeBackup: (path: string, text: string) => void,
): string {
  const rejected = new Set<string>();
  let lastPath = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const backupPath = resolveMigrateBackupFile(projectRoot, suffix, backupRootDir, rejected);
    lastPath = backupPath;
    let failed: unknown = null;
    try {
      writeBackup(backupPath, text);
    } catch (err) {
      failed = err;
    }
    if (failed === null) return backupPath;
    if (!isBackupCreateExists(failed)) {
      writeBackup(backupPath, text);
      return backupPath;
    }
    rejected.add(backupPath);
    rejected.add(resolve(backupPath));
  }
  writeBackup(lastPath, text);
  return lastPath;
}

/**
 * Locate the canonical-vendored install manifest (`.deft/core/VERSION`).
 * Returns the path only when the canonical install-root manifest is present;
 * legacy `.deft/VERSION` / `deft/VERSION` layouts are intentionally NOT
 * normalized here (stage-1 guarantees canonical-vendored input).
 */
export function detectCanonicalVendoredManifest(
  projectRoot: string,
  isFile: (path: string) => boolean = existsSync,
): string | null {
  const canonical = join(projectRoot, CANONICAL_INSTALL_ROOT, "VERSION");
  const located = locateManifest(projectRoot, CANONICAL_INSTALL_ROOT, isFile);
  return located === canonical ? located : null;
}

/** True when the manifest already carries the npm-managed handshake sentinel. */
export function isNpmManaged(manifest: Record<string, string>): boolean {
  return manifest[NPM_MANAGED_SENTINEL_KEY] === NPM_MANAGED_SENTINEL_VALUE;
}

/** Append the npm-managed sentinel line to existing manifest text. */
export function stampManifestText(text: string): string {
  const base = text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
  return `${base}${NPM_MANAGED_SENTINEL_KEY}: '${NPM_MANAGED_SENTINEL_VALUE}'\n`;
}

function engineMissingMessage(): string {
  return (
    `directive migrate: the global Deft engine (${ENGINE_PACKAGE_NAME}) does not resolve.\n` +
    "Install it first, then re-run migrate:\n\n" +
    `  npm i -g ${ENGINE_PACKAGE_NAME}\n\n` +
    "See the README (Install / Upgrade) for details. migrate never installs or " +
    "downloads payload on your behalf (#1933)."
  );
}

/**
 * Orchestrate the stage-2 provenance migration for `projectRoot`. Pure of
 * process exit; the caller maps {@link MigrateResult.exitCode} to a process code.
 */
export function runMigrate(projectRoot: string, seams: MigrateSeams = {}): MigrateResult {
  const isFile = seams.isFile ?? existsSync;
  const readText = seams.readText ?? defaultReadText;
  const writeText =
    seams.writeText ??
    ((path: string, text: string) => {
      // #2980 wave A: product write sink routes through containedWrite.
      containedWrite({
        root: resolve(projectRoot),
        target: path,
        data: text,
        mode: "replace",
      });
    });
  const nowIso = seams.nowIso ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const resolveEngine = seams.resolveEngine ?? defaultResolveEngine;
  const writeBackup = seams.writeBackup ?? writeBackupFile;

  const manifestPath = detectCanonicalVendoredManifest(projectRoot, isFile);
  if (manifestPath === null) {
    return {
      outcome: "no-deposit",
      exitCode: 2,
      manifestPath: null,
      backupPath: null,
      sentinelKey: NPM_MANAGED_SENTINEL_KEY,
      message: `directive migrate: no canonical-vendored ${CANONICAL_INSTALL_ROOT}/VERSION deposit found under ${projectRoot}. Nothing to migrate.`,
    };
  }

  const text = readText(manifestPath);
  // `parseInstallManifest` always returns a record (never null), so the only
  // unreadable/empty cases are a failed read or a manifest with no key/value
  // lines; both map to the same config error.
  const manifest = text === null ? {} : parseInstallManifest(text);
  if (text === null || Object.keys(manifest).length === 0) {
    return {
      outcome: "manifest-unreadable",
      exitCode: 2,
      manifestPath,
      backupPath: null,
      sentinelKey: NPM_MANAGED_SENTINEL_KEY,
      message: `directive migrate: install manifest at ${manifestPath} is empty or unreadable.`,
    };
  }

  if (isNpmManaged(manifest)) {
    return {
      outcome: "already-hybrid",
      exitCode: 0,
      manifestPath,
      backupPath: null,
      sentinelKey: NPM_MANAGED_SENTINEL_KEY,
      message: `directive migrate: ${manifestPath} is already npm-managed (already hybrid) -- no change.`,
    };
  }

  if (resolveEngine() === null) {
    return {
      outcome: "engine-missing",
      exitCode: 1,
      manifestPath,
      backupPath: null,
      sentinelKey: NPM_MANAGED_SENTINEL_KEY,
      message: engineMissingMessage(),
    };
  }

  const backupPath = writeMigrateBackup(
    projectRoot,
    backupSuffix(nowIso()),
    text,
    seams.backupRootDir,
    writeBackup,
  );
  writeText(manifestPath, stampManifestText(text));

  return {
    outcome: "migrated",
    exitCode: 0,
    manifestPath,
    backupPath,
    sentinelKey: NPM_MANAGED_SENTINEL_KEY,
    message: `directive migrate: stamped ${manifestPath} npm-managed (${NPM_MANAGED_SENTINEL_KEY}: '${NPM_MANAGED_SENTINEL_VALUE}'); backup written to ${backupPath}.`,
  };
}

export interface RunMigrateCliOptions {
  readonly projectDir: string;
  readonly jsonOut: boolean;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly seams?: MigrateSeams;
}

function buildMigrateSummaryJson(
  result: MigrateResult,
  projectDir: string,
): Record<string, unknown> {
  return {
    success: result.exitCode === 0,
    action: "migrate",
    outcome: result.outcome,
    exit_code: result.exitCode,
    project_dir: projectDir,
    manifest_path: result.manifestPath,
    backup_path: result.backupPath,
    sentinel_key: result.sentinelKey,
    sentinel_value: NPM_MANAGED_SENTINEL_VALUE,
    message: result.message,
  };
}

/**
 * CLI-facing wrapper: runs the migration, emits JSON or human output, maps the
 * outcome to a 0/1/2 exit code. Engine-missing prints the README signpost to
 * stderr; config errors print to stderr; success prints to stdout.
 */
export function runMigrateCli(options: RunMigrateCliOptions): number {
  const result = runMigrate(options.projectDir, options.seams);

  if (options.jsonOut) {
    options.writeOut(
      `${JSON.stringify(buildMigrateSummaryJson(result, options.projectDir), null, 2)}\n`,
    );
    return result.exitCode;
  }

  if (result.exitCode === 0) {
    options.writeOut(`${result.message}\n`);
  } else {
    options.writeErr(`${result.message}\n`);
  }
  return result.exitCode;
}

/** One-line nudge for init/update/session completion when provenance is unstamped (#2059). */
export const MIGRATE_COMPLETION_NUDGE =
  "[deft] One-time: run `directive migrate` to stamp npm provenance (idempotent). See content/UPGRADING.md.";

/** True when a canonical-vendored deposit exists and lacks the npm-managed sentinel. */
export function shouldEmitMigrateNudge(
  projectRoot: string,
  seams: Pick<MigrateSeams, "isFile" | "readText"> = {},
): boolean {
  const isFile = seams.isFile ?? existsSync;
  const readText = seams.readText ?? defaultReadText;
  const manifestPath = detectCanonicalVendoredManifest(projectRoot, isFile);
  if (manifestPath === null) return false;
  const text = readText(manifestPath);
  if (text === null) return false;
  const manifest = parseInstallManifest(text);
  if (Object.keys(manifest).length === 0) return false;
  return !isNpmManaged(manifest);
}

export interface MigrateNudgeIo {
  printf: (text: string) => void;
}

/** Prints {@link MIGRATE_COMPLETION_NUDGE} when {@link shouldEmitMigrateNudge} is true. */
export function printMigrateNudgeIfNeeded(
  projectRoot: string,
  io: MigrateNudgeIo,
  seams: Pick<MigrateSeams, "isFile" | "readText"> = {},
): void {
  if (shouldEmitMigrateNudge(projectRoot, seams)) {
    io.printf(`\n${MIGRATE_COMPLETION_NUDGE}\n`);
  }
}
