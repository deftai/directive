/**
 * TS-native healthy-path refresh for `directive update` (#1942 S3).
 *
 * Re-copies the pinned @deftai/directive-content into `.deft/core`, surgically
 * re-renders the AGENTS.md managed-section, runs #1430 neutralization, and
 * discloses refresh side-effects + engine/content version skew.
 *
 * Refs #1942, #1430, #1671.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyTree } from "../deposit/copy-tree.js";
import { resolveInstalledContentRoot } from "../deposit/resolve-content.js";
import { manifestTagToVersion, parseInstallManifest } from "../doctor/manifest.js";
import { readCorePackageVersion } from "../engine-version.js";
import { gitPorcelain } from "../story-ready/git.js";
import { type InitDepositArgs, parseInitArgv } from "./init-deposit.js";
import {
  buildLegacyRefusalJson,
  buildLegacyRefusalMessage,
  detectLegacyLayout,
  LEGACY_LAYOUT_REFUSED_EXIT_CODE,
  type LegacyLayoutDetection,
  LegacyLayoutRefusedError,
} from "./legacy-detect.js";
import {
  CANONICAL_INSTALL_ROOT,
  depositNeutralization,
  type InitDepositIo,
  type InstallManifestFields,
  writeAgentsMd,
  writeInstallManifest,
} from "./scaffold.js";

export interface RefreshDepositArgs extends InitDepositArgs {
  readonly upgrade: boolean;
}

export interface RefreshDepositResult {
  readonly projectDir: string;
  readonly deftDir: string;
  readonly contentVersion: string;
  readonly engineVersion: string;
  readonly previousDepositVersion: string | null;
  readonly agentsMdUpdated: boolean;
  readonly versionSkewNotice: string | null;
  readonly legacyLayout: boolean;
}

export interface RefreshDepositSeams {
  resolveContentRoot?: () => Promise<string>;
  copyContent?: (src: string, dst: string) => Promise<void>;
  readPackageVersion?: () => string;
  readEngineVersion?: () => string;
  nowIso?: () => string;
  gitPorcelain?: (projectRoot: string) => string | null;
  detectLegacy?: (projectDir: string) => LegacyLayoutDetection;
}

const INSTALLER_MANAGED_EXACT = new Set([
  "AGENTS.md",
  ".gitattributes",
  ".gitignore",
  "greptile.json",
  ".github/codeql/codeql-config.yml",
  ".github/workflows/deft-core-guard.yml",
  "vbrief/.deft-version",
  "vbrief/vbrief.md",
  "vbrief/proposed/.gitkeep",
  "vbrief/pending/.gitkeep",
  "vbrief/active/.gitkeep",
  "vbrief/completed/.gitkeep",
  "vbrief/cancelled/.gitkeep",
]);

const INSTALLER_MANAGED_PREFIXES = [
  ".agents/",
  ".githooks/",
  "vbrief/schemas/",
  "vbrief/migration/",
];

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

function readContentPackageVersion(contentRoot: string, fallback: () => string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(contentRoot, "package.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const version = (parsed as { version?: string }).version;
      if (version?.trim()) return version.trim();
    }
  } catch {
    // fall through
  }
  return fallback();
}

function readRecordedDepositVersion(deftDir: string): string | null {
  const manifestPath = join(deftDir, "VERSION");
  if (!existsSync(manifestPath)) return null;
  try {
    return manifestTagToVersion(parseInstallManifest(readFileSync(manifestPath, "utf8")));
  } catch {
    return null;
  }
}

function isInstallerManagedPath(path: string): boolean {
  if (INSTALLER_MANAGED_EXACT.has(path)) return true;
  return INSTALLER_MANAGED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function unquoteGitPath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

function porcelainStatusPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    let rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    const trimmed = unquoteGitPath(rest.trim());
    if (!trimmed) continue;
    paths.push(trimmed.replace(/\\/g, "/"));
  }
  return paths;
}

function classifyChangedPaths(changed: readonly string[]): {
  core: string[];
  installerManaged: string[];
} {
  const core: string[] = [];
  const installerManaged: string[] = [];
  for (const path of changed) {
    if (!path) continue;
    if (path.startsWith(".deft/core/") || path === ".deft/core") {
      core.push(path);
    } else if (isInstallerManagedPath(path)) {
      installerManaged.push(path);
    }
  }
  return { core, installerManaged };
}

/** Framework-managed uncommitted paths after refresh (#1671). */
export function frameworkRefreshSideEffects(
  projectDir: string,
  readPorcelain: (root: string) => string | null = gitPorcelain,
): string[] {
  const porcelain = readPorcelain(projectDir);
  if (porcelain === null) return [];
  const changed = porcelainStatusPaths(porcelain);
  const { core, installerManaged } = classifyChangedPaths(changed);
  const files = [...core, ...installerManaged].sort();
  return files.length > 0 ? files : [];
}

export function printRefreshSideEffects(io: InitDepositIo, files: readonly string[]): void {
  if (files.length === 0) return;
  io.printf("\nAGENTS.md refresh side effects (#1671): the refresh and framework payload swap\n");
  io.printf("left these framework files with uncommitted changes -- they belong in the\n");
  io.printf("framework deposit commit (the installer stages them before printing the\n");
  io.printf("`git add` list below, so there are no post-stage stragglers):\n");
  for (const file of files) {
    io.printf(`  ${file}\n`);
  }
}

export function buildVersionSkewNotice(
  engineVersion: string,
  contentVersion: string,
  previousDepositVersion: string | null,
): string | null {
  const engine = normalizeVersion(engineVersion);
  const content = normalizeVersion(contentVersion);
  if (engine !== content) {
    return (
      `[deft update] Version skew: @deftai/directive-core is v${engine} but ` +
      `@deftai/directive-content is v${content}. Consider aligning npm installs ` +
      "(`npm i -g @deftai/directive@latest`)."
    );
  }
  if (previousDepositVersion !== null) {
    const recorded = normalizeVersion(previousDepositVersion);
    if (recorded !== content) {
      return (
        `[deft update] Version skew: deposited content is v${content} but the ` +
        `recorded manifest was v${recorded}.`
      );
    }
  }
  return null;
}

export function buildUpdateSummaryJson(
  result: RefreshDepositResult,
  options: RefreshDepositArgs,
): Record<string, unknown> {
  return {
    success: true,
    action: "upgrade",
    version: result.engineVersion,
    project_dir: result.projectDir,
    deft_dir: result.deftDir,
    legacy_layout: result.legacyLayout,
    update: true,
    non_interactive: options.nonInteractive,
    upgrade: options.upgrade,
    taskfile_wired: false,
    missing_tools: [],
    maintainer_mode: false,
    maintainer_tools: [],
    skipped_consumer_projections: [],
    user_config_dir: "",
    skills_created: false,
    payload_layout: "vendored",
    strategy: "file-swap",
    dirty_tree: false,
    dirty_files: [],
    staged_paths: [],
    backup_path: "",
    previous_version: result.previousDepositVersion ?? "",
    content_version: result.contentVersion,
    version_skew_notice: result.versionSkewNotice,
    agents_md_updated: result.agentsMdUpdated,
  };
}

export function printUpdateComplete(result: RefreshDepositResult, io: InitDepositIo): void {
  io.printf("\n✓ Deft framework payload refreshed.\n\n");
  io.printf(`  Location     : ${result.deftDir}\n`);
  io.printf(`  Content      : v${normalizeVersion(result.contentVersion)}\n`);
  io.printf(`  AGENTS.md    : ${result.agentsMdUpdated ? "updated" : "already current"}\n`);
  if (result.versionSkewNotice) {
    io.printf(`\n${result.versionSkewNotice}\n`);
  }
  io.printf("\n");
}

export async function runRefreshDeposit(
  args: RefreshDepositArgs,
  io: InitDepositIo,
  seams: RefreshDepositSeams = {},
): Promise<RefreshDepositResult> {
  const projectDir = resolve(args.projectDir);
  const deftDir = join(projectDir, CANONICAL_INSTALL_ROOT);

  // #1912: refuse a legacy on-disk layout BEFORE any refresh. The npm CLI never
  // migrates -- the frozen Go bridge does (stage 1), then the npm path (stage 2).
  const detectLegacy = seams.detectLegacy ?? detectLegacyLayout;
  const legacy = detectLegacy(projectDir);
  if (legacy.legacy) {
    throw new LegacyLayoutRefusedError(legacy);
  }

  const resolveContent = seams.resolveContentRoot ?? resolveInstalledContentRoot;
  const copyContent = seams.copyContent ?? copyTree;
  const readEngine = seams.readEngineVersion ?? readCorePackageVersion;
  const readPackageVersion = seams.readPackageVersion ?? readCorePackageVersion;

  const contentRoot = await resolveContent();
  const previousDepositVersion = readRecordedDepositVersion(deftDir);
  const engineVersion = readEngine();
  const contentVersion = readContentPackageVersion(contentRoot, readPackageVersion);
  const versionSkewNotice = buildVersionSkewNotice(
    engineVersion,
    contentVersion,
    previousDepositVersion,
  );

  await copyContent(contentRoot, deftDir);

  const nowIso = seams.nowIso ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const manifestFields: InstallManifestFields = {
    ref: contentVersion.startsWith("v") ? contentVersion : `v${contentVersion}`,
    sha: "content-package",
    tag: contentVersion.startsWith("v") ? contentVersion : `v${contentVersion}`,
    installRoot: CANONICAL_INSTALL_ROOT,
    fetchedAt: nowIso(),
    fetchedBy: "directive-update",
  };
  writeInstallManifest(projectDir, deftDir, manifestFields);

  const agentsMdUpdated = writeAgentsMd(projectDir, deftDir, io);

  await depositNeutralization(projectDir, io);

  const readPorcelain = seams.gitPorcelain ?? gitPorcelain;
  printRefreshSideEffects(io, frameworkRefreshSideEffects(projectDir, readPorcelain));

  if (versionSkewNotice) {
    io.printf(`${versionSkewNotice}\n`);
  }

  return {
    projectDir,
    deftDir,
    contentVersion,
    engineVersion,
    previousDepositVersion,
    agentsMdUpdated,
    versionSkewNotice,
    legacyLayout: false,
  };
}

export interface RunRefreshDepositCliOptions extends RefreshDepositArgs {
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly seams?: RefreshDepositSeams;
}

/** CLI-facing wrapper: runs refresh, emits JSON or wizard UX, returns exit code. */
export async function runRefreshDepositCli(options: RunRefreshDepositCliOptions): Promise<number> {
  const io: InitDepositIo = {
    printf: (text) => {
      if (options.jsonOut) {
        options.writeErr(text);
      } else {
        options.writeOut(text);
      }
    },
  };

  try {
    const result = await runRefreshDeposit(options, io, options.seams);
    if (options.jsonOut) {
      options.writeOut(`${JSON.stringify(buildUpdateSummaryJson(result, options), null, 2)}\n`);
      printUpdateComplete(result, { printf: options.writeErr });
    } else {
      printUpdateComplete(result, io);
    }
    return 0;
  } catch (cause) {
    if (cause instanceof LegacyLayoutRefusedError) {
      io.printf(buildLegacyRefusalMessage("update", cause.detection));
      if (options.jsonOut) {
        options.writeOut(
          `${JSON.stringify(buildLegacyRefusalJson("update", resolve(options.projectDir), cause.detection), null, 2)}\n`,
        );
      }
      return LEGACY_LAYOUT_REFUSED_EXIT_CODE;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    options.writeErr(`directive update: ${message}\n`);
    if (options.jsonOut) {
      options.writeOut(
        `${JSON.stringify({ success: false, error: message, error_code: "refresh_deposit_failed" }, null, 2)}\n`,
      );
    }
    return 1;
  }
}

export function parseUpdateArgv(
  canonicalArgv: readonly string[],
  userArgv: readonly string[] = [],
): RefreshDepositArgs {
  const base = parseInitArgv(canonicalArgv, userArgv);
  const args = [...canonicalArgv, ...userArgv];
  let upgrade = false;
  for (const arg of args) {
    if (arg === "--upgrade" || arg === "/upgrade") {
      upgrade = true;
    }
  }
  return { ...base, upgrade };
}
