#!/usr/bin/env node
/**
 * Directive host-hook outer (v261027 / #5994 / #6122 / #6201 / #6620). Node built-ins only.
 * Shared entry order: eligible disable → runtime missing (project install, by
 * lockfile) → spawn pin hook-bin.js.
 * Eligible = lstat regular-file + successful untracked git ls-files listing.
 * Any failure on tool.before blocks the tool call in the host's own form.
 */
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const GUIDANCE = "Directive can't run: @deftai/directive-runtime is not installed in this project. Run {install} in a terminal in this project. Agent tool calls stay blocked until a person runs it.";
const NONDECISION = "Directive hooks: the hook could not reach a decision. Run directive doctor in this project to see the fix.";
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

function parseArg(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
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

/** The project install named in GUIDANCE, from the lockfile at root (AC9.12). */
function installCommand(root) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "`pnpm install --frozen-lockfile`";
  if (existsSync(join(root, "package-lock.json"))) return "`npm install`";
  return "`npm install` (or `pnpm install --frozen-lockfile`)";
}

function quietAllow() {
  process.exit(0);
}

/**
 * The single failure exit (#6201). tool.before blocks: Claude/Codex/unknown
 * exit 2, Cursor and Grok one deny JSON on exit 0. Other events: Grok deny
 * JSON on exit 0, every other host stderr + exit 1 (no compaction or prompt
 * blocks, D-018).
 */
function blockToolCall(host, event, reason) {
  if (host === "grok") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\n");
    process.exit(0);
  }
  if (event === "tool.before" && host === "cursor") {
    process.stdout.write(
      JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }) + "\n",
    );
    process.exit(0);
  }
  process.stderr.write(reason + "\n");
  process.exit(event === "tool.before" ? 2 : 1);
}

function nonDecision(detail) {
  return NONDECISION + " (" + detail + ")";
}

/** Grok success output: empty, or exactly one object with decision allow|deny (#6166). */
function grokOutputIsDecision(text) {
  if (text.trim().length === 0) return true;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return parsed.decision === "allow" || parsed.decision === "deny";
}

const root = findProjectRoot(here);
const argv = process.argv.slice(2);
const host = parseArg(argv, "--host");
const event = parseArg(argv, "--event");

const killPath = join(root, FLAG);
if (isRegularFile(killPath) && gitTrackListing(root, FLAG) === "untracked") {
  quietAllow();
}

const pin = join(root, PIN_REL);
if (!existsSync(pin)) {
  blockToolCall(host, event, GUIDANCE.replace("{install}", () => installCommand(root)));
}

const child = spawnSync(process.execPath, [pin, ...argv], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "pipe", "inherit"],
  maxBuffer: 16 * 1024 * 1024,
});
if (child.error) {
  blockToolCall(host, event, nonDecision("failed to run pin hook-bin: " + child.error.message));
}
if (child.status === null) {
  const signal = child.signal ? ", signal " + child.signal : "";
  blockToolCall(host, event, nonDecision("pin hook-bin ended without an exit status" + signal));
}
if (child.status !== 0) {
  blockToolCall(host, event, nonDecision("pin hook-bin exited " + child.status));
}
if (!Buffer.isBuffer(child.stdout)) {
  blockToolCall(host, event, nonDecision("pin hook-bin output was not captured"));
}
const text = child.stdout.toString("utf8");
if (host === "grok") {
  if (!grokOutputIsDecision(text)) {
    blockToolCall(host, event, nonDecision("pin hook-bin output is not one Grok decision"));
  }
  if (text.trim().length === 0) process.exit(0);
}
process.stdout.write(child.stdout);
