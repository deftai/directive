#!/usr/bin/env node
/**
 * Run an ownership verb via temp-bin marker or engine:invoke (#1617).
 * Usage: node ownership-run.cjs <DEFT_ROOT> <USER_WORKING_DIR> <verb> [cli args...]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(process.argv[2] || ".");
const cwd = path.resolve(process.argv[3] || process.cwd());
const verb = process.argv[4];
const extra = process.argv.slice(5);
if (!verb) {
  process.stderr.write("ownership-run: missing verb\n");
  process.exit(2);
}

const marker = path.join(root, ".deft-scratch", "ownership-bin-path");
const engineCmd = [verb, "--project-root", cwd, ...extra].join(" ");

if (fs.existsSync(marker)) {
  const bin = fs.readFileSync(marker, "utf8").trim();
  const result = spawnSync(process.execPath, [bin, verb, "--project-root", cwd, ...extra], {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  process.exit(result.status === 0 ? 0 : (result.status ?? 1));
}

const result = spawnSync(
  "task",
  [":engine:invoke", `ENGINE_CMD=${engineCmd}`],
  {
    cwd,
    stdio: "inherit",
    shell: true,
    windowsHide: true,
    env: process.env,
  },
);
process.exit(result.status === 0 ? 0 : (result.status ?? 1));
