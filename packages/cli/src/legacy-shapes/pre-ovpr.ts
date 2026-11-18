/**
 * Message-only pre-OVPR layout recogniser (§A6.7 / AC10.2, RC-01 / RC-07).
 *
 * Wider than AC10.1 detection on purpose: it only chooses the old-repo
 * message (for `deft-hook` now; later the launcher gate and doctor). It never
 * feeds `readPin().oldStyle`, `upgrade` admission or `install` refusal
 * (AC10.1 / AC10.7). Reads only; writes nothing. A nested `package.json` is
 * evidence only, never the project or the pin (AC1.7).
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "../constants.js";
import { resolveInstallShape } from "./detect.js";

export interface PreOvprEvidence {
  readonly evidence: readonly string[];
}

/** Host configs where pre-OVPR Directive registered a bare `deft-hook`. */
const OLD_HOST_CONFIGS = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  ".grok/hooks/deft.json",
] as const;
const OLD_GROK_WRAPPER = ".grok/hooks/deft-pretooluse-wrapper.sh";
const OLD_GIT_HOOK_HELPER = ".githooks/_deft-run.sh";

/** Bounds for the nested package.json walk (signal b). */
export const PRE_OVPR_WALK_MAX_DEPTH = 3;
export const PRE_OVPR_WALK_MAX_FILES = 200;

const BARE_HOOK_COMMAND = /^\s*(deft-hook|deft\s+hook:dispatch)(\s|$)/;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function relPath(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

/** Dependency names in any form (exact, range, tag) — same blocks as pin.ts. */
function dependencyNames(pkg: unknown): Set<string> {
  const out = new Set<string>();
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) return out;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const block = (pkg as Record<string, unknown>)[key];
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec === "string") out.add(name);
    }
  }
  return out;
}

function hasBareHookCommand(value: unknown): boolean {
  if (typeof value === "string") return BARE_HOOK_COMMAND.test(value);
  if (Array.isArray(value)) return value.some(hasBareHookCommand);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasBareHookCommand);
  }
  return false;
}

/**
 * Nested `package.json` (depth ≤ 3 below root; skips `node_modules`, `.git`
 * and other dot-dirs; stops after 200 files) that lists `@deftai/directive`
 * in any form. Returns its root-relative path, or null.
 */
function findNestedLauncherDependency(root: string): string | null {
  let filesSeen = 0;
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(next.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = next.rel === "" ? entry.name : `${next.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        if (next.depth < PRE_OVPR_WALK_MAX_DEPTH) {
          queue.push({ abs: join(next.abs, entry.name), rel, depth: next.depth + 1 });
        }
        continue;
      }
      filesSeen += 1;
      if (filesSeen > PRE_OVPR_WALK_MAX_FILES) return null;
      if (next.depth === 0 || entry.name !== "package.json") continue;
      const names = dependencyNames(readJson(join(next.abs, entry.name)));
      if (names.has(LAUNCHER_PACKAGE_NAME)) return rel;
    }
  }
  return null;
}

/**
 * Recognise a pre-OVPR Directive layout, for the old-repo message only.
 * Null when the root `package.json` lists `@deftai/directive-runtime` in any
 * form: that repo is OVPR, and leftovers there are hygiene.
 */
export function recognisePreOvprLayout(root: string): PreOvprEvidence | null {
  const rootDeps = dependencyNames(readJson(join(root, "package.json")));
  if (rootDeps.has(RUNTIME_PACKAGE_NAME)) return null;
  const rootListsLauncher = rootDeps.has(LAUNCHER_PACKAGE_NAME);
  const evidence: string[] = [];

  // (a) A historical install shape the launcher already knows (reused).
  const shape = resolveInstallShape(root);
  if (shape !== null && shape.shapeId !== "ovpr-runtime-pin") {
    evidence.push(`install shape ${shape.shapeId}`);
  }

  // (b) A .deft/core folder (any contents) + an @deftai/directive dependency.
  if (isDir(join(root, ".deft", "core"))) {
    const where = rootListsLauncher ? "package.json" : findNestedLauncherDependency(root);
    if (where !== null) evidence.push(`.deft/core + ${where}#${LAUNCHER_PACKAGE_NAME}`);
  }

  // (c) The old git-hook helper.
  if (isFile(relPath(root, OLD_GIT_HOOK_HELPER))) evidence.push(OLD_GIT_HOOK_HELPER);

  // (d) Fresh clone: root dependency + an old host hook registration.
  if (rootListsLauncher) {
    for (const rel of OLD_HOST_CONFIGS) {
      const path = relPath(root, rel);
      if (isFile(path) && hasBareHookCommand(readJson(path))) {
        evidence.push(`${rel} (bare deft-hook command)`);
      }
    }
    if (isFile(relPath(root, OLD_GROK_WRAPPER))) evidence.push(OLD_GROK_WRAPPER);
  }

  return evidence.length > 0 ? { evidence } : null;
}
