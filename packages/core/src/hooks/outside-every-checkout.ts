/**
 * Outside-every-checkout write class (#6376).
 *
 * A direct Write/Edit target is in this class only when it is proven to land in
 * the OS temp directory, or in an ordinary folder under a home directory, and
 * outside every checkout, Git directory and Directive project. A target that is
 * in the class is allowed without the occupancy lease and the gated session
 * ritual of the payload root (see `inspectMutationGates`). Any doubt keeps the
 * target out of the class, and a target out of the class is judged as before.
 *
 * The test is closed: it reads only the target path, the filesystem, the
 * process environment and one `git rev-parse`. It selects no ritual, lease,
 * story or worktree registration.
 *
 * Bound lean: #6376 comment 6908601625. Docs: content/docs/hook-root-admission.md.
 */
import { lstatSync, realpathSync, type Stats, statSync } from "node:fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { isOutsideProjectRootWrite } from "./outside-project-root.js";

/** Decision code of an allowed write in the class. */
export const OUTSIDE_EVERY_CHECKOUT_READY_CODE = "write-outside-every-checkout-ready" as const;

/** Environment variables named by the lean, beside every `DEFT_*` / `DIRECTIVE_*` name. */
export const OUTSIDE_EVERY_CHECKOUT_EXCLUDED_ENV = [
  "OPENCLAW_STATE_DIR",
  "CODEX_HOME",
  "GH_CONFIG_DIR",
  "PNPM_HOME",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GITHUB_EVENT_PATH",
  "GITHUB_STEP_SUMMARY",
] as const;

/** Variables that name a configuration area. */
export const CONFIGURATION_AREA_ENV = [
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

/** Directories directly under a home directory that are configuration areas by name. */
const CONFIG_NAMES = new Set(["library", "appdata"]);

/** Test seams. Every default reads the real host. */
export interface OutsideEveryCheckoutSeams {
  readonly platform?: NodeJS.Platform;
  readonly homedir?: () => string;
  readonly tmpdir?: () => string;
  /** Native resolver: links, junctions, short names, letter case. Throws when unresolvable. */
  readonly realpath?: (path: string) => string;
  readonly lstat?: (path: string) => Stats;
  readonly stat?: (path: string) => Stats;
  readonly runGit?: GitRunner;
  /** Physical package directory of the running Directive runtime; null skips the rule. */
  readonly runtimePackageDir?: string | null;
}

export type OutsideEveryCheckoutVerdict =
  | { readonly inClass: true }
  | { readonly inClass: false; readonly reason: string };

interface Anchor {
  /** Every spelling of the directory: as given (resolved) and physical when it exists. */
  readonly forms: readonly string[];
}

interface Context {
  readonly platform: NodeJS.Platform;
  readonly homes: readonly Anchor[];
  readonly temp: Anchor;
  readonly configEnvAreas: readonly Anchor[];
  readonly excludedEnv: readonly Anchor[];
  readonly pathDirs: readonly Anchor[];
  readonly runtimeDir: Anchor | null;
  readonly realpath: (path: string) => string;
  readonly lstat: (path: string) => Stats;
  readonly stat: (path: string) => Stats;
  readonly runGit: GitRunner;
}

const out = (reason: string): OutsideEveryCheckoutVerdict => ({ inClass: false, reason });

function caseFold(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

function fold(path: string, platform: NodeJS.Platform): string {
  return caseFold(platform) ? path.toLowerCase() : path;
}

/** Absolute in the host's own form: a drive path on Windows, `/` elsewhere. */
function isHostAbsolute(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(path);
  return path.startsWith("/");
}

/** Device namespaces and network shares on any host (`\\?\`, `\\.\`, `\\server`, `//server`). */
function hasDeviceOrSharePrefix(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/** Path components after the root. */
function components(path: string): string[] {
  const root = parse(path).root;
  return path
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
}

/** Short-name form (`PROGRA~1`), a trailing dot or space, or a colon after the drive prefix. */
function doubtfulComponent(part: string): string | null {
  if (part.endsWith(".") || part.endsWith(" ")) return "component ends with a dot or a space";
  if (/~\d/.test(part)) return "component has the Windows short-name form";
  if (part.includes(":")) return "component contains a colon after the drive prefix";
  return null;
}

function relativeInside(child: string, parent: string, platform: NodeJS.Platform): string | null {
  const rel = relative(fold(parent, platform), fold(child, platform));
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

/** Depth of `parent` when `child` is equal to or inside it, else -1. */
function containDepth(
  child: string,
  anchor: Anchor,
  platform: NodeJS.Platform,
  strict: boolean,
): number {
  let best = -1;
  for (const form of anchor.forms) {
    const rel = relativeInside(child, form, platform);
    if (rel === null || (strict && rel === "")) continue;
    best = Math.max(best, components(form).length);
  }
  return best;
}

function tryRealpath(path: string, realpath: (p: string) => string): string | null {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

/**
 * Anchor for an environment or host directory. `required` anchors (home, temp)
 * must resolve physically; optional ones keep their given form when absent.
 */
function anchorFor(
  value: string | undefined,
  platform: NodeJS.Platform,
  realpath: (p: string) => string,
  required: boolean,
): Anchor | "unresolvable" | null {
  const raw = value?.trim() ?? "";
  if (raw.length === 0) return required ? "unresolvable" : null;
  if (!isHostAbsolute(raw, platform) || hasDeviceOrSharePrefix(raw)) {
    return required ? "unresolvable" : null;
  }
  const given = resolve(raw);
  const physical = tryRealpath(given, realpath);
  if (physical === null && required) return "unresolvable";
  const forms = physical === null || physical === given ? [given] : [given, physical];
  return { forms };
}

function envLookup(environ: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string {
  const direct = environ[name];
  if (direct !== undefined) return direct;
  if (platform !== "win32") return "";
  const key = Object.keys(environ).find((k) => k.toUpperCase() === name);
  return key === undefined ? "" : (environ[key] ?? "");
}

let cachedRuntimeDir: string | null | undefined;

/** Nearest ancestor of this module that holds a package.json, physically resolved. */
export function defaultRuntimePackageDir(): string | null {
  if (cachedRuntimeDir !== undefined) return cachedRuntimeDir;
  cachedRuntimeDir = null;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      try {
        statSync(join(dir, "package.json"));
        cachedRuntimeDir = realpathSync.native(dir);
        break;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    cachedRuntimeDir = null;
  }
  return cachedRuntimeDir;
}

function buildContext(
  environ: NodeJS.ProcessEnv,
  seams: OutsideEveryCheckoutSeams,
): Context | { readonly error: string } {
  const platform = seams.platform ?? process.platform;
  const realpath = seams.realpath ?? ((p: string) => realpathSync.native(p));
  const homes: Anchor[] = [];
  const homeValues = [
    (seams.homedir ?? osHomedir)(),
    envLookup(environ, "HOME", platform),
    envLookup(environ, "USERPROFILE", platform),
  ];
  for (const [index, value] of homeValues.entries()) {
    if (index > 0 && value.trim().length === 0) continue;
    const anchor = anchorFor(value, platform, realpath, true);
    if (anchor === "unresolvable") return { error: "a home directory cannot be resolved" };
    if (anchor !== null) homes.push(anchor);
  }
  const temp = anchorFor((seams.tmpdir ?? osTmpdir)(), platform, realpath, true);
  if (temp === "unresolvable" || temp === null) {
    return { error: "the OS temp directory cannot be resolved" };
  }
  const optional = (value: string): Anchor | null => {
    const anchor = anchorFor(value, platform, realpath, false);
    return anchor === "unresolvable" ? null : anchor;
  };
  const configEnvAreas: Anchor[] = [];
  for (const name of CONFIGURATION_AREA_ENV) {
    const anchor = optional(envLookup(environ, name, platform));
    if (anchor !== null) configEnvAreas.push(anchor);
  }
  const excludedEnv: Anchor[] = [];
  const named = new Set<string>(OUTSIDE_EVERY_CHECKOUT_EXCLUDED_ENV);
  for (const [name, value] of Object.entries(environ)) {
    const upper = name.toUpperCase();
    if (!(upper.startsWith("DEFT_") || upper.startsWith("DIRECTIVE_") || named.has(upper))) {
      continue;
    }
    const anchor = optional(value ?? "");
    if (anchor !== null) excludedEnv.push(anchor);
  }
  const pathDirs: Anchor[] = [];
  const pathValue = envLookup(environ, "PATH", platform);
  for (const entry of pathValue.split(platform === "win32" ? ";" : delimiter)) {
    const anchor = optional(entry);
    if (anchor !== null) pathDirs.push(anchor);
  }
  const runtimeValue =
    seams.runtimePackageDir === undefined ? defaultRuntimePackageDir() : seams.runtimePackageDir;
  const runtimeDir = runtimeValue === null ? null : optional(runtimeValue);
  return {
    platform,
    homes,
    temp,
    configEnvAreas,
    excludedEnv,
    pathDirs,
    runtimeDir,
    realpath,
    lstat: seams.lstat ?? lstatSync,
    stat: seams.stat ?? statSync,
    runGit: seams.runGit ?? defaultGitRunner,
  };
}

interface Physical {
  readonly path: string;
  /** Deepest existing folder of the physical destination. */
  readonly deepestDir: string;
  /** Stats of the existing target itself, or null when it does not exist yet. */
  readonly leaf: Stats | null;
}

/**
 * Walk the typed path from its root one component at a time. Each existing
 * component is resolved with the native resolver; the first missing component
 * starts the unresolved rest, appended unchanged. A link that cannot be resolved
 * fails the build.
 */
function buildPhysical(typed: string, ctx: Context): Physical | { readonly error: string } {
  const root = parse(typed).root;
  let current = tryRealpath(root, ctx.realpath);
  if (current === null) return { error: "the filesystem root cannot be resolved" };
  const parts = components(typed);
  let leaf: Stats | null = null;
  let index = 0;
  for (; index < parts.length; index += 1) {
    const next = join(current, parts[index] as string);
    try {
      ctx.lstat(next);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") break;
      return { error: `a component cannot be read (${code ?? "unknown"})` };
    }
    const resolved = tryRealpath(next, ctx.realpath);
    if (resolved === null) return { error: "a link on the path cannot be resolved" };
    current = resolved;
    let stats: Stats;
    try {
      stats = ctx.stat(current);
    } catch {
      return { error: "a resolved component cannot be read" };
    }
    if (index === parts.length - 1) {
      leaf = stats;
    } else if (!stats.isDirectory()) {
      return { error: "a non-directory component has further components" };
    }
  }
  const rest = parts.slice(index);
  const path = rest.length === 0 ? current : join(current, ...rest);
  const deepestDir = leaf !== null && !leaf.isDirectory() ? dirname(current) : current;
  return { path, deepestDir, leaf };
}

/** Positive location, configuration areas (innermost decides) and name exclusions. */
function locationVerdict(path: string, ctx: Context): string | null {
  const { platform } = ctx;
  for (const part of components(path)) {
    const doubt = doubtfulComponent(part);
    if (doubt !== null) return doubt;
    const lower = part.toLowerCase();
    if (lower.includes("deft") || lower.includes("directive")) {
      return "a path component contains deft or directive";
    }
    if (lower === ".git") return "a path component is named .git";
  }
  const tempDepth = containDepth(path, ctx.temp, platform, true);
  let homeInside = false;
  let configDepth = -1;
  for (const home of ctx.homes) {
    for (const form of home.forms) {
      const rel = relativeInside(path, form, platform);
      if (rel === null || rel === "") continue;
      homeInside = true;
      const first = rel.split(sep)[0] ?? "";
      if (first.startsWith(".") || CONFIG_NAMES.has(first.toLowerCase())) {
        configDepth = Math.max(configDepth, components(form).length + 1);
      }
    }
  }
  if (tempDepth < 0 && !homeInside) {
    return "not inside the OS temp directory or a home directory";
  }
  for (const area of ctx.configEnvAreas) {
    configDepth = Math.max(configDepth, containDepth(path, area, platform, false));
  }
  // The innermost of the configuration areas and the temp directory decides; a
  // tie goes to the configuration area.
  if (configDepth >= 0 && configDepth >= tempDepth) {
    return "inside a configuration area";
  }
  for (const anchor of ctx.excludedEnv) {
    if (containDepth(path, anchor, platform, false) >= 0) {
      return "inside a path named by a Directive or tool environment variable";
    }
  }
  for (const anchor of ctx.pathDirs) {
    if (containDepth(path, anchor, platform, false) >= 0) {
      return "inside a directory listed in PATH";
    }
  }
  if (ctx.runtimeDir !== null && containDepth(path, ctx.runtimeDir, platform, false) >= 0) {
    return "inside the running Directive runtime package";
  }
  return null;
}

/**
 * Walk to the filesystem root: no `.git` / `.deft` entry beside any ancestor, no
 * Git directory. Each ancestor is probed for the named entries only, so a large
 * folder (the OS temp directory) is never listed.
 */
function walkVerdict(deepestDir: string, ctx: Context): string | null {
  let dir = deepestDir;
  for (;;) {
    const has = (name: string): boolean | "unreadable" => {
      try {
        ctx.lstat(join(dir, name));
        return true;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR" ? false : "unreadable";
      }
    };
    const probes = [".git", ".deft", "HEAD", "objects", "refs"].map(has);
    if (probes.includes("unreadable")) return "a directory on the walk cannot be read";
    const [git, deft, head, objects, refs] = probes;
    if (git === true || deft === true) {
      return "an ancestor holds a .git or .deft entry";
    }
    if (head === true && objects === true && refs === true) {
      return "an ancestor is a Git directory";
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The toplevel lookup must run to completion and report no repository. */
function gitVerdict(deepestDir: string, ctx: Context): string | null {
  const result = ctx.runGit(deepestDir, ["rev-parse", "--show-toplevel"]);
  if (result.code === 0) return "Git reports a repository the walk did not find";
  if (/not a git repository/i.test(result.stderr)) return null;
  return "the Git lookup could not run to completion";
}

function classifyWithContext(
  payloadRoot: string,
  target: string,
  ctx: Context,
): OutsideEveryCheckoutVerdict {
  if (target.trim().length === 0) return out("empty target");
  if (hasDeviceOrSharePrefix(target)) return out("device or network-share prefix");
  if (!isHostAbsolute(target, ctx.platform)) return out("relative typed path");
  const typed = resolve(target);
  const typedDoubt = locationVerdict(typed, ctx);
  if (typedDoubt !== null) return out(`typed path: ${typedDoubt}`);
  const physical = buildPhysical(typed, ctx);
  if ("error" in physical) return out(physical.error);
  const physicalDoubt = locationVerdict(physical.path, ctx);
  if (physicalDoubt !== null) return out(`physical destination: ${physicalDoubt}`);
  if (physical.leaf !== null && !physical.leaf.isDirectory() && physical.leaf.nlink > 1) {
    return out("existing target file has more than one hard link");
  }
  if (!isOutsideProjectRootWrite(payloadRoot, target)) return out("inside the payload root");
  const walk = walkVerdict(physical.deepestDir, ctx);
  if (walk !== null) return out(walk);
  const git = gitVerdict(physical.deepestDir, ctx);
  if (git !== null) return out(git);
  return { inClass: true };
}

/** Classify one direct-write target (#6376). Never throws. */
export function classifyOutsideEveryCheckoutTarget(
  payloadRoot: string,
  target: string,
  environ: NodeJS.ProcessEnv,
  seams: OutsideEveryCheckoutSeams = {},
): OutsideEveryCheckoutVerdict {
  try {
    const ctx = buildContext(environ, seams);
    if ("error" in ctx) return out(ctx.error);
    return classifyWithContext(payloadRoot, target, ctx);
  } catch (cause) {
    return out(`classification failed: ${String(cause)}`);
  }
}

/** True only when the set is non-empty and every target is in the class. Never throws. */
export function allTargetsOutsideEveryCheckout(
  payloadRoot: string,
  targets: readonly string[],
  environ: NodeJS.ProcessEnv,
  seams: OutsideEveryCheckoutSeams = {},
): boolean {
  if (targets.length === 0) return false;
  try {
    const ctx = buildContext(environ, seams);
    if ("error" in ctx) return false;
    return targets.every((target) => classifyWithContext(payloadRoot, target, ctx).inClass);
  } catch {
    return false;
  }
}

/**
 * Temp-directory name helper: every file or folder Directive creates under the
 * OS temp directory carries `deft` in its created name (#6376 item 12).
 */
export function deftTempName(prefix: string): string {
  return /deft/i.test(prefix) ? prefix : `deft-${prefix}`;
}
