#!/usr/bin/env node
/**
 * Ensure a CLI with ownership recovery verbs exists (#1617 / Greptile P1).
 *
 * Prefer order: vendored packages/cli/dist/bin.js → global deft/directive that
 * actually runs ownership:doctor --help → npm i -g @deftai/directive when
 * uid===0 (re-probe verbs) → local engine:_ts-build (including root fallback
 * when the published CLI predates these verbs).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(process.argv[2] || process.cwd());
const bin = path.join(root, "packages", "cli", "dist", "bin.js");
const isWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    shell: isWin,
    windowsHide: true,
    ...opts,
  });
}

function hasOwnershipDoctor(cmd) {
  // Require the recovery verb itself — --version alone can pass on a published
  // CLI that predates ownership:doctor (#1617 Greptile P1).
  const probe = run(cmd, ["ownership:doctor", "--help"]);
  return probe.status === 0;
}

if (fs.existsSync(bin)) {
  process.exit(0);
}

if (hasOwnershipDoctor("deft") || hasOwnershipDoctor("directive")) {
  process.exit(0);
}

let uid = null;
try {
  if (typeof process.getuid === "function") {
    uid = process.getuid();
  }
} catch {
  uid = null;
}

function isLikelyWsl() {
  if (
    process.env.WSL_DISTRO_NAME ||
    process.env.WSL_INTEROP ||
    process.env.WSLENV ||
    process.env.WSL_INTEROP_PATH
  ) {
    return true;
  }
  try {
    return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

if (uid === 0) {
  const wslBit = isLikelyWsl() ? " (WSL detected)" : "";
  process.stderr.write(
    `deft ownership: no local CLI with ownership verbs${wslBit}; trying ` +
      "global @deftai/directive install (#1617).\n",
  );
  const install = run("npm", ["i", "-g", "@deftai/directive"], {
    stdio: "inherit",
    shell: true,
  });
  if (
    install.status === 0 &&
    (hasOwnershipDoctor("deft") || hasOwnershipDoctor("directive"))
  ) {
    process.exit(0);
  }
  process.stderr.write(
    "deft ownership: published global CLI missing or lacks ownership verbs; " +
      "building local CLI so recovery can start. " +
      "ownership:fix can repair any root-owned dist afterward (#1617).\n",
  );
}

const build = run("task", [":engine:_ts-build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
process.exit(build.status === 0 ? 0 : (build.status ?? 1));
