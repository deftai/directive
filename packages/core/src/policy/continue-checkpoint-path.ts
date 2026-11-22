/**
 * continue-checkpoint-path.ts -- the continue checkpoint is a process-owned path (#6914).
 *
 * `deft-checkpoint` saves session state to `xbrief/continue.xbrief.json`
 * (legacy `vbrief/continue.vbrief.json`), and continue-here says it MUST be
 * written at session end. The story write fence must not count it as story
 * work. The dispatcher admits a write whose every target is an eligible
 * checkpoint path; the write fence names the checkpoint in its refusal.
 *
 * The admission is for storage only: checkpoint narratives authorize no
 * product change.
 */

import { lstatSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";

/** The exact project-relative checkpoint paths. No glob and no other name. */
export const CONTINUE_CHECKPOINT_REL_PATHS: readonly string[] = [
  "xbrief/continue.xbrief.json",
  "vbrief/continue.vbrief.json",
];

/** True only for an exact checkpoint path (project-relative POSIX, case-sensitive). */
export function isContinueCheckpointPath(rel: string): boolean {
  return CONTINUE_CHECKPOINT_REL_PATHS.includes(rel);
}

/**
 * True when one harvested mutation target may use the checkpoint exemption.
 * `target` is the harvested path after URI decoding and before lexical
 * normalization. Every condition must hold:
 * - no `..` component (a collapsed `..` can hide a traversed link);
 * - the resolved path is an exact checkpoint path;
 * - `assertWriteTargetSafe` passes (containment; no link on any existing component);
 * - an existing checkpoint is a regular file with exactly one hard link.
 * An inspection error declines.
 */
export function isEligibleContinueCheckpointTarget(projectRoot: string, target: string): boolean {
  if (target.split(/[\\/]+/).some((part) => part === "..")) return false;
  const projectAbs = resolve(projectRoot);
  const targetAbs = resolve(projectAbs, target.replace(/\\/g, "/"));
  const rel = relative(projectAbs, targetAbs).split(sep).join("/");
  if (!isContinueCheckpointPath(rel)) return false;
  try {
    assertWriteTargetSafe(projectAbs, targetAbs);
    const info = lstatSync(targetAbs, { throwIfNoEntry: false });
    if (info === undefined) return true;
    return info.isFile() && info.nlink === 1;
  } catch {
    return false;
  }
}

/**
 * Write-fence refusal text for refused checkpoint paths. It names the
 * continue checkpoint and gives no split or widen remedy for it.
 */
export function continueCheckpointRefusalNote(paths: readonly string[]): string {
  const named = paths.map((p) => `\`${p}\``).join(", ");
  return (
    `${named} is the continue checkpoint, a process-owned path, not story work (#6914). ` +
    "A write that names only the checkpoint is eligible for the checkpoint exemption when its " +
    "path safety holds (no `..` part, no link on any part, one hard link) and the project " +
    "checks pass. Write the checkpoint separately from any other path."
  );
}
