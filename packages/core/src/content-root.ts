/**
 * content-root.ts -- resolve the shippable-content root across both contexts.
 *
 * The #1875 "content/ move" relocated every shippable framework asset under a
 * single `content/` root in the SOURCE repo. The C1 flatten deposit strips that
 * prefix when packaging, so a CONSUMER install sees the same `.deft/core/<x>`
 * layout it always had -- there is no `content/` directory in a deposited
 * framework.
 *
 * Engine modules that read shippable content by framework-root path (the event
 * registry, content packs, vBRIEF schemas, skill bodies, ...) therefore live in
 * two worlds:
 *
 *   - SOURCE checkout:  content lives at `<framework-root>/content/<x>`.
 *   - CONSUMER deposit: content lives at `<framework-root>/<x>` (flattened).
 *
 * `contentRoot(frameworkRoot)` resolves the difference by probing for the
 * `content/` directory: it returns `<framework-root>/content` when that
 * directory exists (source) and `<framework-root>` otherwise (consumer). Build
 * content paths off the returned root so the same code resolves both contexts
 * without a branch. Mirrors scripts/_content_root.py::content_root.
 *
 * Refs #1875 (content/ move), #1669 (Wave-1 LockedDecisions C1 flatten).
 */

import { statSync } from "node:fs";
import { join } from "node:path";

export const CONTENT_DIRNAME = "content";

/** Return the directory that holds flattened shippable content. */
export function contentRoot(frameworkRoot: string): string {
  const candidate = join(frameworkRoot, CONTENT_DIRNAME);
  try {
    if (statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // No content/ dir -> consumer (flattened) deposit; fall through.
  }
  return frameworkRoot;
}
