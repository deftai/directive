#!/usr/bin/env node
/**
 * Ensure a CLI exists for ownership recovery without blindly building under
 * WSL-as-root on a project tree (#1617).
 *
 * Prefer order: vendored packages/cli/dist/bin.js → global deft/directive →
 * local engine:_ts-build (non-WSL-root only) → fail closed with global-install
 * bootstrap (WSL root must not create root-owned dist).
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

function hasGlobal(cmd) {
  const probe = spawnSync(cmd, ["--version"], {
    encoding: "utf8",
    shell: false,
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

let isWsl = false;
try {
  isWsl = /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
} catch {
  isWsl = false;
}

if (uid === 0 && isWsl) {
  process.stderr.write(
    "deft ownership: no packages/cli/dist/bin.js and no global deft/directive.\n" +
      "  Under WSL root, install outside the project tree first:\n" +
      "    npm i -g @deftai/directive\n" +
      "  Then re-run ownership:doctor / ownership:fix / verify:ownership.\n" +
      "  Avoid `task build` here — it can create root-owned dist (#1617).\n",
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
