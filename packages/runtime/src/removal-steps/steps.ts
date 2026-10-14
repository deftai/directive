/**
 * Shared removal-step primitives for uninstall + WAVE3-V2 upgrade convert.
 * 3d: API skeleton — implementations land in 3e (husks) / 3f (layout steps).
 */
export type RemovalStepId =
  | "removeCopiedCore"
  | "removeDeftFrameworkTree"
  | "clearOwnedHookEntries"
  | "removeOwnedSkillPointers"
  | "pruneEmptyAncestors"
  | "removeSoleAuthorHusks"
  | "stripLegacyLauncherPin"
  | "removeOrphanDeftVersion"
  | "normalizeGitmodules";

export interface StepContext {
  readonly root: string;
  /** Relative path that was just removed; prune walks from its parent. */
  readonly emptiedFrom?: string;
}

export interface StepResult {
  readonly stepId: RemovalStepId;
  readonly removed: readonly string[];
  readonly modified: readonly string[];
}

/**
 * After Directive removes an owned file/entry, prune empty ancestor dirs it
 * emptied. Stops at non-empty or foreign parents (C4 / F-012).
 * @returns relative paths removed
 */
export function pruneEmptyAncestors(_root: string, _emptiedFrom: string): string[] {
  throw new Error("pruneEmptyAncestors not implemented");
}

/**
 * Remove sole-author Directive residue: `{ "private": true }`-only package.json
 * we created, empty `{}` host hooks we created, install-seeded AGENTS stubs
 * with no user body (C5 / F-013). Then callers apply pruneEmptyAncestors.
 * @returns relative paths removed
 */
export function removeSoleAuthorHusks(_root: string): string[] {
  throw new Error("removeSoleAuthorHusks not implemented");
}

/** Dispatch a named step. Unimplemented steps throw until 3e/3f. */
export function runStep(stepId: RemovalStepId, ctx: StepContext): StepResult {
  switch (stepId) {
    case "pruneEmptyAncestors": {
      if (ctx.emptiedFrom === undefined) {
        throw new Error("pruneEmptyAncestors requires ctx.emptiedFrom");
      }
      const removed = pruneEmptyAncestors(ctx.root, ctx.emptiedFrom);
      return { stepId, removed, modified: [] };
    }
    case "removeSoleAuthorHusks": {
      const removed = removeSoleAuthorHusks(ctx.root);
      return { stepId, removed, modified: [] };
    }
    default:
      throw new Error(`removal step '${stepId}' not implemented`);
  }
}
