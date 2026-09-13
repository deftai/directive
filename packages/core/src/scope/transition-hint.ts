/**
 * Derived recovery when a scope action cannot apply in the current folder (#4412).
 *
 * Auto-promote from proposed/ is refused: proposed -> pending is the approval
 * boundary. The hint names the two-step; it does not run it.
 */
import { formatFrameworkCommand } from "../render/framework-commands.js";
import {
  type LifecycleFolder,
  type ScopeAction,
  TRANSITIONS,
} from "./constants.js";

/** Printed whenever a recovery names promote then activate. */
export const AUTO_PROMOTE_REFUSED =
  "auto-promote from proposed/ is refused";

/**
 * Shared dispatcher recovery: no current folder is in scope, so name both
 * rungs rather than activate alone (#4412).
 */
export const SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE =
  "for a newly written proposal, run `deft scope:promote -- <path>` then " +
  "`deft scope:activate -- <path>` (auto-promote from proposed/ is refused); " +
  "for an already-pending xBRIEF run `deft scope:activate -- <path>`";

/**
 * The action whose source is `currentFolder` and whose target is an allowed
 * source of `act`. Null when `act` already applies or no single bridge exists.
 */
export function deriveBridgeAction(
  act: ScopeAction,
  currentFolder: LifecycleFolder,
): ScopeAction | null {
  const requested = TRANSITIONS[act];
  if (requested.allowedSources.includes(currentFolder)) return null;
  const bridges = (Object.keys(TRANSITIONS) as ScopeAction[]).filter((name) => {
    const spec = TRANSITIONS[name];
    return (
      spec.targetFolder !== null &&
      spec.allowedSources.includes(currentFolder) &&
      requested.allowedSources.includes(spec.targetFolder)
    );
  });
  return bridges.length === 1 ? (bridges[0] ?? null) : null;
}

/** Copy-paste two-step when a bridge exists; otherwise null. */
export function formatUnreachableTransitionHint(
  act: ScopeAction,
  currentFolder: LifecycleFolder,
  basename: string,
): string | null {
  const bridge = deriveBridgeAction(act, currentFolder);
  if (bridge === null) return null;
  const after = TRANSITIONS[bridge].targetFolder;
  if (after === null) return null;
  const first = formatFrameworkCommand([
    `scope:${bridge}`,
    "--",
    `xbrief/${currentFolder}/${basename}`,
  ]);
  const second = formatFrameworkCommand([`scope:${act}`, "--", `xbrief/${after}/${basename}`]);
  return `Recovery: run \`${first}\` then \`${second}\` (${AUTO_PROMOTE_REFUSED}).`;
}
