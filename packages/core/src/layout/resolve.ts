import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
} from "../xbrief-migrate/constants.js";

export {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
};

/**
 * Lifecycle directory names recognized by the layout-aware resolver, in
 * preference order (migrated `xbrief` first, legacy `vbrief` second).
 */
export const LIFECYCLE_DIR_NAMES = [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR] as const;

/**
 * Artifact filename suffixes recognized by the layout-aware resolver, in
 * preference order (`.xbrief.json` first, `.vbrief.json` second).
 */
export const ARTIFACT_SUFFIXES = [MIGRATED_ARTIFACT_SUFFIX, LEGACY_ARTIFACT_SUFFIX] as const;

/** The on-disk lifecycle layout an engine call site should resolve against (#2109). */
export interface LifecycleLayout {
  /** The lifecycle directory name -- `xbrief` when migrated, else `vbrief`. */
  readonly artifactDir: typeof MIGRATED_ARTIFACT_DIR | typeof LEGACY_ARTIFACT_DIR;
  /** The artifact filename suffix matching `artifactDir`. */
  readonly artifactSuffix: typeof MIGRATED_ARTIFACT_SUFFIX | typeof LEGACY_ARTIFACT_SUFFIX;
  /** The `*BRIEFInfo` root key matching `artifactDir`. */
  readonly infoRootKey: typeof MIGRATED_INFO_ROOT_KEY | typeof LEGACY_INFO_ROOT_KEY;
  /** Absolute path to the resolved lifecycle root (`<projectRoot>/<artifactDir>`). */
  readonly root: string;
  /** True when the resolved layout is the migrated `xbrief` layout. */
  readonly migrated: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `name` ends with any recognized artifact suffix (.xbrief.json or .vbrief.json). */
export function hasArtifactSuffix(name: string): boolean {
  return ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Strip whichever recognized artifact suffix `name` ends with. Returns `name`
 * unchanged when it carries no recognized suffix.
 */
export function stripArtifactSuffix(name: string): string {
  for (const suffix of ARTIFACT_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * True when a POSIX-style path is a lifecycle artifact under either layout
 * root (`xbrief/` or `vbrief/`) carrying either artifact suffix.
 */
export function isLifecycleArtifactPath(posix: string): boolean {
  const underLifecycleDir = LIFECYCLE_DIR_NAMES.some((dir) => posix.startsWith(`${dir}/`));
  return underLifecycleDir && hasArtifactSuffix(posix);
}

/** Walk `root` looking for any `.xbrief.json` file (bounded iterative scan). */
function containsMigratedArtifact(root: string): boolean {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined || !isDirectory(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(MIGRATED_ARTIFACT_SUFFIX)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolve the active lifecycle layout for `projectRoot` (#2109 part 1).
 *
 * Prefers the migrated `xbrief/` layout only when BOTH the `xbrief/` directory
 * exists AND it contains at least one `.xbrief.json` artifact; otherwise falls
 * back to the legacy `vbrief/` layout. With only `vbrief/` present (today's
 * repo) the result is the legacy layout, so existing behavior is unchanged.
 */
export function resolveLifecycleLayout(projectRoot: string): LifecycleLayout {
  const migratedRoot = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  if (isDirectory(migratedRoot) && containsMigratedArtifact(migratedRoot)) {
    return {
      artifactDir: MIGRATED_ARTIFACT_DIR,
      artifactSuffix: MIGRATED_ARTIFACT_SUFFIX,
      infoRootKey: MIGRATED_INFO_ROOT_KEY,
      root: migratedRoot,
      migrated: true,
    };
  }
  return {
    artifactDir: LEGACY_ARTIFACT_DIR,
    artifactSuffix: LEGACY_ARTIFACT_SUFFIX,
    infoRootKey: LEGACY_INFO_ROOT_KEY,
    root: join(projectRoot, LEGACY_ARTIFACT_DIR),
    migrated: false,
  };
}

/** Convenience accessor for the absolute resolved lifecycle root directory. */
export function resolveLifecycleRoot(projectRoot: string): string {
  return resolveLifecycleLayout(projectRoot).root;
}
