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

/** A checkpoint-named path spelling: ends with a checkpoint basename. */
const CHECKPOINT_NAME_RE = /continue\.[xv]brief\.json$/;
/** Patch header path (mutation headers and `*** Move to:`). */
const PATCH_HEADER_PATH_RE = /^\*\*\* [A-Za-z ]+?: (.*)$/;

/**
 * True when the payload spells a checkpoint-named path with leading or trailing
 * whitespace. The shared harvest trims paths, but a host writes the raw
 * spelling, so `xbrief/continue.xbrief.json ` is another file. The checkpoint
 * exemption declines such a payload (#6914). Single-line strings are checked
 * whole; multi-line strings (patch bodies) by their header lines.
 */
export function payloadHasPaddedCheckpointPath(payload: unknown, depth = 0): boolean {
  if (depth > 6 || payload === null || payload === undefined) return false;
  if (typeof payload === "string") {
    const candidates = payload.includes("\n")
      ? payload.split("\n").flatMap((line) => {
          const m = PATCH_HEADER_PATH_RE.exec(line.replace(/\r$/, ""));
          return m?.[1] !== undefined ? [m[1]] : [];
        })
      : [payload];
    return candidates.some((c) => c !== c.trim() && CHECKPOINT_NAME_RE.test(c.trim()));
  }
  if (typeof payload !== "object") return false;
  const values = Array.isArray(payload) ? payload : Object.values(payload);
  return values.some((v) => payloadHasPaddedCheckpointPath(v, depth + 1));
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
