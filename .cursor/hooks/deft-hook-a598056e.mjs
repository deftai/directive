#!/usr/bin/env node
/**
 * Directive host-hook outer (v261027 / #5994 / #6122). Node built-ins only until guards pass.
 * F1 order: eligible disable → missing pin (project PM) → spawn pin hook-bin.js.
 * Eligible = lstat regular-file + successful untracked git ls-files listing.
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

function isRegularFile(path) {
  try {
    const lst = lstatSync(path);
    if (lst.isSymbolicLink()) return false;
    return lst.isFile();
  } catch {
    return false;
  }
}

/** tracked | untracked | indeterminate — only untracked selects quietAllow. */
function gitTrackListing(root, rel) {
  const r = spawnSync("git", ["-C", root, "ls-files", "--", rel], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error || r.status === null || r.status !== 0 || typeof r.stdout !== "string") {
    return "indeterminate";
  }
  return r.stdout.trim().length > 0 ? "tracked" : "untracked";
}

function quietAllow() {
  process.exit(0);
}

function failClosedUnusablePin(host, detail) {
  if (detail) {
    process.stderr.write(detail + "\n");
  }
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
if (isRegularFile(killPath) && gitTrackListing(root, FLAG) === "untracked") {
  quietAllow();
}

const pin = join(root, PIN_REL);
if (!existsSync(pin)) {
  failClosedUnusablePin(host, "");
}

const child = spawnSync(process.execPath, [pin, ...argv], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (child.error) {
  failClosedUnusablePin(
    host,
    "Directive hooks: failed to spawn pin hook-bin: " + child.error.message,
  );
}
if (child.status === null) {
  failClosedUnusablePin(
    host,
    "Directive hooks: pin hook-bin terminated without an exit status",
  );
}
if (child.status !== 0) {
  // Exists-but-unusable (e.g. broken import): Grok needs an explicit deny JSON
  // when the child did not emit a decision (#5994 / Greptile P1).
  failClosedUnusablePin(host, "");
}
process.exit(0);
