/**
 * projection-containment.ts — repo-controlled projection symlink guard (#2413).
 *
 * Projection writers (`codebase:map`, `triage:bootstrap`) write to well-known
 * paths such as `.planning/codebase/MAP.md`, `.gitignore`, and `.gitattributes`.
 * If a malicious repo author commits one of those paths (or a parent) as a
 * symlink escaping the project tree, routine operator commands would follow the
 * link and create/overwrite files outside the checkout.
 *
 * `assertProjectionContained` anchors on `realpath(projectDir)`, walks each
 * existing component down to the write target, rejects symlinks that escape the
 * tree, and asserts the deepest existing ancestor stays under the project root.
 *
 * Refs #2413.
 */

import { type Dirent, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Non-zero exit code for a projection-containment refusal (needs-action). */
export const PROJECTION_CONTAINMENT_REFUSED_EXIT_CODE = 2;

/** Thrown when a projection write target escapes the project tree. */
export class ProjectionContainmentError extends Error {
  readonly projectDir: string;
  readonly targetPath: string;
  readonly offendingPath: string;

  constructor(
    message: string,
    details: { projectDir: string; targetPath: string; offendingPath: string },
  ) {
    super(message);
    this.name = "ProjectionContainmentError";
    this.projectDir = details.projectDir;
    this.targetPath = details.targetPath;
    this.offendingPath = details.offendingPath;
  }
}

/**
 * Path-SEGMENT containment: is `child` equal to `parent` or nested under it?
 * Uses `path.relative` so `/foo` is NOT treated as containing `/foobar`.
 */
function isContained(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Refuse projection writes when the target (or a parent) is a symlink that
 * escapes the resolved project tree. Throws {@link ProjectionContainmentError};
 * MUST be called BEFORE any projection read/write/mkdir.
 */
export function assertProjectionContained(projectDir: string, targetPath: string): void {
  const projectAbs = resolve(projectDir);
  let projectReal: string;
  try {
    projectReal = realpathSync(projectAbs);
  } catch {
    throw new ProjectionContainmentError(
      `projection write refused: project directory ${projectAbs} does not exist`,
      { projectDir: projectAbs, targetPath: resolve(targetPath), offendingPath: projectAbs },
    );
  }

  const targetAbs = resolve(targetPath);
  const rel = relative(projectAbs, targetAbs);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ProjectionContainmentError(
      `projection write refused: target ${targetAbs} is not nested under the project tree ${projectAbs}`,
      { projectDir: projectAbs, targetPath: targetAbs, offendingPath: targetAbs },
    );
  }

  const segments = rel.split(/[\\/]+/).filter((segment) => segment.length > 0);
  let current = projectAbs;
  let deepestExistingReal = projectReal;

  for (const segment of segments) {
    current = join(current, segment);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch {
      break;
    }
    if (info.isSymbolicLink()) {
      let linkReal: string;
      try {
        linkReal = realpathSync(current);
      } catch {
        throw new ProjectionContainmentError(
          `projection write refused: ${current} is a broken/dangling symlink on the projection path`,
          { projectDir: projectAbs, targetPath: targetAbs, offendingPath: current },
        );
      }
      if (!isContained(projectReal, linkReal)) {
        throw new ProjectionContainmentError(
          `projection write refused: ${current} is a symlink escaping the project tree ` +
            `(resolves to ${linkReal}, outside ${projectReal})`,
          { projectDir: projectAbs, targetPath: targetAbs, offendingPath: current },
        );
      }
      deepestExistingReal = linkReal;
      current = linkReal;
    } else {
      try {
        deepestExistingReal = realpathSync(current);
      } catch {
        throw new ProjectionContainmentError(
          `projection write refused: could not resolve ${current} on the projection path`,
          { projectDir: projectAbs, targetPath: targetAbs, offendingPath: current },
        );
      }
    }
  }

  try {
    const targetReal = realpathSync(targetAbs);
    if (!isContained(projectReal, targetReal)) {
      throw new ProjectionContainmentError(
        `projection write refused: projection target resolves outside the project tree ` +
          `(${targetReal} is outside ${projectReal})`,
        { projectDir: projectAbs, targetPath: targetAbs, offendingPath: targetReal },
      );
    }
    deepestExistingReal = targetReal;
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      throw err;
    }
    // Target does not exist yet; parent walk above is sufficient.
  }

  if (!isContained(projectReal, deepestExistingReal)) {
    throw new ProjectionContainmentError(
      `projection write refused: projection path escapes the project tree ` +
        `(${deepestExistingReal} is outside ${projectReal})`,
      { projectDir: projectAbs, targetPath: targetAbs, offendingPath: deepestExistingReal },
    );
  }
}

/**
 * Refuse writes when the resolved target already exists as a symlink (#2626 / #2632).
 * Pair with {@link assertProjectionContained} before read/write/mkdir/append.
 */
export function assertWriteTargetSafe(projectDir: string, targetPath: string): void {
  assertProjectionContained(projectDir, targetPath);
  const targetAbs = resolve(targetPath);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(targetAbs);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    throw new ProjectionContainmentError(
      `projection write refused: ${targetAbs} is a symlink on the write path`,
      { projectDir: resolve(projectDir), targetPath: targetAbs, offendingPath: targetAbs },
    );
  }
}

/**
 * Refuse projection writes that would follow an IN-TREE destination symlink on
 * the write path (#2912).
 *
 * {@link assertProjectionContained} only rejects symlinks that ESCAPE the
 * project tree, so an in-tree symlink (leaf or parent) pointing at another
 * checked-in path is silently followed — letting a malicious or mistaken repo
 * symlink divert a consumer projection write (AGENTS.md, .githooks/**,
 * .gitattributes, .github/**, .agents/**, vbrief|xbrief/**, package.json, …)
 * onto an unintended file under operator credentials.
 *
 * This guard first runs the escape checks in {@link assertProjectionContained},
 * then walks every EXISTING component from the project root down to the write
 * target and refuses the write if ANY of them is a symlink — regardless of
 * whether the link resolves inside the tree. Call it BEFORE any projection
 * read/write/mkdir/append on consumer deposit sinks.
 */
export function assertDestinationNotSymlink(projectDir: string, targetPath: string): void {
  assertProjectionContained(projectDir, targetPath);

  const projectAbs = resolve(projectDir);
  const targetAbs = resolve(targetPath);
  const rel = relative(projectAbs, targetAbs);
  const segments = rel.split(/[\\/]+/).filter((segment) => segment.length > 0);

  let current = projectAbs;
  for (const segment of segments) {
    current = join(current, segment);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch {
      // Component does not exist yet; nothing deeper can exist to follow.
      break;
    }
    if (info.isSymbolicLink()) {
      throw new ProjectionContainmentError(
        `projection write refused: ${current} is a symlink on the destination path ` +
          `(in-tree destination symlinks are refused)`,
        { projectDir: projectAbs, targetPath: targetAbs, offendingPath: current },
      );
    }
  }
}

/**
 * Refuse when a lifecycle corpus root is itself a symlink (#2626 category-b).
 */
export function assertDirectoryNotSymlink(
  projectDir: string,
  dirPath: string,
  label: string,
): void {
  assertProjectionContained(projectDir, dirPath);
  const dirAbs = resolve(dirPath);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(dirAbs);
  } catch {
    throw new ProjectionContainmentError(
      `projection write refused: ${label} ${dirAbs} does not exist`,
      { projectDir: resolve(projectDir), targetPath: dirAbs, offendingPath: dirAbs },
    );
  }
  if (info.isSymbolicLink()) {
    throw new ProjectionContainmentError(
      `projection write refused: ${label} ${dirAbs} must not be a symlink`,
      { projectDir: resolve(projectDir), targetPath: dirAbs, offendingPath: dirAbs },
    );
  }
}

/** Walk a directory tree and refuse any symlink entry (#2601 / #2626). */
export function walkDirectoryRejectSymlinks(root: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      throw new ProjectionContainmentError(
        `projection write refused: symlink on traversal path: ${full}`,
        { projectDir: resolve(root), targetPath: full, offendingPath: full },
      );
    }
    if (info.isDirectory()) {
      walkDirectoryRejectSymlinks(full);
    }
  }
}
