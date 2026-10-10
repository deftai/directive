/**
 * Thin launcher router (UNIFIED §A5 / R3).
 * Zero dependency on runtime/core/content (AC3.1).
 */
import {
  EXIT_CODES,
  INSTALL_ALIASES,
  INSTALL_MANAGEMENT_COMMANDS,
  RECOVERY_GUIDANCE,
  RETIRED_INSTALL_VERBS,
  RUNTIME_PACKAGE_NAME,
} from "./constants.js";
import { discoverProject, takeRootFlag } from "./discover.js";
import { checkNodeVersion } from "./node-check.js";
import { readProjectInstallState, type ProjectInstallState } from "./pin.js";
import { invokeRuntime } from "./contract-invoke.js";
import {
  runDoctorStub,
  runInstallStub,
  runUninstallStub,
  runUpgradeStub,
} from "./bookends.js";
import { readLauncherVersion } from "./version.js";

export interface LauncherIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

function defaultIo(): LauncherIo {
  return {
    writeOut: (t) => {
      process.stdout.write(t);
    },
    writeErr: (t) => {
      process.stderr.write(t);
    },
  };
}

function printHelp(version: string, io: LauncherIo): void {
  io.writeOut(
    `@deftai/directive ${version} — launcher\n` +
      `\n` +
      `Usage: directive <command> [options]\n` +
      `\n` +
      `Installation management:\n` +
      `  install [--repair] [--dry-run] [--yes] [--root <path>]\n` +
      `  upgrade [--target-version <ver>] [--dry-run] [--yes] [--root <path>]\n` +
      `  uninstall [--dry-run] [--yes] [--root <path>]\n` +
      `  doctor [--root <path>]\n` +
      `\n` +
      `Aliases: init→install, update→upgrade, remove→uninstall\n` +
      `\n` +
      `Ordinary product commands pass through to the pinned ${RUNTIME_PACKAGE_NAME}.\n` +
      `\n` +
      `First-time: npm i -g @deftai/directive && directive install\n` +
      `Repair:     ${RECOVERY_GUIDANCE}\n` +
      `\n` +
      `Options:\n` +
      `  --version, -V    Show launcher / pin status\n` +
      `  --help, -h       Show this help\n` +
      `  --root <path>    Project root (must be Git toplevel when in a repo)\n` +
      `  --dry-run        Show plan; change nothing\n` +
      `  --yes, -y        Approve a fully resolved bookend plan\n`,
  );
}

function printVersion(
  launcherVersion: string,
  projectRoot: string | null,
  state: ProjectInstallState | null,
  io: LauncherIo,
): void {
  if (projectRoot === null || state === null) {
    io.writeOut(`launcher ${launcherVersion} · no project\n`);
    return;
  }
  const pin = state.pin.version ?? state.pin.raw ?? "(none)";
  let status: string;
  if (state.pin.kind === "none") {
    status = "no pin";
  } else if (state.oldStyle) {
    status = "older layout — run directive upgrade";
  } else if (state.installed === null) {
    status = "not installed";
  } else if (!state.pinMatchesInstalled) {
    status = `installed ${state.installed.version} (does not match pin)`;
  } else if (!state.contractSupported) {
    status = `installed ${state.installed.version} (contract too new for this launcher)`;
  } else {
    status = "installed (metadata verified)";
  }
  io.writeOut(`launcher ${launcherVersion} · project pins ${pin} (${status})\n`);
}

function resolveCommand(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (INSTALL_ALIASES[raw]) return INSTALL_ALIASES[raw];
  return raw;
}

function isInstallManagement(cmd: string): cmd is (typeof INSTALL_MANAGEMENT_COMMANDS)[number] {
  return (INSTALL_MANAGEMENT_COMMANDS as readonly string[]).includes(cmd);
}

/**
 * Main launcher entry. Returns process exit code.
 */
export function runLauncher(
  argv: readonly string[],
  io: LauncherIo = defaultIo(),
): number {
  const node = checkNodeVersion();
  if (!node.ok) {
    io.writeErr(`${node.message}\n`);
    return node.exitCode;
  }
  if (node.warning) {
    io.writeErr(`${node.warning}\n`);
  }

  const launcherVersion = readLauncherVersion();
  const { root: rootFlag, rest } = takeRootFlag(argv);

  if (rootFlag === "") {
    io.writeErr("directive: --root requires a path\n");
    return EXIT_CODES.USAGE;
  }

  const wantsVersion = rest.includes("--version") || rest.includes("-V");
  const wantsHelp =
    rest.includes("--help") ||
    rest.includes("-h") ||
    rest.length === 0;

  // Strip global flags from positionals for command detection.
  const positionals = rest.filter(
    (a) => a !== "--version" && a !== "-V" && a !== "--help" && a !== "-h",
  );

  const discovered = discoverProject({
    rootFlag,
    cwd: process.cwd(),
  });

  let projectRoot: string | null = null;
  let state: ProjectInstallState | null = null;

  if (discovered.ok) {
    projectRoot = discovered.root;
    // Disclose upward discovery only when Git/cwd walk moved (not explicit --root).
    if (discovered.movedUp && rootFlag === null && positionals[0] !== undefined) {
      io.writeErr(`Using project root ${projectRoot} (moved up from ${process.cwd()})\n`);
    }
    state = readProjectInstallState(projectRoot);
  } else if (rootFlag !== null) {
    io.writeErr(`${discovered.message}\n`);
    return EXIT_CODES.USAGE;
  }

  if (wantsVersion) {
    printVersion(launcherVersion, projectRoot, state, io);
    return EXIT_CODES.SUCCESS;
  }

  if (wantsHelp && positionals.length === 0) {
    printHelp(launcherVersion, io);
    return EXIT_CODES.SUCCESS;
  }

  const rawCmd = positionals[0];
  const cmd = resolveCommand(rawCmd);
  const cmdArgv = positionals.slice(1);

  if (cmd === null) {
    printHelp(launcherVersion, io);
    return EXIT_CODES.SUCCESS;
  }

  if (RETIRED_INSTALL_VERBS.has(cmd) || (rawCmd !== undefined && RETIRED_INSTALL_VERBS.has(rawCmd))) {
    io.writeErr(
      `Unknown command '${rawCmd}'. Known installation commands: install, upgrade, uninstall, doctor.\n` +
        (rawCmd === "migrate" || cmd === "migrate"
          ? "Did you mean: upgrade?\n"
          : rawCmd === "sync" || rawCmd === "bootstrap"
            ? "Did you mean: install?\n"
            : ""),
    );
    return EXIT_CODES.USAGE;
  }

  // --- No project ---
  if (projectRoot === null || state === null) {
    if (cmd === "install") {
      io.writeErr(
        `${discovered.ok === false ? discovered.message : "No project root found."}\n` +
          "Run from inside a repository, or pass --root <path>.\n",
      );
      return EXIT_CODES.FAILURE;
    }
    if (cmd === "doctor") {
      return runDoctorStub(null, null, cmdArgv, launcherVersion, io);
    }
    io.writeErr(
      `No Directive project here. Run \`directive install\` inside a repository.\n`,
    );
    return EXIT_CODES.FAILURE;
  }

  // --- Old-style layout (§A6.7): only upgrade / uninstall / doctor ---
  if (state.oldStyle) {
    const oldStyleAllowed = new Set(["upgrade", "uninstall", "doctor"]);
    if (!oldStyleAllowed.has(cmd)) {
      io.writeErr(
        "This project uses an older Directive layout. Run `directive upgrade`.\n",
      );
      return EXIT_CODES.FAILURE;
    }
  }

  // --- Contract too new (AC4.7): stop delegation; uninstall keeps launcher fallback ---
  if (state.installed !== null && !state.contractSupported && cmd !== "uninstall") {
    io.writeErr(
      "This launcher is too old for this project. `npm i -g @deftai/directive@latest`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  if (isInstallManagement(cmd)) {
    switch (cmd) {
      case "install":
        return runInstallStub(projectRoot, state, cmdArgv, launcherVersion, io);
      case "upgrade":
        return runUpgradeStub(projectRoot, state, cmdArgv, launcherVersion, io);
      case "uninstall":
        return runUninstallStub(projectRoot, state, cmdArgv, launcherVersion, io);
      case "doctor":
        return runDoctorStub(projectRoot, state, cmdArgv, launcherVersion, io);
    }
  }

  // --- Ordinary passthrough ---
  if (!state.pinMatchesInstalled || state.installed === null) {
    io.writeErr(
      `Pinned ${RUNTIME_PACKAGE_NAME}@${state.pin.version ?? state.pin.raw ?? "?"} ` +
        `is not installed (found ${state.installed?.version ?? "nothing"}).\n` +
        `Recovery: ${RECOVERY_GUIDANCE}\n`,
    );
    return EXIT_CODES.FAILURE;
  }
  if (!state.contractSupported) {
    io.writeErr(
      "This launcher is too old for this project. `npm i -g @deftai/directive@latest`.\n",
    );
    return EXIT_CODES.FAILURE;
  }

  const result = invokeRuntime({
    projectRoot,
    launcherVersion,
    runtime: state.installed,
    argv: positionals,
  });
  if (result.message) io.writeErr(`${result.message}\n`);
  return result.exitCode;
}
