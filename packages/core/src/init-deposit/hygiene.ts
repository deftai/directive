/**
 * Scoped staging + installer-managed allowlist for TS-native init/update (#1453).
 *
 * Mirrors cmd/deft-install/hygiene.go + deposit.go installerManagedMatchers.
 * Refs #1576, #1453, #1430.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
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

/** Single source of truth for installer-managed paths (#1440 / #1576). */
export function installerManagedMatchers(): InstallerManagedMatcher[] {
  return [
    { exact: "AGENTS.md" },
    { prefix: ".agents/" },
    { prefix: ".githooks/" },
    { exact: ".gitattributes" },
    { exact: ".gitignore" },
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

/** POSIX ERE alternation embedded in the deposited deft-core-guard workflow. */
export function installerManagedGuardEre(): string {
  return installerManagedMatchers()
    .map((matcher) => matcherToEre(matcher))
    .join("|");
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

export function isInstallerManagedPath(path: string): boolean {
  return matchesInstallerManaged(path, installerManagedMatchers());
}

export interface FrameworkStagePathsOptions {
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
  if (relDeft && !relDeft.startsWith("..") && !relDeft.startsWith("/")) {
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
