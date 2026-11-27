/**
 * Outside-every-checkout write class (#6376).
 *
 * A direct Write/Edit target is in this class only when it is proven to land in
 * the OS temp directory, in an ordinary folder under a home directory, or in the
 * checkout folder (the folder that holds the payload repository's main
 * worktree, #6871), and outside every checkout, Git directory and Directive
 * project. A target that is in the class is allowed without the occupancy lease
 * and the gated session ritual of the payload root (see `inspectMutationGates`).
 * Any doubt keeps the target out of the class, and a target out of the class is
 * judged as before.
 *
 * The test is closed: it reads only the target path, the filesystem, the
 * process environment, one `git rev-parse` on the target and, for a target
 * outside temp and home, the payload root's `--git-common-dir`. It selects no
 * ritual, lease, story or worktree registration.
 *
 * Bound leans: #6376 comment 6908601625; #6871 comment 7070642790.
 * Docs: content/docs/hook-root-admission.md.
 */
import { lstatSync, realpathSync, type Stats, statSync } from "node:fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "node:os";
import { basename, delimiter, dirname, join, parse, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { resolveHookHostIdentity } from "./classify/host-session-identity.js";
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
  /** Working directory that relative exclusion values resolve against. */
  readonly cwd?: () => string;
  readonly runGit?: GitRunner;
  /** Physical package directory of the running Directive runtime; null skips the rule. */
  readonly runtimePackageDir?: string | null;
  /**
   * The applying agy session (#7445): its conversation id from the host identity
   * and the payload `artifactDirectoryPath`. Null or absent keeps the carve-out off.
   */
  readonly agyConversation?: AgyConversationSeam | null;
}

export interface AgyConversationSeam {
  readonly conversationId: string;
  readonly artifactDirectoryPath: string | null;
}

/**
 * The two folders under a home directory that hold one directory per agy
 * conversation: the desktop app's and the CLI's. Nothing else under `~/.gemini`.
 */
const AGY_BRAIN_ROOTS = [
  [".gemini", "antigravity", "brain"],
  [".gemini", "antigravity-cli", "brain"],
] as const;

/** A conversation id is one plain path component. */
const AGY_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Seam for the agy conversation-folder carve-out (#7445). Null unless the host
 * is agy and the identity resolves to a plain conversation id.
 */
export function agyConversationSeam(
  host: string,
  payload: unknown,
  environ: NodeJS.ProcessEnv,
): AgyConversationSeam | null {
  if (host !== "agy") return null;
  const identity = resolveHookHostIdentity("agy", payload, environ);
  const id = identity.status === "ok" ? identity.rawSessionId : null;
  if (id === null || !AGY_CONVERSATION_ID_RE.test(id)) return null;
  const raw =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).artifactDirectoryPath
      : undefined;
  if (raw === undefined || raw === null) return { conversationId: id, artifactDirectoryPath: null };
  // A present but unusable value must fail the cross-check, never be ignored.
  return { conversationId: id, artifactDirectoryPath: typeof raw === "string" ? raw : "" };
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
  /** The checkout folder (#6871), read once on first use; null when there is none. */
  readonly checkoutFolder: () => Anchor | null;
  readonly realpath: (path: string) => string;
  readonly lstat: (path: string) => Stats;
  readonly stat: (path: string) => Stats;
  readonly runGit: GitRunner;
}

const out = (reason: string): OutsideEveryCheckoutVerdict => ({ inClass: false, reason });

/**
 * Hosts whose usual filesystems ignore letter case. Used only to widen an
 * exclusion (a conservative direction); positive location never folds case,
 * because a volume can be case-sensitive (#6376 round 3).
 */
function caseFold(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** How a containment test compares names. */
type Compare = "exact" | "exclusion";

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

/** Root and components parsed by the given platform's path rules, not the host's. */
function platformParts(
  path: string,
  platform: NodeJS.Platform,
): { readonly root: string; readonly parts: string[] } {
  const rules = platform === "win32" ? win32 : posix;
  const raw = rules.parse(path).root;
  const root =
    platform === "win32"
      ? raw.replace(/\//g, "\\").replace(/^[a-z]:/, (drive) => drive.toUpperCase())
      : raw;
  const separators = platform === "win32" ? /[\\/]+/ : /\/+/;
  const parts = path
    .slice(raw.length)
    .split(separators)
    .filter((part) => part.length > 0);
  return { root, parts };
}

/**
 * Components of `child` below `parent` when `child` is equal to or inside it,
 * else null. `exact` compares native names exactly (no case folding on any
 * platform); `exclusion` folds case on hosts whose usual filesystems ignore it,
 * which can only widen an exclusion.
 */
export function pathInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform,
  compare: Compare,
): string[] | null {
  const ignoreCase = compare === "exclusion" && caseFold(platform);
  const same = (a: string, b: string): boolean =>
    ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  const parentPath = platformParts(parent, platform);
  const childPath = platformParts(child, platform);
  if (!same(parentPath.root, childPath.root)) return null;
  const parentParts = parentPath.parts;
  const childParts = childPath.parts;
  if (childParts.length < parentParts.length) return null;
  for (const [index, part] of parentParts.entries()) {
    if (!same(part, childParts[index] as string)) return null;
  }
  return childParts.slice(parentParts.length);
}

/** Depth of `parent` when `child` is equal to or inside it, else -1. */
function containDepth(
  child: string,
  anchor: Anchor,
  platform: NodeJS.Platform,
  strict: boolean,
  compare: Compare,
): number {
  let best = -1;
  for (const form of anchor.forms) {
    const rest = pathInside(child, form, platform, compare);
    if (rest === null || (strict && rest.length === 0)) continue;
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
 * Physical form of a path that may not exist yet: its deepest existing ancestor
 * resolved natively, with the missing rest appended unchanged. Null when no
 * ancestor resolves.
 */
function physicalOf(path: string, realpath: (p: string) => string): string | null {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    const resolved = tryRealpath(current, realpath);
    if (resolved !== null) return rest.length === 0 ? resolved : join(resolved, ...rest);
    const parent = dirname(current);
    if (parent === current) return null;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
}

function anchorOfAbsolute(given: string, realpath: (p: string) => string): Anchor {
  const physical = physicalOf(given, realpath);
  return { forms: physical === null || physical === given ? [given] : [given, physical] };
}

/**
 * Anchor for an environment or host directory. `required` anchors (home, temp)
 * must exist and resolve physically. Optional ones also carry the physical form
 * of their deepest existing ancestor, so a missing file below a link is caught.
 * With `relativeBases`, a relative value is resolved against each base.
 */
function anchorFor(
  value: string | undefined,
  platform: NodeJS.Platform,
  realpath: (p: string) => string,
  required: boolean,
  relativeBases: readonly string[] = [],
): Anchor | "unresolvable" | null {
  const raw = value?.trim() ?? "";
  if (raw.length === 0) return required ? "unresolvable" : null;
  if (hasDeviceOrSharePrefix(raw)) return required ? "unresolvable" : null;
  if (!isHostAbsolute(raw, platform)) {
    if (required || relativeBases.length === 0) return required ? "unresolvable" : null;
    const forms = relativeBases.flatMap(
      (base) => anchorOfAbsolute(resolve(base, raw), realpath).forms,
    );
    return { forms };
  }
  const given = resolve(raw);
  if (required) {
    const physical = tryRealpath(given, realpath);
    if (physical === null) return "unresolvable";
    return { forms: physical === given ? [given] : [given, physical] };
  }
  return anchorOfAbsolute(given, realpath);
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

/** True when the path is a filesystem or drive root. */
function isFilesystemRoot(path: string, platform: NodeJS.Platform): boolean {
  return platformParts(path, platform).parts.length === 0;
}

/**
 * The checkout folder (#6871): the parent of the payload repository's main
 * worktree, in physical form. The main worktree is the folder that holds the
 * common directory `git rev-parse --git-common-dir` reports for the payload
 * root. None when the payload root is not a repository, a lookup fails, the
 * repository is bare (or its common directory is not a `.git` folder), or the
 * parent is a filesystem or drive root. Worktree registrations are not read.
 */
function resolveCheckoutFolder(
  payloadRoot: string,
  platform: NodeJS.Platform,
  realpath: (p: string) => string,
  runGit: GitRunner,
): Anchor | null {
  const root = resolve(payloadRoot);
  const common = runGit(root, ["rev-parse", "--git-common-dir"]);
  const reported = common.code === 0 ? common.stdout.trim() : "";
  if (reported.length === 0) return null;
  const physicalCommon = tryRealpath(resolve(root, reported), realpath);
  if (physicalCommon === null || basename(physicalCommon) !== ".git") return null;
  const bare = runGit(root, [`--git-dir=${physicalCommon}`, "rev-parse", "--is-bare-repository"]);
  if (bare.code !== 0 || bare.stdout.trim() !== "false") return null;
  const folder = dirname(dirname(physicalCommon));
  if (isFilesystemRoot(folder, platform)) return null;
  return { forms: [folder] };
}

function buildContext(
  payloadRoot: string,
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
  // A relative exclusion value is read the way its consumer reads it: against
  // the process working directory (and, to be safe, the payload root).
  const relativeBases = [(seams.cwd ?? process.cwd)(), resolve(payloadRoot)];
  const optional = (value: string, bases: readonly string[] = []): Anchor | null => {
    const anchor = anchorFor(value, platform, realpath, false, bases);
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
    const anchor = optional(value ?? "", relativeBases);
    if (anchor !== null) excludedEnv.push(anchor);
  }
  const pathDirs: Anchor[] = [];
  const pathValue = envLookup(environ, "PATH", platform);
  for (const entry of pathValue.split(platform === "win32" ? ";" : delimiter)) {
    const anchor = optional(entry, relativeBases);
    if (anchor !== null) pathDirs.push(anchor);
  }
  const runtimeValue =
    seams.runtimePackageDir === undefined ? defaultRuntimePackageDir() : seams.runtimePackageDir;
  const runtimeDir = runtimeValue === null ? null : optional(runtimeValue);
  const runGit = seams.runGit ?? defaultGitRunner;
  let folder: Anchor | null | undefined;
  const checkoutFolder = (): Anchor | null => {
    if (folder === undefined) {
      try {
        folder = resolveCheckoutFolder(payloadRoot, platform, realpath, runGit);
      } catch {
        folder = null;
      }
    }
    return folder;
  };
  return {
    platform,
    homes,
    temp,
    configEnvAreas,
    excludedEnv,
    pathDirs,
    runtimeDir,
    checkoutFolder,
    realpath,
    lstat: seams.lstat ?? lstatSync,
    stat: seams.stat ?? statSync,
    runGit,
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
  // Positive location compares native names exactly; configuration areas and
  // exclusions may fold case, which only keeps more paths out.
  const tempDepth = containDepth(path, ctx.temp, platform, true, "exact");
  let homeInside = false;
  let configDepth = -1;
  for (const home of ctx.homes) {
    for (const form of home.forms) {
      const exact = pathInside(path, form, platform, "exact");
      if (exact !== null && exact.length > 0) homeInside = true;
      const loose = pathInside(path, form, platform, "exclusion");
      if (loose === null || loose.length === 0) continue;
      const first = loose[0] ?? "";
      if (first.startsWith(".") || CONFIG_NAMES.has(first.toLowerCase())) {
        configDepth = Math.max(configDepth, components(form).length + 1);
      }
    }
  }
  // The checkout folder applies only outside temp and home, which keep their
  // rules exactly (#6871). Inside it, the deft/directive name rule skips only
  // the components of the folder's own path.
  let checkoutInside = false;
  let nameRuleFrom = 0;
  if (tempDepth < 0 && !homeInside) {
    const folder = ctx.checkoutFolder();
    for (const form of folder?.forms ?? []) {
      const rest = pathInside(path, form, platform, "exact");
      if (rest === null || rest.length === 0) continue;
      const depth = components(path).length - rest.length;
      nameRuleFrom = checkoutInside ? Math.min(nameRuleFrom, depth) : depth;
      checkoutInside = true;
    }
  }
  for (const [index, part] of components(path).entries()) {
    const doubt = doubtfulComponent(part);
    if (doubt !== null) return doubt;
    const lower = part.toLowerCase();
    if (index >= nameRuleFrom && (lower.includes("deft") || lower.includes("directive"))) {
      return "a path component contains deft or directive";
    }
    if (lower === ".git") return "a path component is named .git";
  }
  if (tempDepth < 0 && !homeInside && !checkoutInside) {
    return "not inside the OS temp directory or a home directory, nor in the checkout folder";
  }
  for (const area of ctx.configEnvAreas) {
    configDepth = Math.max(configDepth, containDepth(path, area, platform, false, "exclusion"));
  }
  // The innermost of the configuration areas and the temp directory decides; a
  // tie goes to the configuration area.
  if (configDepth >= 0 && configDepth >= tempDepth) {
    return "inside a configuration area";
  }
  for (const anchor of ctx.excludedEnv) {
    if (containDepth(path, anchor, platform, false, "exclusion") >= 0) {
      return "inside a path named by a Directive or tool environment variable";
    }
  }
  for (const anchor of ctx.pathDirs) {
    if (containDepth(path, anchor, platform, false, "exclusion") >= 0) {
      return "inside a directory listed in PATH";
    }
  }
  if (
    ctx.runtimeDir !== null &&
    containDepth(path, ctx.runtimeDir, platform, false, "exclusion") >= 0
  ) {
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
  // On POSIX a backslash is a filename character, not a separator; reading it
  // as one would judge a different path than the write reaches.
  if (ctx.platform !== "win32" && target.includes("\\")) {
    return out("backslash in a POSIX typed path");
  }
  // Normalizing `..` before links are followed would judge a different place
  // than the write reaches (`/tmp/link/../x`), so parent and current steps are
  // doubt, not something to collapse.
  if (target.split(/[\\/]+/).some((part) => part === ".." || part === ".")) {
    return out("parent or current-directory step in the typed path");
  }
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
  // Both paths must pass: walk the typed ancestors too, so a project or
  // repository that a link points out of still keeps the target out.
  const typedWalk = walkVerdict(dirname(typed), ctx);
  if (typedWalk !== null) return out(`typed path: ${typedWalk}`);
  const walk = walkVerdict(physical.deepestDir, ctx);
  if (walk !== null) return out(walk);
  const git = gitVerdict(physical.deepestDir, ctx);
  if (git !== null) return out(git);
  return { inClass: true };
}

/** True when `child` is strictly inside `parent` by exact names, in any form of either. */
function strictlyInside(
  child: string,
  parents: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  return parents.some((parent) => {
    const rest = pathInside(child, parent, platform, "exact");
    return rest !== null && rest.length > 0;
  });
}

/**
 * Agy conversation-folder carve-out (#7445). A target is admitted only when it
 * is strictly inside `<home>/.gemini/{antigravity,antigravity-cli}/brain/<conversationId>/` for the
 * applying session's own id, by typed and by physical path. A conversation
 * folder that is itself a link out of the brain folder, another conversation,
 * `config/`, a `..` step and a link out all stay gated. A present payload
 * `artifactDirectoryPath` must name the same folder; it never widens the carve-out.
 */
function isAgyConversationFolderTarget(
  payloadRoot: string,
  target: string,
  ctx: Context,
  agy: AgyConversationSeam,
): boolean {
  const { platform } = ctx;
  if (!AGY_CONVERSATION_ID_RE.test(agy.conversationId)) return false;
  if (target.trim().length === 0 || hasDeviceOrSharePrefix(target)) return false;
  if (!isHostAbsolute(target, platform)) return false;
  if (platform !== "win32" && target.includes("\\")) return false;
  if (target.split(/[\\/]+/).some((part) => part === ".." || part === ".")) return false;
  const typed = resolve(target);
  const physical = buildPhysical(typed, ctx);
  if ("error" in physical) return false;
  if (physical.leaf !== null && !physical.leaf.isDirectory() && physical.leaf.nlink > 1) {
    return false;
  }
  if (!isOutsideProjectRootWrite(payloadRoot, target)) return false;
  for (const home of ctx.homes) {
    for (const form of home.forms) {
      for (const rootParts of AGY_BRAIN_ROOTS) {
        const brain = join(form, ...rootParts);
        const folder = join(brain, agy.conversationId);
        if (!strictlyInside(typed, [folder], platform)) continue;
        const brainPhysical = physicalOf(brain, ctx.realpath);
        const folderPhysical = physicalOf(folder, ctx.realpath);
        if (brainPhysical === null || folderPhysical === null) continue;
        // The folder must be a real child of the brain folder, not a link elsewhere.
        if (!strictlyInside(folderPhysical, [brainPhysical], platform)) continue;
        if (folderPhysical !== join(brainPhysical, agy.conversationId)) continue;
        if (!strictlyInside(physical.path, [folderPhysical], platform)) continue;
        if (components(typed).some((part) => doubtfulComponent(part) !== null)) continue;
        if (agy.artifactDirectoryPath !== null) {
          const claimed = agy.artifactDirectoryPath;
          if (
            claimed.length === 0 ||
            hasDeviceOrSharePrefix(claimed) ||
            !isHostAbsolute(claimed, platform)
          ) {
            continue;
          }
          const claimedPath = resolve(claimed);
          const same = (a: string): boolean =>
            pathInside(a, folder, platform, "exact")?.length === 0;
          const claimedPhysical = physicalOf(claimedPath, ctx.realpath);
          if (
            !same(claimedPath) &&
            !(claimedPhysical !== null && claimedPhysical === folderPhysical)
          ) {
            continue;
          }
        }
        return true;
      }
    }
  }
  return false;
}

/** Classify one direct-write target (#6376). Never throws. */
export function classifyOutsideEveryCheckoutTarget(
  payloadRoot: string,
  target: string,
  environ: NodeJS.ProcessEnv,
  seams: OutsideEveryCheckoutSeams = {},
): OutsideEveryCheckoutVerdict {
  try {
    const ctx = buildContext(payloadRoot, environ, seams);
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
    const ctx = buildContext(payloadRoot, environ, seams);
    if ("error" in ctx) return false;
    const agy = seams.agyConversation ?? null;
    return targets.every(
      (target) =>
        classifyWithContext(payloadRoot, target, ctx).inClass ||
        (agy !== null && isAgyConversationFolderTarget(payloadRoot, target, ctx, agy)),
    );
  } catch {
    return false;
  }
}

/** ApplyPatch headers that name a mutation target (same ops the harvest reads). */
const PATCH_TARGET_HEADER_RE =
  /^\*\*\* (?:Add File|Update File|Delete File|Move File|Rename File|Move to): (.*)$/;

function collectStrings(value: unknown, into: string[], depth: number): void {
  if (depth > 8 || into.length > 5000) return;
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, into, depth + 1);
    }
  }
}

/**
 * True only when every harvested target is spelled in the payload exactly as
 * the class test reads it (#6376 round 3). The harvest trims surrounding
 * whitespace and decodes `file:` URIs; on POSIX `/tmp/note ` and `/tmp/note`
 * are different files, so a target whose original spelling differs from the
 * harvested one is kept out of the class. Never throws.
 */
export function targetsKeepOriginalSpelling(payload: unknown, targets: readonly string[]): boolean {
  if (targets.length === 0) return false;
  try {
    const strings: string[] = [];
    collectStrings(payload, strings, 0);
    const headerCaptures: string[] = [];
    for (const text of strings) {
      for (const line of text.split(/\r?\n/)) {
        const match = PATCH_TARGET_HEADER_RE.exec(line);
        if (match !== null) headerCaptures.push(match[1] ?? "");
      }
    }
    return targets.every((target) => {
      const altered = [...strings, ...headerCaptures].some(
        (s) => s !== target && s.trim() === target,
      );
      if (altered) return false;
      return strings.includes(target) || headerCaptures.includes(target);
    });
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
