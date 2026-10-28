/**
 * v261027 thin host `.mjs` outer (#5994 / AC9.1 / AC9.12).
 *
 * Registered host command is `node <deposit>/deft-hook-<sha8>.mjs …`.
 * Outer uses Node built-ins only until entry guards pass, then spawns pin
 * `hook-bin.js`. No timeout logic in the outer (#5920 / #5988 out of scope).
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
 * Directive host-hook outer (v261027 / #5994). Node built-ins only until guards pass.
 * F1 order: disable → missing pin (project PM) → spawn pin hook-bin.js.
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
process.exit(child.status === null ? 1 : child.status);
`;
}
