/**
 * v261027 thin host `.mjs` outer (#5994 / AC9.1 / AC9.12).
 *
 * Registered host command is `node <deposit>/deft-hook-<sha8>.mjs …`.
 * Outer uses Node built-ins only until entry guards pass, then spawns pin
 * `hook-bin.js`. No timeout logic in the outer (#5920 / #5988 out of scope).
 *
 * F1 operator-disable eligibility (#6122): quietAllow only for positively
 * validated eligible (lstat regular-file + successful untracked `git ls-files`
 * listing with usable captured output). Tracked / wrong kind / indeterminate
 * never select the override.
 */

import { createHash } from "node:crypto";
import type { HookHost } from "../hooks/dispatcher.js";

/** Project-PM guidance for missing pin (⊗ AC9.7 INSTALLATION_RECOVERY_GUIDANCE). */
export const HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE =
  "Directive hooks: missing node_modules/@deftai/directive-runtime. " +
  "Run npm install or pnpm install (or yarn) in this project.";

export const HOST_HOOK_OUTER_PIN_HOOK_BIN_REL =
  "node_modules/@deftai/directive-runtime/dist/hook-bin.js";

/** Filename stem + content-hash suffix (AC9.1). */
export function hostHookOuterFileName(sha8: string): string {
  return `deft-hook-${sha8}.mjs`;
}

/** Deposit-relative path for the committed outer (per host). */
export function hostHookOuterRelPath(host: HookHost, sha8: string): string {
  const name = hostHookOuterFileName(sha8);
  switch (host) {
    case "grok":
      return `.grok/hooks/${name}`;
    case "cursor":
      return `.cursor/hooks/${name}`;
    case "claude":
      return `.claude/${name}`;
    case "codex":
      return `.codex/${name}`;
    default: {
      const _exhaustive: never = host;
      return _exhaustive;
    }
  }
}

/** Registered command prefix: `node <rel>` (host/event args appended by callers). */
export function hostHookOuterCommand(host: HookHost, sha8: string): string {
  return `node ${hostHookOuterRelPath(host, sha8)}`;
}

export function hostHookOuterSha8(source: string = hostHookOuterSource()): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 8);
}

/** True when a registered command string is the v261027 `.mjs` outer form. */
export function isHostHookOuterCommand(commandText: string): boolean {
  return /(?:^|[\s/])deft-hook-[a-f0-9]{8}\.mjs(?:\s|$)/.test(commandText);
}

/**
 * Reason the outer gives when the pin exists but hook-bin reached no decision
 * (spawn error, signal / null status, non-zero exit, stdout capture failure,
 * or malformed Grok output). Placeholder wording; P4-U3a moves it into the
 * shared message table (#6201 / #6166).
 */
export const HOST_HOOK_NONDECISION_REASON =
  "Directive hooks: the hook could not reach a decision. " +
  "Run directive doctor in this project to see the fix.";

/**
 * Pure ESM outer source deposited under each host dir.
 * Keep this string the SoT for sha8; tests assert F1 order + messaging.
 *
 * #6201 / #6166: every failure path goes through `blockToolCall`. On
 * `tool.before` it uses the host's blocking form (Claude/Codex exit 2,
 * Cursor and Grok one deny JSON on exit 0). Other events keep today's exit
 * codes (D-018). Child stdout is captured so a failed run never leaks a
 * partial decision, and Grok output must be one decision or empty.
 */
export function hostHookOuterSource(): string {
  const guidance = HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE;
  const nondecision = HOST_HOOK_NONDECISION_REASON;
  const pinRel = HOST_HOOK_OUTER_PIN_HOOK_BIN_REL;
  return `#!/usr/bin/env node
/**
 * Directive host-hook outer (v261027 / #5994 / #6122 / #6201). Node built-ins only.
 * F1 order: eligible disable → missing pin (project PM) → spawn pin hook-bin.js.
 * Eligible = lstat regular-file + successful untracked git ls-files listing.
 * Any failure on tool.before blocks the tool call in the host's own form.
 */
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const GUIDANCE = ${JSON.stringify(guidance)};
const NONDECISION = ${JSON.stringify(nondecision)};
const PIN_REL = ${JSON.stringify(pinRel)};
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
    process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\\n");
    process.exit(0);
  }
  if (event === "tool.before" && host === "cursor") {
    process.stdout.write(
      JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }) + "\\n",
    );
    process.exit(0);
  }
  process.stderr.write(reason + "\\n");
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
  blockToolCall(host, event, GUIDANCE);
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
`;
}
