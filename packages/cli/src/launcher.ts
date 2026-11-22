/**
 * Thin launcher router (UNIFIED §A5 / R3).
 * Zero dependency on runtime/core/content (AC3.1).
 */

import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { runDoctorStub, runInstall, runUninstall, runUpgrade } from "./bookends.js";
import {
  EXIT_CODES,
  INSTALL_ALIASES,
  INSTALL_MANAGEMENT_COMMANDS,
  OLD_STYLE_LAUNCHER_COMMANDS,
  PRE_OVPR_LAYOUT_MESSAGE,
  RETIRED_INSTALL_VERBS,
  RUNTIME_PACKAGE_NAME,
} from "./constants.js";
import { invokeRuntime } from "./contract-invoke.js";
import { discoverProject, takeRootFlag } from "./discover.js";
import {
  classifyLauncherSituation,
  DISABLE_ONE_LINE,
  isDisableFlagActive,
  KILL_SWITCH_LAUNCHER_COMMANDS,
} from "./entry-guard.js";
import { runHookLauncher, runProjectLocalCopy } from "./hook-launcher.js";
import { type ProjectLocalCopy, recognisePreOvprLayout } from "./legacy-shapes/pre-ovpr.js";
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
      `  upgrade [--target-version <ver>] [--migrate-xbrief] [--dry-run] [--yes]\n` +
      `          [--root <path>]\n` +
      `  uninstall [--dry-run] [--yes] [--root <path>]\n` +
      `  doctor [--root <path>] [--full] [--json]\n` +
      `\n` +
      `Aliases: init→install, update→upgrade, remove→uninstall\n` +
      `\n` +
      `Ordinary product commands pass through to the pinned ${RUNTIME_PACKAGE_NAME}.\n` +
      `\n` +
      `First-time: npm i -g @deftai/directive && directive install\n` +
      `After clone or pull: npm install (or pnpm install --frozen-lockfile)\n` +
      `Repair wiring: directive install --repair\n` +
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
      `  --migrate-xbrief           Upgrade: also run the vbrief→xbrief data migration\n` +
      `                             (--yes alone does not run it)\n` +
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

/** The old copy's bin matching how the launcher was called (`directive` or `deft`). */
function invokedBinName(copy: ProjectLocalCopy): string {
  const called = basename((process.argv[1] ?? "").replace(/\\/g, "/")).toLowerCase();
  const preferred = called.startsWith("directive") ? "directive" : "deft";
  if (copy.bins[preferred] !== undefined) return preferred;
  return preferred === "deft" ? "directive" : "deft";
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

  // --- AC9.12 step 1: a valid kill record (#6740) stops commands that would
  // start Directive (not install / upgrade / uninstall / doctor, the kill
  // record verbs, --version or --help); the hook entry has its own check.
  if (
    projectRoot !== null &&
    rawCmd !== "hook:dispatch" &&
    !KILL_SWITCH_LAUNCHER_COMMANDS.has(rawCmd ?? "") &&
    !isInstallManagement(cmd) &&
    !RETIRED_INSTALL_VERBS.has(cmd) &&
    isDisableFlagActive(projectRoot)
  ) {
    io.writeErr(`${DISABLE_ONE_LINE}\n`);
    return EXIT_CODES.SUCCESS;
  }

  // --- Old-style project (§A6.7 / AC10.2, RC-12): every command except
  // upgrade / uninstall (and --version / --help, handled above) runs the
  // project's own installed pre-split copy, or stops when none is installed.
  if (projectRoot !== null && !OLD_STYLE_LAUNCHER_COMMANDS.has(cmd)) {
    if (rawCmd === "hook:dispatch") {
      // Old registrations call `deft hook:dispatch`: same path as `deft-hook`
      // (hand-off, or the host's blocking form); `--root` is honoured.
      return runHookLauncher(cmdArgv, projectRoot, "hook:dispatch");
    }
    const old = recognisePreOvprLayout(projectRoot);
    if (old !== null) {
      if (old.localCopy !== null) {
        const code = runProjectLocalCopy(old.localCopy, invokedBinName(old.localCopy), argv);
        if (code !== null) return code;
      }
      io.writeErr(`${PRE_OVPR_LAYOUT_MESSAGE}\n`);
      return EXIT_CODES.FAILURE;
    }
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
  // One row per situation from the shared table (AC3.12, AC9.12, §A5.6).
  const blocked = classifyLauncherSituation(projectRoot, state);
  if (blocked !== null || state.installed === null) {
    io.writeErr(`${blocked?.message ?? "Directive can't run here."}\n`);
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
