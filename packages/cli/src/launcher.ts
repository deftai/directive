/**
 * Thin launcher router (UNIFIED §A5 / R3).
 * Zero dependency on runtime/core/content (AC3.1).
 */

import { mkdirSync } from "node:fs";
import { runDoctorStub, runInstall, runUninstall, runUpgrade } from "./bookends.js";
import {
  EXIT_CODES,
  INSTALL_ALIASES,
  INSTALL_MANAGEMENT_COMMANDS,
  RECOVERY_GUIDANCE,
  RETIRED_INSTALL_VERBS,
  RUNTIME_PACKAGE_NAME,
} from "./constants.js";
import { invokeRuntime } from "./contract-invoke.js";
import { discoverProject, takeRootFlag } from "./discover.js";
import { checkNodeVersion } from "./node-check.js";
import { type ProjectInstallState, readProjectInstallState } from "./pin.js";
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
      `  install [--repair] [--target-version <exact>] [--package-manager npm|pnpm]\n` +
      `          [--dry-run] [--yes] [--root <path>]\n` +
      `  upgrade [--target-version <ver>] [--dry-run] [--yes] [--root <path>]\n` +
      `  uninstall [--dry-run] [--yes] [--root <path>]\n` +
      `  doctor [--root <path>] [--full] [--json]\n` +
      `\n` +
      `Aliases: init→install, update→upgrade, remove→uninstall\n` +
      `\n` +
      `Ordinary product commands pass through to the pinned ${RUNTIME_PACKAGE_NAME}.\n` +
      `\n` +
      `First-time: npm i -g @deftai/directive && directive install\n` +
      `Repair:     ${RECOVERY_GUIDANCE}\n` +
      `Upgrade:    directive upgrade\n` +
      `Uninstall:  directive uninstall\n` +
      `\n` +
      `Automation examples:\n` +
      `  directive install --yes\n` +
      `  directive install --repair --yes\n` +
      `  directive upgrade --yes\n` +
      `  directive uninstall --dry-run\n` +
      `\n` +
      `Options:\n` +
      `  --version, -V              Show launcher / pin status\n` +
      `  --help, -h                 Show this help\n` +
      `  --root <path>              Project root (must be Git toplevel when in a repo)\n` +
      `  --repo-root <path>         Alias of --root (historical init/update spelling)\n` +
      `  --target-version <exact>   Exact runtime version (required for prereleases)\n` +
      `  --package-manager npm|pnpm Force PM when lockfile evidence is absent\n` +
      `  --repair                  Restore the existing exact pin + wiring\n` +
      `  --dry-run                  Show plan; change nothing\n` +
      `  --yes, -y                  Approve a fully resolved bookend plan\n`,
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
export function runLauncher(argv: readonly string[], io: LauncherIo = defaultIo()): number {
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
    io.writeErr("directive: --root / --repo-root requires a path\n");
    return EXIT_CODES.USAGE;
  }

  const wantsVersion = rest.includes("--version") || rest.includes("-V");

  // First non-flag token is the command. Keep --help/-h on the argv forwarded
  // to product commands; launcher help only when no command remains.
  const commandIndex = rest.findIndex(
    (a) => a !== "--help" && a !== "-h" && a !== "--version" && a !== "-V" && !a.startsWith("-"),
  );
  const rawCmd = commandIndex >= 0 ? rest[commandIndex] : undefined;
  const forwardArgv =
    commandIndex >= 0
      ? rest.filter((a, i) => i === commandIndex || (a !== "--version" && a !== "-V"))
      : rest.filter((a) => a !== "--version" && a !== "-V");
  const cmdArgv = commandIndex >= 0 ? forwardArgv.slice(1) : [];
  const wantsLauncherHelp =
    rest.length === 0 || (rawCmd === undefined && (rest.includes("--help") || rest.includes("-h")));

  let discovered = discoverProject({
    rootFlag,
    cwd: process.cwd(),
  });

  // Greenfield install/init: create a missing --root / --repo-root directory so
  // `directive init --repo-root ./new-app` matches historical init-cli behavior.
  if (
    !discovered.ok &&
    discovered.kind === "missing_root" &&
    rootFlag !== null &&
    resolveCommand(rawCmd) === "install"
  ) {
    try {
      mkdirSync(rootFlag, { recursive: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      io.writeErr(`Cannot create --root ${rootFlag}: ${detail}\n`);
      return EXIT_CODES.USAGE;
    }
    discovered = discoverProject({
      rootFlag,
      cwd: process.cwd(),
    });
  }

  let projectRoot: string | null = null;
  let state: ProjectInstallState | null = null;

  if (discovered.ok) {
    projectRoot = discovered.root;
    // Disclose upward discovery only when Git/cwd walk moved (not explicit --root).
    if (discovered.movedUp && rootFlag === null && rawCmd !== undefined) {
      io.writeErr(`Using project root ${projectRoot} (moved up from ${process.cwd()})\n`);
    }
    state = readProjectInstallState(projectRoot);
  } else if (rootFlag !== null) {
    io.writeErr(`${discovered.message}\n`);
    return EXIT_CODES.USAGE;
  }

  if (wantsVersion && rawCmd === undefined) {
    printVersion(launcherVersion, projectRoot, state, io);
    return EXIT_CODES.SUCCESS;
  }

  if (wantsLauncherHelp) {
    printHelp(launcherVersion, io);
    return EXIT_CODES.SUCCESS;
  }

  // CLI-PARSE: glued bookend flags (`install--target-version`) are malformed, not
  // product passthrough verbs (AC13.6 / AC3.16).
  if (rawCmd !== undefined && /^(install|upgrade|uninstall|doctor)--/.test(rawCmd)) {
    const verb = rawCmd.slice(0, rawCmd.indexOf("--"));
    const restFlag = rawCmd.slice(rawCmd.indexOf("--"));
    io.writeErr(
      `Unknown command '${rawCmd}'. Did you mean: ${verb} ${restFlag} …?\n` +
        `Known installation commands: install, upgrade, uninstall, doctor.\n`,
    );
    return EXIT_CODES.USAGE;
  }

  const cmd = resolveCommand(rawCmd);

  if (cmd === null) {
    printHelp(launcherVersion, io);
    return EXIT_CODES.SUCCESS;
  }

  if (
    RETIRED_INSTALL_VERBS.has(cmd) ||
    (rawCmd !== undefined && RETIRED_INSTALL_VERBS.has(rawCmd))
  ) {
    const suggestion =
      rawCmd === "migrate" || cmd === "migrate" || rawCmd === "install-upgrade"
        ? "Did you mean: upgrade?\n"
        : rawCmd === "sync" || rawCmd === "bootstrap"
          ? "Did you mean: install?\n"
          : rawCmd === "install-uninstall"
            ? "Did you mean: uninstall?\n"
            : "";
    io.writeErr(
      `Unknown command '${rawCmd}'. Known installation commands: install, upgrade, uninstall, doctor.\n` +
        suggestion,
    );
    return EXIT_CODES.USAGE;
  }

  // AC13.6: "doctor fix" is retired — doctor is read-only.
  if (cmd === "doctor") {
    const positional = cmdArgv.find((a) => !a.startsWith("-"));
    if (positional === "fix") {
      io.writeErr(
        "Unknown command 'doctor fix'. Doctor is read-only. Known installation commands: install, upgrade, uninstall, doctor.\n" +
          "Did you mean: install --repair?\n",
      );
      return EXIT_CODES.USAGE;
    }
  }

  const cmdWantsHelp = cmdArgv.includes("--help") || cmdArgv.includes("-h");

  // --- No project ---
  if (projectRoot === null || state === null) {
    if (cmd === "install") {
      if (cmdWantsHelp) {
        printHelp(launcherVersion, io);
        return EXIT_CODES.SUCCESS;
      }
      io.writeErr(
        `${discovered.ok === false ? discovered.message : "No project root found."}\n` +
          "Run from inside a repository, or pass --root <path>.\n",
      );
      return EXIT_CODES.FAILURE;
    }
    if (cmd === "doctor") {
      if (cmdWantsHelp) {
        printHelp(launcherVersion, io);
        return EXIT_CODES.SUCCESS;
      }
      return runDoctorStub(null, null, cmdArgv, launcherVersion, io);
    }
    io.writeErr(`No Directive project here. Run \`directive install\` inside a repository.\n`);
    return EXIT_CODES.FAILURE;
  }

  // --- Old-style layout (§A6.7 / AC10.2): only upgrade / uninstall ---
  // --version / --help already returned above.
  if (state.oldStyle) {
    const oldStyleAllowed = new Set(["upgrade", "uninstall"]);
    if (!oldStyleAllowed.has(cmd)) {
      io.writeErr("This project uses an older Directive layout. Run `directive upgrade`.\n");
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
    if (cmdWantsHelp) {
      printHelp(launcherVersion, io);
      return EXIT_CODES.SUCCESS;
    }
    switch (cmd) {
      case "install":
        return runInstall(projectRoot, state, cmdArgv, launcherVersion, io);
      case "upgrade":
        return runUpgrade(projectRoot, state, cmdArgv, launcherVersion, io);
      case "uninstall":
        return runUninstall(projectRoot, state, cmdArgv, launcherVersion, io);
      case "doctor":
        return runDoctorStub(projectRoot, state, cmdArgv, launcherVersion, io);
    }
  }

  // --- Ordinary passthrough (preserve --help/-h on product commands) ---
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
    argv: forwardArgv,
  });
  if (result.message) io.writeErr(`${result.message}\n`);
  return result.exitCode;
}
