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
 * Pure ESM outer source deposited under each host dir.
 * Keep this string the SoT for sha8; tests assert F1 order + messaging.
 */
export function hostHookOuterSource(): string {
  const guidance = HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE;
  const pinRel = HOST_HOOK_OUTER_PIN_HOOK_BIN_REL;
  return `#!/usr/bin/env node
/**
 * Directive host-hook outer (v261027 / #5994 / #6122). Node built-ins only until guards pass.
 * F1 order: eligible disable → missing pin (project PM) → spawn pin hook-bin.js.
 * Eligible = lstat regular-file + successful untracked git ls-files listing.
 */
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const GUIDANCE = ${JSON.stringify(guidance)};
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
    process.stderr.write(detail + "\\n");
  }
  if (host === "grok") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: GUIDANCE }) + "\\n");
    process.exit(0);
  }
  process.stderr.write(GUIDANCE + "\\n");
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
`;
}
