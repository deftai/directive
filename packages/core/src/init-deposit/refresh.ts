/**
 * TS-native healthy-path refresh for `directive update` (#1942 S3).
 *
 * Re-copies the pinned @deftai/directive-content into `.deft/core`, surgically
 * re-renders the AGENTS.md managed-section, runs #1430 neutralization, and
 * discloses refresh side-effects + engine/content version skew.
 *
 * Refs #1942, #1430, #1671.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";
import type { ResolutionFacts, ResolutionPlan } from "@deftai/directive-types";
import { assertDepositContained } from "../deposit/contain.js";
import { replaceTree } from "../deposit/copy-tree.js";
import { prunePythonArtifactsFromDeposit } from "../deposit/python-free.js";
import { resolveInstalledContentRoot } from "../deposit/resolve-content.js";
import { manifestTagToVersion, parseInstallManifest } from "../doctor/manifest.js";
import { readCorePackageVersion } from "../engine-version.js";
import { readLiveGeneration, stampLiveGeneration } from "../freshness/generation.js";
import {
  activeMutationLedger,
  formatMutationSummary,
  type MutationSummary,
  mutationSummaryJson,
  runWithMutationLedger,
  snapshotMutationSummary,
} from "../fs/mutation-ledger.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import {
  detectNoDeftDirective,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
} from "../policy/no-deft-directive.js";
import { runOrgForceOnMigration } from "../policy/org-force-on-migration.js";
import {
  type ClassifySeams,
  checkLocalEngineIntegrity,
  classify,
  ENGINE_PACKAGE,
  type EngineInstallRunner,
  type EngineResolution,
  type LadderFacts,
  plan,
  type ReprojectRunner,
  renderGlobalInstall,
  resolveEngine,
} from "../resolution/index.js";
import { depositOpenClawSoftRebindSkill } from "../session/openclaw-soft-rebind-deposit.js";
import { depositOpenClawL2ProductCommands } from "../slash/openclaw-deposit.js";
import { gitPorcelain } from "../story-ready/git.js";
import {
  type AgentHookReadinessResult,
  agentHookReadinessJson,
  evaluateAgentHookReadiness,
  evaluateAgentHookReadinessSafely,
} from "../verify-env/agent-hook-readiness.js";
import { removeStaleMigratedFrameworkNarrative } from "../xbrief-migrate/migrate-project.js";
import { writeAgentHookDeposit } from "./agent-hooks.js";
import { ensureInitGitignoreLines, type GitLsFiles, isDepositTrackedInGit } from "./gitignore.js";
import {
  depositStagePaths,
  installerManagedMatchers,
  isInstallerManagedPath,
  printCommitGuidance,
  reconcileDepositToContentPackage,
} from "./hygiene.js";
import { type InitDepositArgs, parseInitArgv } from "./init-deposit.js";
import {
  buildLegacyRefusalJson,
  buildLegacyRefusalMessage,
  detectLegacyLayout,
  LEGACY_LAYOUT_REFUSED_EXIT_CODE,
  type LegacyLayoutDetection,
  LegacyLayoutRefusedError,
} from "./legacy-detect.js";
import { printMigrateNudgeIfNeeded } from "./migrate.js";
import { ensurePrettierIgnoreLines } from "./prettierignore.js";
import {
  CANONICAL_INSTALL_ROOT,
  depositNeutralization,
  ensureTaskfile,
  type GitHooksSeams,
  type InitDepositIo,
  type InstallManifestFields,
  writeAgentsMd,
  writeConsumerGitHooks,
  writeInstallManifest,
} from "./scaffold.js";
import { writeMultiHostSkillDiscovery } from "./skill-discovery-deposit.js";
import { writeSlashCommandDeposit } from "./slash-deposit.js";
import {
  syncBareVersionMarker,
  syncConsumerXbriefSchemas,
  syncExistingBareVersionMarker,
} from "./xbrief-projections.js";

export interface RefreshDepositArgs extends InitDepositArgs {
  readonly upgrade: boolean;
}

export interface RefreshDepositResult {
  readonly projectDir: string;
  readonly deftDir: string;
  readonly contentVersion: string;
  readonly engineVersion: string;
  readonly previousDepositVersion: string | null;
  readonly alreadyCurrent: boolean;
  readonly strategy: RefreshDepositStrategy;
  readonly agentsMdUpdated: boolean;
  readonly versionSkewNotice: string | null;
  readonly legacyLayout: boolean;
  readonly taskfileWired: boolean;
  readonly stagedPaths: string[];
  /** This-run write/remove ledger (#3392). Same source as printf + JSON. */
  readonly mutations: MutationSummary;
}

function hasCanonicalXbriefLifecycle(projectDir: string): boolean {
  try {
    resolveLifecycleRoot(projectDir);
    return true;
  } catch {
    return false;
  }
}

export type RefreshDepositStrategy = "file-swap" | "no-op";

export interface RefreshDepositSeams {
  resolveContentRoot?: () => Promise<string>;
  copyContent?: (src: string, dst: string) => Promise<void>;
  readPackageVersion?: () => string;
  readEngineVersion?: () => string;
  nowIso?: () => string;
  gitPorcelain?: (projectRoot: string) => string | null;
  gitSemanticDiffNames?: GitSemanticDiffNames;
  detectLegacy?: (projectDir: string) => LegacyLayoutDetection;
  /**
   * #2266: `git ls-files` probe threaded into the non-destructive `.gitignore`
   * upkeep so the refresh never invokes a destructive `git rm --cached` path.
   */
  gitLsFiles?: GitLsFiles;
  /** #2530: injected git config seams for {@link writeConsumerGitHooks}. */
  gitHooks?: GitHooksSeams;
  /** #2822: optional seam for trusted-org policy force-on migration. */
  runOrgForceOn?: (projectRoot: string) => void;
  /** Post-deposit functional readiness gate (#3100). */
  evaluateAgentHookReadiness?: (projectRoot: string) => AgentHookReadinessResult;
}

/**
 * The four states `directive update` classifies an EXISTING install into BEFORE
 * any copy (#2266). Derived from the keystone `classify()`/`plan()` spine
 * (#2264) — there is exactly one classifier in the system; this maps the shared
 * {@link ResolutionPlan} onto the narrow update-verb contract.
 *
 * - `not-initialized`     — no Directive footprint at all; STOP, hint `init`.
 * - `current`             — initialized and already up to date; refresh is a no-op.
 * - `updated`             — initialized and the refresh forward-migrates content.
 * - `migration-required`  — pre-cutover artifacts; `update` is not enough.
 */
export type UpdateState = "not-initialized" | "current" | "updated" | "migration-required";

export interface UpdateClassification {
  readonly state: UpdateState;
  readonly plan: ResolutionPlan;
  readonly facts: ResolutionFacts;
}

/** The exact refusal shown when `update` runs against an un-initialized project. */
export const NOT_INITIALIZED_MESSAGE = "This project is not initialized. Run directive init.";

/** `update` refused because the project has no install / needs a different verb. */
export const UPDATE_REFUSED_EXIT_CODE = 1;

/** A project is initialized when it carries ANY Directive footprint. */
function isInitialized(facts: ResolutionFacts): boolean {
  return facts.hasDeftCore || facts.hasManagedSection || facts.pinVersion !== null;
}

/**
 * Collapse the shared resolution {@link ResolutionPlan} onto the four update
 * states. Pre-cutover wins over everything (migrate before any refresh); a
 * project with no footprint is not-initialized; an initialized project that the
 * spine says can `proceed` is already current; everything else (deposit
 * reconstitution, content behind pin, engine self-heal) is an `updated` refresh.
 */
export function updateStateFromPlan(
  facts: ResolutionFacts,
  resolutionPlan: ResolutionPlan,
): UpdateState {
  if (resolutionPlan.mode === "migrate") return "migration-required";
  if (!isInitialized(facts)) return "not-initialized";
  if (resolutionPlan.mode === "proceed") return "current";
  return "updated";
}

/**
 * Run the up-front four-state classifier (#2266). Reuses the keystone
 * `classify()` fact-set + `plan()` precedence table — no second classifier.
 */
export function classifyUpdateState(
  projectDir: string,
  classifySeams: ClassifySeams = {},
): UpdateClassification {
  const facts = classify(projectDir, classifySeams);
  const resolutionPlan = plan(facts, {});
  return { state: updateStateFromPlan(facts, resolutionPlan), plan: resolutionPlan, facts };
}

export interface SelfHealSeams {
  /** Pre-computed ladder facts; when omitted, cheap local probes build them. */
  readonly ladderFacts?: LadderFacts;
  /** Injected side-effecting install runner; when omitted, the install is deferred. */
  readonly engineInstallRunner?: EngineInstallRunner;
  /** Injected content re-projection after a fresh install. */
  readonly reproject?: ReprojectRunner;
}

/**
 * Cheap, non-networked ladder facts for the default self-heal path. The global
 * engine version is whatever `classify()` already probed; the local sandbox
 * engine integrity is a filesystem check. `registryUp`/`globalPrefixWritable`
 * default optimistic so the ladder surfaces the canonical `npm i -g` remediation
 * when no install runner is wired.
 */
export function buildDefaultLadderFacts(projectDir: string, facts: ResolutionFacts): LadderFacts {
  const integrity = checkLocalEngineIntegrity(projectDir);
  return {
    pinVersion: facts.pinVersion,
    globalEngineVersion: facts.engineReachable ? facts.engineVersion : null,
    localEngine: integrity.present ? { version: null, integrity } : null,
    registryUp: true,
    globalPrefixWritable: true,
    stagedTarballAvailable: false,
    platform: osPlatform(),
  };
}

/**
 * Self-heal a mismatched / unreachable engine by DELEGATING to the keystone
 * global-first ladder (`resolveEngine`, #2264). The refresh's content copy comes
 * from the resolved content package and does not itself require the engine, so
 * this is a best-effort heal that prints the ladder trace and remediation; when
 * a caller wires an install runner, the ladder performs the install with zero
 * manual npm/PATH steps (#2266 a3).
 */
export function selfHealEngine(
  projectDir: string,
  facts: ResolutionFacts,
  io: InitDepositIo,
  seams: SelfHealSeams = {},
): EngineResolution {
  const ladderFacts = seams.ladderFacts ?? buildDefaultLadderFacts(projectDir, facts);
  const resolution = resolveEngine(ladderFacts, {
    installRunner: seams.engineInstallRunner,
    reproject: seams.reproject,
  });
  io.printf(`\n[deft update] engine self-heal (global-first ladder): ${resolution.trace}\n`);
  if (!resolution.selfHealed && !resolution.decision.usable) {
    io.printf(`[deft update] ${resolution.decision.reason}\n`);
    if (resolution.decision.rung === "install-global") {
      const suffix = facts.pinVersion ? `@${facts.pinVersion}` : "";
      const spec = `${ENGINE_PACKAGE}${suffix}`;
      io.printf(`  Remediation: ${renderGlobalInstall("npm", spec)}\n`);
      io.printf(`               (pnpm: ${renderGlobalInstall("pnpm", spec)})\n`);
    }
  }
  return resolution;
}

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

export interface RefreshDepositPlan {
  readonly contentRoot: string;
  readonly previousDepositVersion: string | null;
  readonly contentVersion: string;
  readonly engineVersion: string;
  readonly alreadyCurrent: boolean;
  readonly strategy: RefreshDepositStrategy;
  readonly versionSkewNotice: string | null;
  readonly plannedFileCount: number;
  readonly plannedPaths: string[];
}

function displayVersion(version: string | null): string {
  return version === null || version.trim() === "" ? "unknown" : normalizeVersion(version);
}

function listContentRelPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const nextAbs = join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(nextAbs, nextRel);
        continue;
      }
      if (entry.isFile()) {
        out.push(nextRel.replace(/\\/g, "/"));
      }
    }
  };
  walk(root, "");
  return out.sort();
}

/** Installer-managed consumer paths a file-swap refresh also writes (#3437). */
function plannedInstallerManagedPaths(): string[] {
  const paths: string[] = [];
  for (const matcher of installerManagedMatchers()) {
    if (matcher.exact) paths.push(matcher.exact);
    else if (matcher.prefix) paths.push(matcher.prefix);
  }
  return paths;
}

function plannedRefreshPaths(strategy: RefreshDepositStrategy, contentRoot: string): string[] {
  if (strategy === "no-op") return [];
  const core = listContentRelPaths(contentRoot).map((rel) => `${CANONICAL_INSTALL_ROOT}/${rel}`);
  return [...new Set([...core, ...plannedInstallerManagedPaths()])].sort();
}

/** Top-level prefix rollup for dry-run blast-radius lines (#3437). */
export function rollupPlannedPathPrefixes(paths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    const slash = normalized.indexOf("/");
    const prefix = slash === -1 ? normalized : `${normalized.slice(0, slash)}/`;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix, count]) => (count > 1 ? `${prefix} ${count}` : prefix));
}

function formatPlannedFilesLine(count: number, paths: readonly string[]): string {
  if (count === 0) return "0 will be rewritten";
  const rollup = rollupPlannedPathPrefixes(paths);
  const suffix = rollup.length > 0 ? ` (${rollup.join(", ")})` : "";
  return `${count} will be rewritten${suffix}`;
}

/**
 * Read-only refresh plan: versions, no-op vs file-swap, and planned paths.
 * Does not copy, stage, or stamp (#3437).
 */
export async function planRefreshDeposit(
  projectDir: string,
  seams: RefreshDepositSeams = {},
): Promise<RefreshDepositPlan> {
  const deftDir = join(resolve(projectDir), CANONICAL_INSTALL_ROOT);
  const resolveContent = seams.resolveContentRoot ?? resolveInstalledContentRoot;
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
  const alreadyCurrent =
    previousDepositVersion !== null &&
    normalizeVersion(previousDepositVersion) === normalizeVersion(contentVersion);
  const strategy: RefreshDepositStrategy = alreadyCurrent ? "no-op" : "file-swap";
  const plannedPaths = plannedRefreshPaths(strategy, contentRoot);
  return {
    contentRoot,
    previousDepositVersion,
    contentVersion,
    engineVersion,
    alreadyCurrent,
    strategy,
    versionSkewNotice,
    plannedFileCount: plannedPaths.length,
    plannedPaths,
  };
}

/** Deposit freshness owns `State` / `update_state`; file-swap is never `current` (#3437). */
export function updateStateFromFreshness(strategy: RefreshDepositStrategy): UpdateState {
  return strategy === "file-swap" ? "updated" : "current";
}

/** Prior `managed_by` provenance sentinel from the deposit manifest, if any (#2056). */
function readRecordedManagedBy(deftDir: string): string | null {
  const manifestPath = join(deftDir, "VERSION");
  if (!existsSync(manifestPath)) return null;
  try {
    const value = (
      parseInstallManifest(readFileSync(manifestPath, "utf8")).managed_by ?? ""
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Retire a stale legacy `.deft/VERSION` after the canonical `.deft/core/VERSION`
 * has been (re)written (#2064). Folded in from the former `install-upgrade`
 * path so the shared refresh transaction covers the v0.27.x -> v0.28 manifest
 * transition (#1046 PR-B) that the doctor's `install-manifest-disagreement`
 * check still cites `task upgrade` to repair. Only acts when the canonical
 * manifest lives at `<project>/.deft/core/VERSION` and a legacy
 * `<project>/.deft/VERSION` disagrees; renames the legacy file to
 * `.deft/VERSION.premigrate` (best-effort, never fatal).
 */
function migrateLegacyInstallManifest(projectDir: string, canonicalManifestPath: string): void {
  const canonical = resolve(canonicalManifestPath);
  const expectedParent = resolve(projectDir, ".deft", "core");
  if (resolve(canonical, "..") !== expectedParent) return;

  const legacy = join(projectDir, ".deft", "VERSION");
  if (!existsSync(legacy) || !statSync(legacy).isFile()) return;

  try {
    const legacyVersion = manifestTagToVersion(parseInstallManifest(readFileSync(legacy, "utf8")));
    const canonicalVersion = manifestTagToVersion(
      parseInstallManifest(readFileSync(canonical, "utf8")),
    );
    if (legacyVersion !== null && legacyVersion === canonicalVersion) return;
    renameSync(legacy, join(projectDir, ".deft", "VERSION.premigrate"));
  } catch {
    // best-effort
  }
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

interface PorcelainStatusEntry {
  readonly status: string;
  readonly path: string;
}

function porcelainStatusEntries(porcelain: string): PorcelainStatusEntry[] {
  const entries: PorcelainStatusEntry[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    const trimmed = unquoteGitPath(rest.trim());
    if (!trimmed) continue;
    entries.push({ status, path: trimmed.replace(/\\/g, "/") });
  }
  return entries;
}

function classifyChangedEntries(changed: readonly PorcelainStatusEntry[]): {
  core: PorcelainStatusEntry[];
  installerManaged: PorcelainStatusEntry[];
} {
  const core: PorcelainStatusEntry[] = [];
  const installerManaged: PorcelainStatusEntry[] = [];
  for (const entry of changed) {
    const { path } = entry;
    if (!path) continue;
    if (path.startsWith(".deft/core/") || path === ".deft/core") {
      core.push(entry);
    } else if (isInstallerManagedPath(path)) {
      installerManaged.push(entry);
    }
  }
  return { core, installerManaged };
}

function isCrlfNoiseCandidate(status: string): boolean {
  return status.includes("M") && /^[ M]+$/.test(status);
}

function normalizeGitNameList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

export type GitSemanticDiffNames = (
  projectRoot: string,
  paths: readonly string[],
) => readonly string[] | null;

export interface FrameworkRefreshSideEffectsOptions {
  readonly readPorcelain?: (root: string) => string | null;
  readonly readSemanticDiffNames?: GitSemanticDiffNames;
}

function gitSemanticDiffNames(projectRoot: string, paths: readonly string[]): string[] | null {
  if (paths.length === 0) return [];
  try {
    const args = ["diff", "--ignore-cr-at-eol", "--name-only", "--", ...paths];
    const worktree = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cached = execFileSync(
      "git",
      ["diff", "--cached", "--ignore-cr-at-eol", "--name-only", "--", ...paths],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return [...new Set([...normalizeGitNameList(worktree), ...normalizeGitNameList(cached)])];
  } catch {
    return null;
  }
}

export interface RefreshSideEffects {
  readonly files: string[];
  readonly crlfOnlyCoreFiles: string[];
  readonly payloadSwapped?: boolean;
}

/** Framework-managed uncommitted paths after refresh (#1671). */
export function frameworkRefreshSideEffects(
  projectDir: string,
  options?: FrameworkRefreshSideEffectsOptions,
): RefreshSideEffects {
  const readPorcelain = options?.readPorcelain ?? gitPorcelain;
  const readSemanticDiffNames = options?.readSemanticDiffNames ?? gitSemanticDiffNames;
  const porcelain = readPorcelain(projectDir);
  if (porcelain === null) return { files: [], crlfOnlyCoreFiles: [] };
  const changed = porcelainStatusEntries(porcelain);
  const { core, installerManaged } = classifyChangedEntries(changed);
  const semanticCoreNames =
    core.length > 0
      ? readSemanticDiffNames(
          projectDir,
          core.map((entry) => entry.path),
        )
      : [];
  const semanticCoreSet = semanticCoreNames === null ? null : new Set(semanticCoreNames);

  const coreFiles: string[] = [];
  const crlfOnlyCoreFiles: string[] = [];
  for (const entry of core) {
    if (
      semanticCoreSet !== null &&
      isCrlfNoiseCandidate(entry.status) &&
      !semanticCoreSet.has(entry.path)
    ) {
      crlfOnlyCoreFiles.push(entry.path);
      continue;
    }
    coreFiles.push(entry.path);
  }

  const files = [...coreFiles, ...installerManaged.map((entry) => entry.path)].sort();
  return { files, crlfOnlyCoreFiles: crlfOnlyCoreFiles.sort() };
}

export function printRefreshSideEffects(io: InitDepositIo, effects: RefreshSideEffects): void {
  if (effects.crlfOnlyCoreFiles.length > 0) {
    io.printf(
      "\nWindows line-ending note (#2118): suppressed .deft/core CRLF/LF-only noise; " +
        "ensure .gitattributes contains `.deft/core/** text eol=lf`.\n",
    );
  }
  if (effects.files.length === 0) return;
  if (effects.payloadSwapped === false) {
    io.printf("\nFramework-managed files still have semantic uncommitted changes:\n");
    for (const file of effects.files) {
      io.printf(`  ${file}\n`);
    }
    return;
  }
  io.printf("\nAGENTS.md refresh side effects (#1671): the refresh and framework payload swap\n");
  io.printf("left these framework files with uncommitted changes -- they belong in the\n");
  io.printf("framework deposit commit (the installer stages this-run installer-managed\n");
  io.printf("paths; ledger remainder stays unstaged):\n");
  for (const file of effects.files) {
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

export function buildUpdateSummaryJson(input: {
  result: RefreshDepositResult;
  options: RefreshDepositArgs;
  updateState: UpdateState | undefined;
  readiness: AgentHookReadinessResult | undefined;
  resolutionMode?: string;
}): Record<string, unknown> {
  const { result, options, updateState, readiness, resolutionMode } = input;
  return {
    success: readiness ? readiness.code === 0 : true,
    deposit_completed: true,
    ...(readiness ? { agent_hook_readiness: agentHookReadinessJson(readiness) } : {}),
    action: "upgrade",
    ...(updateState ? { update_state: updateState } : {}),
    ...(resolutionMode ? { resolution_mode: resolutionMode } : {}),
    version: result.engineVersion,
    project_dir: result.projectDir,
    deft_dir: result.deftDir,
    legacy_layout: result.legacyLayout,
    update: true,
    non_interactive: options.nonInteractive,
    upgrade: options.upgrade,
    taskfile_wired: result.taskfileWired,
    missing_tools: [],
    maintainer_mode: false,
    maintainer_tools: [],
    skipped_consumer_projections: [],
    user_config_dir: "",
    skills_created: false,
    payload_layout: "vendored",
    strategy: result.strategy,
    already_current: result.alreadyCurrent,
    dirty_tree: false,
    dirty_files: [],
    staged_paths: result.stagedPaths,
    mutations: mutationSummaryJson(result.mutations),
    prettier_sensitive_rewrites: prettierSensitiveRewrites(result.mutations),
    backup_path: "",
    previous_version: result.previousDepositVersion ?? "",
    content_version: result.contentVersion,
    version_skew_notice: result.versionSkewNotice,
    agents_md_updated: result.agentsMdUpdated,
  };
}

/** Consumer-owned prefixes whose rewrite can fail a repo Prettier/fmt gate (#3395). */
export const PRETTIER_SENSITIVE_CONSUMER_PREFIXES = ["xbrief/schemas/"] as const;

export const PRETTIER_SENSITIVE_FMT_HINT =
  "run `task fmt` or your repo formatter before the upgrade PR";

/** Ledger `wrote` paths under prettier-sensitive consumer-owned prefixes. */
export function prettierSensitiveRewrites(summary: MutationSummary): string[] {
  return summary.wrote.filter((path) =>
    PRETTIER_SENSITIVE_CONSUMER_PREFIXES.some(
      (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
    ),
  );
}

export function formatPrettierSensitiveAnnounce(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return (
    `Rewritten consumer-owned paths (${PRETTIER_SENSITIVE_FMT_HINT}):\n` +
    paths.map((path) => `  ${path}\n`).join("")
  );
}

export function printUpdateComplete(
  result: RefreshDepositResult,
  io: InitDepositIo,
  updateState?: UpdateState,
  resolution?: { readonly mode: string; readonly rootCause: string },
): void {
  io.printf(
    result.alreadyCurrent
      ? "\nOK Deft framework payload already current.\n\n"
      : "\nOK Deft framework payload refreshed.\n\n",
  );
  io.printf(`  Location     : ${result.deftDir}\n`);
  io.printf(`  Content      : v${normalizeVersion(result.contentVersion)}\n`);
  io.printf(`  Strategy     : ${result.strategy}\n`);
  if (updateState) {
    io.printf(`  State        : ${updateState}\n`);
  }
  if (resolution) {
    io.printf(`  Resolution   : ${resolution.mode} (${resolution.rootCause})\n`);
  }
  io.printf(`  AGENTS.md    : ${result.agentsMdUpdated ? "updated" : "already current"}\n`);
  if (result.versionSkewNotice) {
    io.printf(`\n${result.versionSkewNotice}\n`);
  }
  const mutationText = formatMutationSummary(result.mutations);
  if (mutationText.length > 0) {
    io.printf(`\n${mutationText}`);
  }
  const prettierText = formatPrettierSensitiveAnnounce(prettierSensitiveRewrites(result.mutations));
  if (prettierText.length > 0) {
    io.printf(`\n${prettierText}`);
  }
  printMigrateNudgeIfNeeded(result.projectDir, io);
  io.printf("\n");
}

export async function runRefreshDeposit(
  args: RefreshDepositArgs,
  io: InitDepositIo,
  seams: RefreshDepositSeams = {},
): Promise<RefreshDepositResult> {
  const projectDir = resolve(args.projectDir);
  if (activeMutationLedger() === undefined) {
    return runWithMutationLedger(projectDir, () => runRefreshDeposit(args, io, seams));
  }
  const deftDir = join(projectDir, CANONICAL_INSTALL_ROOT);

  // #1912: refuse a legacy on-disk layout BEFORE any refresh. The npm CLI never
  // migrates -- the frozen Go bridge does (stage 1), then the npm path (stage 2).
  const detectLegacy = seams.detectLegacy ?? detectLegacyLayout;
  const legacy = detectLegacy(projectDir);
  if (legacy.legacy) {
    throw new LegacyLayoutRefusedError(legacy);
  }

  // #2305: refuse a symlink-escaping deposit boundary BEFORE the first copy so a
  // malicious `.deft`/`.deft/core` symlink cannot redirect the refresh outside
  // the resolved project tree. Writes nothing on refusal.
  assertDepositContained(projectDir, deftDir);

  // #2913: default is full-tree replace (Go swapInCore parity), not additive copyTree.
  // Injected seams.copyContent still wins (tests / specialized callers).
  const copyContent = seams.copyContent ?? replaceTree;
  const planned = await planRefreshDeposit(projectDir, seams);
  const {
    contentRoot,
    previousDepositVersion,
    contentVersion,
    engineVersion,
    alreadyCurrent,
    strategy,
    versionSkewNotice,
  } = planned;
  const previousManagedBy = readRecordedManagedBy(deftDir);

  if (alreadyCurrent) {
    io.printf("[deft update] Framework payload already current; skipping payload copy.\n");
    // #2913: still fail-closed reconcile so dst-only leftovers cannot linger when
    // VERSION already matches (e.g. pre-#2804 additive deposits). Does not re-stamp.
    await reconcileDepositToContentPackage(deftDir, contentRoot, io);
    migrateLegacyInstallManifest(projectDir, join(deftDir, "VERSION"));
    // #3117: ensure a readable live generation token exists without advancing
    // when the payload did not swap (already-current). stampLiveGeneration is a
    // no-op write when the token already matches (keeps git clean under #2118).
    // If generation is missing or behind VERSION (e.g. prior stamp failed after
    // VERSION rewrite), fail closed — do not report success with a stale token.
    const priorGen = readLiveGeneration(projectDir);
    const generationMatches =
      priorGen !== null &&
      normalizeVersion(priorGen.contentVersion) === normalizeVersion(contentVersion);
    try {
      stampLiveGeneration(projectDir, {
        contentVersion,
        stampedBy: "directive-update",
        increment: false,
      });
    } catch (err) {
      if (!generationMatches) {
        throw err;
      }
      // Token already matches content; ensure write failure is non-fatal noise.
    }
  } else {
    // Full-tree replace (or injected seam). Additive copy is no longer the default.
    await copyContent(contentRoot, deftDir);
    await prunePythonArtifactsFromDeposit(deftDir, projectDir, io);
    // #2913 / #2804 / #2347: fail-closed delete-not-in-source BEFORE VERSION stamp.
    // replaceTree already drops dst-only paths; reconcile verifies and covers
    // additive seams. Throws => no VERSION rewrite (refuse stamp until clean).
    await reconcileDepositToContentPackage(deftDir, contentRoot, io);

    const nowIso = seams.nowIso ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
    const stampedAt = nowIso();
    const manifestFields: InstallManifestFields = {
      ref: contentVersion.startsWith("v") ? contentVersion : `v${contentVersion}`,
      sha: "content-package",
      tag: contentVersion.startsWith("v") ? contentVersion : `v${contentVersion}`,
      installRoot: CANONICAL_INSTALL_ROOT,
      fetchedAt: stampedAt,
      fetchedBy: "directive-update",
      ...(previousManagedBy ? { managedBy: previousManagedBy } : {}),
    };
    const writtenManifestPath = writeInstallManifest(projectDir, deftDir, manifestFields);

    // #2064: retire a stale legacy .deft/VERSION now that the canonical
    // .deft/core/VERSION has been rewritten (folded in from install-upgrade so no
    // manifest behavior is lost by the redirect). Best-effort; never fatal.
    migrateLegacyInstallManifest(projectDir, writtenManifestPath);

    // #3117: monotonic live generation MUST advance after a successful payload
    // swap. Suppressing stamp failure would leave a prior bound/live match
    // reporting `current` while the on-disk payload already changed (Greptile P1).
    stampLiveGeneration(projectDir, {
      contentVersion,
      stampedBy: "directive-update",
      increment: true,
      nowIso: stampedAt,
    });
  }

  // #2595: payload freshness and consumer derivative freshness are independent.
  // Always repair these cheap projections, including on the #2118 no-op path.
  if (alreadyCurrent) {
    syncExistingBareVersionMarker(projectDir, contentVersion);
  } else {
    syncBareVersionMarker(projectDir, contentVersion);
  }
  // Do not turn a legacy-only or cache-only support tree into canonical
  // lifecycle content before migrate:xbrief can transactionally converge it.
  if (hasCanonicalXbriefLifecycle(projectDir)) {
    syncConsumerXbriefSchemas(projectDir, deftDir);
    removeStaleMigratedFrameworkNarrative(projectDir);
  }

  const runOrgForceOn =
    seams.runOrgForceOn ??
    ((root) => {
      runOrgForceOnMigration(root, { actor: "directive-update" });
    });
  try {
    runOrgForceOn(projectDir);
  } catch {
    // Policy migration is best-effort; never block framework refresh (#2822).
  }

  const agentsMdUpdated = writeAgentsMd(projectDir, deftDir, io);
  writeAgentHookDeposit(projectDir, io);
  // #75 residual: multi-host thin skill discovery (mirror `.agents/skills` inventory).
  writeMultiHostSkillDiscovery(projectDir, io);
  writeSlashCommandDeposit(projectDir, io);
  // #3171: OpenClaw soft AGENTS re-bind skill when OC signals present (fail-closed otherwise).
  depositOpenClawSoftRebindSkill({});
  // #3064: OpenClaw L2 product-command skills when OC signals present (fail-closed otherwise).
  depositOpenClawL2ProductCommands({
    projectRoot: projectDir,
    printf: (t) => io.printf(t),
  });
  // #2530: root `.githooks/` is a consumer derivative like #2595 marker/schemas —
  // repair on every refresh, including the already-current no-op path.
  writeConsumerGitHooks(projectDir, deftDir, io, seams.gitHooks);

  // #2148: the deft-core-guard CI workflow is only meaningful when the deposit
  // is git-tracked (committed vendor layout). On an npm-managed (gitignored)
  // deposit it creates untracked noise after every `directive update`. Probe
  // git-tracked status once and share the result with the gitignore upkeep below.
  const depositTracked = isDepositTrackedInGit(projectDir, seams.gitLsFiles);
  const skipGuardWorkflow = depositTracked !== true;

  await depositNeutralization(projectDir, io, { skipGuardWorkflow });

  // #2266: non-destructive `.gitignore` upkeep for framework-owned paths. This
  // NEVER un-tracks a committed deposit -- `ensureInitGitignoreLines` only writes
  // `.gitignore` and leaves an already-tracked `.deft/core` tracked. The
  // destructive `git rm --cached .deft/core` un-track is the deliberate
  // `migrate --untrack-core` step (#2269), not `update`.
  ensureInitGitignoreLines(projectDir, io, { gitLsFiles: seams.gitLsFiles });
  ensurePrettierIgnoreLines(projectDir, io);

  let taskfileWired = false;
  if (args.nonInteractive) {
    taskfileWired = ensureTaskfile(projectDir, io);
  }

  const readPorcelain = seams.gitPorcelain ?? gitPorcelain;
  const effects = frameworkRefreshSideEffects(projectDir, {
    readPorcelain,
    readSemanticDiffNames: seams.gitSemanticDiffNames ?? gitSemanticDiffNames,
  });

  let stagedPaths: string[] = [];
  if (!alreadyCurrent || effects.files.length > 0) {
    const stagedResult = depositStagePaths(projectDir, {
      includeTaskfile: taskfileWired,
      includeCore: !alreadyCurrent,
      printf: (text) => io.printf(text),
    });
    stagedPaths = stagedResult.stagedPaths;
    if (!alreadyCurrent) {
      printCommitGuidance(io, stagedResult.stagePaths, stagedResult.staged);
    } else if (stagedResult.stagedPaths.length > 0) {
      io.printf("\nUpdated installer-managed projections for the current framework deposit:\n");
      io.printf(`  git add -- ${stagedResult.stagedPaths.join(" ")}\n`);
    }
  }

  printRefreshSideEffects(io, { ...effects, payloadSwapped: !alreadyCurrent });

  if (versionSkewNotice) {
    io.printf(`${versionSkewNotice}\n`);
  }

  return {
    projectDir,
    deftDir,
    contentVersion,
    engineVersion,
    previousDepositVersion,
    alreadyCurrent,
    strategy,
    agentsMdUpdated,
    versionSkewNotice,
    legacyLayout: false,
    taskfileWired,
    stagedPaths,
    mutations: snapshotMutationSummary(),
  };
}

export interface RunRefreshDepositCliOptions extends RefreshDepositArgs {
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly seams?: RefreshDepositSeams;
  /** #2266: print the classified plan without executing the refresh (`--dry-run`/`--plan`). */
  readonly dryRun?: boolean;
  /** #2266: seams for the up-front four-state classifier (default: real fs + engine probe). */
  readonly classifySeams?: ClassifySeams;
  /** #2266: pre-computed engine-ladder facts for the self-heal delegation (default: probed). */
  readonly ladderFacts?: LadderFacts;
  /** #2266: injected engine install runner for the ladder self-heal (default: deferred). */
  readonly engineInstallRunner?: EngineInstallRunner;
  /** #2266: injected content re-projection after a self-heal install. */
  readonly reproject?: ReprojectRunner;
}

function buildRefusalJson(
  state: UpdateState,
  projectDir: string,
  message: string,
  command: string,
): Record<string, unknown> {
  return {
    success: false,
    action: "update",
    update_state: state,
    project_dir: projectDir,
    message,
    next_action: { command },
  };
}

/** Emit the `not-initialized` refusal: STOP, hint `init`, never write a partial install. */
function emitNotInitialized(
  options: RunRefreshDepositCliOptions,
  io: InitDepositIo,
  projectDir: string,
): number {
  io.printf(`${NOT_INITIALIZED_MESSAGE}\n`);
  if (options.jsonOut) {
    options.writeOut(
      `${JSON.stringify(
        buildRefusalJson("not-initialized", projectDir, NOT_INITIALIZED_MESSAGE, "directive init"),
        null,
        2,
      )}\n`,
    );
  }
  return UPDATE_REFUSED_EXIT_CODE;
}

/** Emit the `migration-required` refusal: `update` is not enough; point at init/migrate. */
function emitMigrationRequired(
  options: RunRefreshDepositCliOptions,
  io: InitDepositIo,
  projectDir: string,
  classification: UpdateClassification,
): number {
  const remediation = classification.plan.nextAction.remediation;
  const message = `directive update: this project requires migration before it can be refreshed. ${remediation}`;
  io.printf(`${message}\n`);
  if (options.jsonOut) {
    options.writeOut(
      `${JSON.stringify(
        buildRefusalJson(
          "migration-required",
          projectDir,
          message,
          classification.plan.nextAction.command ?? "directive init",
        ),
        null,
        2,
      )}\n`,
    );
  }
  return UPDATE_REFUSED_EXIT_CODE;
}

/** Emit deposit freshness + classified plan for `--dry-run`/`--plan` without writing. */
async function emitDryRunPlan(
  options: RunRefreshDepositCliOptions,
  io: InitDepositIo,
  projectDir: string,
  classification: UpdateClassification,
): Promise<number> {
  const planned = await planRefreshDeposit(projectDir, options.seams ?? {});
  const { plan: resolutionPlan } = classification;
  const updateState = updateStateFromFreshness(planned.strategy);
  const header =
    planned.strategy === "file-swap"
      ? "[deft update] dry-run -- pending file-swap (no writes this run):"
      : "[deft update] dry-run -- classified plan (no changes would be written):";
  io.printf(`\n${header}\n`);
  io.printf(
    `  Manifest     : ${displayVersion(planned.previousDepositVersion)} -> ${displayVersion(planned.contentVersion)}\n`,
  );
  io.printf(`  Strategy     : ${planned.strategy}\n`);
  io.printf(
    `  Files        : ${formatPlannedFilesLine(planned.plannedFileCount, planned.plannedPaths)}\n`,
  );
  io.printf(`  State        : ${updateState}\n`);
  io.printf(`  Resolution   : ${resolutionPlan.mode} (${resolutionPlan.nextAction.rootCause})\n`);
  if (planned.versionSkewNotice) {
    io.printf(`${planned.versionSkewNotice}\n`);
  }
  io.printf(`  Remediation  : ${resolutionPlan.nextAction.remediation}\n`);
  for (const warning of resolutionPlan.warnings) {
    io.printf(`  Warning      : ${warning}\n`);
  }
  if (options.jsonOut) {
    options.writeOut(
      `${JSON.stringify(
        {
          success: true,
          action: "update",
          dry_run: true,
          update_state: updateState,
          mode: resolutionPlan.mode,
          resolution_mode: resolutionPlan.mode,
          project_dir: projectDir,
          previous_version: planned.previousDepositVersion ?? "",
          content_version: planned.contentVersion,
          strategy: planned.strategy,
          already_current: planned.alreadyCurrent,
          planned_file_count: planned.plannedFileCount,
          planned_paths: planned.plannedPaths,
          version_skew_notice: planned.versionSkewNotice,
          next_action: resolutionPlan.nextAction,
          warnings: resolutionPlan.warnings,
        },
        null,
        2,
      )}\n`,
    );
  }
  return 0;
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

  // #2266: classify up front (BEFORE any copy) and gate on the four states.
  // Legacy layouts keep their existing refusal path (thrown by runRefreshDeposit
  // and handled below), so classification is skipped for them.
  const projectDir = resolve(options.projectDir);

  // #2926: root opt-out wins over update/refresh and ambient force-on.
  const optOut = detectNoDeftDirective(projectDir);
  if (optOut.present) {
    const message = optOut.inconsistent
      ? NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE
      : NO_DEFT_DIRECTIVE_DISABLED_MESSAGE;
    io.printf(`${message}\n`);
    if (options.jsonOut) {
      options.writeOut(
        `${JSON.stringify(
          {
            success: false,
            action: "update",
            disabled: true,
            disabled_via: NO_DEFT_DIRECTIVE_FLAG_NAME,
            inconsistent: optOut.inconsistent,
            ...(optOut.inconsistent
              ? { inconsistent_policy: NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY }
              : {}),
            deposit_present: optOut.depositPresent,
            project_dir: projectDir,
            message,
          },
          null,
          2,
        )}\n`,
      );
    }
    return UPDATE_REFUSED_EXIT_CODE;
  }

  const detectLegacy = options.seams?.detectLegacy ?? detectLegacyLayout;
  let classification: UpdateClassification | null = null;
  if (!detectLegacy(projectDir).legacy) {
    classification = classifyUpdateState(projectDir, options.classifySeams ?? {});
    if (classification.state === "not-initialized") {
      return emitNotInitialized(options, io, projectDir);
    }
    if (classification.state === "migration-required") {
      return emitMigrationRequired(options, io, projectDir, classification);
    }
    if (options.dryRun) {
      try {
        return await emitDryRunPlan(options, io, projectDir, classification);
      } catch (cause) {
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
    // #2266 a3: self-heal a mismatched / unreachable engine via the keystone
    // global-first ladder before the refresh proceeds.
    if (!classification.facts.engineReachable) {
      selfHealEngine(projectDir, classification.facts, io, {
        ladderFacts: options.ladderFacts,
        engineInstallRunner: options.engineInstallRunner,
        reproject: options.reproject,
      });
    }
  }

  try {
    const result = await runRefreshDeposit(options, io, options.seams);
    const readiness = evaluateAgentHookReadinessSafely(
      result.projectDir,
      options.seams?.evaluateAgentHookReadiness ?? evaluateAgentHookReadiness,
    );
    const state = updateStateFromFreshness(result.strategy);
    const resolution = classification
      ? { mode: classification.plan.mode, rootCause: classification.plan.nextAction.rootCause }
      : undefined;
    if (options.jsonOut) {
      options.writeOut(
        `${JSON.stringify(
          buildUpdateSummaryJson({
            result,
            options,
            updateState: state,
            readiness,
            resolutionMode: classification?.plan.mode,
          }),
          null,
          2,
        )}\n`,
      );
      printUpdateComplete(result, { printf: options.writeErr }, state, resolution);
    } else {
      printUpdateComplete(result, io, state, resolution);
    }
    const readinessOut = options.jsonOut
      ? options.writeErr
      : readiness.stream === "stderr"
        ? options.writeErr
        : options.writeOut;
    readinessOut(`\n${readiness.message}\n`);
    return readiness.code;
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
