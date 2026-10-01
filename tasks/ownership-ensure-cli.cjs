#!/usr/bin/env node
/**
 * Ensure a CLI exists for ownership recovery without building project dist as
 * root (#1617 / Greptile P1).
 *
 * Prefer order: vendored packages/cli/dist/bin.js → global deft/directive
 * (--version must succeed) → npm i -g @deftai/directive when uid===0 →
 * local engine:_ts-build (non-root only).
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
  // win32: npm shims are .cmd; shell:true launches them. Require --version
  // success — do not treat a stale `where` hit as usable (Greptile P1).
  const probe = spawnSync(cmd, ["--version"], {
    encoding: "utf8",
    shell: isWin,
    windowsHide: true,
  });
  return probe.status === 0;
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

if (uid === 0) {
  const wslBit = isLikelyWsl() ? " (WSL detected)" : "";
  process.stderr.write(
    `deft ownership: no local CLI${wslBit}; installing global @deftai/directive ` +
      "so recovery can start without creating root-owned project dist (#1617).\n",
  );
  const install = spawnSync("npm", ["i", "-g", "@deftai/directive"], {
    stdio: "inherit",
    shell: true,
    windowsHide: true,
  });
  if (install.status === 0 && (hasGlobal("deft") || hasGlobal("directive"))) {
    process.exit(0);
  }
  process.stderr.write(
    "deft ownership: global install failed or CLI still missing.\n" +
      "  Install manually outside the project tree, then re-run:\n" +
      "    npm i -g @deftai/directive\n" +
      "  Avoid `task build` as root — it can create root-owned dist (#1617).\n",
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
