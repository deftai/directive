/** Shared lexical + realpath outside-root check for Write and Shell dests (#2885 / #3997). */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPathIdentity } from "../session/git.js";

function posixRelative(fromAbs: string, toAbs: string): string {
  return relative(fromAbs, toAbs).split(sep).join("/").replace(/\\/g, "/");
}

/**
 * Lexical outside-project-root predicate used by #2885.
 * - ".." / "../..." are outside (not bare startsWith("..") -- that matches ..secret).
 * - Absolute relatives and win32 cross-drive paths (D:/...) are outside.
 * - Drive-letter form is win32-only so POSIX children like D:/tmp/x stay in-repo.
 */
export function isLexicalOutsideProjectRoot(relPosix: string): boolean {
  if (relPosix === ".." || relPosix.startsWith("../") || isAbsolute(relPosix)) {
    return true;
  }
  return process.platform === "win32" && /^[A-Za-z]:\//.test(relPosix);
}

/**
 * win32 only (#7200): the root-relative POSIX path of a target that is
 * lexically outside `projectAbs` but physically inside it once both sides take
 * their native spelling (an 8.3 short name, another letter case or a junction
 * of the same checkout). Null when the target is not physically inside, when
 * either native form cannot be read, and on every other platform. A non-null
 * answer only moves a target inside, so file_scope and denyPaths keep applying
 * to it; it never moves a target outside.
 */
export function win32PhysicalRelative(projectAbs: string, targetAbs: string): string | null {
  if (process.platform !== "win32") return null;
  const root = canonicalPathIdentity(projectAbs);
  if (root === null) return null;
  const target = canonicalPathIdentity(targetAbs);
  if (target === null) return null;
  const rel = posixRelative(root, target);
  return isLexicalOutsideProjectRoot(rel) ? null : rel;
}

/**
 * True when a write target is outside projectRoot for the active-scope skip (#2885).
 * Lexically outside paths still fail the skip when a symlink/junction re-enters the project,
 * or (win32, #7200) when the target's native spelling is inside the root's native spelling.
 * When the project root cannot be realpath-d (unit fixtures), lexical classification wins.
 */
export function isOutsideProjectRootWrite(projectRoot: string, targetPath: string): boolean {
  const projectAbs = resolve(projectRoot);
  const targetAbs = resolve(projectRoot, targetPath.replace(/\\/g, "/"));
  const rel = posixRelative(projectAbs, targetAbs);
  if (!isLexicalOutsideProjectRoot(rel)) return false;
  if (win32PhysicalRelative(projectAbs, targetAbs) !== null) return false;

  try {
    const projectReal = realpathSync(projectAbs);
    let probe = targetAbs;
    for (;;) {
      try {
        const probeReal = realpathSync(probe);
        const reenter = posixRelative(projectReal, probeReal);
        if (reenter === "" || !isLexicalOutsideProjectRoot(reenter)) return false;
        return true;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return true;
        probe = parent;
      }
    }
  } catch {
    return true;
  }
}
