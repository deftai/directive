/**
 * Scoped staging + installer-managed allowlist for TS-native init/update (#1453).
 *
 * Mirrors cmd/deft-install/hygiene.go + deposit.go installerManagedMatchers.
 *
 * CRITICAL (#1430 / #3030): the allowlist MUST honor the SPEC consumer-path
 * denylist (`CONSUMER_GUARD_MUST_FIRE`). Consumer-authored PROJECT-DEFINITION
 * and scope briefs are never installer-managed; if they reappear in
 * `installerManagedMatchers()`, unit tests and deposit-time assert fail closed.
 *
 * Refs #1576, #1453, #1430, #3029, #3030.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { gitPorcelain } from "../story-ready/git.js";
import { CANONICAL_INSTALL_ROOT, type InitDepositIo } from "./constants.js";

export const CODEQL_CONFIG_REL = ".github/codeql/codeql-config.yml";
export const CORE_GUARD_WORKFLOW_REL = ".github/workflows/deft-core-guard.yml";

// The lifecycle dir names are identical across the legacy `vbrief/` tree and the
// post-#2034 / #2110 `xbrief/` tree, so both allowlist families reuse this list.
const VBRIEF_LIFECYCLE_DIRS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

export interface InstallerManagedMatcher {
  readonly exact?: string;
  readonly prefix?: string;
}

/**
 * Consumer paths that MUST trip no-mixed-core-and-app when mixed with
 * `.deft/core/**` (#1430 SPEC). These probe paths must never match
 * `installerManagedMatchers()` / the deposited guard ERE.
 *
 * Legitimate installer scaffolding (xbrief/.deft-version, lifecycle .gitkeep,
 * schemas/, migration/, xbrief.md) is NOT in this denylist — see #2277.
 * Init may still *create* PROJECT-DEFINITION (#3013); create ≠ allowlist.
 *
 * Refs #3030, #3029, #1430.
 */
export const CONSUMER_GUARD_MUST_FIRE: readonly string[] = [
  "xbrief/PROJECT-DEFINITION.xbrief.json",
  "vbrief/PROJECT-DEFINITION.vbrief.json",
  // Representative consumer scope briefs (not scaffolding markers).
  "xbrief/active/example-scope.xbrief.json",
  "vbrief/active/example-scope.vbrief.json",
  "xbrief/proposed/example-scope.xbrief.json",
  "vbrief/pending/example-scope.vbrief.json",
];

/** Single source of truth for installer-managed paths (#1440 / #1576). */
export function installerManagedMatchers(): InstallerManagedMatcher[] {
  return [
    { exact: "AGENTS.md" },
    { prefix: ".agents/" },
    { prefix: ".githooks/" },
    { exact: ".claude/settings.json" },
    { exact: ".grok/hooks/deft.json" },
    { exact: ".cursor/hooks.json" },
    { exact: ".codex/hooks.json" },
    { exact: ".gitattributes" },
    { exact: ".gitignore" },
    // Installer-deposited Prettier gate exclusion (#2534); must be allowlisted or
    // framework-only deposit PRs trip no-mixed-core-and-app (#2629).
    { exact: ".prettierignore" },
    { exact: "greptile.json" },
    { exact: CODEQL_CONFIG_REL },
    { exact: CORE_GUARD_WORKFLOW_REL },
    { exact: "Taskfile.yml" },
    // Legacy vbrief/ tree -- retained for not-yet-migrated consumers.
    { exact: "vbrief/.deft-version" },
    { exact: "vbrief/vbrief.md" },
    { prefix: "vbrief/schemas/" },
    { prefix: "vbrief/migration/" },
    ...VBRIEF_LIFECYCLE_DIRS.map((sub) => ({ exact: `vbrief/${sub}/.gitkeep` })),
    // Migrated xbrief/ tree (#2034 / #2110). The framework-managed version marker
    // now lives at xbrief/.deft-version, so it MUST be allowlisted or every routine
    // `deft update` framework-deposit PR trips no-mixed-core-and-app (#2277).
    { exact: "xbrief/.deft-version" },
    { exact: "xbrief/xbrief.md" },
    // CRITICAL (#1430 / #3029 / #3030): do NOT allowlist consumer-authored
    // PROJECT-DEFINITION (xbrief/ or vbrief/) or consumer scope briefs.
    // Init may still seed PD (#3013); the seed is app-owned for guard classification
    // so core+PD mixed PRs fail no-mixed-core-and-app. See CONSUMER_GUARD_MUST_FIRE.
    { prefix: "xbrief/schemas/" },
    { prefix: "xbrief/migration/" },
    ...VBRIEF_LIFECYCLE_DIRS.map((sub) => ({ exact: `xbrief/${sub}/.gitkeep` })),
  ];
}

function escapeEre(value: string): string {
  return value.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

function matcherToEre(matcher: InstallerManagedMatcher): string {
  if (matcher.exact) return `^${escapeEre(matcher.exact)}$`;
  return `^${escapeEre(matcher.prefix ?? "")}`;
}

function matchesInstallerManaged(
  path: string,
  matchers: readonly InstallerManagedMatcher[],
): boolean {
  for (const matcher of matchers) {
    if (matcher.exact && path === matcher.exact) return true;
    if (matcher.prefix && path.startsWith(matcher.prefix)) return true;
  }
  return false;
}

/**
 * Fail closed when any #1430 consumer denylist path is covered by the
 * installer-managed allowlist (#3030). Pure over `matchers` so tests can inject
 * a bad matcher without mutating production state.
 */
export function assertInstallerAllowlistHonors1430(
  matchers: readonly InstallerManagedMatcher[] = installerManagedMatchers(),
): void {
  for (const path of CONSUMER_GUARD_MUST_FIRE) {
    if (matchesInstallerManaged(path, matchers)) {
      throw new Error(
        `#1430 violation: ${path} must not be installer-managed (SPEC consumer denylist; see CONSUMER_GUARD_MUST_FIRE / #3030)`,
      );
    }
  }
}

/** POSIX ERE alternation embedded in the deposited deft-core-guard workflow. */
export function installerManagedGuardEre(): string {
  const matchers = installerManagedMatchers();
  // Refuse to emit a guard workflow that would exempt consumer denylist paths.
  assertInstallerAllowlistHonors1430(matchers);
  return matchers.map((matcher) => matcherToEre(matcher)).join("|");
}

export function isInstallerManagedPath(path: string): boolean {
  return matchesInstallerManaged(path, installerManagedMatchers());
}

export interface MixedCoreAndAppClassification {
  readonly core: string[];
  readonly installerManaged: string[];
  readonly app: string[];
  /** True when both core and app are non-empty — the deposited guard fails. */
  readonly wouldFail: boolean;
}

/**
 * TS twin of Go `classifyChangedPaths` / deposited shell guard (#1430).
 * Core = `.deft/core/**`; installer-managed = allowlist; app = everything else.
 * Guard fails iff both core and app are non-empty.
 */
export function classifyMixedCoreAndApp(
  changedPaths: readonly string[],
  matchers: readonly InstallerManagedMatcher[] = installerManagedMatchers(),
): MixedCoreAndAppClassification {
  const core: string[] = [];
  const installerManaged: string[] = [];
  const app: string[] = [];
  for (const raw of changedPaths) {
    const path = raw.replace(/\\/g, "/");
    if (!path) continue;
    if (path === ".deft/core" || path.startsWith(".deft/core/")) {
      core.push(path);
    } else if (matchesInstallerManaged(path, matchers)) {
      installerManaged.push(path);
    } else {
      app.push(path);
    }
  }
  return {
    core,
    installerManaged,
    app,
    wouldFail: core.length > 0 && app.length > 0,
  };
}

export interface FrameworkStagePathsOptions {
  /**
   * Include the vendored `.deft/core` payload in the stage set. Defaults to
   * `true` for init and real payload swaps. No-op updates set this to `false`
   * so CRLF-only core noise cannot be staged while safe projections are repaired.
   */
  readonly includeCore?: boolean;
  /**
   * Include the project-root ``Taskfile.yml`` in the stage set. Defaults to
   * ``false``: unlike the other allowlisted paths, ``Taskfile.yml`` is a
   * consumer-owned file that merely *contains* an installer-managed include
   * block, so it must only be staged when the installer actually wired that
   * block this run -- otherwise an unrelated user edit would be silently
   * ``git add``ed (#1576 review).
   */
  readonly includeTaskfile?: boolean;
}

export function frameworkStagePaths(
  projectDir: string,
  deftDir: string,
  options: FrameworkStagePathsOptions = {},
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string): void => {
    const normalized = rel.replace(/\\/g, "/");
    if (!normalized || normalized === "." || seen.has(normalized)) return;
    if (!existsSync(join(projectDir, normalized))) return;
    seen.add(normalized);
    paths.push(normalized);
  };

  const relDeft = relative(projectDir, deftDir);
  if (
    options.includeCore !== false &&
    relDeft &&
    !relDeft.startsWith("..") &&
    !relDeft.startsWith("/")
  ) {
    add(relDeft);
  }

  for (const matcher of installerManagedMatchers()) {
    if (matcher.exact === "Taskfile.yml" && !options.includeTaskfile) continue;
    if (matcher.exact) {
      add(matcher.exact);
    } else if (matcher.prefix) {
      add(matcher.prefix.replace(/\/$/, ""));
    }
  }
  return paths;
}

export interface StageFrameworkPathsSeams {
  gitPorcelain?: (projectRoot: string) => string | null;
  runGitAdd?: (projectDir: string, paths: readonly string[]) => void;
}

/** Best-effort scoped `git add` — never fails the install/update (#1453 Layer 2b). */
export function stageFrameworkPaths(
  projectDir: string,
  paths: readonly string[],
  seams: StageFrameworkPathsSeams = {},
): { staged: boolean; error: Error | null } {
  if (paths.length === 0) return { staged: false, error: null };
  const readPorcelain = seams.gitPorcelain ?? gitPorcelain;
  if (readPorcelain(projectDir) === null) return { staged: false, error: null };
  const runGitAdd =
    seams.runGitAdd ??
    ((root: string, stagePaths: readonly string[]) => {
      execFileSync("git", ["add", ...stagePaths], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    });
  try {
    runGitAdd(projectDir, paths);
    return { staged: true, error: null };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return { staged: false, error };
  }
}

/**
 * Framework-internal subdirectories that are shipped as part of the source
 * repository but are NOT included in the `@deftai/directive-content` npm
 * package deposited into `.deft/core/`. If one of these paths survives from
 * a prior git-vendored install, `deft update`'s additive file-swap will never
 * remove it — causing the deposit-hygiene advisory to persist indefinitely.
 *
 * Each entry is a relative path within `.deft/core/`; presence in the CONTENT
 * root overrides the prune (i.e. if the content package ever ships `packages/`
 * again, we won't prune it).
 *
 * Refs #2347.
 */
export const STRAY_DEPOSIT_FRAMEWORK_PATHS = ["packages"] as const;

/**
 * Deposit-local files generated by init/update that are intentionally absent
 * from `@deftai/directive-content` (#2804).
 */
export const DEPOSIT_GENERATED_METADATA_PATHS = ["VERSION"] as const;

export function isDepositGeneratedMetadata(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return (DEPOSIT_GENERATED_METADATA_PATHS as readonly string[]).includes(normalized);
}

function normalizeRelativePath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function listRelativeFilePathsSync(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  walk(root, "");
  return results;
}

async function listRelativeFilePaths(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = normalizeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  await walk(root, "");
  return results;
}

function contentDirectoryPaths(contentFiles: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of contentFiles) {
    let dir = dirname(file);
    while (dir && dir !== ".") {
      dirs.add(normalizeRelativePath(dir));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return dirs;
}

/**
 * List deposit-relative paths that are absent from the installed content package,
 * excluding generated deposit metadata such as `VERSION` (#2804).
 */
export function findPackageAbsentDepositPathsSync(deftDir: string, contentRoot: string): string[] {
  const depositFiles = listRelativeFilePathsSync(deftDir);
  const contentFiles = new Set(listRelativeFilePathsSync(contentRoot));
  return depositFiles
    .filter((rel) => !contentFiles.has(rel) && !isDepositGeneratedMetadata(rel))
    .sort();
}

export async function findPackageAbsentDepositPaths(
  deftDir: string,
  contentRoot: string,
): Promise<string[]> {
  const depositFiles = await listRelativeFilePaths(deftDir);
  const contentFiles = new Set(await listRelativeFilePaths(contentRoot));
  return depositFiles
    .filter((rel) => !contentFiles.has(rel) && !isDepositGeneratedMetadata(rel))
    .sort();
}

export interface PrunePackageAbsentDepositPathsResult {
  readonly pruned: string[];
  readonly prunedDirs: string[];
}

async function pruneEmptyParentsForFile(
  deftDir: string,
  contentDirs: ReadonlySet<string>,
  relFile: string,
): Promise<string[]> {
  const prunedDirs: string[] = [];
  let rel = dirname(relFile);
  while (rel && rel !== ".") {
    const normalized = normalizeRelativePath(rel);
    if (contentDirs.has(normalized)) break;
    const abs = join(deftDir, rel);
    try {
      if (!existsSync(abs) || readdirSync(abs).length !== 0) break;
      rmSync(abs, { recursive: false, force: true });
      prunedDirs.push(normalized);
    } catch {
      break;
    }
    rel = dirname(rel);
  }
  return prunedDirs;
}

/**
 * Remove deposit files not shipped by `@deftai/directive-content`, preserving
 * generated deposit metadata such as `VERSION` (#2804). Subsumes the legacy
 * hard-coded `packages/` prune (#2347).
 *
 * Individual removal failures are reported but do not throw — callers that must
 * refuse a VERSION stamp until the deposit matches the content package should
 * use {@link reconcileDepositToContentPackage} (#2913).
 */
export async function prunePackageAbsentDepositPaths(
  deftDir: string,
  contentRoot: string,
  io: InitDepositIo,
): Promise<PrunePackageAbsentDepositPathsResult> {
  const absent = await findPackageAbsentDepositPaths(deftDir, contentRoot);
  const contentDirs = contentDirectoryPaths(listRelativeFilePathsSync(contentRoot));
  const pruned: string[] = [];
  const prunedDirs: string[] = [];
  for (const rel of absent) {
    try {
      rmSync(join(deftDir, rel), { force: true });
      pruned.push(rel);
      prunedDirs.push(...(await pruneEmptyParentsForFile(deftDir, contentDirs, rel)));
    } catch (cause) {
      io.printf(`Warning: could not prune .deft/core/${rel}: ${String(cause)}\n`);
    }
  }
  if (pruned.length > 0) {
    io.printf(
      `Pruned ${pruned.length} package-absent deposit file(s) not shipped by @deftai/directive-content (#2804).\n`,
    );
  }
  return { pruned, prunedDirs };
}

/**
 * Fail-closed deposit reconcile against the installed content package (#2913).
 *
 * Runs {@link prunePackageAbsentDepositPaths}, then re-scans. If any
 * package-absent path remains, throws so callers refuse the VERSION stamp
 * (dst-only stale/malicious agent content must not survive a refresh).
 *
 * After a successful {@link replaceTree} full-swap this is typically a no-op
 * verification; it also covers additive copy seams and the already-current
 * refresh path that skips payload copy.
 */
export async function reconcileDepositToContentPackage(
  deftDir: string,
  contentRoot: string,
  io: InitDepositIo,
): Promise<PrunePackageAbsentDepositPathsResult> {
  const result = await prunePackageAbsentDepositPaths(deftDir, contentRoot, io);
  const remaining = await findPackageAbsentDepositPaths(deftDir, contentRoot);
  if (remaining.length > 0) {
    const sample = remaining.slice(0, 5).join(", ");
    const more = remaining.length > 5 ? ` (+${remaining.length - 5} more)` : "";
    throw new Error(
      `deposit reconcile failed: ${remaining.length} package-absent path(s) remain under .deft/core ` +
        `(e.g. ${sample}${more}). Refusing VERSION stamp until dst-only content is removed (#2913).`,
    );
  }
  return result;
}

export interface PruneStrayDepositPathsResult {
  readonly pruned: string[];
}

/**
 * Remove framework-source subdirectories from `.deft/core/` that are not
 * present in the deposited content package (#2347). Silently skips any path
 * that is also present in `contentRoot` (future-safe: if the content package
 * ever ships `packages/` we stop pruning it).
 */
export async function pruneStrayDepositPaths(
  deftDir: string,
  contentRoot: string,
  io: InitDepositIo,
): Promise<PruneStrayDepositPathsResult> {
  const pruned: string[] = [];
  for (const rel of STRAY_DEPOSIT_FRAMEWORK_PATHS) {
    const depositPath = join(deftDir, rel);
    const contentPath = join(contentRoot, rel);
    let isInDeposit = false;
    let isInContent = false;
    try {
      isInDeposit = (await stat(depositPath)).isDirectory();
    } catch {
      // absent — nothing to prune
    }
    if (!isInDeposit) continue;
    try {
      isInContent = (await stat(contentPath)).isDirectory();
    } catch {
      // not in content package — safe to prune
    }
    if (isInContent) continue;
    try {
      await rm(depositPath, { recursive: true, force: true });
      pruned.push(rel);
      io.printf(
        `Pruned stray framework-source tree .deft/core/${rel}/ — not shipped by @deftai/directive-content (#2347).\n`,
      );
    } catch (cause) {
      io.printf(`Warning: could not prune .deft/core/${rel}/: ${String(cause)}\n`);
    }
  }
  return { pruned };
}

export const COMMIT_HYGIENE_BRANCH_NAME = "chore/deft-framework-upgrade";

export function printCommitGuidance(
  io: InitDepositIo,
  paths: readonly string[],
  staged: boolean,
): void {
  if (paths.length === 0) return;
  const addCmd = `git add ${paths.join(" ")}`;
  io.printf("\nCommit hygiene (#1453, #1671): keep the framework deposit in its OWN branch/PR.\n");
  io.printf("Do NOT use `git add -A` -- mixing the payload with your own files trips the\n");
  io.printf("deft-core-guard CI check.\n");
  if (staged) {
    io.printf("The installer already staged ONLY these framework + installer-managed paths:\n");
    io.printf(`  ${addCmd}\n`);
  } else {
    io.printf("Stage ONLY these framework + installer-managed paths:\n");
    io.printf(`  ${addCmd}\n`);
  }
  io.printf("Then take the framework deposit through the full PR lifecycle so deft-core-guard\n");
  io.printf("evaluates a clean, standalone PR:\n");
  io.printf(`  1. Branch: git switch -c ${COMMIT_HYGIENE_BRANCH_NAME}\n`);
  io.printf('  2. Commit: git commit -m "chore(deft): update framework payload"\n');
  io.printf(`  3. Push:   git push -u origin ${COMMIT_HYGIENE_BRANCH_NAME}\n`);
  io.printf('  4. PR:     gh pr create --fill --title "chore(deft): update framework payload"\n');
  io.printf("  5. Merge:  gh pr merge --squash --delete-branch   # after deft-core-guard passes\n");
}

function defaultCachedNames(projectDir: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\0")
      .map((entry) => entry.trim().replace(/\\/g, "/"))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Narrow the candidate stage paths to those that actually have staged index
 * changes. A candidate file matches when the cached name is identical; a
 * candidate directory (e.g. ``.deft/core``) matches when any cached name lives
 * beneath it. This keeps ``staged_paths`` honest for downstream automation --
 * it reports what git actually staged, not every path passed to ``git add``.
 */
function actuallyStagedPaths(
  stagePaths: readonly string[],
  cachedNames: readonly string[],
): string[] {
  return stagePaths.filter((candidate) =>
    cachedNames.some((name) => name === candidate || name.startsWith(`${candidate}/`)),
  );
}

export interface DepositStagePathsOptions
  extends StageFrameworkPathsSeams,
    FrameworkStagePathsOptions {
  readCachedNames?: (projectDir: string) => string[];
}

export function depositStagePaths(
  projectDir: string,
  options: DepositStagePathsOptions = {},
): {
  stagePaths: string[];
  staged: boolean;
  stagedPaths: string[];
} {
  const deftDir = join(projectDir, CANONICAL_INSTALL_ROOT);
  const stagePaths = frameworkStagePaths(projectDir, deftDir, {
    includeCore: options.includeCore,
    includeTaskfile: options.includeTaskfile ?? false,
  });
  const { staged } = stageFrameworkPaths(projectDir, stagePaths, options);
  const readCachedNames = options.readCachedNames ?? defaultCachedNames;
  const cachedNames = staged ? readCachedNames(projectDir) : [];
  return {
    stagePaths,
    staged,
    stagedPaths: staged ? actuallyStagedPaths(stagePaths, cachedNames) : [],
  };
}
