#!/usr/bin/env node
/**
 * Directive host-hook outer (v261027 / #5994). Node built-ins only until guards pass.
 * F1 order: disable → missing pin (project PM) → spawn pin hook-bin.js.
 */
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const GUIDANCE = "Directive hooks: missing node_modules/@deftai/directive-runtime. Run npm install or pnpm install (or yarn) in this project.";
const PIN_REL = "node_modules/@deftai/directive-runtime/dist/hook-bin.js";
const FLAG = ".deft-directive-disable";

const here = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start, "../..");
    dir = parent;
  }
}

function parseHost(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) return argv[i + 1];
  }
  return "";
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isGitTracked(root, rel) {
  const r = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

function quietAllow() {
  process.exit(0);
}

function failClosedMissingPin(host) {
  if (host === "grok") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: GUIDANCE }) + "\n");
    process.exit(0);
  }
  process.stderr.write(GUIDANCE + "\n");
  process.exit(1);
}

const root = findProjectRoot(here);
const argv = process.argv.slice(2);
const host = parseHost(argv);

const killPath = join(root, FLAG);
if (existsSync(killPath) && !isSymlink(killPath) && !isGitTracked(root, FLAG)) {
  quietAllow();
}

const pin = join(root, PIN_REL);
if (!existsSync(pin)) {
  failClosedMissingPin(host);
}

const child = spawnSync(process.execPath, [pin, ...argv], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (child.error) {
  process.stderr.write(
    "Directive hooks: failed to spawn pin hook-bin: " + child.error.message + "\n",
  );
}
process.exit(child.status === null ? 1 : child.status);
