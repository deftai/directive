/**
 * Install / upgrade / uninstall / doctor bookends (Wave 2a: real install/repair).
 * Upgrade/uninstall remain stubs for later waves.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, RECOVERY_GUIDANCE, RUNTIME_PACKAGE_NAME } from "./constants.js";
import {
  doctorArgv,
  invokeRuntime,
  setupArgv,
  uninstallArgv,
  type InvokeResult,
} from "./contract-invoke.js";
import {
  detectPackageManager,
  ensurePackageJson,
  lockfileRecordsExactPin,
  runPmExactAdd,
  type PackageManager,
  type PmAddResult,
} from "./pm.js";
import type { ProjectInstallState } from "./pin.js";
import { readInstalledRuntime, readProjectInstallState } from "./pin.js";
import { resolveLatestStableVersion, validateTargetVersionSpec } from "./registry.js";

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
  const { flags, usageError } = parseFlags(argv);
  const env = deps.env ?? process.env;

  // Missing --target-version / --package-manager values → usage before registry/PM.
  if (usageError !== null) {
    io.writeErr(`${usageError}\n`);
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
  const pmCmd =
    pmDetect.pm === "npm"
      ? `npm install --save-dev --save-exact --ignore-scripts ${RUNTIME_PACKAGE_NAME}@${targetVersion}`
      : `pnpm add -D --save-exact --ignore-scripts ${RUNTIME_PACKAGE_NAME}@${targetVersion}`;

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

  const pmCmd =
    pmDetect.pm === "npm"
      ? `npm install --save-dev --save-exact --ignore-scripts ${RUNTIME_PACKAGE_NAME}@${pinVersion}`
      : `pnpm add -D --save-exact --ignore-scripts ${RUNTIME_PACKAGE_NAME}@${pinVersion}`;

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

function handOffSetup(opts: {
  projectRoot: string;
  launcherVersion: string;
  runtime: NonNullable<ProjectInstallState["installed"]>;
  operation: "install" | "repair";
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
  if (result.message) opts.io.writeErr(`${result.message}\n`);
  if (result.stderr) {
    opts.io.writeErr(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
  if (result.stdout) {
    // Prefer structured JSON summary when present (AC4.9).
    const trimmed = result.stdout.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed.split("\n").filter(Boolean).pop() ?? "");
      if (parsed && typeof parsed === "object") {
        const rec = parsed as {
          created?: unknown;
          modified?: unknown;
          removed?: unknown;
          conflicts?: unknown;
          message?: unknown;
        };
        opts.io.writeOut(
          `setup ${opts.operation}: ` +
            `created=${JSON.stringify(rec.created ?? [])} ` +
            `modified=${JSON.stringify(rec.modified ?? [])} ` +
            `removed=${JSON.stringify(rec.removed ?? [])}` +
            (Array.isArray(rec.conflicts) && rec.conflicts.length > 0
              ? ` conflicts=${JSON.stringify(rec.conflicts)}`
              : "") +
            "\n",
        );
        if (typeof rec.message === "string" && rec.message.length > 0) {
          opts.io.writeOut(`${rec.message}\n`);
        }
      } else {
        opts.io.writeOut(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
      }
    } catch {
      opts.io.writeOut(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    }
  }
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

/** @deprecated Use {@link runInstall}. Kept as alias for any residual stub callers. */
export const runInstallStub = runInstall;

export function runUpgradeStub(
  projectRoot: string,
  state: ProjectInstallState,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
): number {
  const { flags } = parseFlags(argv);
  const target = flags.targetVersion ?? state.pin.version ?? "(unresolved)";
  io.writeOut(
    `directive upgrade: project ${projectRoot}\n` +
      `  current pin: ${state.pin.version ?? state.pin.raw ?? "(none)"}\n` +
      `  target: ${target}\n` +
      `  installed: ${state.installed?.version ?? "(missing)"}\n`,
  );
  if (flags.dryRun) {
    io.writeOut("[dry-run] would upgrade (launcher skeleton; target resolve + PM add in wave 2b)\n");
    return EXIT_CODES.SUCCESS;
  }
  if (state.installed && state.contractSupported && state.pinMatchesInstalled) {
    const from = state.pin.version ?? "none";
    const result = invokeRuntime({
      projectRoot,
      launcherVersion,
      runtime: state.installed,
      argv: setupArgv("upgrade", from, projectRoot),
    });
    if (result.message) io.writeErr(`${result.message}\n`);
    return result.exitCode;
  }
  io.writeOut(
    `Launcher skeleton: upgrade PM mutation not implemented yet (wave 2b).\n` +
      `Recovery: ${RECOVERY_GUIDANCE}\n`,
  );
  return EXIT_CODES.SUCCESS;
}

export function runUninstallStub(
  projectRoot: string,
  state: ProjectInstallState,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
): number {
  const { flags } = parseFlags(argv);
  io.writeOut(
    `directive uninstall: project ${projectRoot}\n` +
      `  pin: ${state.pin.version ?? state.pin.raw ?? "(none)"}\n` +
      `  installed: ${state.installed?.version ?? "(missing)"}\n`,
  );
  if (flags.dryRun) {
    io.writeOut("[dry-run] would uninstall (launcher skeleton; ownership cleanup in wave 2)\n");
    return EXIT_CODES.SUCCESS;
  }
  if (state.installed && state.contractSupported) {
    const result = invokeRuntime({
      projectRoot,
      launcherVersion,
      runtime: state.installed,
      argv: uninstallArgv(projectRoot),
    });
    if (result.message) io.writeErr(`${result.message}\n`);
    io.writeOut("Launcher fallback cleanup not fully implemented yet (wave 2 / R11).\n");
    return result.exitCode;
  }
  io.writeOut(
    "Runtime unavailable; launcher fallback cleanup stub (wave 2 / R11).\n" +
      "No files changed.\n",
  );
  return EXIT_CODES.SUCCESS;
}

export function runDoctorStub(
  projectRoot: string | null,
  state: ProjectInstallState | null,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
): number {
  const { flags } = parseFlags(argv);
  if (projectRoot === null || state === null) {
    io.writeOut(
      "directive doctor: no project context.\n" +
        `Install the launcher globally, then run \`${RECOVERY_GUIDANCE}\` inside a repo.\n`,
    );
    return EXIT_CODES.SUCCESS;
  }
  io.writeOut(
    `directive doctor: project ${projectRoot}\n` +
      `  launcher: ${launcherVersion}\n` +
      `  pin: ${state.pin.version ?? state.pin.raw ?? "(none)"} (${state.pin.kind})\n` +
      `  installed: ${state.installed?.version ?? "(missing)"}\n` +
      `  contract: ${state.installed?.contract ?? "(n/a)"}\n` +
      `  pinMatchesInstalled: ${state.pinMatchesInstalled}\n` +
      `  oldStyle: ${state.oldStyle}\n`,
  );
  if (!state.pinMatchesInstalled || state.installed === null) {
    io.writeOut(`Recovery: ${RECOVERY_GUIDANCE}\n`);
  }
  if (flags.dryRun) {
    return EXIT_CODES.SUCCESS;
  }
  if (state.installed && state.contractSupported) {
    const result = invokeRuntime({
      projectRoot,
      launcherVersion,
      runtime: state.installed,
      argv: doctorArgv(),
      stdio: "pipe",
    });
    if (result.stdout) io.writeOut(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) io.writeErr(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    if (result.message) io.writeErr(`${result.message}\n`);
    return result.exitCode;
  }
  return EXIT_CODES.SUCCESS;
}
