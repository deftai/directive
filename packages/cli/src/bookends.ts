/**
 * Install / upgrade / uninstall / doctor bookends (Wave 2a–2g).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_NUMBER,
  EXIT_CODES,
  LAUNCHER_MAX_SUPPORTED_CONTRACT,
  LAUNCHER_PACKAGE_NAME,
  RECOVERY_GUIDANCE,
  RUNTIME_PACKAGE_NAME,
} from "./constants.js";
import {
  doctorArgv,
  doctorDiagnoseArgv,
  invokeRuntime,
  migrateArgv,
  setupArgv,
  uninstallArgv,
  type InvokeResult,
} from "./contract-invoke.js";
import { checkNodeVersion } from "./node-check.js";
import {
  detectPackageManager,
  ensurePackageJson,
  formatPmExactAddCommand,
  formatPmRemoveCommand,
  lockfileRecordsExactPin,
  removeLegacyDirectivePin,
  runPmExactAdd,
  runPmRemove,
  type PackageManager,
  type PmAddResult,
} from "./pm.js";
import type { ProjectInstallState } from "./pin.js";
import { isContractSupported, readInstalledRuntime, readProjectInstallState } from "./pin.js";
import {
  compareExactVersions,
  resolveLatestStableVersion,
  resolvePublishedContract,
  validateTargetVersionSpec,
} from "./registry.js";
import {
  applyLauncherCleanup,
  cleanupHooksPath,
  discoverUninstallFootprint,
  verifyUninstallComplete,
  type UninstallDiscovery,
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
}

export type DataStatusValue = "current" | "migration_needed" | "diagnosis_failed";

/** Testable seams for install (unit tests inject; production uses defaults). */
export interface InstallDeps {
  readonly stdinIsTTY?: boolean;
  readonly env?: NodeJS.ProcessEnv;
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
}

/** Testable seams for upgrade (extends install seams). */
export interface UpgradeDeps extends InstallDeps {
  readonly resolvePublishedContract?: (
    version: string,
  ) =>
    | { ok: true; contract: number }
    | { ok: false; message: string };
  readonly invokeMigrate?: (argv: readonly string[]) => InvokeResult;
  readonly invokeDoctorDataStatus?: () =>
    | { ok: true; dataStatus: DataStatusValue }
    | { ok: false; message: string };
}

/** Testable seams for uninstall (R11). */
export interface UninstallDeps {
  readonly stdinIsTTY?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly invokeUninstall?: (argv: readonly string[]) => InvokeResult;
  readonly runPmRemove?: (opts: {
    projectRoot: string;
    pm: PackageManager;
    packageName: string;
  }) => PmAddResult;
  readonly applyCleanup?: (projectRoot: string, discovery: UninstallDiscovery) => ReturnType<
    typeof applyLauncherCleanup
  >;
  readonly cleanupHooksPath?: (projectRoot: string) => ReturnType<typeof cleanupHooksPath>;
}

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
  const rest: string[] = [];
  let dryRun = false;
  let yes = false;
  let repair = false;
  let targetVersion: string | null = null;
  let packageManager: string | null = null;
  let usageError: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
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
      const next = argv[i + 1];
      if (flagValueMissing(next)) {
        usageError = "--target-version requires a value.";
        continue;
      }
      targetVersion = argv[++i]!;
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
      const next = argv[i + 1];
      if (flagValueMissing(next)) {
        usageError = "--package-manager requires a value.";
        continue;
      }
      packageManager = argv[++i]!;
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
  return { flags: { dryRun, yes, repair, targetVersion, packageManager }, rest, usageError };
}

function printPlan(
  io: BookendIo,
  lines: readonly string[],
): void {
  io.writeOut("Plan:\n");
  for (const line of lines) {
    io.writeOut(`  ${line}\n`);
  }
}

function requireApproval(
  flags: BookendFlags,
  deps: InstallDeps,
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
  // Interactive prompt is optional for YOLO; without readline approval, require --yes.
  io.writeErr(`Interactive approval not wired in this build; pass --yes to approve: ${prompt}\n`);
  return EXIT_CODES.USAGE;
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

  // Old-style: install changes nothing and names upgrade (AC6.13).
  // Launcher usually gates this earlier; keep a belt-and-braces check.
  if (state.oldStyle) {
    io.writeErr("This project uses an older Directive layout. Run `directive upgrade`.\n");
    return EXIT_CODES.FAILURE;
  }

  const configuredExact = state.pin.kind === "exact" && state.pin.version !== null;

  // AC6.6 / INIT-20: configured + --yes without --repair → exit 2 with choices
  if (configuredExact && !flags.repair) {
    if (flags.dryRun) {
      // Dry-run on configured project without --repair: show that repair would be selected interactively.
      io.writeOut(
        `Directive is already configured. Pinned version: ${state.pin.version}.\n` +
          `[dry-run] would present Repair ${state.pin.version} / Cancel (use --repair to select repair).\n`,
      );
      return EXIT_CODES.SUCCESS;
    }
    if (flags.yes) {
      io.writeErr(
        `Directive is already configured (pin ${state.pin.version}). --yes does not choose the operation.\n` +
          `  Repair this pin:  directive install --repair --yes\n` +
          `  Change version:   directive upgrade --yes\n`,
      );
      return EXIT_CODES.USAGE;
    }
    // Non-interactive without --yes/--repair
    const tty = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
    if (!tty) {
      io.writeErr(
        `Directive is already configured (pin ${state.pin.version}). Pass --repair --yes to repair, or run interactively.\n` +
          `  directive install --repair --yes\n` +
          `  directive upgrade --yes\n`,
      );
      return EXIT_CODES.USAGE;
    }
    io.writeErr(
      `Directive is already configured (pin ${state.pin.version}). Pass --repair to repair, or directive upgrade to change versions.\n`,
    );
    return EXIT_CODES.USAGE;
  }

  if (flags.repair) {
    return runRepair(projectRoot, state, flags, launcherVersion, io, deps, env);
  }

  return runFirstInstall(projectRoot, state, flags, launcherVersion, io, deps, env);
}

function runFirstInstall(
  projectRoot: string,
  state: ProjectInstallState,
  flags: BookendFlags,
  launcherVersion: string,
  io: BookendIo,
  deps: InstallDeps,
  env: NodeJS.ProcessEnv,
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

  let targetVersion: string;
  if (flags.targetVersion !== null) {
    const validated = validateTargetVersionSpec(flags.targetVersion);
    if (!validated.ok) {
      io.writeErr(`${validated.message}\n`);
      return EXIT_CODES.USAGE;
    }
    targetVersion = validated.version;
  } else {
    const resolver =
      deps.resolveLatest ??
      (() => resolveLatestStableVersion(env, projectRoot));
    const resolved = resolver();
    // Support sync or async seam; install path is sync so only sync results are used.
    if (resolved instanceof Promise) {
      io.writeErr("Internal error: async resolveLatest is not supported in sync install path.\n");
      return EXIT_CODES.FAILURE;
    }
    if (!resolved.ok) {
      io.writeErr(`${resolved.message}\n`);
      return EXIT_CODES.FAILURE;
    }
    targetVersion = resolved.version;
  }

  const willCreatePkg = !existsSync(join(projectRoot, "package.json"));
  const pmCmd = formatPmExactAddCommand(pmDetect.pm, targetVersion, projectRoot);

  printPlan(io, [
    `operation: install (first-time)`,
    `root: ${projectRoot}`,
    `package manager: ${pmDetect.pm} (${pmDetect.evidence})`,
    `target: ${RUNTIME_PACKAGE_NAME}@${targetVersion}`,
    willCreatePkg
      ? `manifest: create package.json { "private": true }`
      : `manifest: add exact pin to existing package.json`,
    `PM command: ${pmCmd}`,
    `expected: package.json pin + lockfile update via PM`,
    `setup: runtime setup --operation install --from none (wiring, GENERATION.json, readiness; may create missing seed placeholders)`,
  ]);

  if (flags.dryRun) {
    io.writeOut("[dry-run] no changes made.\n");
    return EXIT_CODES.SUCCESS;
  }

  const approval = requireApproval(
    flags,
    deps,
    io,
    "Set up Directive in this project?",
  );
  if (approval !== null) return approval;

  if (willCreatePkg) {
    ensurePackageJson(projectRoot);
    io.writeOut("Created package.json { \"private\": true }\n");
  }

  const add =
    deps.runPmAdd?.({ projectRoot, pm: pmDetect.pm, version: targetVersion }) ??
    runPmExactAdd({ projectRoot, pm: pmDetect.pm, version: targetVersion, env });
  if (!add.ok) {
    io.writeErr(`${add.message}\n`);
    if ("stderr" in add && add.stderr) io.writeErr(`${add.stderr}\n`);
    return EXIT_CODES.FAILURE;
  }

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
    from: "none",
    io,
    deps,
  });
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
    state.installed !== null &&
    state.installed.version === pinVersion &&
    state.contractSupported;
  const needsPmRestore = !lockOk || !installedOk;

  const pmCmd = formatPmExactAddCommand(pmDetect.pm, pinVersion, projectRoot);

  printPlan(io, [
    `operation: repair`,
    `root: ${projectRoot}`,
    `package manager: ${pmDetect.pm} (${pmDetect.evidence})`,
    `pin (unchanged): ${RUNTIME_PACKAGE_NAME}@${pinVersion}`,
    needsPmRestore
      ? `PM: restore pin via exact add (${lockOk ? "installed package mismatch/missing" : "lockfile missing/unusable/disagree"})`
      : `PM: none (lockfile records pin; installed package matches)`,
    needsPmRestore ? `PM command: ${pmCmd}` : `PM command: (none)`,
    `setup: runtime setup --operation repair --from ${pinVersion} (wiring/GENERATION/readiness; does not create seed files; never migrates xbrief)`,
  ]);

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

  if (needsPmRestore) {
    const add =
      deps.runPmAdd?.({ projectRoot, pm: pmDetect.pm, version: pinVersion }) ??
      runPmExactAdd({ projectRoot, pm: pmDetect.pm, version: pinVersion, env });
    if (!add.ok) {
      io.writeErr(`${add.message}\n`);
      if ("stderr" in add && add.stderr) io.writeErr(`${add.stderr}\n`);
      return EXIT_CODES.FAILURE;
    }
  }

  const after = readProjectInstallState(projectRoot);
  if (after.pin.version !== pinVersion) {
    io.writeErr(`Repair changed the pin unexpectedly (${after.pin.raw}). Aborting.\n`);
    return EXIT_CODES.FAILURE;
  }
  const installed = readInstalledRuntime(projectRoot);
  if (installed === null || installed.version !== pinVersion) {
    io.writeErr(
      `Repair verification failed: expected installed ${pinVersion}, found ${installed?.version ?? "nothing"}. ${RECOVERY_GUIDANCE}\n`,
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
  });
}

function reportJsonSummary(
  io: BookendIo,
  label: string,
  result: InvokeResult,
): void {
  if (result.message) io.writeErr(`${result.message}\n`);
  if (result.stderr) {
    io.writeErr(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
  if (!result.stdout) return;
  const trimmed = result.stdout.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed.split("\n").filter(Boolean).pop() ?? "");
    if (parsed && typeof parsed === "object") {
      const rec = parsed as {
        created?: unknown;
        modified?: unknown;
        removed?: unknown;
        migrated?: unknown;
        conflicts?: unknown;
        message?: unknown;
      };
      io.writeOut(
        `${label}: ` +
          `created=${JSON.stringify(rec.created ?? [])} ` +
          `modified=${JSON.stringify(rec.modified ?? [])} ` +
          `removed=${JSON.stringify(rec.removed ?? [])}` +
          (Array.isArray(rec.migrated) ? ` migrated=${JSON.stringify(rec.migrated)}` : "") +
          (Array.isArray(rec.conflicts) && rec.conflicts.length > 0
            ? ` conflicts=${JSON.stringify(rec.conflicts)}`
            : "") +
          "\n",
      );
      if (typeof rec.message === "string" && rec.message.length > 0) {
        io.writeOut(`${rec.message}\n`);
      }
      return;
    }
  } catch {
    /* fall through */
  }
  io.writeOut(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
}

function handOffSetup(opts: {
  projectRoot: string;
  launcherVersion: string;
  runtime: NonNullable<ProjectInstallState["installed"]>;
  operation: "install" | "repair" | "upgrade";
  from: string;
  io: BookendIo;
  deps: InstallDeps;
}): number {
  const argv = setupArgv(opts.operation, opts.from, opts.projectRoot);
  const result =
    opts.deps.invokeSetup?.(argv) ??
    invokeRuntime({
      projectRoot: opts.projectRoot,
      launcherVersion: opts.launcherVersion,
      runtime: opts.runtime,
      argv,
      stdio: "pipe",
    });
  reportJsonSummary(opts.io, `setup ${opts.operation}`, result);
  if (result.exitCode === 0) {
    opts.io.writeOut(
      `directive ${opts.operation}: ${RUNTIME_PACKAGE_NAME}@${opts.runtime.version} ready in ${opts.projectRoot}\n`,
    );
  } else if (opts.operation === "install") {
    opts.io.writeErr(
      `Package pin is in place but setup failed. Fix the cause, then run: directive install --repair --yes\n`,
    );
  }
  return result.exitCode;
}

function handOffMigrate(opts: {
  projectRoot: string;
  launcherVersion: string;
  runtime: NonNullable<ProjectInstallState["installed"]>;
  from: string;
  io: BookendIo;
  deps: UpgradeDeps;
}): number {
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
  reportJsonSummary(opts.io, "migrate", result);
  return result.exitCode;
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
    if (
      status !== "current" &&
      status !== "migration_needed" &&
      status !== "diagnosis_failed"
    ) {
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
  const { flags, rest, usageError } = parseFlags(argv);
  const env = deps.env ?? process.env;

  if (usageError !== null) {
    io.writeErr(`${usageError}\n`);
    return EXIT_CODES.USAGE;
  }
  if (rest.length > 0) {
    io.writeErr(`Unknown argument(s): ${rest.join(" ")}\n`);
    return EXIT_CODES.USAGE;
  }

  // AC7.1: exact pin or old-style; else exit 2 naming install
  const exactPin = state.pin.kind === "exact" && state.pin.version !== null;
  if (!exactPin && !state.oldStyle) {
    io.writeErr(
      `Upgrade requires an exact ${RUNTIME_PACKAGE_NAME} pin or a supported old-style layout. Run \`directive install\`.\n`,
    );
    return EXIT_CODES.USAGE;
  }

  const currentPin = state.pin.version!;
  const fromLabel = state.oldStyle ? "old-style" : currentPin;

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
    const resolver =
      deps.resolveLatest ?? (() => resolveLatestStableVersion(env, projectRoot));
    const resolved = resolver();
    if (resolved instanceof Promise) {
      io.writeErr("Internal error: async resolveLatest is not supported in sync upgrade path.\n");
      return EXIT_CODES.FAILURE;
    }
    if (!resolved.ok) {
      io.writeErr(`${resolved.message}\n`);
      return EXIT_CODES.FAILURE;
    }
    targetVersion = resolved.version;
  }

  // Target older than pin → reject (AC7.3). Parse failure is never treated as equal.
  let versionOrd: number;
  try {
    versionOrd = state.oldStyle ? 1 : compareExactVersions(targetVersion, currentPin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.writeErr(`${msg}\n`);
    return EXIT_CODES.FAILURE;
  }
  if (!state.oldStyle && versionOrd < 0) {
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
    io.writeErr(`${published.message}\n`);
    return EXIT_CODES.FAILURE;
  }
  if (!isContractSupported(published.contract)) {
    io.writeErr(
      `This launcher is too old for target ${RUNTIME_PACKAGE_NAME}@${targetVersion} ` +
        `(contract ${published.contract} > ${LAUNCHER_MAX_SUPPORTED_CONTRACT}). ` +
        "`npm i -g @deftai/directive@latest`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  const versionChange = state.oldStyle || versionOrd !== 0;
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
      io.writeErr(
        `Equal-version upgrade requires the pinned runtime installed and contract-supported. ${RECOVERY_GUIDANCE}\n`,
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

  const pmCmd = versionChange
    ? formatPmExactAddCommand(pmDetect.pm, targetVersion, projectRoot)
    : "(none)";

  const planLines = [
    `operation: upgrade`,
    `root: ${projectRoot}`,
    `package manager: ${pmDetect.pm} (${pmDetect.evidence})`,
    `current: ${RUNTIME_PACKAGE_NAME}@${currentPin}${state.oldStyle ? " (old-style)" : ""}`,
    `target: ${RUNTIME_PACKAGE_NAME}@${targetVersion}`,
    versionChange
      ? `PM: exact add target (pin + lockfile change)`
      : `PM: none (equal version; package already matches pin)`,
    versionChange ? `PM command: ${pmCmd}` : `PM command: (none)`,
    needSetup
      ? `setup: runtime setup --operation upgrade --from ${fromLabel}`
      : `setup: none (wiring current for pin)`,
    needMigrate
      ? `migrate: runtime migrate --from ${fromLabel}` +
        (dataStatus !== null ? ` (dataStatus=${dataStatus})` : "")
      : `migrate: none`,
    `disclosure: target runtime performs required setup/migrations; project settings/data preserved`,
    `global launcher: unchanged`,
  ];
  if (state.oldStyle) {
    planLines.splice(
      7,
      0,
      `remove: .deft/core (legacy content copy, even if edited)`,
      `replace: ${LAUNCHER_PACKAGE_NAME} pin → ${RUNTIME_PACKAGE_NAME}@${targetVersion}`,
    );
  }
  printPlan(io, planLines);

  if (flags.dryRun) {
    io.writeOut("[dry-run] no changes made.\n");
    return EXIT_CODES.SUCCESS;
  }

  const approval = requireApproval(
    flags,
    deps,
    io,
    versionChange
      ? `Upgrade Directive from ${currentPin} to ${targetVersion}?`
      : `Finish equal-version upgrade work for ${currentPin}?`,
  );
  if (approval !== null) return approval;

  if (versionChange) {
    // AC10.3: replace pre-split @deftai/directive pin before PM adds the runtime.
    if (state.oldStyle) {
      removeLegacyDirectivePin(projectRoot);
    }
    const add =
      deps.runPmAdd?.({ projectRoot, pm: pmDetect.pm, version: targetVersion }) ??
      runPmExactAdd({ projectRoot, pm: pmDetect.pm, version: targetVersion, env });
    if (!add.ok) {
      io.writeErr(`${add.message}\n`);
      if ("stderr" in add && add.stderr) io.writeErr(`${add.stderr}\n`);
      return EXIT_CODES.FAILURE;
    }

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

    const setupCode = handOffSetup({
      projectRoot,
      launcherVersion,
      runtime: installed,
      operation: "upgrade",
      from: fromLabel,
      io,
      deps,
    });
    if (setupCode !== 0) {
      io.writeErr(
        `Pin and lockfile now reference ${RUNTIME_PACKAGE_NAME}@${targetVersion}, but setup failed. ` +
          `Fix the cause, then run: directive install --repair --yes (wiring) or directive upgrade --yes (data).\n`,
      );
      return setupCode;
    }

    const migrateCode = handOffMigrate({
      projectRoot,
      launcherVersion,
      runtime: installed,
      from: fromLabel,
      io,
      deps,
    });
    if (migrateCode !== 0) {
      io.writeErr(
        `Pin and lockfile now reference ${RUNTIME_PACKAGE_NAME}@${targetVersion}, but migrate failed. ` +
          `Fix the cause, then run: directive upgrade --yes.\n`,
      );
      return migrateCode;
    }

    io.writeOut(
      `directive upgrade: ${RUNTIME_PACKAGE_NAME}@${currentPin} → ${targetVersion} complete in ${projectRoot}\n`,
    );
    return EXIT_CODES.SUCCESS;
  }

  // Equal-version path: setup-when-stale then migrate (no PM)
  const runtime = state.installed!;
  if (needSetup) {
    const setupCode = handOffSetup({
      projectRoot,
      launcherVersion,
      runtime,
      operation: "upgrade",
      from: fromLabel,
      io,
      deps,
    });
    if (setupCode !== 0) {
      io.writeErr(
        `Equal-version setup failed. Fix the cause, then run: directive install --repair --yes or directive upgrade --yes.\n`,
      );
      return setupCode;
    }
  }
  if (needMigrate) {
    const migrateCode = handOffMigrate({
      projectRoot,
      launcherVersion,
      runtime,
      from: fromLabel,
      io,
      deps,
    });
    if (migrateCode !== 0) {
      io.writeErr(
        `Equal-version migrate failed. Fix the cause, then run: directive upgrade --yes.\n`,
      );
      return migrateCode;
    }
  }
  io.writeOut(
    `directive upgrade: equal-version work complete for ${RUNTIME_PACKAGE_NAME}@${currentPin}\n`,
  );
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
  const { flags, usageError } = parseFlags(argv);
  const env = deps.env ?? process.env;
  if (usageError !== null) {
    io.writeErr(`${usageError}\n`);
    return EXIT_CODES.USAGE;
  }

  // Retain discovery before any repository uninstaller mutates GENERATION (AC11.2).
  const discovery = discoverUninstallFootprint(projectRoot);

  if (!discovery.hasFootprint) {
    io.writeOut("No Directive installation footprint found in this project. Nothing to uninstall.\n");
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
  const keepPaths = discovery.artifacts
    .filter((a) => a.kind === "retained")
    .map((a) => a.path);
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
  const pmLabel = pmDetect.ok ? pmDetect.pm : "npm";
  const pmEvidence = pmDetect.ok ? pmDetect.evidence : "default (detection failed; will skip PM remove)";
  const packagesToRemove: string[] = [];
  if (discovery.hasRuntimePin) packagesToRemove.push(RUNTIME_PACKAGE_NAME);
  if (discovery.hasLegacyLauncherPin || state.oldStyle) {
    packagesToRemove.push(LAUNCHER_PACKAGE_NAME);
  }

  const planLines = [
    `operation: uninstall`,
    `root: ${projectRoot}`,
    `ownership record: ${discovery.ownershipInspection}`,
    `pin: ${state.pin.version ?? state.pin.raw ?? "(none)"}${state.oldStyle ? " (old-style)" : ""}`,
    `installed runtime: ${state.installed?.version ?? "(missing/unavailable)"}`,
    `remove: ${removePaths.length > 0 ? removePaths.join(", ") : "(none listed)"}`,
    discovery.hasLegacyCore ? `remove: .deft/core (legacy)` : null,
    `keep: ${keepPaths.join(", ")}`,
    packagesToRemove.length > 0
      ? `PM remove (${pmLabel}, ${pmEvidence}): ${packagesToRemove.map((p) => formatPmRemoveCommand(pmLabel as PackageManager, p, projectRoot)).join("; ")}`
      : `PM remove: (none)`,
    state.installed && state.contractSupported
      ? `repository uninstaller: invoke when available, then launcher fallback`
      : `repository uninstaller: unavailable — launcher fallback only (no repair/upgrade required)`,
    `hooksPath: unset .githooks only when safe for sibling worktrees`,
  ].filter((l): l is string => l !== null);

  printPlan(io, planLines);

  if (flags.dryRun) {
    io.writeOut("[dry-run] no changes made.\n");
    return EXIT_CODES.SUCCESS;
  }

  const approval = requireApproval(
    flags,
    { stdinIsTTY: deps.stdinIsTTY },
    io,
    "Uninstall Directive from this project?",
  );
  if (approval !== null) return approval;

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
    reportJsonSummary(io, "repository uninstall", result);
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
    deps.applyCleanup?.(projectRoot, discovery) ??
    applyLauncherCleanup(projectRoot, discovery);
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

  // PM remove after wiring cleanup (AC11.6).
  if (packagesToRemove.length > 0) {
    if (!pmDetect.ok) {
      io.writeErr(`${pmDetect.message}\n`);
      io.writeErr("Could not remove package dependency via PM; pin may remain.\n");
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
          io.writeErr(`${rm.message}\n`);
          if ("stderr" in rm && rm.stderr) io.writeErr(`${rm.stderr}\n`);
          io.writeErr(
            `PM remove of ${packageName} failed; continuing remaining uninstall steps.\n`,
          );
        } else {
          io.writeOut(`Removed ${packageName} via ${pmDetect.pm}.\n`);
        }
      }
    }
  }

  const hooksPathResult =
    deps.cleanupHooksPath?.(projectRoot) ?? cleanupHooksPath(projectRoot);
  io.writeOut(`core.hooksPath: ${hooksPathResult}\n`);

  const verification = verifyUninstallComplete(projectRoot);
  // Legacy launcher pin leftover only matters for old-style; modern projects should not have it.
  const filteredLeftovers = verification.leftovers.filter((l) => {
    if (l === `package.json#${LAUNCHER_PACKAGE_NAME}` && !state.oldStyle && !discovery.hasLegacyLauncherPin) {
      return false;
    }
    return true;
  });
  const complete = filteredLeftovers.length === 0;

  io.writeOut(
    `directive uninstall: ${complete ? "complete" : "partial"} in ${projectRoot}\n`,
  );
  if (cleanup.preserved.length > 0) {
    io.writeOut(`preserved: ${cleanup.preserved.join(", ")}\n`);
  }
  if (!complete) {
    io.writeOut(`known leftovers: ${filteredLeftovers.join(", ")}\n`);
  }
  if (runtimeUninstallAttempted && runtimeUninstallFailed && complete) {
    io.writeOut(
      "Repository uninstaller failed earlier, but launcher fallback verified complete removal.\n",
    );
  }
  io.writeOut(
    "To uninstall the global launcher (other repos may still need it): npm uninstall -g @deftai/directive\n",
  );

  if (!complete) {
    return EXIT_CODES.FAILURE;
  }
  return EXIT_CODES.SUCCESS;
}

/** @deprecated Use {@link runUninstall}. */
export const runUninstallStub = runUninstall;

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
  const node = checkNodeVersion();
  if (node.warning) io.writeOut(`${node.warning}\n`);

  // AC14.27 / A5.6: no project → non-zero + directive install.
  if (projectRoot === null || state === null) {
    io.writeErr("No Directive project here. Run `directive install`.\n");
    return EXIT_CODES.FAILURE;
  }

  if (state.oldStyle) {
    io.writeOut(
      "This project uses an older Directive layout. Run `directive upgrade`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  // Bare --root / cwd with no Directive pin is still "not a project" (AC14.27).
  if (state.pin.kind === "none") {
    io.writeErr("No Directive project here. Run `directive install`.\n");
    return EXIT_CODES.FAILURE;
  }

  const pinLabel = state.pin.version ?? state.pin.raw ?? "(none)";
  const installedLabel = state.installed?.version ?? "(missing)";

  // Runtime missing or pin≠installed → launcher basic diagnosis (AC12.4 / A5.6).
  if (state.installed === null || !state.pinMatchesInstalled) {
    if (state.installed === null) {
      io.writeOut(
        `directive doctor: project ${projectRoot}\n` +
          `  launcher: ${launcherVersion}\n` +
          `  pin: ${pinLabel} (${state.pin.kind})\n` +
          `  installed: missing\n` +
          `Recovery: ${RECOVERY_GUIDANCE}\n`,
      );
    } else {
      io.writeOut(
        `directive doctor: project ${projectRoot}\n` +
          `  launcher: ${launcherVersion}\n` +
          `  pin: ${pinLabel} (${state.pin.kind})\n` +
          `  installed: ${installedLabel} (≠ pin)\n` +
          `Recovery: ${RECOVERY_GUIDANCE}\n`,
      );
    }
    return EXIT_CODES.FAILURE;
  }

  if (!state.contractSupported) {
    io.writeErr(
      "This launcher is too old for this project. `npm i -g @deftai/directive@latest`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  if (flags.dryRun) {
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
    argv: doctorDiagnoseArgv(),
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
