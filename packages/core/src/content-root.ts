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
 * in `node_modules` **and has staged shippable content** (templates/ or skills/),
 * the resolver prefers that package root (already flattened) and falls back to
 * the vendored `.deft/core/` deposit / in-repo `content/` layout across
 * in-repo-vendored, hybrid npm-engine, and external-workspace operating modes.
 * A bare workspace `packages/content` package (package.json + stage-pack only)
 * must not shadow in-repo `content/` (#1589 agents-md-freshness on CI).
 *
 * Refs #1875 (content/ move), #1669 (Wave-1 LockedDecisions C1 flatten), #11.
 */

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONTENT_DIRNAME = "content";
export const CONTENT_PACKAGE_NAME = "@deftai/directive-content";

/**
 * Defensive upper bound on the ancestor walk. A correctly-terminating walk
 * stops at the filesystem root in far fewer than this many steps on every
 * platform; the cap exists only so a future regression in the root-detection
 * logic degrades to "not found" instead of hanging the process. 256 dwarfs any
 * realistic absolute-path depth.
 */
const MAX_ANCESTOR_WALK_DEPTH = 256;

/**
 * Walk upward from `searchFrom` and return the installed content package root.
 *
 * Termination uses the idempotent-`dirname` pattern: `dirname` returns its own
 * input at the filesystem root on BOTH POSIX (`/` -> `/`) and Windows (`C:\` ->
 * `C:\`, `\\\\share` -> `\\\\share`), so `parent === dir` is the portable
 * stop condition. A hardcoded `resolve("/")` comparison is NOT safe on Windows:
 * `resolve("/")` yields the drive root of the CWD, which never equals the walk
 * cursor when `searchFrom` is on a different drive (or a UNC path) -- the
 * classic Windows drive-root infinite loop. A max-depth guard backstops both.
 */
export function resolveContentPackageRoot(searchFrom: string): string | null {
  let dir = resolve(searchFrom);
  for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH; depth += 1) {
    const pkgJson = join(dir, "node_modules", "@deftai", "directive-content", "package.json");
    try {
      if (statSync(pkgJson).isFile()) {
        return dirname(pkgJson);
      }
    } catch {
      // No physical install at this ancestor -- keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when an installed `@deftai/directive-content` root has staged shippable
 * content (prepack / consumer deposit). The workspace `packages/content`
 * package ships only `package.json` + `stage-pack.mjs` in git; preferring that
 * empty root shadows in-repo `content/templates` and fails
 * `agents-md-freshness` on rule-relocation PRs (#1589 CI).
 * Agent markers are templates/skills. Flattened `vbrief/` alone is enough only
 * when in-repo `content/` is absent (#4310 schemas-only deposits) so a
 * schemas-only package cannot hide in-repo templates/skills (#1589).
 */
function contentPackageHasAgentContent(packageRoot: string): boolean {
  return (
    directoryExists(join(packageRoot, "templates")) || directoryExists(join(packageRoot, "skills"))
  );
}

function contentPackageHasVbrief(packageRoot: string): boolean {
  return directoryExists(join(packageRoot, "vbrief"));
}

/** Return the directory that holds flattened shippable content. */
export function contentRoot(frameworkRoot: string): string {
  const packageRoot = resolveContentPackageRoot(frameworkRoot);
  const candidate = join(frameworkRoot, CONTENT_DIRNAME);
  const hasInRepoContent = directoryExists(candidate);

  if (packageRoot !== null) {
    if (contentPackageHasAgentContent(packageRoot)) {
      return packageRoot;
    }
    // Schemas-only npm root: prefer only when there is no competing content/.
    if (contentPackageHasVbrief(packageRoot) && !hasInRepoContent) {
      return packageRoot;
    }
  }

  if (hasInRepoContent) {
    return candidate;
  }
  return frameworkRoot;
}
