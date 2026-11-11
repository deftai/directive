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
 *
 * #6163 Prefer-A Bound 6772886751: tip-required Cursor deposit paths + stage-only
 * force-add + committed/index association bookend (Cursor-at-minimum).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { HookHost } from "../hooks/dispatcher.js";

/** Project-PM guidance for missing pin (⊗ AC9.7 INSTALLATION_RECOVERY_GUIDANCE). */
export const HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE =
  "Directive hooks: missing node_modules/@deftai/directive-runtime. " +
  "Run npm install or pnpm install (or yarn) in this project.";

export const HOST_HOOK_OUTER_PIN_HOOK_BIN_REL =
  "node_modules/@deftai/directive-runtime/dist/hook-bin.js";

/** Tip-tracked Cursor hooks registration (#6163). */
export const CURSOR_HOOKS_JSON_REL = ".cursor/hooks.json";

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
 * Exact tip-required Cursor paths for the installed outer hash (#6163).
 * New-hash shim path is enumerated explicitly — "already tracked" under
 * `.cursor/` is not exact-path membership for the new hash.
 */
export function tipRequiredCursorDepositPaths(
  sha8: string = hostHookOuterSha8(),
): readonly [typeof CURSOR_HOOKS_JSON_REL, string] {
  return [CURSOR_HOOKS_JSON_REL, hostHookOuterRelPath("cursor", sha8)];
}

/** Tree source for Cursor deposit association (#6163). */
export type CursorDepositTreeSource = "HEAD" | "index";

export interface CursorDepositAssociationResult {
  readonly ok: boolean;
  readonly sha8: string;
  readonly paths: readonly string[];
  readonly detail: string;
}

export interface StageTipRequiredCursorDepositResult {
  readonly staged: readonly string[];
  readonly sha8: string;
  readonly paths: readonly string[];
}

export type CursorDepositTreeFileReader = (
  projectRoot: string,
  relPath: string,
  source: CursorDepositTreeSource,
) => string | null;

export type CursorDepositGitAdd = (projectRoot: string, paths: readonly string[]) => void;

function defaultReadTreeFile(
  projectRoot: string,
  relPath: string,
  source: CursorDepositTreeSource,
): string | null {
  try {
    // `HEAD:./<path>` / `:./<path>` resolve relative to projectRoot so a
    // nested project reads its own deposit, not the repository parent's
    // (same pattern as defaultReadCommittedFile — #6163 Greptile P1).
    const spec = source === "HEAD" ? `HEAD:./${relPath}` : `:./${relPath}`;
    return execFileSync("git", ["show", spec], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** True when hooks.json registers the expected outer via a command field. */
function hooksJsonRegistersOuter(
  hooksJson: string,
  expectedCmd: string,
  shimRelPath: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(hooksJson);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;
  for (const value of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const command = (entry as Record<string, unknown>).command;
      if (typeof command !== "string") continue;
      // Exact deposit command only — substring/filename matches are not association.
      if (command === expectedCmd) return true;
      const m = command.trim().match(/^(?:node(?:\.exe)?)\s+(\S+)/i);
      const invokedPath = m?.[1];
      if (!invokedPath) continue;
      const invoked = invokedPath.replace(/\\/g, "/");
      if (invoked === shimRelPath || invoked === `./${shimRelPath}`) return true;
    }
  }
  return false;
}

function defaultGitAddForce(projectRoot: string, paths: readonly string[]): void {
  // Bounded path list only — never `git add -f .cursor/` (#6163).
  execFileSync("git", ["add", "-f", "--", ...paths], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Stage-only force-add of tip-required Cursor paths despite local exclude
 * `.cursor/` (#6163 Prefer-A Bound 6772886751). Never commits.
 */
export function stageTipRequiredCursorDeposit(
  projectRoot: string,
  options: {
    readonly sha8?: string;
    readonly gitAdd?: CursorDepositGitAdd;
  } = {},
): StageTipRequiredCursorDepositResult {
  const sha8 = options.sha8 ?? hostHookOuterSha8();
  const paths = tipRequiredCursorDepositPaths(sha8);
  const gitAdd = options.gitAdd ?? defaultGitAddForce;
  gitAdd(projectRoot, paths);
  return { staged: [...paths], sha8, paths };
}

/**
 * Committed-byte / index association bookend for installed outer hash (#6163).
 * Working-tree inspectAgentHookDeposit green alone is not sufficient.
 */
export function validateCursorDepositAssociation(
  projectRoot: string,
  options: {
    readonly source?: CursorDepositTreeSource;
    readonly outerSource?: string;
    readonly readTreeFile?: CursorDepositTreeFileReader;
  } = {},
): CursorDepositAssociationResult {
  const outerSource = options.outerSource ?? hostHookOuterSource();
  const sha8 = hostHookOuterSha8(outerSource);
  const paths = tipRequiredCursorDepositPaths(sha8);
  const source = options.source ?? "HEAD";
  const read = options.readTreeFile ?? defaultReadTreeFile;
  const hooksJson = read(projectRoot, paths[0], source);
  if (hooksJson === null) {
    return {
      ok: false,
      sha8,
      paths,
      detail: `missing ${paths[0]} in ${source} tree (#6163)`,
    };
  }
  const expectedCmd = hostHookOuterCommand("cursor", sha8);
  const shimToken = hostHookOuterFileName(sha8);
  if (!hooksJsonRegistersOuter(hooksJson, expectedCmd, paths[1])) {
    return {
      ok: false,
      sha8,
      paths,
      detail: `${paths[0]} in ${source} does not register command for ${expectedCmd} (#6163)`,
    };
  }
  const shim = read(projectRoot, paths[1], source);
  if (shim === null) {
    return {
      ok: false,
      sha8,
      paths,
      detail: `missing ${paths[1]} in ${source} tree (#6163)`,
    };
  }
  if (shim !== outerSource) {
    return {
      ok: false,
      sha8,
      paths,
      detail: `${paths[1]} bytes do not match installed hostHookOuterSource (#6163)`,
    };
  }
  if (hostHookOuterSha8(shim) !== sha8) {
    return {
      ok: false,
      sha8,
      paths,
      detail: `shim content hash mismatch for ${paths[1]} (#6163)`,
    };
  }
  return {
    ok: true,
    sha8,
    paths,
    detail: `Cursor deposit associated in ${source} for ${shimToken}`,
  };
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
