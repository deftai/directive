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

import { lstatSync, realpathSync } from "node:fs";
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
      } catch (err) {
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
