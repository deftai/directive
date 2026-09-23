/**
 * npm's Windows bin linker (cmd-shim) always writes a .ps1 beside the .cmd.
 * PowerShell selects that .ps1 and stops when script execution is refused, so
 * the bare name never reaches the .cmd. This runs from postinstall, after
 * that link, and removes only this package's generated .ps1 files.
 * A .ps1 is removed only when its sibling .cmd records a target inside this
 * install, so an ambient PNPM_HOME from another install is left alone.
 * It does not change npx.ps1, npm.ps1, or the operator's execution policy.
 */
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";

/** Fallback when package.json cannot be read. Keep aligned with the bin map. */
export const PACKAGE_BIN_NAMES = [
  "directive",
  "deft",
  "deft-ts",
  "deft-hook",
  "deft-verify-encoding",
] as const;

/** Node owns these shims. This package must not delete them. */
export const NODE_OWNED_SHIM_NAMES = ["npx", "npm"] as const;

export interface Ps1ShimRemoval {
  readonly removed: readonly string[];
  readonly failed: readonly string[];
}

export function packageIsUnderNodeModules(pkgDir: string): boolean {
  const parent = dirname(pkgDir);
  if (basename(parent) === "node_modules") return true;
  return basename(dirname(parent)) === "node_modules";
}

/** bin-links layout. Valid only when {@link packageIsUnderNodeModules} is true. */
export function nodeModulesDir(pkgDir: string): string {
  const scopeOrNm = dirname(pkgDir);
  if (basename(scopeOrNm) === "node_modules") return scopeOrNm;
  return dirname(scopeOrNm);
}

/** Same directory bin-links uses for this package root. */
export function linkerBinDir(opts: {
  readonly pkgDir: string;
  readonly global: boolean;
  readonly platform: string;
}): string {
  const nm = nodeModulesDir(opts.pkgDir);
  if (!opts.global) return join(nm, ".bin");
  const prefix = dirname(nm);
  if (opts.platform === "win32") return prefix;
  return join(prefix, "bin");
}

export function isGlobalInstall(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.npm_config_global === "true";
}

function dirKey(dir: string, platform: string): string {
  const norm = dir.replace(/[\\/]+/g, "/");
  if (platform === "win32") return norm.toLowerCase();
  return norm;
}

function ancestorBinDirs(pkgDir: string, stopDir: string, platform: string): string[] {
  const stop = dirKey(stopDir, platform);
  const start = dirKey(pkgDir, platform);
  const stopPrefix = stop.endsWith("/") ? stop : `${stop}/`;
  if (start !== stop && !start.startsWith(stopPrefix)) {
    return [join(stopDir, "node_modules", ".bin")];
  }
  const out: string[] = [];
  let dir = pkgDir;
  for (;;) {
    out.push(join(dir, "node_modules", ".bin"));
    if (dirKey(dir, platform) === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function candidateBinDirs(opts: {
  readonly pkgDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}): string[] {
  const global = isGlobalInstall(opts.env);
  const dirs: string[] = [];
  if (packageIsUnderNodeModules(opts.pkgDir)) {
    dirs.push(linkerBinDir({ pkgDir: opts.pkgDir, global, platform: opts.platform }));
  }
  if (global) {
    const prefix = opts.env.npm_config_prefix;
    if (prefix !== undefined && prefix.length > 0) {
      dirs.push(opts.platform === "win32" ? prefix : join(prefix, "bin"));
    }
    // Candidate only. Removal still requires the .cmd to target this install.
    const pnpmHome = opts.env.PNPM_HOME;
    if (pnpmHome !== undefined && pnpmHome.length > 0) dirs.push(pnpmHome);
  } else {
    const localPrefix = opts.env.npm_config_local_prefix;
    if (localPrefix !== undefined && localPrefix.length > 0) {
      dirs.push(...ancestorBinDirs(opts.pkgDir, localPrefix, opts.platform));
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const key = dirKey(dir, opts.platform);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

function isSafeBinName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return true;
}

export function removeGeneratedPs1Shims(opts: {
  readonly binDir: string;
  readonly binNames: readonly string[];
  readonly platform: string;
  readonly protectedNames?: readonly string[];
}): Ps1ShimRemoval {
  if (opts.platform !== "win32") return { removed: [], failed: [] };
  const protect = new Set(
    (opts.protectedNames ?? NODE_OWNED_SHIM_NAMES).map((name) => name.toLowerCase()),
  );
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of opts.binNames) {
    if (!isSafeBinName(name) || protect.has(name.toLowerCase())) continue;
    const ps1 = join(opts.binDir, `${name}.ps1`);
    const cmd = join(opts.binDir, `${name}.cmd`);
    if (!existsSync(cmd) || !existsSync(ps1)) continue;
    try {
      unlinkSync(ps1);
      removed.push(ps1);
    } catch {
      failed.push(ps1);
    }
  }
  return { removed, failed };
}

function normalizedWinPath(p: string): string {
  const norm = win32.normalize(p).replace(/[\\/]+/g, "\\");
  const trimmed = norm.length > 3 && norm.endsWith("\\") ? norm.slice(0, -1) : norm;
  return trimmed.toLowerCase();
}

function pathIsInside(root: string, target: string): boolean {
  const rootKey = normalizedWinPath(root);
  const targetKey = normalizedWinPath(target);
  return targetKey === rootKey || targetKey.startsWith(`${rootKey}\\`);
}

function realpathIsInside(root: string, target: string): boolean {
  try {
    return pathIsInside(realpathSync(root), realpathSync(target));
  } catch {
    return false;
  }
}

/** True when cmd-shim text records a target path inside this install. */
export function cmdShimTargetsPackage(cmdText: string, binDir: string, pkgDir: string): boolean {
  const re = /%(?:dp0%|~dp0)(?:\\+|\/+)([^"\r\n\s]+)/gi;
  for (const match of cmdText.matchAll(re)) {
    const rel = match[1];
    if (rel === undefined || rel.length === 0) continue;
    const resolved = win32.normalize(win32.join(binDir, rel.replace(/\//g, "\\")));
    if (pathIsInside(pkgDir, resolved) || realpathIsInside(pkgDir, resolved)) return true;
  }
  return false;
}

function cmdLinksCurrentInstall(binDir: string, name: string, pkgDir: string): boolean {
  if (!isSafeBinName(name)) return false;
  let text: string;
  try {
    text = readFileSync(join(binDir, `${name}.cmd`), "utf8");
  } catch {
    return false;
  }
  return cmdShimTargetsPackage(text, binDir, pkgDir);
}

export function readPackageBinNames(packageJsonText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const bin = (parsed as { bin?: unknown }).bin;
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) return [];
  return Object.keys(bin as Record<string, unknown>);
}

export function removeInstalledWindowsPs1Shims(opts: {
  readonly pkgDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly readText?: (path: string) => string;
}): Ps1ShimRemoval {
  if (opts.platform !== "win32") return { removed: [], failed: [] };
  const readText = opts.readText ?? ((path: string) => readFileSync(path, "utf8"));
  let names: readonly string[];
  try {
    names = readPackageBinNames(readText(join(opts.pkgDir, "package.json")));
  } catch {
    names = PACKAGE_BIN_NAMES;
  }
  const removed: string[] = [];
  const failed: string[] = [];
  for (const binDir of candidateBinDirs(opts)) {
    const linked = names.filter((name) => cmdLinksCurrentInstall(binDir, name, opts.pkgDir));
    const result = removeGeneratedPs1Shims({
      binDir,
      binNames: linked,
      platform: opts.platform,
    });
    removed.push(...result.removed);
    failed.push(...result.failed);
  }
  return { removed, failed };
}
