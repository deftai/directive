import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
} from "../xbrief-migrate/constants.js";

export {
  LEGACY_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
};

/**
 * Lifecycle directory names recognized by the layout-aware resolver and path
 * validators. Includes both `xbrief` (canonical) and `vbrief` (legacy) so that
 * path-validation helpers remain accurate during and after migration.
 */
export const LIFECYCLE_DIR_NAMES = [MIGRATED_ARTIFACT_DIR, LEGACY_ARTIFACT_DIR] as const;

/**
 * Artifact filename suffixes recognized by the layout-aware resolver and path
 * validators. Includes both `.xbrief.json` (canonical) and `.vbrief.json`
 * (legacy) so that path-validation helpers remain accurate during and after
 * migration.
 */
export const ARTIFACT_SUFFIXES = [MIGRATED_ARTIFACT_SUFFIX, LEGACY_ARTIFACT_SUFFIX] as const;

/** The on-disk lifecycle layout an engine call site should resolve against (#2109 / #2112). */
export interface LifecycleLayout {
  /** The lifecycle directory name -- always `xbrief` after the vbrief read path removal (#2112). */
  readonly artifactDir: typeof MIGRATED_ARTIFACT_DIR;
  /** The artifact filename suffix -- always `.xbrief.json` after #2112. */
  readonly artifactSuffix: typeof MIGRATED_ARTIFACT_SUFFIX;
  /** The `xBRIEFInfo` root key. */
  readonly infoRootKey: typeof MIGRATED_INFO_ROOT_KEY;
  /** Absolute path to the resolved lifecycle root (`<projectRoot>/xbrief`). */
  readonly root: string;
  /** Always `true` -- the legacy vbrief read path was removed in #2112. */
  readonly migrated: true;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns the layout root for non-layout-sensitive helpers (#2112).
 *
 * - If a valid `xbrief/` layout exists, returns its root.
 * - If only `vbrief/` exists (legacy-only), throws so the caller surfaces the migrate hint.
 * - If neither exists (empty/new project), falls back to `<projectRoot>/xbrief/` canonical path.
 */
export function resolveLayoutRootOrCanonical(projectRoot: string): string {
  try {
    return resolveLifecycleRoot(projectRoot);
  } catch (err) {
    if (
      isDirectory(join(projectRoot, LEGACY_ARTIFACT_DIR)) &&
      !isDirectory(join(projectRoot, MIGRATED_ARTIFACT_DIR))
    ) {
      throw err; // Legacy-only project: operator must run deft migrate:xbrief.
    }
    return join(projectRoot, MIGRATED_ARTIFACT_DIR); // New/empty project; use canonical path.
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
 * True when a POSIX-style path is a lifecycle artifact path carrying a
 * recognized lifecycle directory prefix (`xbrief/` or `vbrief/`) and a
 * recognized artifact suffix. The `vbrief/` prefix and `.vbrief.json` suffix
 * remain recognized for path-validation purposes during and after migration.
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
 * Resolve the active lifecycle layout for `projectRoot` (#2109 part 1 / #2112).
 *
 * Requires the migrated `xbrief/` layout: the `xbrief/` directory must exist
 * AND contain at least one `.xbrief.json` artifact. If no such layout is found,
 * throws with a clear error directing the operator to run `deft migrate:xbrief`.
 *
 * The legacy `vbrief/` read-path fallback was removed in #2112 (0.73.0 MINOR).
 * Projects that have not migrated must run `deft migrate:xbrief` first.
 *
 * @throws {Error} When no `xbrief/` layout with `.xbrief.json` artifacts exists.
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
  throw new Error(
    `No xbrief/ layout found at ${projectRoot}. ` +
      "Run `deft migrate:xbrief` to convert your project from the legacy vbrief/ layout.",
  );
}

/** Convenience accessor for the absolute resolved lifecycle root directory. */
export function resolveLifecycleRoot(projectRoot: string): string {
  return resolveLifecycleLayout(projectRoot).root;
}

/**
 * Absolute path to a lifecycle folder under the resolved `xbrief/` layout root
 * (e.g. `<root>/xbrief/active`). Layout-aware (#2109 part 2a / #2112).
 */
export function resolveLifecycleFolder(projectRoot: string, folder: string): string {
  // Throws on a pure vbrief/-only tree (#2112). Falls back to xbrief/ when neither layout exists.
  return join(resolveLayoutRootOrCanonical(projectRoot), folder);
}

/** Absolute path to the layout-aware `.eval/` directory for version-eval results (#1703). */
export function resolveEvalDir(projectRoot: string): string {
  // Throws on a pure vbrief/-only tree (#2112). Falls back to xbrief/ when neither layout exists.
  const layoutRoot = resolveLayoutRootOrCanonical(projectRoot);
  return join(layoutRoot, ".eval");
}

/** Absolute path under `.eval/` for version-eval artefacts (not triage working-set). */
export function resolveEvalPath(projectRoot: string, ...segments: string[]): string {
  return join(resolveEvalDir(projectRoot), ...segments);
}

/** Absolute path to the resolved lifecycle `.audit` directory (#2109 part 2a). */
export function resolveAuditDir(projectRoot: string): string {
  // Throws on a pure vbrief/-only tree (#2112). Falls back to xbrief/ when neither layout exists.
  const layoutRoot = resolveLayoutRootOrCanonical(projectRoot);
  return join(layoutRoot, ".audit");
}

/** Absolute path to a file or subpath under the resolved `.audit` directory. */
export function resolveAuditPath(projectRoot: string, ...segments: string[]): string {
  return join(resolveAuditDir(projectRoot), ...segments);
}

/**
 * The PROJECT-DEFINITION artifact filename for the resolved layout
 * (`PROJECT-DEFINITION.xbrief.json` when migrated, else `.vbrief.json`).
 */
export function projectDefinitionFilename(projectRoot: string): string {
  // Throws on a pure vbrief/-only tree (#2112). Falls back to xbrief/ when neither layout exists.
  try {
    return `PROJECT-DEFINITION${resolveLifecycleLayout(projectRoot).artifactSuffix}`;
  } catch (err) {
    if (
      isDirectory(join(projectRoot, LEGACY_ARTIFACT_DIR)) &&
      !isDirectory(join(projectRoot, MIGRATED_ARTIFACT_DIR))
    ) {
      throw err;
    }
    return `PROJECT-DEFINITION${MIGRATED_ARTIFACT_SUFFIX}`;
  }
}

/** Absolute path to the resolved PROJECT-DEFINITION artifact (#2109 part 2a). */
export function resolveProjectDefinitionPath(projectRoot: string): string {
  // Throws on a pure vbrief/-only tree (#2112). Falls back to xbrief/ when neither layout exists.
  try {
    const layout = resolveLifecycleLayout(projectRoot);
    return join(layout.root, `PROJECT-DEFINITION${layout.artifactSuffix}`);
  } catch (err) {
    if (
      isDirectory(join(projectRoot, LEGACY_ARTIFACT_DIR)) &&
      !isDirectory(join(projectRoot, MIGRATED_ARTIFACT_DIR))
    ) {
      throw err; // Legacy-only project: operator must run deft migrate:xbrief.
    }
    return join(
      projectRoot,
      MIGRATED_ARTIFACT_DIR,
      `PROJECT-DEFINITION${MIGRATED_ARTIFACT_SUFFIX}`,
    );
  }
}

/**
 * POSIX-style display path to the resolved PROJECT-DEFINITION artifact relative
 * to the project root (e.g. `xbrief/PROJECT-DEFINITION.xbrief.json`).
 */
export function projectDefinitionRelPath(projectRoot: string): string {
  // Throws on a pure vbrief/-only tree (#2112). Falls back to xbrief/ when neither layout exists.
  try {
    const layout = resolveLifecycleLayout(projectRoot);
    return `${layout.artifactDir}/PROJECT-DEFINITION${layout.artifactSuffix}`;
  } catch (err) {
    if (
      isDirectory(join(projectRoot, LEGACY_ARTIFACT_DIR)) &&
      !isDirectory(join(projectRoot, MIGRATED_ARTIFACT_DIR))
    ) {
      throw err;
    }
    return `${MIGRATED_ARTIFACT_DIR}/PROJECT-DEFINITION${MIGRATED_ARTIFACT_SUFFIX}`;
  }
}

/**
 * Absolute path to the resolved specification artifact (#2132 / #2112).
 *
 * Returns `xbrief/specification.xbrief.json`; throws when no migrated xbrief/
 * layout is present (see `resolveLifecycleLayout`).
 */
export function resolveSpecArtifactPath(projectRoot: string): string {
  const layout = resolveLifecycleLayout(projectRoot);
  return join(layout.root, `specification${layout.artifactSuffix}`);
}

/**
 * POSIX-style display path to the resolved specification artifact relative to
 * the project root (`xbrief/specification.xbrief.json`).
 */
export function specArtifactRelPath(projectRoot: string): string {
  const layout = resolveLifecycleLayout(projectRoot);
  return `${layout.artifactDir}/specification${layout.artifactSuffix}`;
}
