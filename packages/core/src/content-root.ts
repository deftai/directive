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
 * #11 / C4 adds a third source: when `@deftai/directive-content` is installed
 * in `node_modules`, the resolver prefers that package root (already flattened)
 * and falls back to the vendored `.deft/core/` deposit / in-repo `content/`
 * layout across in-repo-vendored, hybrid npm-engine, and external-workspace
 * operating modes.
 *
 * Refs #1875 (content/ move), #1669 (Wave-1 LockedDecisions C1 flatten), #11.
 */

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONTENT_DIRNAME = "content";
export const CONTENT_PACKAGE_NAME = "@deftai/directive-content";

/** Walk upward from `searchFrom` and return the installed content package root. */
export function resolveContentPackageRoot(searchFrom: string): string | null {
  let dir = resolve(searchFrom);
  const filesystemRoot = resolve("/");
  while (true) {
    const pkgJson = join(dir, "node_modules", "@deftai", "directive-content", "package.json");
    try {
      if (statSync(pkgJson).isFile()) {
        return dirname(pkgJson);
      }
    } catch {
      // No physical install at this ancestor -- keep walking.
    }
    if (dir === filesystemRoot) break;
    dir = dirname(dir);
  }
  return null;
}

/** Return the directory that holds flattened shippable content. */
export function contentRoot(frameworkRoot: string): string {
  const packageRoot = resolveContentPackageRoot(frameworkRoot);
  if (packageRoot) return packageRoot;

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
