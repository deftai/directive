/**
 * Payload-root realpath of recovered Shell dest-of-write (#4188).
 * classify remains I/O-free; this layer only reveals symlink aliases.
 * Absolute dests outside the payload root are out of this slice (no
 * effective-root admission expansion).
 */

import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  isLexicalOutsideProjectRoot,
  isOutsideProjectRootWrite,
} from "../hooks/outside-project-root.js";
import { destLiteralIsRelativeProtected, harvestDestsOfWriteForRealpath } from "./classify.js";

function posixRelative(fromAbs: string, toAbs: string): string {
  return relative(fromAbs, toAbs).split(sep).join("/").replace(/\\/g, "/");
}

function relIsProtectedDirectiveDest(relPosix: string): boolean {
  const p = relPosix.replace(/\\/g, "/");
  if (p === ".deft/authz" || p.startsWith(".deft/authz/")) return true;
  if (p === ".deft/approved-scope" || p.startsWith(".deft/approved-scope/")) return true;
  const segments = p.split("/").filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    const rest = segments.slice(i).join("/");
    if (rest === ".deft/authz" || rest.startsWith(".deft/authz/")) return true;
    if (rest === ".deft/approved-scope" || rest.startsWith(".deft/approved-scope/")) return true;
  }
  const base = segments[segments.length - 1] ?? "";
  return base === ".deft-directive-disable" || base === ".no-deft-directive";
}

export function resolvedDestIsPayloadRootProtected(projectRoot: string, dest: string): boolean {
  const trimmed = dest.trim();
  if (trimmed.length === 0) return false;
  if (isOutsideProjectRootWrite(projectRoot, trimmed)) return false;

  const projectAbs = resolve(projectRoot);
  const targetAbs = resolve(projectRoot, trimmed.replace(/\\/g, "/"));
  let resolved = targetAbs;
  try {
    resolved = realpathSync(targetAbs);
  } catch {
    let probe = targetAbs;
    for (;;) {
      const parent = dirname(probe);
      if (parent === probe) return false;
      try {
        const parentReal = realpathSync(parent);
        const suffix = probe.slice(parent.length);
        resolved = join(parentReal, suffix.replace(/^[\\/]/, ""));
        break;
      } catch {
        probe = parent;
      }
    }
  }

  let projectReal = projectAbs;
  try {
    projectReal = realpathSync(projectAbs);
  } catch {
    return false;
  }
  const rel = posixRelative(projectReal, resolved);
  if (rel === "" || isLexicalOutsideProjectRoot(rel)) return false;
  return relIsProtectedDirectiveDest(rel);
}

/**
 * True when a recovered dest is not lexically protected but realpath-resolves
 * onto a payload-root protected path (non-shell symlink alias).
 */
export function shellCommandHasPayloadRootProtectedDestAfterRealpath(
  projectRoot: string,
  command: string,
): boolean {
  for (const dest of harvestDestsOfWriteForRealpath(command)) {
    if (destLiteralIsRelativeProtected(dest)) continue;
    if (resolvedDestIsPayloadRootProtected(projectRoot, dest)) return true;
  }
  return false;
}
