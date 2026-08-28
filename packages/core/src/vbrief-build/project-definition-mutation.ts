import { dirname, isAbsolute, relative, resolve } from "node:path";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import {
  atomicWriteProjectDefinition,
  type MutationLockDeps,
  parseProjectDefinitionAt,
  projectDefinitionArtifactLabel,
  projectDefinitionMutationLock,
} from "./project-definition-io.js";
import type { JsonObject } from "./types.js";

/**
 * Capability handed to a PROJECT-DEFINITION mutation critical section (#3796).
 *
 * The artifact identity is captured once, when the lock is acquired, and every
 * read and write goes through this object. That is what makes "every mutator
 * uses the shared lock" checkable: a caller cannot resolve the path again, so it
 * cannot lock one artifact and then load or persist a different one after a
 * configured path or symlink is retargeted mid-section.
 */
export interface ProjectDefinitionMutation {
  /** Artifact path captured at lock acquisition. Stable for the section. */
  readonly artifactPath: string;
  /** Control-safe label for this artifact in diagnostics. */
  readonly artifactLabel: string;
  /** Load and parse the captured artifact. Throws `ProjectDefinitionIOError`. */
  load(): JsonObject;
  /** Atomically persist `data` to the captured artifact under containment. */
  persist(data: JsonObject): void;
}

/**
 * Containment root for a persist.
 *
 * For an in-tree artifact this is the project root, so a force-added directory
 * symlink anywhere on the way down (`xbrief/` and friends) fails closed before
 * temp+rename -- the #3042 / #3077 guarantee. A `DEFT_PROJECT_PATH` override may
 * legitimately resolve outside the project root, and refusing those writes would
 * be a new restriction rather than a mutation-identity fix, so those fall back to
 * the artifact's own directory and keep the leaf-symlink refusal.
 */
function containmentRootFor(projectRoot: string, artifactPath: string): string {
  const rel = relative(projectRoot, resolve(artifactPath));
  const inTree = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  return inTree ? projectRoot : dirname(resolve(artifactPath));
}

/**
 * Run `fn` inside the shared PROJECT-DEFINITION mutation lock with load, parse
 * and persist bound to the artifact identity captured at acquisition.
 *
 * This is the only sanctioned mutation entry point. `verify:*`-adjacent
 * inventory coverage in `project-definition-mutation-inventory.test.ts` fails
 * closed when production code reaches for the raw resolver, the raw lock, or the
 * raw write sink instead (#3796).
 */
export function withProjectDefinitionMutation<T>(
  projectRoot: string,
  fn: (mutation: ProjectDefinitionMutation) => T,
  deps: MutationLockDeps = {},
): T {
  const root = resolve(projectRoot);
  return projectDefinitionMutationLock(
    projectRoot,
    (artifactPath) => {
      const mutation: ProjectDefinitionMutation = {
        artifactPath,
        artifactLabel: projectDefinitionArtifactLabel(artifactPath),
        load: () => parseProjectDefinitionAt(artifactPath),
        persist: (data) => {
          assertWriteTargetSafe(containmentRootFor(root, artifactPath), resolve(artifactPath));
          atomicWriteProjectDefinition(artifactPath, data);
        },
      };
      return fn(mutation);
    },
    deps,
  );
}
