#!/usr/bin/env node
/**
 * Ensure a CLI exists for ownership recovery without blindly building as root
 * on a project tree (#1617 / Greptile P1).
 *
 * Prefer order: vendored packages/cli/dist/bin.js → global deft/directive →
 * local engine:_ts-build (non-root only) → fail closed with global-install
 * bootstrap (root must not create root-owned dist).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(process.argv[2] || process.cwd());
const bin = path.join(root, "packages", "cli", "dist", "bin.js");

if (fs.existsSync(bin)) {
  process.exit(0);
}

const isWin = process.platform === "win32";

function hasGlobal(cmd) {
  // win32: npm shims are .cmd; shell:true is required to launch them.
  const probe = spawnSync(cmd, ["--version"], {
    encoding: "utf8",
    shell: isWin,
    windowsHide: true,
  });
  if (probe.status === 0) return true;
  if (!isWin) return false;
  const where = spawnSync(`where ${cmd}`, {
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });
  return where.status === 0 && String(where.stdout || "").trim().length > 0;
}

if (hasGlobal("deft") || hasGlobal("directive")) {
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

// Any uid 0 build can create root-owned dist; WSL env markers catch hosts
// whose /proc/version omits "microsoft" (Greptile P1).
if (uid === 0) {
  const wslBit = isLikelyWsl() ? " (WSL detected)" : "";
  process.stderr.write(
    `deft ownership: no packages/cli/dist/bin.js and no global deft/directive${wslBit}.\n` +
      "  Running as root — refuse project `task build` (root-owned dist risk) (#1617).\n" +
      "  Install outside the project tree, then re-run ownership:doctor / fix / verify:\n" +
      "    npm i -g @deftai/directive\n",
  );
  process.exit(2);
}

const build = spawnSync("task", [":engine:_ts-build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  windowsHide: true,
});
process.exit(build.status === 0 ? 0 : (build.status ?? 1));
