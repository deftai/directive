/**
 * Install / upgrade / uninstall / doctor bookends (Wave 2a–2g).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  CONTRACT_NUMBER,
  EXIT_CODES,
  LAUNCHER_MAX_SUPPORTED_CONTRACT,
  LAUNCHER_PACKAGE_NAME,
  RUNTIME_PACKAGE_NAME,
} from "./constants.js";
import {
  doctorArgv,
  doctorDiagnoseArgv,
  type InvokeResult,
  invokeRuntime,
  migrateArgv,
  setupArgv,
  uninstallArgv,
} from "./contract-invoke.js";
import {
  classifyLauncherSituation,
  formatEntryGuardMessage,
  projectInstallCommand,
} from "./entry-guard.js";
import { type InteractiveLine, readInteractiveLine } from "./interactive-stdin.js";
import {
  formatShapeRecoveryMessage,
  isL2RefusalDecision,
  resolveInstallShape,
} from "./legacy-shapes/index.js";
import { checkNodeVersion } from "./node-check.js";
import type { ProjectInstallState } from "./pin.js";
import { isContractSupported, readInstalledRuntime, readProjectInstallState } from "./pin.js";
import {
  type HooksTakeover,
  type LegacyVbriefTree,
  parseVerbosityFlags,
  presentAmbiguousYes,
  presentFirstInstallPlan,
  presentInstallSuccess,
  presentMigrateFailedAfterUpgrade,
  presentMigrationPending,
  presentPathSummary,
  presentRepairPlan,
  presentRepairSuccess,
  presentSetupFailedAfterInstall,
  presentUninstallPlan,
  presentUninstallSuccess,
  presentUpgradePlan,
  presentUpgradeSuccess,
  type SetupSummary,
  summarizeUninstallRemovals,
  tryParseSetupSummary,
  type Verbosity,
} from "./plan-present.js";
import {
  detectPackageManager,
  ensurePackageJson,
  ensurePackageManagerAvailable,
  fingerprintPlanCriticalFiles,
  formatPmExactAddCommand,
  formatPmRemoveCommand,
  formatPnpmIgnoredBuildsRecovery,
  formatPnpmReleaseAgeRecovery,
  INSTALL_SCRIPT_POLICY_PLAN_LINE,
  isPnpmIgnoredBuildsFailure,
  isPnpmReleaseAgeFailure,
  lockfileRecordsExactPin,
  PARTIAL_CHANGES_MAY_REMAIN,
  type PackageManager,
  type PlanFingerprint,
  type PmAddResult,
  planFingerprintChanged,
  pnpmWorkspaceDigest,
  purgeRetiredDirectiveLockfiles,
  RETIRED_DIRECTIVE_PACKAGE_NAMES,
  readDeclaredPackageManagerVersion,
  removeLegacyDirectivePackages,
  removeLegacyDirectivePin,
  runPmExactAdd,
  runPmRemove,
} from "./pm.js";
import {
  compareExactVersions,
  resolveLatestStableVersion,
  resolvePublishedContract,
  validateTargetVersionSpec,
} from "./registry.js";
import { type RegistryHintVerb, scopedRegistryHint } from "./registry-hint.js";
import { filesWithDirectiveLines } from "./retired-lines.js";
import {
  applyLauncherCleanup,
  cleanupHooksPath,
  discoverUninstallFootprint,
  listKeptDirectiveData,
  registeredWorktreesInsideProject,
  removeSoleAuthorManifest,
  restoreManifestFiles,
  siblingWorktreesNeedingHooksPath,
  snapshotManifestFiles,
  type UninstallDiscovery,
  verifyUninstallComplete,
} from "./uninstall-map.js";

export interface BookendIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface BookendFlags {
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly repair: boolean;
  readonly targetVersion: string | null;
  readonly packageManager: string | null;
  readonly verbosity: Verbosity;
}

export type DataStatusValue = "current" | "migration_needed" | "diagnosis_failed";

/** INIT-16 Repair/Cancel menu selection. */
export type ConfiguredMenuChoice = "repair" | "cancel";

export interface ChooseMenuOptions {
  readonly projectRoot: string;
  readonly pinVersion: string;
  readonly defaultChoice: ConfiguredMenuChoice;
}

/** Testable seams for install (unit tests inject; production uses defaults). */
export interface InstallDeps {
  readonly stdinIsTTY?: boolean;
  /** Sync [y/N] confirm; true = approve. Injected in tests; production reads stdin. */
  readonly confirm?: (prompt: string) => boolean;
  /** Sync Repair/Cancel menu; injected in tests; production reads stdin. */
  readonly chooseMenu?: (opts: ChooseMenuOptions) => ConfiguredMenuChoice;
  /**
   * Production stdin line reader seam (UX-INT-TTY). Owner tests inject without mocking fs.
   * When omitted, uses blocking interactive reader (retries EAGAIN).
   */
  readonly readInteractiveLine?: () => InteractiveLine;
  readonly env?: NodeJS.ProcessEnv;
  /** Override Node version for plan Node best-effort disclosure (AC14.54 tests). */
  readonly nodeVersion?: string;
  /** Override PM availability preflight (AC5.8 / AC14.45 tests). */
  readonly checkPmAvailable?: (pm: PackageManager) => { ok: true } | { ok: false; message: string };
  readonly resolveLatest?: () =>
    | Promise<{ ok: true; version: string } | { ok: false; message: string }>
    | { ok: true; version: string }
    | { ok: false; message: string };
  readonly runPmAdd?: (opts: {
    projectRoot: string;
    pm: PackageManager;
    version: string;
  }) => PmAddResult;
  readonly invokeSetup?: (argv: readonly string[]) => InvokeResult;
  /** #6141 test seam: effective `@deftai:registry` read (production: `npm config get`). */
  readonly readScopedRegistry?: (projectRoot: string, env: NodeJS.ProcessEnv) => string | null;
}

/**
 * Plan-time read-only Git query (#6002 / #7056). Null when Git is missing,
 * fails, or times out; callers never block the upgrade on it.
 */
function readOnlyPlanGit(projectRoot: string, args: readonly string[]): string | null {
  const result = spawnSync(
    "git",
    ["-C", projectRoot, ...args],
    // Read-only: no optional index refresh writes; bounded so a slow Git never stalls the plan.
    { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 5000 },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout;
}

/** Upgrade-only flag: consent to the vbrief→xbrief data migration (#7056). */
export const MIGRATE_XBRIEF_FLAG = "--migrate-xbrief";

/** Project-relative POSIX paths of the files under `rel` (symlinks listed, not followed). */
function listFilesUnder(projectRoot: string, rel: string): string[] {
  const files: string[] = [];
  const pending = [rel];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(projectRoot, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = `${current}/${entry.name}`;
      // Dirent reports a symlink as a symlink (never followed): count it as a file.
      if (entry.isDirectory()) pending.push(child);
      else files.push(child);
    }
  }
  return files;
}

/**
 * #7056: the legacy `vbrief/` tree the upgrade migration would process and
 * delete. Null when there is no `vbrief/` or it holds no files. `tracked` is
 * how many of those on-disk files Git tracks (tracked paths already deleted
 * from disk are not counted): 0 outside a Git repo, null when Git could not
 * be read. Read-only.
 */
export function detectLegacyVbriefTree(projectRoot: string): LegacyVbriefTree | null {
  try {
    if (!statSync(join(projectRoot, "vbrief")).isDirectory()) return null;
  } catch {
    return null;
  }
  const onDisk = listFilesUnder(projectRoot, "vbrief");
  const files = onDisk.length;
  if (files === 0) return null;
  if (!existsSync(join(projectRoot, ".git"))) return { files, tracked: 0 };
  const stdout = readOnlyPlanGit(projectRoot, ["ls-files", "-z", "--", "vbrief"]);
  if (stdout === null) return { files, tracked: null };
  const trackedPaths = new Set(stdout.split("\0").filter((p) => p.length > 0));
  return { files, tracked: onDisk.filter((p) => trackedPaths.has(p)).length };
}

/**
 * Read-only: paths Git reports as modified or untracked under `.deft/core`
 * (AC10.6 / RC-03, #6002). Empty when there is no Git repo, Git is missing,
 * or `.deft/core` is ignored or clean. Never blocks the upgrade.
 */
export function listDeftCoreGitEdits(projectRoot: string): string[] {
  if (!existsSync(join(projectRoot, ".deft", "core"))) return [];
  const stdout = readOnlyPlanGit(projectRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".deft/core",
  ]);
  if (stdout === null) return [];
  const tokens = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] ?? "";
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // Rename / copy entries carry the original path as the next token.
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return paths;
}

/** Testable seams for upgrade (extends install seams). */
export interface UpgradeDeps extends InstallDeps {
  /** Override the read-only `.deft/core` Git edit listing (#6002 tests). */
  readonly listDeftCoreGitEdits?: (projectRoot: string) => readonly string[];
  readonly resolvePublishedContract?: (
    version: string,
  ) => { ok: true; contract: number } | { ok: false; message: string };
  readonly invokeMigrate?: (argv: readonly string[]) => InvokeResult;
  readonly invokeDoctorDataStatus?: () =>
    | { ok: true; dataStatus: DataStatusValue }
    | { ok: false; message: string };
  /** Wave4e: prune retired triad/launcher from lockfile before runtime add. */
  readonly runPmRemove?: (opts: {
    projectRoot: string;
    pm: PackageManager;
    packageName: string;
  }) => PmAddResult;
}

/** Testable seams for uninstall (R11). */
export interface UninstallDeps {
  readonly stdinIsTTY?: boolean;
  readonly confirm?: (prompt: string) => boolean;
  /** Production stdin line reader seam (UX-INT-TTY); see InstallDeps. */
  readonly readInteractiveLine?: () => InteractiveLine;
  readonly env?: NodeJS.ProcessEnv;
  readonly invokeUninstall?: (argv: readonly string[]) => InvokeResult;
  readonly runPmRemove?: (opts: {
    projectRoot: string;
    pm: PackageManager;
    packageName: string;
  }) => PmAddResult;
  readonly applyCleanup?: (
    projectRoot: string,
    discovery: UninstallDiscovery,
  ) => ReturnType<typeof applyLauncherCleanup>;
  readonly cleanupHooksPath?: (projectRoot: string) => ReturnType<typeof cleanupHooksPath>;
  /** Other worktrees that still use Directive hooks (report for `preserved-sibling`). */
  readonly siblingWorktrees?: (projectRoot: string) => string[];
}

const CANCELLED_NO_CHANGES = "Cancelled. No project files were changed.";

function defaultIo(): BookendIo {
  return {
    writeOut: (t) => {
      process.stdout.write(t);
    },
    writeErr: (t) => {
      process.stderr.write(t);
    },
  };
}

function flagValueMissing(next: string | undefined): boolean {
  return next === undefined || next.startsWith("-");
}

function parseFlags(argv: readonly string[]): {
  flags: BookendFlags;
  rest: string[];
  usageError: string | null;
} {
  const { verbosity, rest: afterVerbosity } = parseVerbosityFlags(argv);
  const rest: string[] = [];
  let dryRun = false;
  let yes = false;
  let repair = false;
  let targetVersion: string | null = null;
  let packageManager: string | null = null;
  let usageError: string | null = null;
  for (let i = 0; i < afterVerbosity.length; i++) {
    const a = afterVerbosity[i]!;
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      yes = true;
      continue;
    }
    if (a === "--repair") {
      repair = true;
      continue;
    }
    if (a === "--target-version") {
      const next = afterVerbosity[i + 1];
      if (flagValueMissing(next)) {
        usageError = "--target-version requires a value.";
        continue;
      }
      targetVersion = afterVerbosity[++i]!;
      continue;
    }
    if (a.startsWith("--target-version=")) {
      targetVersion = a.slice("--target-version=".length);
      if (targetVersion.length === 0) {
        usageError = "--target-version requires a value.";
      }
      continue;
    }
    if (a === "--package-manager") {
      const next = afterVerbosity[i + 1];
      if (flagValueMissing(next)) {
        usageError = "--package-manager requires a value.";
        continue;
      }
      packageManager = afterVerbosity[++i]!;
      continue;
    }
    if (a.startsWith("--package-manager=")) {
      packageManager = a.slice("--package-manager=".length);
      if (packageManager.length === 0) {
        usageError = "--package-manager requires a value.";
      }
      continue;
    }
    rest.push(a);
  }
  return {
    flags: { dryRun, yes, repair, targetVersion, packageManager, verbosity },
    rest,
    usageError,
  };
}

function _printPlan(io: BookendIo, lines: readonly string[]): void {
  io.writeOut("Plan:\n");
  for (const line of lines) {
    io.writeOut(`  ${line}\n`);
  }
}

/** AC5.1 / AC14.54 — install-script policy + Node best-effort note when applicable. */
function _appendCommonPlanDisclosures(
  lines: string[],
  deps: Pick<InstallDeps, "nodeVersion">,
): void {
  lines.push(INSTALL_SCRIPT_POLICY_PLAN_LINE);
  const node = checkNodeVersion(deps.nodeVersion);
  if (node.warning) {
    lines.push(`node: ${node.warning}`);
  }
}

/** AC8.6 / AC2.5 / GIT-HOOKS-INACTIVE — disclose when .git is absent at plan time. */
export const GIT_HOOKS_INACTIVE_PLAN_LINE =
  "Git hooks: inactive until git init + eligible repair/self-complete (cannot set core.hooksPath=.githooks yet)";

function _appendGitHooksPlanDisclosure(lines: string[], projectRoot: string): void {
  if (!existsSync(join(projectRoot, ".git"))) {
    lines.push(GIT_HOOKS_INACTIVE_PLAN_LINE);
  }
}

function gitOut(projectRoot: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * #4960 / ledger Problem 20 — read-only check, before the install/repair plan, for
 * Git hooks that `.githooks` would replace in this repository. Returns null when
 * nothing would be replaced (no `.git`, hooks already Directive's, or nothing set).
 * Never writes Git config (safe for `--dry-run`).
 */
export function detectHooksTakeover(projectRoot: string): HooksTakeover | null {
  if (!existsSync(join(projectRoot, ".git"))) return null;
  const ours = resolve(projectRoot, ".githooks");
  const raw = gitOut(projectRoot, ["config", "--show-scope", "--get", "core.hooksPath"]);
  if (raw !== null) {
    const line = raw.replace(/\r?\n$/, "");
    const tab = line.indexOf("\t");
    const scope = tab >= 0 ? line.slice(0, tab) : "";
    const value = (tab >= 0 ? line.slice(tab + 1) : line).trim();
    if (value !== "") {
      if (value === ".githooks" || value === ".githooks/") return null;
      if (samePath(resolve(projectRoot, value), ours)) return null;
      return { previous: value, scope: scope === "" ? null : scope, hooks: [] };
    }
  }
  // Unset: Git's default hooks folder; only sample files mean nothing is replaced.
  const hooksDirRaw = gitOut(projectRoot, ["rev-parse", "--git-path", "hooks"]);
  if (hooksDirRaw === null) return null;
  const hooksDirRel = hooksDirRaw.trim();
  if (hooksDirRel === "") return null;
  const hooksDir = resolve(projectRoot, hooksDirRel);
  let names: string[];
  try {
    names = readdirSync(hooksDir)
      .filter((n) => !n.endsWith(".sample"))
      .filter((n) => {
        try {
          return statSync(join(hooksDir, n)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  return { previous: hooksDirRel, scope: "default", hooks: names };
}

/** AC5.8 / AC14.45 — fail before mutation when the selected PM is not on PATH. */
function preflightPmAvailable(
  projectRoot: string,
  pm: PackageManager,
  deps: Pick<InstallDeps, "checkPmAvailable" | "env">,
  io: BookendIo,
): number | null {
  const declaredVersion = readDeclaredPackageManagerVersion(projectRoot);
  const check =
    deps.checkPmAvailable?.(pm) ??
    ensurePackageManagerAvailable(pm, deps.env ?? process.env, declaredVersion, projectRoot);
  if (check.ok) return null;
  io.writeErr(`${check.message}\n`);
  return EXIT_CODES.FAILURE;
}

/** AC5.13 — abort when plan-critical files changed after the plan was shown. */
function assertPlanStillValid(
  projectRoot: string,
  pm: PackageManager,
  fingerprint: PlanFingerprint,
  io: BookendIo,
): number | null {
  if (!planFingerprintChanged(projectRoot, pm, fingerprint)) return null;
  io.writeErr(
    "Plan invalidated: relevant project files changed after the plan was shown. Re-run the command.\n",
  );
  return EXIT_CODES.FAILURE;
}

/** #6141 context for the split `@deftai` registry hint on a registry miss. */
interface RegistryHintContext {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly verb: RegistryHintVerb;
  readonly deps: Pick<InstallDeps, "readScopedRegistry">;
  readonly pm?: PackageManager;
  readonly lockfileRecordsPin?: boolean;
}

function registryHintFor(blob: string, ctx: RegistryHintContext | undefined) {
  if (ctx === undefined) return null;
  return scopedRegistryHint(ctx.projectRoot, blob, {
    verb: ctx.verb,
    env: ctx.env,
    pm: ctx.pm,
    lockfileRecordsPin: ctx.lockfileRecordsPin,
    readScopedRegistry: ctx.deps.readScopedRegistry,
  });
}

/** Registry lookup (`npm view`) failure: message, plus the #6141 hint on a split-scope miss. */
function reportRegistryLookupFailure(
  io: BookendIo,
  message: string,
  ctx: RegistryHintContext,
): number {
  const hint = registryHintFor(message, ctx);
  io.writeErr(`${hint === null ? message : hint.redact(message)}\n`);
  if (hint !== null) io.writeErr(`${hint.hint}\n`);
  return EXIT_CODES.FAILURE;
}

/** Map PM add/remove failure to exit code; interruption → 130 (AC5.15 / AC14.56). */
function reportPmFailure(
  io: BookendIo,
  add: Extract<PmAddResult, { ok: false }>,
  runtimeVersion?: string,
  hintCtx?: RegistryHintContext,
): number {
  const blob = `${add.message}\n${add.stderr ?? ""}`;
  const registryHint = registryHintFor(blob, hintCtx);
  const redact = registryHint === null ? (text: string) => text : registryHint.redact;
  io.writeErr(`${redact(add.message)}\n`);
  if (add.stderr) io.writeErr(`${redact(add.stderr)}\n`);
  if (registryHint !== null) io.writeErr(`${registryHint.hint}\n`);
  if (isPnpmIgnoredBuildsFailure(blob)) {
    io.writeErr(`${formatPnpmIgnoredBuildsRecovery()}\n`);
  }
  // #5854 (Outcome B): explain pnpm's release-age refusal; Directive never edits pnpm-workspace.yaml.
  if (runtimeVersion !== undefined && isPnpmReleaseAgeFailure(blob)) {
    // Judge the blocked package from pnpm's output only: add.message echoes the add argv.
    io.writeErr(`${formatPnpmReleaseAgeRecovery(runtimeVersion, add.stderr ?? "")}\n`);
  }
  if (add.interrupted) {
    if (!/partial changes may remain/i.test(add.message)) {
      io.writeErr(`${PARTIAL_CHANGES_MAY_REMAIN}\n`);
    }
    return EXIT_CODES.INTERRUPTED;
  }
  return EXIT_CODES.FAILURE;
}

function parseYesNo(answer: string): boolean {
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
}

function resolveLineReader(
  deps: Pick<InstallDeps, "readInteractiveLine"> | Pick<UninstallDeps, "readInteractiveLine">,
): () => InteractiveLine {
  return deps.readInteractiveLine ?? readInteractiveLine;
}

/**
 * INIT-15: Repair is the menu default when the pin is exact and installed or
 * generated files are missing (fresh clone / worktree shape).
 */
function shouldDefaultToRepair(projectRoot: string, state: ProjectInstallState): boolean {
  if (state.installed === null) return true;
  return !existsSync(join(projectRoot, ".deft", "GENERATION.json"));
}

function printConfiguredMenu(io: BookendIo, opts: ChooseMenuOptions): void {
  const repairMarker = opts.defaultChoice === "repair" ? ">" : " ";
  const cancelMarker = opts.defaultChoice === "cancel" ? ">" : " ";
  io.writeOut("Directive is already configured in this project.\n\n");
  io.writeOut(`Project:         ${opts.projectRoot}\n`);
  io.writeOut(`Pinned version:  ${opts.pinVersion}\n\n`);
  io.writeOut("What would you like to do?\n\n");
  io.writeOut(`${repairMarker} Repair ${opts.pinVersion}\n`);
  io.writeOut("    Restore the current version and rerun project setup.\n\n");
  io.writeOut(`${cancelMarker} Cancel\n`);
  io.writeOut("    Leave the project unchanged.\n\n");
}

function parseMenuChoice(
  answer: string,
  defaultChoice: ConfiguredMenuChoice,
): ConfiguredMenuChoice {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed.length === 0) return defaultChoice;
  if (trimmed === "1" || trimmed === "r" || trimmed === "repair") return "repair";
  if (trimmed === "2" || trimmed === "c" || trimmed === "cancel") return "cancel";
  // Unrecognized input → cancel (no mutation).
  return "cancel";
}

function defaultChooseMenu(
  io: BookendIo,
  opts: ChooseMenuOptions,
  readLine: () => InteractiveLine,
): ConfiguredMenuChoice | "eof" {
  printConfiguredMenu(io, opts);
  const defaultLabel = opts.defaultChoice === "repair" ? "Repair" : "Cancel";
  io.writeOut(`Choice [Repair/Cancel] (default: ${defaultLabel}): `);
  const result = readLine();
  if (result.eof) return "eof";
  return parseMenuChoice(result.line, opts.defaultChoice);
}

/**
 * One operation-specific confirmation (AC5.2). Default No.
 * Returns null to proceed; otherwise an exit code (0 on cancel, 2 when --yes required).
 * Claimed TTY + reader EOF → non-interactive (exit 2), not Cancelled (UX-INT-TTY).
 */
function requireApproval(
  flags: BookendFlags,
  deps: Pick<InstallDeps, "stdinIsTTY" | "confirm" | "readInteractiveLine">,
  io: BookendIo,
  prompt: string,
): number | null {
  if (flags.dryRun) return null;
  if (flags.yes) return null;
  const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!tty) {
    io.writeErr(`Non-interactive session requires --yes to approve: ${prompt}\n`);
    return EXIT_CODES.USAGE;
  }
  if (deps.confirm) {
    io.writeOut(`${prompt} [y/N]\n`);
    if (deps.confirm(prompt)) return null;
    io.writeOut(`${CANCELLED_NO_CHANGES}\n`);
    return EXIT_CODES.SUCCESS;
  }
  io.writeOut(`${prompt} [y/N] `);
  const result = resolveLineReader(deps)();
  if (result.eof) {
    io.writeErr(`Non-interactive session requires --yes to approve: ${prompt}\n`);
    return EXIT_CODES.USAGE;
  }
  if (parseYesNo(result.line)) return null;
  io.writeOut(`${CANCELLED_NO_CHANGES}\n`);
  return EXIT_CODES.SUCCESS;
}

/**
 * #7056: separate default-No question for the vbrief→xbrief migration.
 * Asked only in an interactive session without --yes (or --dry-run); a --yes
 * run never asks and never migrates without --migrate-xbrief. EOF = no.
 */
function askMigrationConsent(
  flags: BookendFlags,
  deps: Pick<InstallDeps, "stdinIsTTY" | "confirm" | "readInteractiveLine">,
  io: BookendIo,
  prompt: string,
): boolean {
  if (flags.dryRun || flags.yes) return false;
  const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!tty) return false;
  if (deps.confirm) {
    io.writeOut(`${prompt} [y/N]\n`);
    return deps.confirm(prompt);
  }
  io.writeOut(`${prompt} [y/N] `);
  const result = resolveLineReader(deps)();
  if (result.eof) return false;
  return parseYesNo(result.line);
}

/**
 * Real install / install --repair bookend (R5 / R6).
 */
export function runInstall(
  projectRoot: string,
  state: ProjectInstallState,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
  deps: InstallDeps = {},
): number {
  const { flags, rest, usageError } = parseFlags(argv);
  const env = deps.env ?? process.env;

  // Missing --target-version / --package-manager values → usage before registry/PM.
  if (usageError !== null) {
    io.writeErr(`${usageError}\n`);
    return EXIT_CODES.USAGE;
  }

  // Unknown leftover argv (e.g. --dryrun misspelling) → usage before registry/PM.
  if (rest.length > 0) {
    io.writeErr(`Unknown argument(s): ${rest.join(" ")}\n`);
    return EXIT_CODES.USAGE;
  }

  // AC6.5: --repair + --target-version rejected
  if (flags.repair && flags.targetVersion !== null) {
    io.writeErr(
      "Cannot combine --repair with --target-version. Repair keeps the existing pin; use directive upgrade to change versions.\n",
    );
    return EXIT_CODES.USAGE;
  }

  // L2: unsupported-honest / residual uninstall-reinstall refuse.
  // convert-via-removals falls through to first-install with from=shapeId (3f).
  const installShape = resolveInstallShape(projectRoot);
  if (installShape !== null && isL2RefusalDecision(installShape.decision)) {
    io.writeErr(`${formatShapeRecoveryMessage(installShape, "install")}\n`);
    return EXIT_CODES.FAILURE;
  }
  // Old-style: install changes nothing and names upgrade (AC6.13).
  // Launcher usually gates this earlier; keep a belt-and-braces check.
  if (state.oldStyle || installShape?.decision === "l0-latest-legacy-convert") {
    io.writeErr("This project uses an older Directive layout. Run `directive upgrade`.\n");
    return EXIT_CODES.FAILURE;
  }
  // Stash convert shape for first-install setup --from (WAVE3-V2).
  const convertShapeId =
    installShape?.decision === "convert-via-removals" ? installShape.shapeId : null;

  const configuredExact = state.pin.kind === "exact" && state.pin.version !== null;

  // AC6.4 / AC6.6 / INIT-16 / INIT-20: configured without --repair
  if (configuredExact && !flags.repair) {
    const pinVersion = state.pin.version!;
    if (flags.dryRun) {
      const defaultChoice = shouldDefaultToRepair(projectRoot, state) ? "repair" : "cancel";
      io.writeOut(
        `Directive is already configured. Pinned version: ${pinVersion}.\n` +
          `[dry-run] would present Repair ${pinVersion} / Cancel ` +
          `(default: ${defaultChoice === "repair" ? "Repair" : "Cancel"}; use --repair to select repair).\n`,
      );
      return EXIT_CODES.SUCCESS;
    }
    if (flags.yes) {
      presentAmbiguousYes(io, pinVersion);
      return EXIT_CODES.USAGE;
    }
    const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    if (!tty) {
      io.writeErr(
        `Directive is already configured (pin ${pinVersion}). Pass --repair --yes to repair, or run interactively.\n` +
          `  directive install --repair --yes\n` +
          `  directive upgrade --yes\n`,
      );
      return EXIT_CODES.USAGE;
    }
    // Interactive Repair/Cancel menu (INIT-16) with INIT-15 default rule.
    const menuOpts: ChooseMenuOptions = {
      projectRoot,
      pinVersion,
      defaultChoice: shouldDefaultToRepair(projectRoot, state) ? "repair" : "cancel",
    };
    let choice: ConfiguredMenuChoice | "eof";
    if (deps.chooseMenu) {
      printConfiguredMenu(io, menuOpts);
      choice = deps.chooseMenu(menuOpts);
    } else {
      choice = defaultChooseMenu(io, menuOpts, resolveLineReader(deps));
    }
    if (choice === "eof") {
      io.writeErr(
        `Non-interactive session requires --yes to approve. Pass --repair --yes to repair, or run interactively.\n` +
          `  directive install --repair --yes\n` +
          `  directive upgrade --yes\n`,
      );
      return EXIT_CODES.USAGE;
    }
    if (choice === "cancel") {
      io.writeOut(`${CANCELLED_NO_CHANGES}\n`);
      return EXIT_CODES.SUCCESS;
    }
    return runRepair(projectRoot, state, flags, launcherVersion, io, deps, env);
  }

  if (flags.repair) {
    return runRepair(projectRoot, state, flags, launcherVersion, io, deps, env);
  }

  return runFirstInstall(projectRoot, state, flags, launcherVersion, io, deps, env, convertShapeId);
}

function runFirstInstall(
  projectRoot: string,
  state: ProjectInstallState,
  flags: BookendFlags,
  launcherVersion: string,
  io: BookendIo,
  deps: InstallDeps,
  env: NodeJS.ProcessEnv,
  convertShapeId: string | null = null,
): number {
  // Invalid / ranged pin present (not "none", not exact) — do not treat as first install (AC6.3)
  if (state.pin.kind === "range" || state.pin.kind === "invalid") {
    io.writeErr(
      `Runtime pin is ${state.pin.kind} (${state.pin.raw}). Rectify package.json to an exact @deftai/directive-runtime version, then retry.\n`,
    );
    return EXIT_CODES.FAILURE;
  }

  const pmDetect = detectPackageManager(projectRoot, flags.packageManager);
  if (!pmDetect.ok) {
    io.writeErr(`${pmDetect.message}\n`);
    return EXIT_CODES.USAGE;
  }

  const pmMissing = preflightPmAvailable(projectRoot, pmDetect.pm, deps, io);
  if (pmMissing !== null) return pmMissing;

  let targetVersion: string;
  if (flags.targetVersion !== null) {
    const validated = validateTargetVersionSpec(flags.targetVersion);
    if (!validated.ok) {
      io.writeErr(`${validated.message}\n`);
      return EXIT_CODES.USAGE;
    }
    targetVersion = validated.version;
  } else {
    const resolver = deps.resolveLatest ?? (() => resolveLatestStableVersion(env, projectRoot));
    const resolved = resolver();
    // Support sync or async seam; install path is sync so only sync results are used.
    if (resolved instanceof Promise) {
      io.writeErr("Internal error: async resolveLatest is not supported in sync install path.\n");
      return EXIT_CODES.FAILURE;
    }
    if (!resolved.ok) {
      return reportRegistryLookupFailure(io, resolved.message, {
        projectRoot,
        env,
        verb: "install",
        deps,
      });
    }
    targetVersion = resolved.version;
  }

  const willCreatePkg = !existsSync(join(projectRoot, "package.json"));
  const pmCmd = formatPmExactAddCommand(pmDetect.pm, targetVersion, projectRoot);
  // #4960 / Problem 20: disclose a hooks takeover inside this one plan.
  const hooksTakeover = detectHooksTakeover(projectRoot);

  presentFirstInstallPlan(io, {
    projectRoot,
    pm: pmDetect.pm,
    pmEvidence: pmDetect.evidence,
    version: targetVersion,
    pmCommand: pmCmd,
    willCreatePkg,
    gitHooksInactive: !existsSync(join(projectRoot, ".git")),
    hooksTakeover,
    nodeWarning: checkNodeVersion(deps.nodeVersion).warning ?? null,
    verbosity: flags.verbosity,
  });
  const planFp = fingerprintPlanCriticalFiles(projectRoot, pmDetect.pm);

  if (flags.dryRun) {
    io.writeOut("[dry-run] no changes made.\n");
    return EXIT_CODES.SUCCESS;
  }

  const approval = requireApproval(flags, deps, io, "Set up Directive in this project?");
  if (approval !== null) return approval;

  const stale = assertPlanStillValid(projectRoot, pmDetect.pm, planFp, io);
  if (stale !== null) return stale;

  if (willCreatePkg) {
    ensurePackageJson(projectRoot);
    io.writeOut('Created package.json { "private": true }\n');
  }

  const wsBefore = pnpmWorkspaceDigest(projectRoot);
  const add =
    deps.runPmAdd?.({ projectRoot, pm: pmDetect.pm, version: targetVersion }) ??
    runPmExactAdd({ projectRoot, pm: pmDetect.pm, version: targetVersion, env });
  if (!add.ok) {
    return reportPmFailure(io, add, targetVersion, { projectRoot, env, verb: "install", deps });
  }
  const pnpmWorkspaceChanged = pnpmWorkspaceDigest(projectRoot) !== wsBefore;

  // Verify pin + installed version (INIT-14)
  const after = readProjectInstallState(projectRoot);
  if (after.pin.kind !== "exact" || after.pin.version !== targetVersion) {
    io.writeErr(
      `Pin verification failed: expected ${targetVersion}, got ${after.pin.raw ?? "(none)"}.\n`,
    );
    return EXIT_CODES.FAILURE;
  }
  const installed = readInstalledRuntime(projectRoot);
  if (installed === null || installed.version !== targetVersion) {
    io.writeErr(
      `Installed package verification failed: expected ${RUNTIME_PACKAGE_NAME}@${targetVersion}, found ${installed?.version ?? "nothing"}.\n`,
    );
    return EXIT_CODES.FAILURE;
  }
  if (installed.contract > 1 /* LAUNCHER_MAX mirrored via pin helpers */) {
    // pin.ts already exposes contractSupported on full state
  }
  const verified = readProjectInstallState(projectRoot);
  if (!verified.contractSupported) {
    io.writeErr(
      "This launcher is too old for the installed runtime. `npm i -g @deftai/directive@latest`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  return handOffSetup({
    projectRoot,
    launcherVersion,
    runtime: installed,
    operation: "install",
    from: convertShapeId ?? "none",
    io,
    deps,
    verbosity: flags.verbosity,
    pm: pmDetect.pm,
    pnpmWorkspaceChanged,
    hooksTakeover,
  }).exitCode;
}

function runRepair(
  projectRoot: string,
  state: ProjectInstallState,
  flags: BookendFlags,
  launcherVersion: string,
  io: BookendIo,
  deps: InstallDeps,
  env: NodeJS.ProcessEnv,
): number {
  if (state.pin.kind !== "exact" || state.pin.version === null) {
    io.writeErr(
      `Repair requires an existing unambiguous exact ${RUNTIME_PACKAGE_NAME} pin ` +
        `(found ${state.pin.kind}: ${state.pin.raw ?? "none"}). Rectify package.json; repair does not guess a version.\n`,
    );
    return EXIT_CODES.FAILURE;
  }
  const pinVersion = state.pin.version;

  const pmDetect = detectPackageManager(projectRoot, flags.packageManager);
  if (!pmDetect.ok) {
    io.writeErr(`${pmDetect.message}\n`);
    return EXIT_CODES.USAGE;
  }

  const lockOk = lockfileRecordsExactPin(projectRoot, pinVersion, pmDetect.pm);
  const installedOk =
    state.installed !== null && state.installed.version === pinVersion && state.contractSupported;
  const needsPmRestore = !lockOk || !installedOk;

  if (needsPmRestore) {
    const pmMissing = preflightPmAvailable(projectRoot, pmDetect.pm, deps, io);
    if (pmMissing !== null) return pmMissing;
  }

  const pmCmd = formatPmExactAddCommand(pmDetect.pm, pinVersion, projectRoot);
  const restoreReason = lockOk
    ? "installed package mismatch/missing"
    : "lockfile missing/unusable/disagree";
  // #4960 / Problem 20: disclose a hooks takeover inside this one plan.
  const hooksTakeover = detectHooksTakeover(projectRoot);

  presentRepairPlan(io, {
    projectRoot,
    pm: pmDetect.pm,
    pmEvidence: pmDetect.evidence,
    version: pinVersion,
    needsPmRestore,
    pmCommand: needsPmRestore ? pmCmd : null,
    restoreReason: needsPmRestore ? restoreReason : null,
    gitHooksInactive: !existsSync(join(projectRoot, ".git")),
    hooksTakeover,
    nodeWarning: checkNodeVersion(deps.nodeVersion).warning ?? null,
    verbosity: flags.verbosity,
  });
  const planFp = fingerprintPlanCriticalFiles(projectRoot, pmDetect.pm);

  if (flags.dryRun) {
    io.writeOut("[dry-run] no changes made.\n");
    return EXIT_CODES.SUCCESS;
  }

  const approval = requireApproval(
    flags,
    deps,
    io,
    `Repair Directive ${pinVersion} in this project?`,
  );
  if (approval !== null) return approval;

  const stale = assertPlanStillValid(projectRoot, pmDetect.pm, planFp, io);
  if (stale !== null) return stale;

  let pnpmWorkspaceChanged = false;
  if (needsPmRestore) {
    const wsBefore = pnpmWorkspaceDigest(projectRoot);
    const add =
      deps.runPmAdd?.({ projectRoot, pm: pmDetect.pm, version: pinVersion }) ??
      runPmExactAdd({ projectRoot, pm: pmDetect.pm, version: pinVersion, env });
    if (!add.ok) {
      return reportPmFailure(io, add, pinVersion, {
        projectRoot,
        env,
        verb: "repair",
        deps,
        pm: pmDetect.pm,
        lockfileRecordsPin: lockOk,
      });
    }
    pnpmWorkspaceChanged = pnpmWorkspaceDigest(projectRoot) !== wsBefore;
  }

  const after = readProjectInstallState(projectRoot);
  if (after.pin.version !== pinVersion) {
    io.writeErr(`Repair changed the pin unexpectedly (${after.pin.raw}). Aborting.\n`);
    return EXIT_CODES.FAILURE;
  }
  const installed = readInstalledRuntime(projectRoot);
  if (installed === null || installed.version !== pinVersion) {
    io.writeErr(
      `Repair could not install the pinned runtime (expected ${pinVersion}, found ${installed?.version ?? "nothing"}). ` +
        `Run ${projectInstallCommand(projectRoot)} and read its output.\n`,
    );
    return EXIT_CODES.FAILURE;
  }
  if (!after.contractSupported) {
    io.writeErr(
      "This launcher is too old for this project. `npm i -g @deftai/directive@latest`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  return handOffSetup({
    projectRoot,
    launcherVersion,
    runtime: installed,
    operation: "repair",
    from: pinVersion,
    io,
    deps,
    verbosity: flags.verbosity,
    pm: pmDetect.pm,
    restoredPackage: needsPmRestore,
    pnpmWorkspaceChanged,
    hooksTakeover,
  }).exitCode;
}

function reportInvokeStderr(io: BookendIo, result: InvokeResult): void {
  if (result.message) io.writeErr(`${result.message}\n`);
  if (result.stderr) {
    io.writeErr(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
}

function reportJsonSummary(
  io: BookendIo,
  label: string,
  result: InvokeResult,
  verbosity: Verbosity,
): SetupSummary | null {
  reportInvokeStderr(io, result);
  if (!result.stdout) return null;
  const summary = tryParseSetupSummary(result.stdout);
  if (summary) {
    // Default human path: omit created=[...] dumps; -v/-vv via presentPathSummary.
    if (verbosity >= 1) {
      presentPathSummary(io, label, summary, verbosity);
    } else if (summary.message) {
      io.writeOut(`${summary.message}\n`);
    }
    return summary;
  }
  io.writeOut(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  return null;
}

function handOffSetup(opts: {
  projectRoot: string;
  launcherVersion: string;
  runtime: NonNullable<ProjectInstallState["installed"]>;
  operation: "install" | "repair" | "upgrade";
  from: string;
  io: BookendIo;
  deps: InstallDeps;
  verbosity: Verbosity;
  pm: PackageManager;
  restoredPackage?: boolean;
  /** pnpm changed pnpm-workspace.yaml during the PM add (#5854 / #6006). */
  pnpmWorkspaceChanged?: boolean;
  /**
   * Hooks takeover disclosed in the approved install/repair plan (#4960). Only
   * then does setup get --take-over-hooks-path; upgrade never passes it.
   */
  hooksTakeover?: HooksTakeover | null;
}): { exitCode: number; summary: SetupSummary | null } {
  const hooksTakeover = opts.operation === "upgrade" ? null : (opts.hooksTakeover ?? null);
  const argv = setupArgv(opts.operation, opts.from, opts.projectRoot, {
    takeOverHooksPath: hooksTakeover !== null,
  });
  const result =
    opts.deps.invokeSetup?.(argv) ??
    invokeRuntime({
      projectRoot: opts.projectRoot,
      launcherVersion: opts.launcherVersion,
      runtime: opts.runtime,
      argv,
      stdio: "pipe",
    });
  // Success presenters own path dumps for install/repair; upgrade caller combines later.
  const suppressPathDump =
    result.exitCode === 0 &&
    (opts.operation === "install" || opts.operation === "repair" || opts.operation === "upgrade");
  let summary: SetupSummary | null = null;
  if (suppressPathDump) {
    reportInvokeStderr(opts.io, result);
    summary = tryParseSetupSummary(result.stdout);
  } else {
    summary = reportJsonSummary(opts.io, `setup ${opts.operation}`, result, opts.verbosity);
  }
  if (result.exitCode === 0) {
    if (opts.operation === "install") {
      presentInstallSuccess(opts.io, {
        version: opts.runtime.version,
        projectRoot: opts.projectRoot,
        pm: opts.pm,
        summary,
        verbosity: opts.verbosity,
        pnpmWorkspaceChanged: opts.pnpmWorkspaceChanged ?? false,
        hooksTakeover,
      });
    } else if (opts.operation === "repair") {
      presentRepairSuccess(opts.io, {
        version: opts.runtime.version,
        restoredPackage: opts.restoredPackage ?? false,
        summary,
        verbosity: opts.verbosity,
        pm: opts.pm,
        pnpmWorkspaceChanged: opts.pnpmWorkspaceChanged ?? false,
        hooksTakeover,
      });
    }
    // upgrade: caller presents after migrate
  } else if (
    opts.operation === "install" ||
    opts.operation === "upgrade" ||
    opts.operation === "repair"
  ) {
    presentSetupFailedAfterInstall(opts.io, {
      version: opts.runtime.version,
      operation: opts.operation,
      failedPaths: summary?.conflicts,
      reason: result.message ?? summary?.message ?? null,
    });
  }
  return { exitCode: result.exitCode, summary };
}

function handOffMigrate(opts: {
  projectRoot: string;
  launcherVersion: string;
  runtime: NonNullable<ProjectInstallState["installed"]>;
  from: string;
  io: BookendIo;
  deps: UpgradeDeps;
  verbosity: Verbosity;
}): { exitCode: number; summary: SetupSummary | null } {
  const argv = migrateArgv(opts.from, opts.projectRoot);
  const result =
    opts.deps.invokeMigrate?.(argv) ??
    invokeRuntime({
      projectRoot: opts.projectRoot,
      launcherVersion: opts.launcherVersion,
      runtime: opts.runtime,
      argv,
      stdio: "pipe",
    });
  // Success: caller presents combined upgrade report. Failure: caller presents
  // AC14.18 shape at default verbosity (do not dump message-only here).
  reportInvokeStderr(opts.io, result);
  const summary = tryParseSetupSummary(result.stdout);
  if (result.exitCode !== 0 && opts.verbosity >= 1 && summary) {
    presentPathSummary(opts.io, "migrate", summary, opts.verbosity);
  } else if (result.exitCode !== 0 && !summary && result.stdout) {
    opts.io.writeOut(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
  return { exitCode: result.exitCode, summary };
}

/** GENERATION + readable wiring-ready.<V> JSON; optional body version must match (AC8.6). */
export function isWiringCurrentForVersion(projectRoot: string, version: string): boolean {
  try {
    const genPath = join(projectRoot, ".deft", "GENERATION.json");
    if (!existsSync(genPath)) return false;
    const genRaw: unknown = JSON.parse(readFileSync(genPath, "utf8"));
    if (genRaw === null || typeof genRaw !== "object" || Array.isArray(genRaw)) return false;
    if ((genRaw as { runtimeVersion?: unknown }).runtimeVersion !== version) return false;
    const ready = join(projectRoot, ".deft", "directive", `wiring-ready.${version}.json`);
    if (!existsSync(ready)) return false;
    const bodyRaw: unknown = JSON.parse(readFileSync(ready, "utf8"));
    if (bodyRaw === null || typeof bodyRaw !== "object" || Array.isArray(bodyRaw)) return false;
    const bodyVersion = (bodyRaw as { runtimeVersion?: unknown }).runtimeVersion;
    // Filename encodes V; body version, when present, must agree (same as readReadiness).
    if (bodyVersion !== undefined && bodyVersion !== version) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Accept doctor data-status only on successful exit + supported contract (AC4.10).
 * Exported for focused unit tests.
 */
export function parseDoctorDataStatusResponse(result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly message?: string | null;
}): { ok: true; dataStatus: DataStatusValue } | { ok: false; message: string } {
  if (result.exitCode !== 0) {
    return {
      ok: false,
      message: result.message ?? `doctor diagnostic failed (exit ${result.exitCode})`,
    };
  }
  try {
    const line = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "doctor data-status JSON malformed" };
    }
    const obj = parsed as { contract?: unknown; dataStatus?: unknown };
    if (obj.contract !== CONTRACT_NUMBER) {
      return {
        ok: false,
        message: `doctor data-status unsupported contract: ${String(obj.contract)}`,
      };
    }
    const status = obj.dataStatus;
    if (status !== "current" && status !== "migration_needed" && status !== "diagnosis_failed") {
      return { ok: false, message: `doctor data-status unknown: ${String(status)}` };
    }
    return { ok: true, dataStatus: status };
  } catch {
    return {
      ok: false,
      message: result.message ?? "doctor data-status parse failed",
    };
  }
}

function obtainDataStatus(
  projectRoot: string,
  launcherVersion: string,
  runtime: NonNullable<ProjectInstallState["installed"]>,
  deps: UpgradeDeps,
): { ok: true; dataStatus: DataStatusValue } | { ok: false; message: string } {
  if (deps.invokeDoctorDataStatus) return deps.invokeDoctorDataStatus();
  const result = invokeRuntime({
    projectRoot,
    launcherVersion,
    runtime,
    argv: doctorArgv(),
    stdio: "pipe",
  });
  return parseDoctorDataStatusResponse(result);
}

/**
 * Real upgrade / update bookend (R7 / AC7.* / AC4.10 / AC4.7).
 */
export function runUpgrade(
  projectRoot: string,
  state: ProjectInstallState,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
  deps: UpgradeDeps = {},
): number {
  // #7056: upgrade-only consent flag; taken out before the shared parser so
  // install / repair / uninstall still reject it.
  const migrateXbrief = argv.includes(MIGRATE_XBRIEF_FLAG);
  const { flags, rest, usageError } = parseFlags(argv.filter((a) => a !== MIGRATE_XBRIEF_FLAG));
  const env = deps.env ?? process.env;

  if (usageError !== null) {
    io.writeErr(`${usageError}\n`);
    return EXIT_CODES.USAGE;
  }
  if (rest.length > 0) {
    io.writeErr(`Unknown argument(s): ${rest.join(" ")}\n`);
    return EXIT_CODES.USAGE;
  }

  // L2: only unsupported-honest / residual uninstall-reinstall refuse.
  // convert-via-removals continues into strategy → pin → setup → migrate (3f).
  const upgradeShape = resolveInstallShape(projectRoot);
  if (upgradeShape !== null && isL2RefusalDecision(upgradeShape.decision)) {
    io.writeErr(`${formatShapeRecoveryMessage(upgradeShape, "upgrade")}\n`);
    return EXIT_CODES.USAGE;
  }

  const convertViaRemovals =
    upgradeShape !== null && upgradeShape.decision === "convert-via-removals";

  // AC7.1: exact pin or old-style; WAVE3-V2 also allows convert-via-removals shapes.
  const exactPin = state.pin.kind === "exact" && state.pin.version !== null;
  if (!exactPin && !state.oldStyle && !convertViaRemovals) {
    io.writeErr(
      `Upgrade requires an exact ${RUNTIME_PACKAGE_NAME} pin or a supported old-style layout. Run \`directive install\`.\n`,
    );
    return EXIT_CODES.USAGE;
  }

  const currentPin = state.pin.version ?? "none";
  const fromLabel = state.oldStyle
    ? "old-style"
    : convertViaRemovals
      ? upgradeShape?.shapeId
      : currentPin;

  // Resolve target once before plan (AC7.2)
  let targetVersion: string;
  if (flags.targetVersion !== null) {
    const validated = validateTargetVersionSpec(flags.targetVersion);
    if (!validated.ok) {
      io.writeErr(`${validated.message}\n`);
      return EXIT_CODES.USAGE;
    }
    targetVersion = validated.version;
  } else {
    const resolver = deps.resolveLatest ?? (() => resolveLatestStableVersion(env, projectRoot));
    const resolved = resolver();
    if (resolved instanceof Promise) {
      io.writeErr("Internal error: async resolveLatest is not supported in sync upgrade path.\n");
      return EXIT_CODES.FAILURE;
    }
    if (!resolved.ok) {
      return reportRegistryLookupFailure(io, resolved.message, {
        projectRoot,
        env,
        verb: "upgrade",
        deps,
      });
    }
    targetVersion = resolved.version;
  }

  // Target older than pin → reject (AC7.3). Parse failure is never treated as equal.
  // old-style / convert-via-removals always treat as version-changing conversion.
  let versionOrd: number;
  try {
    versionOrd =
      state.oldStyle || convertViaRemovals ? 1 : compareExactVersions(targetVersion, currentPin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.writeErr(`${msg}\n`);
    return EXIT_CODES.FAILURE;
  }
  if (!state.oldStyle && !convertViaRemovals && versionOrd < 0) {
    io.writeErr(
      `Target ${targetVersion} is older than pin ${currentPin}; upgrade rejects downgrades.\n`,
    );
    return EXIT_CODES.FAILURE;
  }

  // Contract preflight before modifying pin/lockfile (AC4.7 / AC7.2)
  const contractResolver =
    deps.resolvePublishedContract ??
    ((version: string) => resolvePublishedContract(version, env, projectRoot));
  const published = contractResolver(targetVersion);
  if (!published.ok) {
    return reportRegistryLookupFailure(io, published.message, {
      projectRoot,
      env,
      verb: "upgrade",
      deps,
    });
  }
  if (!isContractSupported(published.contract)) {
    io.writeErr(
      `This launcher is too old for target ${RUNTIME_PACKAGE_NAME}@${targetVersion} ` +
        `(contract ${published.contract} > ${LAUNCHER_MAX_SUPPORTED_CONTRACT}). ` +
        "`npm i -g @deftai/directive@latest`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  const versionChange = state.oldStyle || convertViaRemovals || versionOrd !== 0;
  const pmDetect = detectPackageManager(projectRoot, flags.packageManager);
  if (!pmDetect.ok) {
    io.writeErr(`${pmDetect.message}\n`);
    return EXIT_CODES.USAGE;
  }

  // Equal-version: AC4.10 data-status + wiring check
  let needSetup = versionChange;
  let needMigrate = versionChange;
  let dataStatus: DataStatusValue | null = null;

  if (!versionChange) {
    if (state.installed === null || !state.pinMatchesInstalled || !state.contractSupported) {
      const blocked = classifyLauncherSituation(projectRoot, state);
      io.writeErr(
        `Equal-version upgrade needs the pinned runtime installed. ${blocked?.message ?? ""}`.trimEnd() +
          "\n",
      );
      return EXIT_CODES.FAILURE;
    }
    const status = obtainDataStatus(projectRoot, launcherVersion, state.installed, deps);
    if (!status.ok) {
      io.writeErr(`Data-status diagnostic failed: ${status.message}\n`);
      return EXIT_CODES.FAILURE;
    }
    if (status.dataStatus === "diagnosis_failed") {
      io.writeErr("Data-status diagnostic reported diagnosis_failed; refusing no-op.\n");
      return EXIT_CODES.FAILURE;
    }
    dataStatus = status.dataStatus;
    const wiringCurrent = isWiringCurrentForVersion(projectRoot, currentPin);
    needSetup = !wiringCurrent;
    needMigrate = dataStatus === "migration_needed" || needSetup;
    if (!needSetup && !needMigrate) {
      io.writeOut(
        `directive upgrade: already current (${RUNTIME_PACKAGE_NAME}@${currentPin}; wiring + data current). No-op.\n`,
      );
      return EXIT_CODES.SUCCESS;
    }
  }

  // Version-changing upgrades need the PM; equal-version setup/migrate may not.
  if (versionChange) {
    const pmMissing = preflightPmAvailable(projectRoot, pmDetect.pm, deps, io);
    if (pmMissing !== null) return pmMissing;
  }

  const pmCmd = versionChange
    ? formatPmExactAddCommand(pmDetect.pm, targetVersion, projectRoot)
    : null;

  // #7056: a migration that would process and delete a non-empty vbrief/ tree
  // needs its own consent; null means the migrate hand-off runs as before.
  const legacyVbrief = needMigrate ? detectLegacyVbriefTree(projectRoot) : null;

  presentUpgradePlan(io, {
    projectRoot,
    pm: pmDetect.pm,
    pmEvidence: pmDetect.evidence,
    version: targetVersion,
    currentVersion: currentPin,
    targetVersion,
    versionChange,
    pmCommand: pmCmd,
    needSetup,
    needMigrate,
    oldStyle: state.oldStyle,
    convertShapeId: convertViaRemovals ? upgradeShape?.shapeId : null,
    willCreatePkg: convertViaRemovals && !existsSync(join(projectRoot, "package.json")),
    deftCoreGitEdits:
      state.oldStyle || convertViaRemovals
        ? (deps.listDeftCoreGitEdits ?? listDeftCoreGitEdits)(projectRoot)
        : null,
    gitHooksInactive: !existsSync(join(projectRoot, ".git")),
    nodeWarning: checkNodeVersion(deps.nodeVersion).warning ?? null,
    verbosity: flags.verbosity,
    legacyVbrief,
    migrateXbrief,
  });
  const planFp = fingerprintPlanCriticalFiles(projectRoot, pmDetect.pm);

  if (flags.dryRun) {
    io.writeOut("[dry-run] no changes made.\n");
    return EXIT_CODES.SUCCESS;
  }

  const migrationPrompt =
    legacyVbrief === null
      ? ""
      : `Run the vbrief → xbrief migration now (processes ${legacyVbrief.files} file(s) under vbrief/ and deletes vbrief/)?`;
  // True when the migrate hand-off may run: no legacy tree, or consent given.
  let migrateConsent = legacyVbrief === null || migrateXbrief;

  if (legacyVbrief !== null && !migrateXbrief && !versionChange && !needSetup) {
    // #7056: the gated migration is the only remaining work; its own
    // question is the approval, and no consent means nothing to do.
    migrateConsent = askMigrationConsent(flags, deps, io, migrationPrompt);
    if (!migrateConsent) {
      presentMigrationPending(io, legacyVbrief, currentPin);
      io.writeOut(`${CANCELLED_NO_CHANGES}\n`);
      return EXIT_CODES.SUCCESS;
    }
  } else {
    const approval = requireApproval(
      flags,
      deps,
      io,
      versionChange
        ? `Upgrade Directive from ${currentPin} to ${targetVersion}?`
        : `Finish equal-version upgrade work for ${currentPin}?`,
    );
    if (approval !== null) return approval;
    if (!migrateConsent && legacyVbrief !== null) {
      migrateConsent = askMigrationConsent(flags, deps, io, migrationPrompt);
    }
  }

  // #7056: consent was granted for the tree the plan showed. If vbrief/ was
  // empty or absent then and files appeared since (during the prompt, PM add
  // or setup), recheck right before the hand-off: without the flag the
  // migration stays pending rather than deleting files nobody was shown.
  const migrationGate = (): { run: boolean; legacy: LegacyVbriefTree | null } => {
    if (legacyVbrief !== null) return { run: migrateConsent, legacy: legacyVbrief };
    const late = detectLegacyVbriefTree(projectRoot);
    return { run: late === null || migrateXbrief, legacy: late };
  };

  const stale = assertPlanStillValid(projectRoot, pmDetect.pm, planFp, io);
  if (stale !== null) return stale;

  if (versionChange) {
    // #5854 / #6006: baseline before any PM call so a file pnpm changes is listed for review.
    const wsBefore = pnpmWorkspaceDigest(projectRoot);
    // AC10.3: replace pre-split @deftai/directive pin before PM adds the runtime.
    if (state.oldStyle || convertViaRemovals) {
      // F-016 / AC6.12: create {private:true} BEFORE any PM remove. `npm remove`
      // with no manifest invents `{}`, which would make a later ensurePackageJson
      // no-op and drop the private greenfield marker.
      if (convertViaRemovals && !existsSync(join(projectRoot, "package.json"))) {
        ensurePackageJson(projectRoot);
        io.writeOut('Created package.json { "private": true }\n');
      }
      // Strip launcher pin + retired triad before PM add (wave4e / AC10.3).
      // Upgrade must not require old triad tarballs on the registry.
      // 1) PM remove first so lockfiles drop triad entries (pnpm otherwise 404s
      //    hybrid @deftai→Verdaccio scopes — ledgerd residual).
      // 2) package.json strip as belt-and-suspenders if PM remove no-ops.
      for (const packageName of RETIRED_DIRECTIVE_PACKAGE_NAMES) {
        const rm =
          deps.runPmRemove?.({ projectRoot, pm: pmDetect.pm, packageName }) ??
          runPmRemove({ projectRoot, pm: pmDetect.pm, packageName, env });
        if (!rm.ok && rm.interrupted) {
          return reportPmFailure(io, rm);
        }
        // Non-ok (already absent, etc.): continue — strip + add still proceed.
      }
      removeLegacyDirectivePackages(projectRoot);
      // Lockfile-only triad (pnpm) still 404s hybrid Verdaccio — drop those lockfiles.
      const purged = purgeRetiredDirectiveLockfiles(projectRoot);
      if (purged.length > 0 && flags.verbosity >= 1) {
        io.writeOut(
          `Purged lockfile(s) referencing retired Directive packages: ${purged.join(", ")}\n`,
        );
      }
    }
    // Convert shapes may lack a package.json (rare); ensure before PM add.
    if (convertViaRemovals && !existsSync(join(projectRoot, "package.json"))) {
      ensurePackageJson(projectRoot);
      io.writeOut('Created package.json { "private": true }\n');
    }
    const add =
      deps.runPmAdd?.({ projectRoot, pm: pmDetect.pm, version: targetVersion }) ??
      runPmExactAdd({ projectRoot, pm: pmDetect.pm, version: targetVersion, env });
    if (!add.ok) {
      return reportPmFailure(io, add, targetVersion, { projectRoot, env, verb: "upgrade", deps });
    }
    const pnpmWorkspaceChanged = pnpmWorkspaceDigest(projectRoot) !== wsBefore;

    const after = readProjectInstallState(projectRoot);
    if (after.pin.kind !== "exact" || after.pin.version !== targetVersion) {
      io.writeErr(
        `Pin verification failed: expected ${targetVersion}, got ${after.pin.raw ?? "(none)"}.\n`,
      );
      return EXIT_CODES.FAILURE;
    }
    const installed = readInstalledRuntime(projectRoot);
    if (installed === null || installed.version !== targetVersion) {
      io.writeErr(
        `Installed package verification failed: expected ${RUNTIME_PACKAGE_NAME}@${targetVersion}, found ${installed?.version ?? "nothing"}.\n`,
      );
      return EXIT_CODES.FAILURE;
    }
    if (!isContractSupported(installed.contract)) {
      io.writeErr(
        "This launcher is too old for the installed runtime. `npm i -g @deftai/directive@latest`.\n",
      );
      return EXIT_CODES.FAILURE;
    }

    const setupResult = handOffSetup({
      projectRoot,
      launcherVersion,
      runtime: installed,
      operation: "upgrade",
      from: fromLabel,
      io,
      deps,
      verbosity: flags.verbosity,
      pm: pmDetect.pm,
    });
    if (setupResult.exitCode !== 0) {
      return setupResult.exitCode;
    }

    // F-016 belt-and-braces: convert setup must not delete the runtime pin package.json
    // (removeSoleAuthorHusks is uninstall-only). Fail closed instead of false success.
    if (convertViaRemovals) {
      const pkgPath = join(projectRoot, "package.json");
      if (!existsSync(pkgPath)) {
        io.writeErr(
          `Convert upgrade lost package.json after setup (shape ${upgradeShape?.shapeId}). ` +
            `Expected exact ${RUNTIME_PACKAGE_NAME}@${targetVersion}. ` +
            `Fix the cause, then run: directive upgrade --yes.\n`,
        );
        return EXIT_CODES.FAILURE;
      }
      const pinAfterSetup = readProjectInstallState(projectRoot).pin;
      if (pinAfterSetup.kind !== "exact" || pinAfterSetup.version !== targetVersion) {
        io.writeErr(
          `Convert upgrade lost runtime pin after setup (shape ${upgradeShape?.shapeId}): ` +
            `expected ${RUNTIME_PACKAGE_NAME}@${targetVersion}, got ${pinAfterSetup.raw ?? "(none)"}. ` +
            `Fix the cause, then run: directive upgrade --yes.\n`,
        );
        return EXIT_CODES.FAILURE;
      }
    }

    // #7056: without consent the migrate entry is not invoked at all (the
    // contract-1 argv cannot skip part of it), so vbrief/ stays untouched.
    let migrateSummary: SetupSummary | null = null;
    const gate = migrationGate();
    if (gate.run) {
      const migrateResult = handOffMigrate({
        projectRoot,
        launcherVersion,
        runtime: installed,
        from: fromLabel,
        io,
        deps,
        verbosity: flags.verbosity,
      });
      if (migrateResult.exitCode !== 0) {
        presentMigrateFailedAfterUpgrade(io, {
          version: targetVersion,
          versionChange: true,
          summary: migrateResult.summary,
        });
        return migrateResult.exitCode;
      }
      migrateSummary = migrateResult.summary;
    }

    presentUpgradeSuccess(io, {
      version: targetVersion,
      versionChange: true,
      pm: pmDetect.pm,
      summary: setupResult.summary,
      migrateSummary,
      verbosity: flags.verbosity,
      pnpmWorkspaceChanged,
      legacyVbrief: gate.legacy,
      migrationRan: gate.run,
    });
    return EXIT_CODES.SUCCESS;
  }

  // Equal-version path: setup-when-stale then migrate (no PM)
  const runtime = state.installed!;
  let setupSummary: SetupSummary | null = null;
  if (needSetup) {
    const setupResult = handOffSetup({
      projectRoot,
      launcherVersion,
      runtime,
      operation: "upgrade",
      from: fromLabel,
      io,
      deps,
      verbosity: flags.verbosity,
      pm: pmDetect.pm,
    });
    if (setupResult.exitCode !== 0) {
      return setupResult.exitCode;
    }
    setupSummary = setupResult.summary;
  }
  let migrateSummary: SetupSummary | null = null;
  // #7056: without consent the migrate entry is not invoked at all.
  const gate = needMigrate ? migrationGate() : { run: false, legacy: null };
  if (gate.run) {
    const migrateResult = handOffMigrate({
      projectRoot,
      launcherVersion,
      runtime,
      from: fromLabel,
      io,
      deps,
      verbosity: flags.verbosity,
    });
    if (migrateResult.exitCode !== 0) {
      presentMigrateFailedAfterUpgrade(io, {
        version: currentPin,
        versionChange: false,
        summary: migrateResult.summary,
      });
      return migrateResult.exitCode;
    }
    migrateSummary = migrateResult.summary;
  }
  presentUpgradeSuccess(io, {
    version: currentPin,
    versionChange: false,
    pm: pmDetect.pm,
    summary: setupSummary,
    migrateSummary,
    verbosity: flags.verbosity,
    legacyVbrief: gate.legacy,
    migrationRan: gate.run,
  });
  return EXIT_CODES.SUCCESS;
}

/** @deprecated Use {@link runInstall}. Kept as alias for any residual stub callers. */
export const runInstallStub = runInstall;

/** @deprecated Use {@link runUpgrade}. */
export const runUpgradeStub = runUpgrade;

/**
 * Uninstall bookend (R11 / AC11.*).
 * Discovery → plan → approval → repository uninstaller (when safe) →
 * launcher fallback cleanup → PM remove → hooksPath sibling protection.
 * No --force; no prerequisite install/repair/upgrade.
 */
export function runUninstall(
  projectRoot: string,
  state: ProjectInstallState,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
  deps: UninstallDeps = {},
): number {
  const { flags, rest, usageError } = parseFlags(argv);
  const env = deps.env ?? process.env;
  if (usageError !== null) {
    io.writeErr(`${usageError}\n`);
    return EXIT_CODES.USAGE;
  }
  // Unknown leftover argv (e.g. --dryrun misspelling) → usage before any removal.
  if (rest.length > 0) {
    io.writeErr(`Unknown argument(s): ${rest.join(" ")}\n`);
    return EXIT_CODES.USAGE;
  }

  // Retain discovery before any repository uninstaller mutates GENERATION (AC11.2).
  const discovery = discoverUninstallFootprint(projectRoot);

  if (!discovery.hasFootprint) {
    io.writeOut(
      "No Directive installation footprint found in this project. Nothing to uninstall.\n",
    );
    return EXIT_CODES.SUCCESS;
  }

  const removePaths = discovery.artifacts
    .filter((a) => a.kind !== "retained")
    .map((a) =>
      a.kind === "whole-file"
        ? a.path
        : a.kind === "marked-section"
          ? `${a.path} (marked section)`
          : `${a.path} (${a.entryKey ?? "structured entry"})`,
    );
  const keepPaths = discovery.artifacts.filter((a) => a.kind === "retained").map((a) => a.path);
  if (!keepPaths.includes("xbrief") && existsSync(join(projectRoot, "xbrief"))) {
    keepPaths.push("xbrief");
  }
  if (
    !keepPaths.includes(".deft/settings.json") &&
    existsSync(join(projectRoot, ".deft", "settings.json"))
  ) {
    keepPaths.push(".deft/settings.json");
  }
  keepPaths.push("user content in AGENTS.md / host configs", "global launcher");

  const pmDetect = detectPackageManager(projectRoot, flags.packageManager);
  const pmEvidence = pmDetect.ok
    ? pmDetect.evidence
    : "default (detection failed; will skip PM remove)";
  const packagesToRemove: string[] = [];
  if (discovery.hasRuntimePin) packagesToRemove.push(RUNTIME_PACKAGE_NAME);
  if (discovery.hasLegacyLauncherPin || state.oldStyle) {
    packagesToRemove.push(LAUNCHER_PACKAGE_NAME);
  }

  const pinRaw = state.pin.version ?? state.pin.raw;
  const pinVersion =
    pinRaw != null
      ? `${pinRaw}${state.oldStyle ? " (old-style)" : ""}`
      : state.oldStyle
        ? "(none) (old-style)"
        : null;
  const pmCommand =
    packagesToRemove.length > 0 && pmDetect.ok
      ? packagesToRemove.map((p) => formatPmRemoveCommand(pmDetect.pm, p, projectRoot)).join("; ")
      : null;
  const removal = summarizeUninstallRemovals(removePaths, {
    willRemovePin: packagesToRemove.length > 0,
    legacyCore: discovery.hasLegacyCore,
    preserveLabels: keepPaths,
  });
  const extraHumanLines =
    flags.verbosity >= 1
      ? [
          `Ownership record: ${discovery.ownershipInspection}`,
          `Installed runtime: ${state.installed?.version ?? "(missing/unavailable)"}`,
          state.installed && state.contractSupported
            ? "Repository uninstaller: invoke when available, then launcher fallback"
            : "Repository uninstaller: unavailable — launcher fallback only (no repair/upgrade required)",
          "hooksPath: unset .githooks only when safe for sibling worktrees",
        ]
      : undefined;

  // Shown at default verbosity: what uninstall edits in shared files, what it
  // keeps, and the worktrees it leaves alone (AC11.3 / #6007 / D-025).
  const directiveLineFiles = filesWithDirectiveLines(projectRoot);
  const worktrees = registeredWorktreesInsideProject(projectRoot);
  presentUninstallPlan(io, {
    projectRoot,
    pm: pmDetect.ok ? pmDetect.pm : null,
    pmEvidence: pmDetect.ok ? pmDetect.evidence : pmEvidence,
    pinVersion,
    pmCommand,
    verbosity: flags.verbosity,
    removal,
    extraHumanLines,
    directiveLineFiles,
    keptData: listKeptDirectiveData(projectRoot).filter((k) => !keepPaths.includes(k)),
    worktrees,
  });

  if (flags.dryRun) {
    io.writeOut("[dry-run] no changes made.\n");
    return EXIT_CODES.SUCCESS;
  }

  const approval = requireApproval(
    flags,
    {
      stdinIsTTY: deps.stdinIsTTY,
      confirm: deps.confirm,
      readInteractiveLine: deps.readInteractiveLine,
    },
    io,
    "Uninstall Directive from this project?",
  );
  if (approval !== null) return approval;

  // The package manager needs package.json for its remove. An older pinned
  // runtime's uninstaller deletes it first (#5999), so keep the bytes to restore.
  const manifestSnapshot = snapshotManifestFiles(projectRoot);
  let runtimeUninstallAttempted = false;
  let runtimeUninstallFailed = false;
  if (state.installed && state.contractSupported) {
    runtimeUninstallAttempted = true;
    const result =
      deps.invokeUninstall?.(uninstallArgv(projectRoot)) ??
      invokeRuntime({
        projectRoot,
        launcherVersion,
        runtime: state.installed,
        argv: uninstallArgv(projectRoot),
        stdio: "pipe",
      });
    reportJsonSummary(io, "repository uninstall", result, flags.verbosity);
    if (result.exitCode !== 0) {
      runtimeUninstallFailed = true;
      io.writeOut(
        "Repository uninstaller reported failure or partial removal; continuing launcher fallback cleanup.\n",
      );
    }
  } else {
    io.writeOut(
      "Runtime unavailable or incompatible; continuing launcher fallback cleanup (R11).\n",
    );
  }

  const cleanup =
    deps.applyCleanup?.(projectRoot, discovery) ?? applyLauncherCleanup(projectRoot, discovery);
  if (flags.verbosity >= 1) {
    io.writeOut(
      `launcher cleanup: removed=${JSON.stringify(cleanup.removed)} ` +
        `modified=${JSON.stringify(cleanup.modified)} ` +
        `preserved=${JSON.stringify(cleanup.preserved)}\n`,
    );
    if (cleanup.leftovers.length > 0) {
      io.writeOut(`leftovers: ${JSON.stringify(cleanup.leftovers)}\n`);
    }
    if (cleanup.uncertainty.length > 0) {
      io.writeOut(`uncertainty: ${JSON.stringify(cleanup.uncertainty)}\n`);
    }
  }

  const restored = restoreManifestFiles(projectRoot, manifestSnapshot);
  if (restored.length > 0 && flags.verbosity >= 1) {
    io.writeOut(`Restored ${restored.join(", ")} for the package manager remove.\n`);
  }

  // PM remove after wiring cleanup (AC11.6). Track the real result (#5999).
  const pmLeftovers = new Map<string, string>();
  let pinRemoved = false;
  if (packagesToRemove.length > 0) {
    if (!pmDetect.ok) {
      io.writeErr(`${pmDetect.message}\n`);
      io.writeErr("Could not remove package dependency via PM; pin may remain.\n");
      for (const packageName of packagesToRemove) {
        pmLeftovers.set(packageName, "no package manager found");
      }
    } else {
      for (const packageName of packagesToRemove) {
        if (packageName === LAUNCHER_PACKAGE_NAME) {
          // Ensure package.json no longer lists the legacy pin even if PM is odd.
          removeLegacyDirectivePin(projectRoot);
        }
        const rm =
          deps.runPmRemove?.({ projectRoot, pm: pmDetect.pm, packageName }) ??
          runPmRemove({ projectRoot, pm: pmDetect.pm, packageName, env });
        if (!rm.ok) {
          if (rm.interrupted) {
            return reportPmFailure(io, rm);
          }
          io.writeErr(`${rm.message}\n`);
          if (rm.stderr) io.writeErr(`${rm.stderr}\n`);
          io.writeErr(
            `PM remove of ${packageName} failed; continuing remaining uninstall steps.\n`,
          );
          pmLeftovers.set(packageName, rm.message);
        } else if (flags.verbosity >= 1) {
          io.writeOut(`Removed ${packageName} via ${pmDetect.pm}.\n`);
        }
      }
    }
    pinRemoved = pmLeftovers.size === 0;
  }

  // Sole-author manifest goes only after the package manager is done with it (F-013 / #5999).
  const manifestRemoved = pmLeftovers.size === 0 ? removeSoleAuthorManifest(projectRoot) : [];

  // core.hooksPath is touched only with evidence that Directive was installed
  // here: its hook files, its ownership record, or its pin (a retry after an
  // interrupted package-manager remove still has the pin). Lines left in shared
  // files alone are not that evidence: `.githooks` may be the user's own (AC11.6).
  const directiveHooksEvidence =
    discovery.ownershipInspection !== "absent" ||
    discovery.hasRuntimePin ||
    discovery.hasLegacyLauncherPin ||
    discovery.hasLegacyCore ||
    discovery.artifacts.some((a) => a.path.startsWith(".githooks/"));
  const hooksPathResult = directiveHooksEvidence
    ? (deps.cleanupHooksPath?.(projectRoot) ?? cleanupHooksPath(projectRoot))
    : "absent";
  if (flags.verbosity >= 1) {
    io.writeOut(`core.hooksPath: ${hooksPathResult}\n`);
  }
  const siblings =
    hooksPathResult === "preserved-sibling"
      ? (deps.siblingWorktrees?.(projectRoot) ?? siblingWorktreesNeedingHooksPath(projectRoot))
      : [];

  const verification = verifyUninstallComplete(projectRoot);
  const leftovers: string[] = [];
  for (const l of verification.leftovers) {
    // Legacy launcher pin leftover only matters for old-style; modern projects should not have it.
    if (
      l === `package.json#${LAUNCHER_PACKAGE_NAME}` &&
      !state.oldStyle &&
      !discovery.hasLegacyLauncherPin
    ) {
      continue;
    }
    const pkg = l.startsWith("package.json#") ? l.slice("package.json#".length) : null;
    const why = pkg !== null ? pmLeftovers.get(pkg) : undefined;
    leftovers.push(why !== undefined ? `${l} (${why})` : l);
  }
  for (const [pkg, why] of pmLeftovers) {
    if (!leftovers.some((l) => l.startsWith(`package.json#${pkg}`))) {
      leftovers.push(`package.json#${pkg} (${why})`);
    }
  }
  // AC5.16: never list node_modules; name the package instead.
  if (
    pinRemoved &&
    packagesToRemove.includes(RUNTIME_PACKAGE_NAME) &&
    existsSync(join(projectRoot, "node_modules", "@deftai", "directive-runtime"))
  ) {
    leftovers.push(`Directive package still installed (${RUNTIME_PACKAGE_NAME})`);
  }
  if (hooksPathResult === "unchanged") leftovers.push("core.hooksPath (could not unset)");
  for (const l of cleanup.leftovers) {
    if (!leftovers.includes(l)) leftovers.push(l);
  }
  // AC11.11: any leftover, failed PM remove or still-installed package is partial.
  const complete = leftovers.length === 0;

  const linesRemoved = cleanup.modified
    .filter((m) => m.endsWith("#directive-lines"))
    .map((m) => m.slice(0, -"#directive-lines".length));
  const keptLabels = cleanup.preserved.length > 0 ? cleanup.preserved : keepPaths;
  presentUninstallSuccess(io, {
    projectRoot,
    complete,
    removal,
    removedPaths: [...cleanup.removed, ...manifestRemoved],
    preserved: keptLabels,
    leftovers,
    uncertainty: cleanup.uncertainty,
    pinRemoved,
    directiveLineFiles: linesRemoved,
    hooksPath: { result: hooksPathResult, siblings },
    keptData: listKeptDirectiveData(projectRoot).filter((k) => !keptLabels.includes(k)),
    worktrees,
    verbosity: flags.verbosity,
  });
  if (runtimeUninstallAttempted && runtimeUninstallFailed && complete) {
    io.writeOut(
      "Repository uninstaller failed earlier, but launcher fallback verified complete removal.\n",
    );
  }

  if (!complete) {
    return EXIT_CODES.FAILURE;
  }
  return EXIT_CODES.SUCCESS;
}

/** @deprecated Use {@link runUninstall}. */
export const runUninstallStub = runUninstall;

/**
 * `directive doctor --json` writes exactly one JSON document to stdout in every
 * launcher-only state (#6004). Human text goes to stderr or is omitted.
 */
function writeDoctorJson(io: BookendIo, payload: Record<string, unknown>): void {
  io.writeOut(`${JSON.stringify({ entry: "doctor", launcher_only: true, ...payload })}\n`);
}

/**
 * Launcher doctor bookend (R12 / AC12.4 / AC3.15).
 * When the runtime can run: full read-only diagnosis.
 * When missing/broken: basic §A5.6 diagnosis ending in AC9.7.
 * Never writes.
 */
export function runDoctor(
  projectRoot: string | null,
  state: ProjectInstallState | null,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
): number {
  const { flags } = parseFlags(argv);
  const json = argv.includes("--json");
  const node = checkNodeVersion();
  if (node.warning) {
    if (json) io.writeErr(`${node.warning}\n`);
    else io.writeOut(`${node.warning}\n`);
  }

  // AC14.27 / A5.6: no project → non-zero + directive install.
  if (projectRoot === null || state === null) {
    io.writeErr("No Directive project here. Run `directive install`.\n");
    if (json) writeDoctorJson(io, { status: "no-project", recovery: "directive install" });
    return EXIT_CODES.FAILURE;
  }

  if (state.oldStyle) {
    const message = "This project uses an older Directive layout. Run `directive upgrade`.";
    if (json) {
      writeDoctorJson(io, { status: "old-layout", message, recovery: "directive upgrade" });
    } else {
      io.writeOut(`${message}\n`);
    }
    return EXIT_CODES.FAILURE;
  }

  // Bare --root / cwd with no Directive pin is still "not a project" (AC14.27).
  if (state.pin.kind === "none") {
    io.writeErr("No Directive project here. Run `directive install`.\n");
    if (json) writeDoctorJson(io, { status: "no-project", recovery: "directive install" });
    return EXIT_CODES.FAILURE;
  }

  const pinLabel = state.pin.version ?? state.pin.raw ?? "(none)";
  const installedLabel = state.installed?.version ?? "(missing)";

  // Runtime missing or pin≠installed → launcher basic diagnosis ending in one
  // next command from the shared table (AC12.4 / A5.6 / AC9.7).
  if (state.installed === null || !state.pinMatchesInstalled) {
    const blocked = classifyLauncherSituation(projectRoot, state);
    const next =
      blocked?.message ??
      formatEntryGuardMessage("runtime-missing", { install: projectInstallCommand(projectRoot) });
    if (json) {
      writeDoctorJson(io, {
        status: state.installed === null ? "runtime-missing" : "pin-mismatch",
        project_root: projectRoot,
        launcher: launcherVersion,
        pin: pinLabel,
        pin_kind: state.pin.kind,
        installed: state.installed?.version ?? null,
        recovery: next,
      });
    } else {
      io.writeOut(
        `directive doctor: project ${projectRoot}\n` +
          `  launcher: ${launcherVersion}\n` +
          `  pin: ${pinLabel} (${state.pin.kind})\n` +
          `  installed: ${state.installed === null ? "missing" : `${installedLabel} (≠ pin)`}\n` +
          `Next: ${next}\n`,
      );
    }
    return EXIT_CODES.FAILURE;
  }

  if (!state.contractSupported) {
    io.writeErr(
      "This launcher is too old for this project. `npm i -g @deftai/directive@latest`.\n",
    );
    if (json) {
      writeDoctorJson(io, {
        status: "launcher-too-old",
        recovery: "npm i -g @deftai/directive@latest",
      });
    }
    return EXIT_CODES.FAILURE;
  }

  if (flags.dryRun) {
    if (json) {
      writeDoctorJson(io, {
        status: "dry-run",
        project_root: projectRoot,
        launcher: launcherVersion,
        pin: pinLabel,
        installed: installedLabel,
      });
      return EXIT_CODES.SUCCESS;
    }
    io.writeOut(
      `directive doctor: project ${projectRoot}\n` +
        `  launcher: ${launcherVersion}\n` +
        `  pin: ${pinLabel}\n` +
        `  installed: ${installedLabel}\n` +
        `  (dry-run: runtime diagnosis not invoked)\n`,
    );
    return EXIT_CODES.SUCCESS;
  }

  const result = invokeRuntime({
    projectRoot,
    launcherVersion,
    runtime: state.installed,
    argv: doctorDiagnoseArgv(argv),
    stdio: "pipe",
  });
  if (result.stdout) {
    io.writeOut(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr) {
    io.writeErr(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
  if (result.message) io.writeErr(`${result.message}\n`);
  return result.exitCode;
}

/** @deprecated Use {@link runDoctor}. Kept as alias for earlier wave call sites. */
export const runDoctorStub = runDoctor;
