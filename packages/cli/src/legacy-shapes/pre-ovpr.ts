/**
 * Old-style (pre-OVPR) project recognition and the project's own installed
 * pre-split copy (§A6.7 / AC10.2, RC-12 / D-031).
 *
 * An old-style project's root `package.json` depends on `@deftai/directive`
 * and not on `@deftai/directive-runtime`. Recognition uses how the launcher
 * was called and fixed top-level evidence only; it never searches sub-folders.
 * It never changes `readPin().oldStyle` or what `upgrade` converts (AC10.7,
 * AC10.8). Reads only; writes nothing.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "../constants.js";

/** Only pre-split `@deftai/directive` releases depend on the core package. */
const PRE_SPLIT_MARKER_DEPENDENCY = "@deftai/directive-core";

/** Host configs where pre-OVPR Directive registered a bare `deft-hook`. */
const OLD_HOST_CONFIGS = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  ".grok/hooks/deft.json",
] as const;
const OLD_GROK_WRAPPER = ".grok/hooks/deft-pretooluse-wrapper.sh";
const OLD_GIT_HOOK_HELPER = ".githooks/_deft-run.sh";

const BARE_HOOK_COMMAND = /^\s*(deft-hook|deft\s+hook:dispatch)(\s|$)/;

/** The project's own installed pre-split `@deftai/directive`. */
export interface ProjectLocalCopy {
  /** Real path of `<root>/node_modules/@deftai/directive`. */
  readonly packageDir: string;
  readonly version: string;
  /** Bin name → real path of its file, from the copy's own `bin` map. */
  readonly bins: Readonly<Record<string, string>>;
}

export interface PreOvprProject {
  readonly evidence: readonly string[];
  /** The project's own pre-split copy, or null when it is not installed. */
  readonly localCopy: ProjectLocalCopy | null;
}

export interface RecogniseOptions {
  /** The launcher was called as `deft-hook` or `deft hook:dispatch`. */
  readonly hookCall?: boolean;
}

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

function readObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function relPath(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

/** Dependency specs in any form (exact, range, tag) — same blocks as pin.ts. */
function dependencySpecs(pkg: Record<string, unknown> | null): Map<string, string> {
  const out = new Map<string, string>();
  if (pkg === null) return out;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const block = pkg[key];
    if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec === "string") out.set(name, spec.trim());
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

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** An exact spec (`1.2.3` or `=1.2.3`) as a version string, else null. */
function exactVersion(spec: string): string | null {
  const bare = spec.startsWith("=") ? spec.slice(1) : spec;
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(bare) ? bare : null;
}

/** `<root>/node_modules/@deftai/directive`, only when it stays inside the project. */
function readInstalledLauncherPackage(
  root: string,
): { readonly packageDir: string; readonly pkg: Record<string, unknown> } | null {
  const realRoot = realpathOrNull(root);
  const packageDir = realpathOrNull(
    join(root, "node_modules", ...LAUNCHER_PACKAGE_NAME.split("/")),
  );
  if (realRoot === null || packageDir === null || !isInside(realRoot, packageDir)) return null;
  const pkg = readObject(join(packageDir, "package.json"));
  if (pkg === null || pkg.name !== LAUNCHER_PACKAGE_NAME) return null;
  return { packageDir, pkg };
}

function isPreSplit(pkg: Record<string, unknown>): boolean {
  return dependencySpecs(pkg).has(PRE_SPLIT_MARKER_DEPENDENCY);
}

/**
 * The project's own installed pre-split copy, read only from
 * `<root>/node_modules/@deftai/directive`. Never a global copy, a copy outside
 * the project (a link that leaves it), or a version other than the exact pin.
 */
export function findProjectLocalCopy(root: string, spec: string | null): ProjectLocalCopy | null {
  const installed = readInstalledLauncherPackage(root);
  if (installed === null || !isPreSplit(installed.pkg)) return null;
  const { packageDir, pkg } = installed;
  const version = typeof pkg.version === "string" ? pkg.version : null;
  if (version === null) return null;
  const pinned = spec === null ? null : exactVersion(spec);
  if (pinned !== null && pinned !== version) return null;
  const bins: Record<string, string> = {};
  const binMap = pkg.bin;
  if (binMap !== null && typeof binMap === "object" && !Array.isArray(binMap)) {
    for (const [name, rel] of Object.entries(binMap as Record<string, unknown>)) {
      if (typeof rel !== "string") continue;
      const file = realpathOrNull(join(packageDir, rel));
      if (file !== null && isInside(packageDir, file) && isFile(file)) bins[name] = file;
    }
  }
  return { packageDir, version, bins };
}

/**
 * Recognise an old-style project: the root `package.json` depends on
 * `@deftai/directive` and not on `@deftai/directive-runtime` (§A6.7). Null
 * when it lists the runtime (AC10.11), does not list `@deftai/directive`, or
 * the project's installed `@deftai/directive` is the new (post-split)
 * launcher, which is a launcher-only dependency (AC14.51), not an old copy.
 */
export function recognisePreOvprLayout(
  root: string,
  options: RecogniseOptions = {},
): PreOvprProject | null {
  const rootDeps = dependencySpecs(readObject(join(root, "package.json")));
  if (rootDeps.has(RUNTIME_PACKAGE_NAME)) return null;
  const spec = rootDeps.get(LAUNCHER_PACKAGE_NAME);
  if (spec === undefined) return null;
  const installed = readInstalledLauncherPackage(root);
  if (installed !== null && !isPreSplit(installed.pkg)) return null;

  const localCopy = findProjectLocalCopy(root, spec);
  const evidence: string[] = [`package.json#${LAUNCHER_PACKAGE_NAME} ${spec}`];
  if (localCopy !== null)
    evidence.push(`node_modules/${LAUNCHER_PACKAGE_NAME} ${localCopy.version}`);
  if (options.hookCall === true) evidence.push("bare deft-hook call");
  if (isDir(join(root, ".deft", "core"))) evidence.push(".deft/core");
  if (isFile(relPath(root, OLD_GIT_HOOK_HELPER))) evidence.push(OLD_GIT_HOOK_HELPER);
  for (const rel of OLD_HOST_CONFIGS) {
    const path = relPath(root, rel);
    if (isFile(path) && hasBareHookCommand(readObject(path))) {
      evidence.push(`${rel} (bare deft-hook command)`);
    }
  }
  if (isFile(relPath(root, OLD_GROK_WRAPPER))) evidence.push(OLD_GROK_WRAPPER);

  return { evidence, localCopy };
}
