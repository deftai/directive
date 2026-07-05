/**
 * contain.ts — deposit-boundary symlink-escape guard (#2305).
 *
 * The framework deposit derives its destination as
 * `deftDir = join(projectDir, ".deft/core")` and copies the (trusted) content
 * payload into it. If a malicious project repo commits `.deft` (or `.deft/core`,
 * or a parent) as a symlink that escapes the tree — e.g. `.deft -> ../../evil` —
 * the deposit would write/replace framework content THROUGH that symlink,
 * outside the resolved project tree, under the victim's account.
 *
 * `assertDepositContained` refuses that: it anchors on `realpath(projectDir)`,
 * walks each existing component from the project root down to `deftDir`, rejects
 * any component that is a symlink escaping the project tree, and asserts the
 * deepest existing ancestor of `deftDir` resolves back UNDER the project tree
 * using path-SEGMENT containment (not string `startsWith`).
 *
 * Callers MUST invoke it BEFORE the first copy/mkdir/reconstitute so a refusal
 * deposits nothing.
 *
 * Refs #2305.
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Non-zero exit code for a deposit-containment refusal (needs-action). */
export const DEPOSIT_CONTAINMENT_REFUSED_EXIT_CODE = 2;

/** Thrown by the deposit/refresh path when the destination escapes the tree. */
export class DepositContainmentError extends Error {
  readonly projectDir: string;
  readonly deftDir: string;
  readonly offendingPath: string;

  constructor(
    message: string,
    details: { projectDir: string; deftDir: string; offendingPath: string },
  ) {
    super(message);
    this.name = "DepositContainmentError";
    this.projectDir = details.projectDir;
    this.deftDir = details.deftDir;
    this.offendingPath = details.offendingPath;
  }
}

/**
 * Path-SEGMENT containment: is `child` equal to `parent` or nested under it?
 * Uses `path.relative` so `/foo` is NOT treated as containing `/foobar`
 * (`relative("/foo", "/foobar")` is `"../foobar"`, which is rejected).
 */
function isContained(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Refuse the deposit when `.deft` / `.deft/core` (or a parent) is a symlink that
 * escapes the resolved project tree. Throws {@link DepositContainmentError};
 * MUST be called BEFORE any deposit write so a refusal deposits nothing.
 */
export function assertDepositContained(projectDir: string, deftDir: string): void {
  const projectAbs = resolve(projectDir);
  let projectReal: string;
  try {
    projectReal = realpathSync(projectAbs);
  } catch {
    // The project directory does not exist yet (e.g. `directive init <new-path>`).
    // Nothing under it can exist, so there is no pre-existing symlink to escape
    // through -- the downstream init flow creates fresh, clean directories. Let
    // the deposit proceed; a missing content payload / mkdir failure surfaces its
    // own error later.
    return;
  }

  const deftAbs = resolve(deftDir);
  const rel = relative(projectAbs, deftAbs);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new DepositContainmentError(
      `deposit refused: deposit target ${deftAbs} is not nested under the project tree ${projectAbs}`,
      { projectDir: projectAbs, deftDir: deftAbs, offendingPath: deftAbs },
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
      // This component does not exist yet; nothing below it can exist either.
      break;
    }
    if (info.isSymbolicLink()) {
      let linkReal: string;
      try {
        linkReal = realpathSync(current);
      } catch {
        throw new DepositContainmentError(
          `deposit refused: ${current} is a broken/dangling symlink on the deposit path`,
          { projectDir: projectAbs, deftDir: deftAbs, offendingPath: current },
        );
      }
      if (!isContained(projectReal, linkReal)) {
        throw new DepositContainmentError(
          `deposit refused: ${current} is a symlink escaping the project tree ` +
            `(resolves to ${linkReal}, outside ${projectReal})`,
          { projectDir: projectAbs, deftDir: deftAbs, offendingPath: current },
        );
      }
      deepestExistingReal = linkReal;
    } else {
      deepestExistingReal = realpathSync(current);
    }
  }

  // Defense-in-depth: the deepest EXISTING ancestor of deftDir must resolve back
  // under the project tree (segment containment, not string startsWith).
  if (!isContained(projectReal, deepestExistingReal)) {
    throw new DepositContainmentError(
      `deposit refused: deposit path escapes the project tree ` +
        `(${deepestExistingReal} is outside ${projectReal})`,
      { projectDir: projectAbs, deftDir: deftAbs, offendingPath: deepestExistingReal },
    );
  }
}
