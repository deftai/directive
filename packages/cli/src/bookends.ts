/**
 * Install / upgrade / uninstall / doctor bookend stubs (Wave 1d skeleton).
 * Real PM mutation lands in Wave 2; here we discover, report, and invoke
 * contract entry points when a compatible runtime is present.
 */
import { EXIT_CODES, RECOVERY_GUIDANCE, RUNTIME_PACKAGE_NAME } from "./constants.js";
import {
  doctorArgv,
  invokeRuntime,
  setupArgv,
  uninstallArgv,
} from "./contract-invoke.js";
import type { ProjectInstallState } from "./pin.js";

export interface BookendIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface BookendFlags {
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly repair: boolean;
  readonly targetVersion: string | null;
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

function parseFlags(argv: readonly string[]): { flags: BookendFlags; rest: string[] } {
  const rest: string[] = [];
  let dryRun = false;
  let yes = false;
  let repair = false;
  let targetVersion: string | null = null;
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
      targetVersion = argv[++i] ?? null;
      continue;
    }
    if (a.startsWith("--target-version=")) {
      targetVersion = a.slice("--target-version=".length);
      continue;
    }
    rest.push(a);
  }
  return { flags: { dryRun, yes, repair, targetVersion }, rest };
}

export function runInstallStub(
  projectRoot: string,
  state: ProjectInstallState,
  argv: readonly string[],
  launcherVersion: string,
  io: BookendIo = defaultIo(),
): number {
  const { flags } = parseFlags(argv);
  const operation = flags.repair ? "repair" : "install";
  const pinLabel = state.pin.version ?? state.pin.raw ?? "(none)";
  io.writeOut(
    `directive ${operation}: project ${projectRoot}\n` +
      `  pin: ${RUNTIME_PACKAGE_NAME}@${pinLabel}\n` +
      `  installed: ${state.installed?.version ?? "(missing)"}\n`,
  );
  if (flags.dryRun) {
    io.writeOut(`[dry-run] would ${operation} (launcher skeleton; PM add in wave 2a)\n`);
    if (state.installed && state.contractSupported && state.pinMatchesInstalled) {
      io.writeOut(`[dry-run] would hand off: setup --operation ${operation}\n`);
    }
    return EXIT_CODES.SUCCESS;
  }
  if (state.installed && state.contractSupported) {
    const from = state.pin.version ?? "none";
    const result = invokeRuntime({
      projectRoot,
      launcherVersion,
      runtime: state.installed,
      argv: setupArgv(operation, flags.repair ? from : "none", projectRoot),
    });
    if (result.message) io.writeErr(`${result.message}\n`);
    return result.exitCode;
  }
  io.writeOut(
    `Launcher skeleton: package-manager add not implemented yet (wave 2a).\n` +
      `When a compatible runtime is installed, setup will be invoked.\n` +
      `Recovery: ${RECOVERY_GUIDANCE}\n`,
  );
  return EXIT_CODES.SUCCESS;
}

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
    // Even if runtime uninstall fails, launcher fallback continues (stub report).
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
